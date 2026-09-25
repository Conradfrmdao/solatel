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

import { BUTTON_FIRE, BUTTON_JUMP } from './net.js';
import { Predictor, SIM } from './sim.js';

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
 * A steady climb ends up lagging by this many seconds of climbing - about
 * 0.18 m going up a ramp at walking pace - and a single step is most of the
 * way resolved in three of these. Longer and the view starts to swim behind
 * the player; shorter and a half-metre step is back to being a jolt.
 */
const EYE_SMOOTH_TIME = 0.09;

/** The eye is never allowed further from the feet than this, so that a long
 *  climb cannot bury the camera in the floor. */
const EYE_MAX_LAG = 0.5;

/** A difference bigger than this is not a step - it is a respawn, a fall, or
 *  the server moving the player - and is followed exactly. */
const EYE_SNAP = 1.5;

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
    /** Simulation time, in ticks' worth of seconds, for the fire rate. */
    this.gameTime = 0;
    this.lastPredictedShot = -Infinity;
    /** Shots this client expects the server to have fired, not yet shown. */
    this.predictedShots = 0;

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
    let buttons = 0;
    if (intent.jump) buttons |= BUTTON_JUMP;
    if (intent.fire) buttons |= BUTTON_FIRE;

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
      this.zoneRadius,
    );
    this._readPredictor();

    this.unacked.push(command);
    while (this.unacked.length > MAX_UNACKED) this.unacked.shift();

    // The shot, as far as this player's own hands are concerned. The server
    // enforces the same interval on the same ticks and decides what the shot
    // hit; this only lets the kick and the flash happen now rather than a
    // round trip from now. A predicted shot the server refused costs one
    // flash that meant nothing.
    this.gameTime += dt;
    if (
      intent.fire &&
      this.matchId &&
      !this.eliminated &&
      this.health > 0 &&
      this.gameTime - this.lastPredictedShot >= SIM.weaponFireInterval
    ) {
      this.lastPredictedShot = this.gameTime;
      this.predictedShots += 1;
    }

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
  }

  /**
   * Stand in line for a table.
   *
   * Nothing is charged here. The entry fee is taken when a match actually
   * forms around this player, so a line that never fills costs nothing - and
   * this is safe to call from a button somebody can mash.
   */
  queue(mapName, dollars) {
    // Whatever happened in the last match is behind them the moment they ask
    // for the next one. Leaving the banner up means a player who has queued
    // is still being told how they died.
    this.eliminated = false;
    this.killedBy = null;
    this.finalBoard = null;
    this.link.send({ t: 'queue', map: mapName, tier_dollars: dollars });
  }

  /** Give up the place in line. No money has moved, so nothing comes back. */
  leaveQueue() {
    this.link.send({ t: 'leave_queue' });
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
        this._reconcile(message);
        return true;

      case 'funds':
        // The server's figure. The client formats it and never adds to it:
        // a client that worked out its own balance would be a client that
        // could be wrong about how much money it has.
        this.balanceMicroUsd = message.balance_micro_usd;
        this.broke = Boolean(message.insufficient);
        return true;

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
        this.place = message.place ?? 0;
        this.formingInMs = this.queuedTable?.forming_in_ms ?? 0;
        return true;

      case 'match_started':
        // In, and paid for. Everything from the last match goes now rather
        // than lingering behind the new one.
        this.matchId = message.match_id;
        this.mapName = message.map_name ?? null;
        this.tier = message.tier ?? null;
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
        if (message.shooter === this.id && message.hit_player) {
          this.hitMarker = HIT_MARKER_SECONDS;
        }
        return false; // The world also wants this, for the tracer.

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
    );
    for (const command of this.unacked) {
      this.predictor.step(
        command.forward,
        command.right,
        command.yaw,
        command.pitch,
        command.buttons,
        this.zoneRadius,
      );
    }
    this._readPredictor();

    this.predictionError = Math.hypot(
      this.current.x - before.x,
      this.current.y - before.y,
      this.current.z - before.z,
    );
    // Keep the render interpolation from lurching when a correction lands; the
    // next fixed step sets it properly.
    this.previous.x = this.current.x;
    this.previous.y = this.current.y;
    this.previous.z = this.current.z;
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
    this.speed = p.speed;
    this.health = p.health;
  }

  /** Shots fired since this was last asked, once. */
  takePredictedShots() {
    const shots = this.predictedShots;
    this.predictedShots = 0;
    return shots;
  }

  /** How hard the last landing was, in metres per second, once. */
  takeLanding() {
    const speed = this.landingSpeed;
    this.landingSpeed = 0;
    return speed;
  }

  /** Eye position for this frame, interpolated between the last two ticks. */
  eyePosition(alpha, out, dt) {
    const raw =
      this.previous.y + (this.current.y - this.previous.y) * alpha + SIM.eyeOffset;

    if (this.eyeY === null || !this.onGround || Math.abs(raw - this.eyeY) > EYE_SNAP) {
      // Airborne, just spawned, or moved by something that was not a step.
      // All of those should be seen as they are.
      this.eyeY = raw;
    } else {
      // Exponential, framerate-independent: the same fraction of the gap is
      // closed per second however often this runs.
      this.eyeY += (raw - this.eyeY) * (1 - Math.exp(-dt / EYE_SMOOTH_TIME));
      this.eyeY = Math.min(Math.max(this.eyeY, raw - EYE_MAX_LAG), raw + EYE_MAX_LAG);
    }

    out.set(
      this.previous.x + (this.current.x - this.previous.x) * alpha,
      this.eyeY,
      this.previous.z + (this.current.z - this.previous.z) * alpha,
    );
    return out;
  }

  tickTimers(dt) {
    this.hitMarker = Math.max(0, this.hitMarker - dt);
  }
}
