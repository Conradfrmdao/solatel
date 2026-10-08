// The local player: input, prediction, and reconciliation.
//
// # Why predict at all
//
// The server is authoritative, so the true answer to "where am I" is always a
// round trip away. Waiting for it would put your own movement behind your ping,
// which is unplayable. So the client runs the same simulation over its own
// input immediately, and corrects itself when the server's answer arrives.
//
// # How correction works
//
// Every command carries a sequence number. Snapshots come back with the newest
// one the server consumed. On receiving one the client throws away its
// prediction, adopts the server's state, and re-applies every command the
// server has not yet seen. Because both sides run the identical simulation -
// literally, the same compiled Rust - the result normally matches what was
// already on screen and nothing visibly moves. When it does not, because the
// player was shot or lied to themselves, the correction is the server's answer,
// every time.

import {
  BUTTON_AIM,
  BUTTON_CROUCH,
  BUTTON_FIRE,
  BUTTON_JUMP,
  BUTTON_RELOAD,
  BUTTON_SIDEARM,
  BUTTON_THROW,
} from './net.js';
import { Predictor, SIM, WEAPONS } from './sim.js';

/** The loadout everybody has until a match says otherwise. */
const DEFAULT_LOADOUT = Object.freeze({ primary: 'rifle', optic: 'red_dot' });

/**
 * How many recent commands ride along in each message.
 *
 * Repeating them means a single dropped packet costs no movement at all, for a
 * few bytes. The server ignores any it has already consumed.
 */
const INPUT_RESEND_WINDOW = 3;

/**
 * Bound on the unacknowledged queue. If the server stops acknowledging, this
 * must not grow without limit while the link recovers.
 */
const MAX_UNACKED = 128;

/** How long the hit marker stays lit. */
const HIT_MARKER_SECONDS = 0.12;

/**
 * How fast the eye catches up with the feet, as a time constant.
 *
 * A single step is most of the way resolved in three of these. Longer and
 * the view starts to swim behind the player; shorter and a half-metre step
 * is back to being a jolt.
 */
const EYE_SMOOTH_TIME = 0.09;

/**
 * And as a distance: the eye closes the gap per metre walked as well as per
 * second, so it keeps up with a climb in proportion to how fast it is made.
 *
 * On time alone a steady climb lags by the climb rate times the time
 * constant, and a ramp is a steady climb: up a thirty-degree ramp at full
 * speed that was 0.42 m, the view sitting most of a crouch low the whole
 * way up. With this the lag up the same ramp is 0.12 m, and a single step
 * taken at a run is smoothed over about the third of a metre the body
 * takes to get over it - which is when a head would rise.
 */
const EYE_SMOOTH_DISTANCE = 0.3;

/**
 * How long the eye takes to go between crouched and standing, as a time
 * constant - smoothed apart from steps, in the air as on the ground, so a
 * jump from a crouch rises out of it rather than snapping up first.
 */
const CROUCH_EYE_TIME = 0.06;

/** The eye is never allowed further from the feet than this, so that a long
 *  climb cannot bury the camera in the floor. */
const EYE_MAX_LAG = 0.5;

/** A difference bigger than this is not a step - it is a respawn, a fall, or
 *  the server moving the player - and is followed exactly. */
const EYE_SNAP = 1.5;

/**
 * How fast the view catches up with a correction, as a time constant.
 *
 * When the server's answer differs from the prediction - a stall outlasted
 * its patience, or commands of this player's were dropped - the feet move
 * to the server's answer at once and the view follows over this long: two thirds of the way
 * in a tenth of a second and all of it in a third, which is under what an eye
 * reads as a jump and over what it reads as a cut. Source's `cl_smoothtime`
 * is the same number for the same job.
 */
const CORRECTION_SMOOTH_TIME = 0.1;

/** A correction bigger than this is a teleport, not an error, and is seen as
 *  one. */
const CORRECTION_SNAP = 2.0;

export class LocalPlayer {
  constructor(link, input) {
    this.link = link;
    this.input = input;

    this.predictor = new Predictor();
    this.id = null;
    this.nextSeq = 1;
    this.unacked = [];

    // Positions either side of the last fixed step, so rendering can
    // interpolate between them instead of stepping at the simulation rate.
    this.previous = { x: 0, y: 0, z: 0 };
    this.current = { x: 0, y: 0, z: 0 };

    this.predictionError = 0;
    /**
     * How far the view is from the prediction, fading to nothing.
     *
     * A correction moves the feet - the simulation's position, and so the
     * next command's starting point - to the server's answer at once. The
     * view keeps showing where it was and closes the gap over
     * `CORRECTION_SMOOTH_TIME`, so a correction is a glide rather than a
     * jump. Nothing but the camera reads it.
     */
    this.correction = { x: 0, y: 0, z: 0 };
    /** Set when a match starts, until the first snapshot of it has said
     *  which spawn this player was given and the view has turned to face
     *  the way it does. */
    this.faceSpawn = false;
    /** Whether a snapshot of the current match has been reconciled yet. */
    this.seenSnapshot = false;
    /** Where the last snapshot put this player, before any replay. */
    this.serverPosition = { x: 0, y: 0, z: 0 };
    this.health = SIM.maxHealth;
    this.onGround = false;
    this.speed = 0;
    this.deadFor = null;
    this.hitMarker = 0;
    /** Whether the shot the marker is for was a headshot. */
    this.hitWasHead = false;
    /** Who killed this player, for the death overlay. */
    this.killedBy = null;
    /** Which match this client is in, or null in the lobby.
     *
     *  Several run at once, so this is what tells a snapshot of this match
     *  from a straggler about the one just left. */
    this.matchId = null;
    /** The tables on offer, straight from the handshake. */
    this.tiers = [];
    /** What each table looks like right now: waiting, needed, running. */
    this.tables = [];
    /** The map this player is queued for, or null. */
    this.queuedMap = null;
    /** The stake this player is queued for, or null. */
    this.queuedFor = null;
    /** The map the current match is played on. */
    this.mapName = null;
    /** Their place in that line, counting from one. */
    this.place = 0;
    /** The table this client has asked to join and the server has not yet
     *  confirmed, so the searching screen is up the moment it is clicked
     *  rather than half a second later. */
    this.queueRequested = null;
    /** When this player got in line, by this client's clock. Only for the
     *  elapsed time on the searching screen; the server keeps its own. */
    this.queuedAt = null;
    /** The match the server has found for this player and is taking the
     *  entry fees for: `{ matchId, map, tier, players }`, or null. */
    this.found = null;
    /** Milliseconds of warm-up left, from the server and run down between
     *  its messages so the countdown reads smoothly. */
    this.startsInMs = 0;
    /** Whether the server still has this player held on their spawn. Set
     *  only from what the server says - never from the local countdown
     *  reaching zero - so the client starts moving late rather than early,
     *  and never predicts a step the server is about to refuse. */
    this.warmingUp = false;
    /** How many bought into the current match. */
    this.matchPlayers = 0;
    /** Milliseconds until a short-handed line starts anyway. The server sets
     *  it; the client only runs it down between messages so it reads
     *  smoothly, and never decides it has reached zero on its own. */
    this.formingInMs = 0;
    /** True once this player has been killed and is out of the match.
     *
     *  Distinct from simply not being in a match: somebody in the lobby is
     *  also not alive, and is looking at a different screen. */
    this.eliminated = false;
    /** The final board of the match just finished, if there was one. */
    this.finalBoard = null;
    /** The table this player is playing for, from `match_started`. */
    this.tier = null;
    /** What this player has won in the match, in micro-USD, from the server.
     *
     *  Kills times the reward, and nothing else: being killed does not take
     *  it off them, and it is already in their wallet. */
    this.winningsMicroUsd = 0;
    /** Whether this player is in a match right now. */
    this.inMatch = false;
    /** What the server settled on calling this player. */
    this.name = '';
    /** The match circle, in metres from the map's centre.
     *
     *  Infinite until the server says otherwise, so a client that has not
     *  had a snapshot yet predicts against no wall rather than against one
     *  at the origin. */
    this.zoneRadius = Infinity;
    /** Milliseconds left in the match, for the clock in the HUD. */
    this.matchRemainingMs = 0;
    /** Ticks this client has simulated, for the rate of fire. Every timer a
     *  gun has is in ticks on the server, and is predicted in ticks here. */
    this.ticks = 0;
    this.nextFireTick = 0;
    this._fireHeld = false;
    /** Shots this client expects the server to have fired, not yet shown:
     *  `{ weapon, from, velocity }` each, for the kick, the sound and the
     *  tracer, the moment the trigger is pulled. */
    this.predictedShots = [];
    /** What this player carries, as the server settled it for the match. */
    this.loadout = DEFAULT_LOADOUT;
    /** Which gun is in hand - 'primary' or 'sidearm' - and the ticks left
     *  of drawing it. Changed the tick the key is pressed, as the server
     *  will change it when that command arrives. */
    this.held = 'primary';
    this.drawTicks = 0;
    /** Rounds in each gun's magazine. The server's figures, run down locally
     *  between snapshots only so the kick stops on the shot the server will
     *  refuse. */
    this.rounds = { primary: 30, sidearm: 15 };
    /** Ticks of reload left on the gun in hand. */
    this.reloadTicks = 0;
    /** The newest command that fired, reloaded or changed guns here. A
     *  snapshot that has not yet acknowledged it knows nothing about the
     *  guns that this client does not, and is not taken over it. */
    this.armsSeq = 0;
    /** Set when the gun in hand changes, for the viewmodel, once. */
    this.switched = false;
    /** Grenades left this life. */
    this.grenades = SIM.grenadesPerLife ?? 2;
    /** Grenades still to go off, `{id, position}`, straight from the server. */
    this.liveGrenades = [];
    /** Whether the body is crouched, as the simulation has it. */
    this.crouched = false;

    /** Everything staked on this match, in micro-USD, straight from the
     *  server. Null until the first snapshot arrives. */
    this.poolMicroUsd = null;

    /** What this player can spend, in micro-USD. Null until the server says,
     *  which it only does on a paid server - in free play it never arrives
     *  and the HUD shows nothing rather than a confident zero. */
    this.balanceMicroUsd = null;
    /** True when the last entry was refused for want of funds. The player
     *  is watching and will stay watching, and is owed an explanation. */
    this.broke = false;

    /** Set on the frame a fall ends, and cleared by whoever reads it. */
    this.landingSpeed = 0;
    this._lastFall = 0;

    /**
     * The eye's own height, trailing the feet through a low-pass filter.
     *
     * Walking up a ramp or a staircase, the simulation lifts the player a
     * whole tread at a time - that is what stepping up *is*, and it is the
     * same on the server, so it cannot be smoothed away there without the two
     * disagreeing. Applied straight to the camera it reads as the head
     * jerking upwards sixty-four times a second.
     *
     * So the feet keep their exact position and the eye follows them through
     * a filter. Nothing about the world changes: this moves the camera and
     * nothing else.
     */
    this.eyeY = null;
    /** The feet's height as the eye follows it (steps smoothed), the eye's
     *  height over the feet (crouching eased), and where the eye was last
     *  frame across the ground, for how far it has walked since. */
    this.feetY = null;
    this.eyeLift = null;
    this._eyeAt = { x: 0, z: 0, set: false };
  }

  get isAlive() {
    return this.health > 0;
  }

  /**
   * One simulation tick: sample intent, predict it, queue it, send it.
   *
   * Runs at exactly the server's tick rate. Any other rate would mean the two
   * sides integrate movement differently and prediction could never settle.
   */
  fixedStep(dt) {
    if (!this.link.isReady) return;

    const intent = this.input.sample();
    if (this.warmingUp) {
      // The server zeroes these for the warm-up, and predicting them would
      // only be a correction a moment later. Gathered, everybody may walk,
      // jump and crouch among each other and nothing more; on a spawn, not
      // even that.
      intent.fire = false;
      intent.reload = false;
      intent.throw = false;
      if (!this.gathered) {
        intent.forward = 0;
        intent.right = 0;
        intent.jump = false;
        intent.crouch = false;
      }
    }
    let buttons = 0;
    if (intent.jump) buttons |= BUTTON_JUMP;
    if (intent.fire) buttons |= BUTTON_FIRE;
    if (intent.crouch) buttons |= BUTTON_CROUCH;
    if (intent.reload) buttons |= BUTTON_RELOAD;
    if (intent.throw) buttons |= BUTTON_THROW;
    // Raised to aim, so everybody else sees the rifle come up.
    if (this.input.aiming) buttons |= BUTTON_AIM;
    // Which gun is a posture, held for as long as the pistol is wanted.
    if (this.input.sidearm) buttons |= BUTTON_SIDEARM;

    const command = {
      seq: this.nextSeq,
      forward: intent.forward,
      right: intent.right,
      yaw: this.input.yaw,
      pitch: this.input.pitch,
      buttons,
    };
    this.nextSeq = (this.nextSeq + 1) >>> 0;

    // Predict immediately, so the player sees their own movement this frame
    // rather than in a round trip's time.
    this.previous.x = this.current.x;
    this.previous.y = this.current.y;
    this.previous.z = this.current.z;
    this.predictor.step(
      command.forward,
      command.right,
      command.yaw,
      command.pitch,
      command.buttons,
    );
    this._readPredictor();

    this.unacked.push(command);
    while (this.unacked.length > MAX_UNACKED) this.unacked.shift();

    // The guns, as far as this player's own hands are concerned. The server
    // keeps the same timers in the same ticks and decides what every shot
    // hit; this only lets the kick, the flash and the tracer happen now
    // rather than a round trip from now. A predicted shot the server refused
    // costs one flash that meant nothing.
    const armed = this.matchId && !this.eliminated && this.health > 0;
    this._predictArms(intent, command);
    if (intent.throw && !this._throwHeld && armed && this.grenades > 0) {
      this.thrown = true;
    }
    this._throwHeld = intent.throw;

    this.link.send({
      t: 'inputs',
      commands: this.unacked.slice(-INPUT_RESEND_WINDOW),
    });

    // Nothing is asked for automatically. There is no respawn, and joining a
    // line is a decision with a dollar at the end of it, so it waits for the
    // player to make it - see `queue`.
    if (this.formingInMs > 0) {
      this.formingInMs = Math.max(0, this.formingInMs - dt * 1000);
    }
    // Not while maps are still loading: the server's countdown has not
    // begun, and it is the server's that counts.
    if (this.startsInMs > 0 && !this.loadingPlayers) {
      this.startsInMs = Math.max(0, this.startsInMs - dt * 1000);
    }
  }

  /**
   * Stand in line for a table.
   *
   * Nothing is charged here. The entry fee is taken when a match actually
   * forms around this player, so a line that never fills costs nothing - and
   * this is safe to call from a button somebody can mash.
   */
  queue(mapName, dollars, loadout = DEFAULT_LOADOUT) {
    // Whatever happened in the last match is behind them the moment they ask
    // for the next one. Leaving the banner up means a player who has queued
    // is still being told how they died.
    this.eliminated = false;
    this.killedBy = null;
    this.finalBoard = null;
    this.broke = false;
    this.queueRequested = { map: mapName, dollars, at: performance.now() };
    if (this.queuedAt === null) this.queuedAt = performance.now();
    // The guns go with the stake: what a life is played with is chosen
    // with it, and the server makes it into something the game allows.
    this.link.send({ t: 'queue', map: mapName, tier_dollars: dollars, loadout });
  }

  /** Give up the place in line. No money has moved, so nothing comes back. */
  leaveQueue() {
    this.queueRequested = null;
    this.queuedAt = null;
    this.queuedMap = null;
    this.queuedFor = null;
    this.link.send({ t: 'leave_queue' });
  }

  /** Whether this player is in a line, or has just asked to be. */
  get searching() {
    // A request the server never confirmed stops counting after a few
    // seconds, so a refusal nobody was told about cannot leave the screen
    // searching forever.
    const asked = this.queueRequested !== null && performance.now() - this.queueRequested.at < 4000;
    return (
      !this.matchId &&
      !this.found &&
      (asked || (this.queuedFor !== null && this.queuedFor !== undefined))
    );
  }

  /** What the table this player is queued for looks like right now. */
  get queuedTable() {
    return (
      this.tables.find(
        (t) => t.dollars === this.queuedFor && t.map === this.queuedMap,
      ) ?? null
    );
  }

  /** Handles one server message. Returns true if it was consumed here. */
  handle(message, dt) {
    switch (message.t) {
      case 'welcome':
        this.id = message.player_id;
        // The price is the server's to state. A client that knew it for
        // itself would be a client that could be wrong about what it is
        // about to be charged.
        this.tiers = message.tiers ?? [];
        // A fresh session. Anything still queued belongs to the old one, and
        // the new server player starts from sequence zero - replaying that
        // backlog against the first snapshot would teleport the player.
        this.unacked.length = 0;
        this.predictionError = 0;
        this.clearCorrection();
        this.name = message.name ?? this.name;
        return true;

      case 'snapshot':
        // Several matches run at once and this client is in at most one of
        // them. A snapshot of any other is a straggler about a match it has
        // already left, and rendering it would put the player back in it.
        if (message.match_id !== this.matchId) return true;
        if (typeof message.pool_micro_usd === 'number') {
          this.poolMicroUsd = message.pool_micro_usd;
        }
        // Taken from the server rather than worked out from a local clock.
        // The circle closes on the server's time, and predicting against a
        // wall a little away from the real one is a correction every tick
        // for anybody standing near it.
        if (typeof message.zone_radius === 'number') {
          this.zoneRadius = message.zone_radius;
        }
        if (typeof message.match_remaining_ms === 'number') {
          this.matchRemainingMs = message.match_remaining_ms;
        }
        // The guns' state is the server's - once it has heard every command
        // that changed it here. Until then a snapshot was on its way before
        // the shot, the reload or the change of gun, and taking it would
        // undo what the player has just done. Its timers are wound on by the
        // commands it has not seen, which this client has already run.
        if (typeof message.ammo === 'number') {
          if ((message.ack_input_seq ?? 0) >= this.armsSeq) {
            const since = this.unacked.filter((c) => c.seq > message.ack_input_seq).length;
            const ticks = (ms) => Math.max(0, Math.round((ms ?? 0) / (SIM.tickDt * 1000)) - since);
            const held = message.weapon === 'pistol' ? 'sidearm' : 'primary';
            if (held !== this.held) this.switched = true;
            this.held = held;
            this.rounds[held] = message.ammo;
            this.rounds[held === 'primary' ? 'sidearm' : 'primary'] = message.spare_ammo ?? 0;
            this.reloadTicks = ticks(message.reload_ms);
            this.drawTicks = ticks(message.switch_ms);
          }
          this.grenades = message.grenades ?? this.grenades;
        }
        this.liveGrenades = message.live_grenades ?? [];
        if (typeof message.starts_in_ms === 'number') {
          const wasWarming = this.warmingUp;
          this.startsInMs = message.starts_in_ms;
          this.warmingUp = message.starts_in_ms > 0;
          // Gone live from the gathering: this snapshot is the first with
          // this player on their own spawn, so face the way it faces.
          if (wasWarming && !this.warmingUp && this.gathered) {
            this.faceSpawn = true;
            this.seenSnapshot = false;
          }
        }
        this.loadingPlayers = message.loading ?? 0;
        this.gathered = Boolean(message.gathered);
        this._reconcile(message);
        return true;

      case 'funds':
        // The server's figure. The client formats it and never adds to it:
        // a client that worked out its own balance would be a client that
        // could be wrong about how much money it has.
        this.balanceMicroUsd = message.balance_micro_usd;
        this.broke = Boolean(message.insufficient);
        if (this.broke) {
          // Refused a place: the searching screen has nothing to search for.
          this.queueRequested = null;
          this.queuedAt = null;
          this.found = null;
        }
        return true;

      case 'match_found':
        // The line became a match. Nothing is charged yet; `match_started`
        // follows once the stakes are in, or a lobby message puts this
        // player back in the lobby if the match did not get enough of them.
        this.found = {
          matchId: message.match_id,
          map: message.map_name,
          tier: message.tier,
          players: message.players,
        };
        this.queueRequested = null;
        return false; // main.js wants it for the sound.

      case 'damaged':
        this.health = message.health_remaining;
        return true;

      case 'hit_confirmed':
        // The shooter's own receipt. A headshot lights a different marker,
        // because it is worth twice as much and the player should be able to
        // tell without counting health bars.
        this.hitMarker = HIT_MARKER_SECONDS;
        this.hitWasHead = message.region === 'head';
        return false; // main.js wants it for the sound.

      case 'killed':
        if (message.victim === this.id) {
          this.killedBy = message.killer_name ?? null;
        }
        return false; // the killfeed wants every one of these.

      case 'lobby':
        // The tables, and where this player stands among them. A few times a
        // minute rather than a few times a second.
        this.tables = message.tables ?? [];
        this.queuedMap = message.queued_map ?? null;
        this.queuedFor = message.queued_for ?? null;
        // Lobby messages only reach players who are not in a match, so one
        // arriving means any match that was being found for this player is
        // not happening.
        this.found = null;
        if (this.queuedFor !== null) {
          this.queueRequested = null;
          if (this.queuedAt === null) this.queuedAt = performance.now();
        } else if (!this.queueRequested) {
          this.queuedAt = null;
        }
        this.place = message.place ?? 0;
        this.formingInMs = this.queuedTable?.forming_in_ms ?? 0;
        return true;

      case 'match_started':
        // In, and paid for. Everything from the last match goes now rather
        // than lingering behind the new one.
        this.matchId = message.match_id;
        // Spawns are dealt out per match, so which way to face is told by
        // where the server put this player - see `spawnFacing`.
        this.faceSpawn = true;
        this.seenSnapshot = false;
        this.mapName = message.map_name ?? null;
        this.tier = message.tier ?? null;
        this.matchPlayers = message.players ?? 0;
        this.startsInMs = message.starts_in_ms ?? 0;
        this.warmingUp = this.startsInMs > 0;
        // Until a snapshot says otherwise, everybody is still loading, and
        // waiting where the match put them.
        this.loadingPlayers = this.warmingUp ? Math.max(1, message.players ?? 1) : 0;
        this.gathered = false;
        this.found = null;
        this.queueRequested = null;
        this.queuedAt = null;
        this.inMatch = true;
        this.eliminated = false;
        this.killedBy = null;
        this.winningsMicroUsd = 0;
        this.broke = false;
        this.finalBoard = null;
        this.queuedMap = null;
        this.queuedFor = null;
        this.place = 0;
        this.unacked.length = 0;
        this.predictionError = 0;
        this.clearCorrection();
        this._arm(message.loadout);
        this.armsSeq = 0;
        this.grenades = SIM.grenadesPerLife;
        this.liveGrenades = [];
        this.input.resetCrouch?.();
        this.input.resetSidearm?.();
        return true;

      case 'match_ended':
        if (message.match_id !== this.matchId) return true;
        // Records are gone on the server the moment the match is, so the
        // board in this message is the only copy of how it finished.
        this.finalBoard = message.entries;
        this.finalBoardAt = performance.now();
        this.winningsMicroUsd = message.winnings_micro_usd ?? this.winningsMicroUsd;
        this.matchId = null;
        this.inMatch = false;
        return false;

      case 'eliminated':
        // Out of that match for good, and back in the lobby this instant.
        // The winnings are the server's figure and are already in the
        // wallet; this is the statement, not the payment.
        this.eliminated = true;
        this.inMatch = false;
        this.matchId = null;
        this.winningsMicroUsd = message.winnings_micro_usd ?? 0;
        return true;

      case 'scoreboard': {
        // Winnings are the server's count of kills times the reward. The
        // client displays it and never adds to it.
        const mine = message.entries.find((entry) => entry.id === this.id);
        if (mine) {
          this.winningsMicroUsd = mine.winnings_micro_usd ?? 0;
          this.inMatch = mine.alive;
        }
        return false; // the HUD wants the whole board.
      }

      case 'shot_fired':
        if (message.shooter === this.id && message.landed?.hit_player) {
          this.hitMarker = HIT_MARKER_SECONDS;
        }
        return false; // The world also wants this, for the tracer.

      case 'shot_landed':
        if (message.shooter === this.id && message.landing?.hit_player) {
          this.hitMarker = HIT_MARKER_SECONDS;
        }
        return false; // And this, for where it came down.

      default:
        return false;
    }
  }

  _reconcile(snapshot) {
    if (!this.id) return;
    const mine = snapshot.players.find((p) => p.id === this.id);
    if (!mine) return;

    const before = { x: this.current.x, y: this.current.y, z: this.current.z };
    const state = mine.state;

    // Anything the server has consumed is history now.
    const ack = snapshot.ack_input_seq;
    this.unacked = this.unacked.filter((command) => command.seq > ack);

    // Adopt the server's answer, then replay what it has not seen through the
    // same simulation it used, so the two agree.
    this.predictor.adopt(
      state.position[0],
      state.position[1],
      state.position[2],
      state.velocity[0],
      state.velocity[1],
      state.velocity[2],
      state.yaw,
      state.pitch,
      state.on_ground,
      state.health,
      Boolean(state.crouched),
    );
    for (const command of this.unacked) {
      this.predictor.step(
        command.forward,
        command.right,
        command.yaw,
        command.pitch,
        command.buttons,
      );
    }
    this._readPredictor();

    this.seenSnapshot = true;
    this.serverPosition.x = state.position[0];
    this.serverPosition.y = state.position[1];
    this.serverPosition.z = state.position[2];
    const dx = this.current.x - before.x;
    const dy = this.current.y - before.y;
    const dz = this.current.z - before.z;
    this.predictionError = Math.hypot(dx, dy, dz);
    // The tick before moves with this one, so drawing between the two
    // carries on smoothly from where it was; and the view keeps showing the
    // old answer, fading it out (see `correction`). Almost always this is
    // nothing at all - the server ran the same commands through the same
    // simulation - and when it is something, it is a glide.
    this.previous.x += dx;
    this.previous.y += dy;
    this.previous.z += dz;
    if (this.predictionError > CORRECTION_SNAP) {
      this.clearCorrection();
    } else {
      this.correction.x -= dx;
      this.correction.y -= dy;
      this.correction.z -= dz;
    }
  }

  clearCorrection() {
    this.correction.x = 0;
    this.correction.y = 0;
    this.correction.z = 0;
  }

  /** Copy the simulation's answer out into the fields the renderer reads. */
  _readPredictor() {
    const p = this.predictor;
    this.current.x = p.x;
    this.current.y = p.y;
    this.current.z = p.z;

    // The speed a fall ended at, held for whoever reads it next. It has to be
    // caught here, on the transition: by the time anything outside notices the
    // player is on the ground, the simulation has already zeroed the vertical
    // velocity that says how hard they hit.
    if (!this.onGround && p.on_ground) this.landingSpeed = Math.abs(this._lastFall);
    this._lastFall = p.vy;

    this.onGround = p.on_ground;
    this.crouched = p.crouched;
    this.eyeOffset = p.eye_offset;
    this.speed = p.speed;
    this.health = p.health;
  }

  /** Shots fired since this was last asked, once. */
  takePredictedShots() {
    const shots = this.predictedShots;
    this.predictedShots = [];
    return shots;
  }

  /** Whether the gun in hand changed since this was last asked, once. */
  takeSwitch() {
    const switched = this.switched;
    this.switched = false;
    return switched;
  }

  /** The gun in hand, by its name on the wire. */
  get weapon() {
    return this.held === 'sidearm' ? 'pistol' : this.loadout.primary;
  }

  /** Everything the shared table says about the gun in hand. */
  get gun() {
    return WEAPONS[this.weapon] ?? WEAPONS.rifle;
  }

  /** What the gun in hand is aimed through. */
  get optic() {
    return this.held === 'sidearm' ? 'irons' : this.loadout.optic;
  }

  /** Rounds in the gun in hand, and in the other one. */
  get ammo() {
    return this.rounds[this.held];
  }

  get spareAmmo() {
    return this.rounds[this.held === 'primary' ? 'sidearm' : 'primary'];
  }

  get reloadMs() {
    return this.reloadTicks * SIM.tickDt * 1000;
  }

  get switchMs() {
    return this.drawTicks * SIM.tickDt * 1000;
  }

  /** Back to a fresh life's guns: the primary in hand, both full. */
  _arm(loadout) {
    this.loadout = loadout ?? DEFAULT_LOADOUT;
    this.held = 'primary';
    this.drawTicks = 0;
    this.reloadTicks = 0;
    this.nextFireTick = 0;
    this._fireHeld = false;
    this.rounds = {
      primary: WEAPONS[this.loadout.primary]?.magazine ?? 30,
      sidearm: WEAPONS.pistol?.magazine ?? 15,
    };
    this.switched = true;
  }

  /**
   * One tick of the guns, on the server's rules and in its order: a reload
   * or a draw running down, a change of gun, a reload asked for, and the
   * trigger - which a pistol or a bolt answers once a pull, and an automatic
   * for as long as it is held, never faster than its own rate.
   */
  _predictArms(intent, command) {
    this.ticks += 1;
    const armed = this.matchId && !this.eliminated && this.health > 0;
    if (this.drawTicks > 0) this.drawTicks -= 1;
    if (this.reloadTicks > 0) {
      this.reloadTicks -= 1;
      if (this.reloadTicks === 0) this.rounds[this.held] = this.gun.magazine;
    }
    const wanted = this.input.sidearm ? 'sidearm' : 'primary';
    if (wanted !== this.held) {
      // Out with the other gun: its own time to draw, and a reload half done
      // put away with the one going back.
      this.held = wanted;
      this.drawTicks = Math.round(this.gun.drawSeconds / SIM.tickDt);
      this.reloadTicks = 0;
      this.armsSeq = command.seq;
      this.switched = true;
    }
    const gun = this.gun;
    const pulled = intent.fire && (gun.automatic || !this._fireHeld);
    this._fireHeld = intent.fire;
    const ready = armed && this.drawTicks === 0 && this.reloadTicks === 0;
    const reload = () => {
      if (this.rounds[this.held] >= gun.magazine) return;
      this.reloadTicks = Math.round(gun.reloadSeconds / SIM.tickDt);
      this.reloadStarted = true;
      this.armsSeq = command.seq;
    };
    if (ready && intent.reload) reload();
    if (pulled && armed && this.drawTicks === 0 && this.reloadTicks === 0 && this.ticks >= this.nextFireTick) {
      if (this.rounds[this.held] === 0) {
        // Pulling the trigger on an empty magazine starts putting one in.
        reload();
        return;
      }
      this.nextFireTick = this.ticks + gun.fireTicks;
      this.rounds[this.held] -= 1;
      this.armsSeq = command.seq;
      // From the eye, along the aim, raised by the gun's zero - exactly as
      // the server launches it - so the tracer drawn now flies where the
      // server's round will.
      const up = command.pitch + gun.zeroAngle;
      const speed = gun.muzzleVelocity;
      this.predictedShots.push({
        weapon: this.weapon,
        from: [this.current.x, this.current.y + (this.eyeOffset ?? SIM.eyeOffset), this.current.z],
        velocity: [
          -Math.sin(command.yaw) * Math.cos(up) * speed,
          Math.sin(up) * speed,
          -Math.cos(command.yaw) * Math.cos(up) * speed,
        ],
      });
      if (this.rounds[this.held] === 0) reload();
    }
  }

  /** Whether a reload started since this was last asked, once. */
  takeReloadStart() {
    const started = Boolean(this.reloadStarted);
    this.reloadStarted = false;
    return started;
  }

  /** Whether a grenade left this player's hand since last asked, once. */
  takeThrow() {
    const thrown = Boolean(this.thrown);
    this.thrown = false;
    return thrown;
  }

  /** Whether this player is standing outside the circle, and burning. */
  get outsideZone() {
    return (
      this.inMatch &&
      Number.isFinite(this.zoneRadius) &&
      Math.hypot(this.current.x, this.current.z) > this.zoneRadius
    );
  }

  /** How hard the last landing was, in metres per second, once. */
  takeLanding() {
    const speed = this.landingSpeed;
    this.landingSpeed = 0;
    return speed;
  }

  /** Eye position for this frame, interpolated between the last two ticks. */
  eyePosition(alpha, out, dt) {
    const fade = Math.exp(-dt / CORRECTION_SMOOTH_TIME);
    this.correction.x *= fade;
    this.correction.y *= fade;
    this.correction.z *= fade;
    const x = this.previous.x + (this.current.x - this.previous.x) * alpha + this.correction.x;
    const z = this.previous.z + (this.current.z - this.previous.z) * alpha + this.correction.z;
    const feet = this.previous.y + (this.current.y - this.previous.y) * alpha + this.correction.y;

    // Crouching and standing, eased on their own clock and in the air as on
    // the ground (`CROUCH_EYE_TIME`).
    const lift = this.eyeOffset ?? SIM.eyeOffset;
    if (this.eyeLift === null) this.eyeLift = lift;
    else this.eyeLift += (lift - this.eyeLift) * (1 - Math.exp(-dt / CROUCH_EYE_TIME));

    if (this.feetY === null || !this.onGround || Math.abs(feet - this.feetY) > EYE_SNAP) {
      // Airborne, just spawned, or moved by something that was not a step.
      // All of those should be seen as they are.
      this.feetY = feet;
    } else {
      // Exponential in time and in distance walked, so framerate-
      // independent and quicker the faster the climb is being made (see
      // `EYE_SMOOTH_DISTANCE`).
      const walked = this._eyeAt.set ? Math.hypot(x - this._eyeAt.x, z - this._eyeAt.z) : 0;
      const k = 1 - Math.exp(-(dt / EYE_SMOOTH_TIME + walked / EYE_SMOOTH_DISTANCE));
      this.feetY += (feet - this.feetY) * k;
      this.feetY = Math.min(Math.max(this.feetY, feet - EYE_MAX_LAG), feet + EYE_MAX_LAG);
    }
    this._eyeAt.x = x;
    this._eyeAt.z = z;
    this._eyeAt.set = true;
    this.eyeY = this.feetY + this.eyeLift;

    out.set(x, this.eyeY, z);
    return out;
  }

  tickTimers(dt) {
    this.hitMarker = Math.max(0, this.hitMarker - dt);
  }
}
