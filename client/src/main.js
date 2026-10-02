// Solatel browser client.
//
// The client renders and predicts; it never decides what happened. Every fact
// about the world - positions, hits, kills, money - comes from the server. What
// this file owns is the loop that keeps those two things in step.
//
// # Two clocks
//
// Input and simulation run at a fixed 64 Hz, because that is the server's rate
// and prediction can only settle if both sides integrate movement identically.
// Rendering runs as fast as the display will go and interpolates between the
// last two simulation steps, so movement is smooth at any frame rate without
// the simulation caring what that rate is.
//
// Mouse look is sampled per *frame*, not per tick, and before the ticks that
// use it. Aiming then never lags the display, and no command carries a stale
// aim - a mistake worth naming because the previous client made it and it made
// turning while moving fight itself.

import * as THREE from 'three';
import { buildPost } from './post.js';
import { Quality } from './quality.js';
import { Impacts } from './impacts.js';
import { DEATH_TIME_SCALE, Death } from './death.js';
import { Clips, clipsSupported, clipsWanted, setClipsWanted } from './clips.js';
import { setNatureDetail } from './nature.js';
import { Hud } from './hud.js';
import { Input } from './input.js';
import { Audio } from './audio.js';
import { Link, noteReferral, readAccountKey, writeAccountKey } from './net.js';
import { LocalPlayer } from './localplayer.js';
import { Remotes } from './remotes.js';
import { BRUSHES, SIM, SPAWNS, loadSim, selectMap, spawnFacing } from './sim.js';
import { Menu } from './menu.js';
import { Matchmaking } from './matchmaking.js';
import { Viewmodel } from './viewmodel.js';
import { World } from './world.js';
import { initPhotos } from './photo.js';
import { prefetchMap } from './prefetch.js';
import { lightHere } from './light.js';
import { asset, clientBuild } from './assets.js';

/**
 * Field of view, measured *horizontally*, the way shooters quote it.
 *
 * Three.js takes a vertical angle, which is the trap here: setting its `fov` to
 * the 90 a shooter means gives about 121 degrees across a 16:9 screen, and the
 * whole view bulges. The vertical angle is computed from this and the aspect
 * ratio instead, so the horizontal view stays put when the window changes shape
 * - widescreen shows more to the sides rather than cropping the top and bottom.
 */
const DEFAULT_HORIZONTAL_FOV = 90;
const FOV_KEY = 'solatel.fov';
/** Where the old "extra shading" box kept its answer, read once so a player
 *  who had turned ambient occlusion on starts on the level that has it. */
const AO_KEY = 'solatel.ao';


const NAME_KEY = 'solatel.name';

/** The name to ask for, or empty to let the server choose one.
 *
 *  Stored per browser, like the sensitivity. It reaches the server in the
 *  handshake, so changing it takes effect on the next connection - which is
 *  what the row in the settings panel says. */
function storedName() {
  try {
    return window.localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Vertical angle three.js wants, from the horizontal one a player picks.
 *
 *  `zoom` narrows it for the sights: it scales the tangent of the half-angle,
 *  which is what magnification is, rather than the angle itself. */
function verticalFov(horizontal, aspect, zoom = 1) {
  const half = (horizontal * Math.PI) / 360;
  return (2 * Math.atan((Math.tan(half) * zoom) / aspect) * 180) / Math.PI;
}

function storedFov() {
  try {
    const value = Number(window.localStorage.getItem(FOV_KEY));
    if (Number.isFinite(value) && value >= 60 && value <= 120) return value;
  } catch {
    /* private browsing */
  }
  return DEFAULT_HORIZONTAL_FOV;
}

/**
 * Never advance more than this many simulation ticks in one frame.
 *
 * A long frame leaves ticks owed, and running them all at once would make
 * the next frame long too. A few a frame makes them up without that.
 */
const MAX_TICKS_PER_FRAME = 5;

/** Scratch for drawing a shot from where its shooter is drawn. */
const _muzzle = new THREE.Vector3();
const _from = new THREE.Vector3();

/**
 * How much time the fixed step may owe and still make up, in ticks.
 *
 * Well under the server's `GUESS_WINDOW_TICKS`, the longest it waits for a
 * late command and puts its guess right: a frame that hitched for a fifth of
 * a second sends that fifth of a second's commands late, and nothing on the
 * screen jumps. Owing more - a tab that was in the background - the time is
 * let go: it was not played, and the server has stopped waiting for it.
 * The frame's own time is capped at a quarter of a second besides, so a tab
 * coming back never asks for hundreds of ticks at once.
 */
const CATCH_UP_TICKS = 20;

async function boot() {
  const canvas = document.getElementById('solatel-canvas');
  const hudRoot = document.getElementById('hud');
  const status = document.getElementById('boot-status');

  const say = (text) => {
    if (status) status.textContent = text;
  };

  say('loading simulation…');
  await loadSim(asset('sim/solatel_sim_bg.wasm'));

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  // The pixel ratio is the quality setting's (quality.js): capped at 2 even at
  // ultra, because a 4K display would otherwise ask the GPU for four times
  // the pixels for a difference nobody is looking for during a firefight.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Filmic tonemapping is most of the difference between "flat coloured
  // shapes" and "a lit place". Without it, bright surfaces clip to their raw
  // material colour and the whole scene reads as a diagram.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  // The photographs' transcoder needs to know which compressed formats this
  // GPU takes before the first one is loaded.
  initPhotos(renderer);

  const scene = new THREE.Scene();
  let horizontalFov = storedFov();
  // The near plane is half the distance it was, and the reason is collision
  // rather than rendering.
  //
  // A player is 0.7 m wide, so pressed against a wall their eye is 0.35 m
  // from the brush that stopped them. That sounds like ample clearance for a
  // 0.1 m near plane, and it is - against a brush. It is not against the
  // *art*: the collision table is voxelised at a quarter of a metre, so where
  // a wall does not run along the grid the brush face can sit up to a cell
  // behind the surface that is drawn. Stand in one of those corners and the
  // eye ends up 0.1 m from the visible wall, which is exactly the near plane,
  // and the wall is clipped away. From inside, being able to see through a
  // wall you are leaning on is indistinguishable from being inside it.
  //
  // 0.05 doubles the margin. It costs depth precision, which is affordable:
  // the far plane is set from the map below rather than left at some round
  // number, and ambient occlusion - the one thing here that reads the depth
  // buffer closely - is off by default.
  const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 220);

  const world = new World(scene, renderer);
  const impacts = new Impacts(scene);
  const remotes = new Remotes(scene);
  const viewmodel = new Viewmodel();

  const options = new URLSearchParams(window.location.search);
  const input = new Input(canvas, { requireLock: !options.has('nolock') });

  // The server is connected to before anything of the world is loaded. Which
  // map gets played is not decided here and not decided at the handshake: the
  // server runs every map, several matches at once, and the one this client
  // ends up on is whichever table the player picks. So the map is loaded when
  // a match starts - see `enterMatch` below - and until then there is no world
  // to draw.
  say('connecting…');
  // Somebody's invite link, kept for the account this browser is about to make.
  noteReferral();
  const link = new Link(clientBuild(), storedName());
  await link.firstWelcome;

  say('loading the weapon…');
  const rifle = await viewmodel.load();
  say('loading the soldier…');
  // The same rifle, handed on rather than fetched again.
  const soldier = await remotes.load(asset('assets/characters/soldier.glb'), rifle);
  // And the same soldier's arms in first person, in the same pose.
  viewmodel.setArms(soldier, remotes.clips.aim);

  const local = new LocalPlayer(link, input);
  // The menu is built before the HUD, because the settings controls live in
  // the menu's markup and the HUD is what wires them up. A HUD constructed
  // first would look for sliders that did not exist yet.
  const menu = new Menu(document.getElementById('menu'));
  const hud = new Hud(hudRoot);
  const audio = new Audio();
  const death = new Death();
  // The last seconds of play, kept for F8. Off unless the player turned it on.
  const clips = new Clips();
  clips.setEnabled(clipsWanted());
  /** Where the death sequence puts the camera, reused frame to frame. */
  const deathPose = { position: new THREE.Vector3(), yaw: 0, pitch: 0, roll: 0, t: 0 };
  let wasDying = false;
  {
    const box = document.querySelector('#clips');
    const note = document.querySelector('#clips-note');
    if (box) {
      box.checked = clipsWanted() && clipsSupported();
      if (!clipsSupported()) {
        box.disabled = true;
        if (note) note.textContent = 'this browser cannot record video';
      }
      box.addEventListener('change', () => {
        setClipsWanted(box.checked);
        clips.setEnabled(box.checked);
      });
      box.addEventListener('keydown', (event) => event.preventDefault());
    }
    window.addEventListener('keydown', (event) => {
      if (event.code !== 'F8') return;
      event.preventDefault();
      if (!clips.enabled) {
        clips.toast(clipsSupported() ? 'clips are off: turn them on in settings' : 'this browser cannot record video');
        return;
      }
      clips
        .save()
        .then((seconds) => clips.toast(seconds > 0 ? `clip saved: ${Math.round(seconds)} s` : 'nothing to save yet'))
        .catch((err) => clips.toast(`could not save the clip: ${err?.message ?? err}`));
    });
  }
  /** A hit taken rolls the view, signed, decaying to nothing. */
  let flinch = 0;
  hud.bindSensitivity(input);
  hud.bindRawMouse(input);
  hud.bindVolume(audio.volume, (value) => audio.setVolume(value));
  // From the link, not the local player: the welcome is queued for the
  // frame loop, so `local` has not seen it yet at this point.
  hud.bindName(link.assignedName || storedName(), (value) => {
    try {
      window.localStorage.setItem(NAME_KEY, value);
    } catch {
      /* private browsing */
    }
  });
  // Joining a line does not take the mouse. A player who has queued is still
  // in the lobby, possibly for two minutes, and may want to leave the line or
  // read the other tables. The pointer is taken when they click the world,
  // which is what the "click to capture the mouse" hint is for and is how
  // every other first person game does it.
  hud.setLocalPlayer(link.playerId);

  // The menu is the screen before the game rather than a panel over it:
  // until a match starts there is no world, and picking a table is what
  // decides which world there will be.
  menu.setOffer(link.maps, link.tiers);
  menu.bindPlay(
    (mapName, dollars) => {
      // The click on a table is a real gesture, so it is also where the
      // sound can be started: the match-found chime has to be heard by
      // somebody who has not clicked the world yet.
      audio.resume();
      local.queue(mapName, dollars);
      // The map's files, into the cache while the line forms.
      prefetchMap(mapName);
    },
    () => local.leaveQueue(),
  );
  const matchmaking = new Matchmaking(document.getElementById('matchmaking'), {
    onLeave: () => local.leaveQueue(),
  });
  /** The whole second the warm-up was on last frame, for its ticks. */
  let warmupSecond = null;
  // A withdrawal is a request like any other: an amount and an address, and
  // the server decides whether it goes, at what rate and for how much SOL.
  menu.bindWallet((micros, destination) =>
    link.send({ t: 'withdraw', amount_micro_usd: micros, destination }),
  );
  menu.bindAccount({
    key: readAccountKey,
    // Signing in as somebody else is a fresh start: a new connection that
    // presents the other key, which is exactly what a reload does.
    restore(key) {
      writeAccountKey(key);
      window.location.reload();
    },
  });
  // Signing in with a Solana wallet: text from the server, signed by the
  // wallet, checked by the server. A wallet that is another account's makes
  // this browser that account, with a key of its own - the same fresh start
  // as restoring a key.
  menu.bindSolana({
    challenge: () => link.send({ t: 'wallet_challenge' }),
    prove: (publicKey, signature) =>
      link.send({ t: 'wallet_proof', public_key: publicKey, signature }),
    switchTo(key) {
      writeAccountKey(key);
      window.location.reload();
    },
  });
  menu.setPlayer(link.playerId, link.inviteCode);
  menu.setWallet(link.wallet);
  menu.setSolana(link.solanaPubkey);
  if (link.accountReplaced) {
    menu.say(
      'the account key this browser had was not recognised, so this is a new account',
      true,
    );
  }
  menu.show(true);

  /**
   * Put this client into the match the server has just started for it.
   *
   * The map arrives with the match, so this is where the ground is chosen,
   * loaded and pointed at. `selectMap` first, because everything the world
   * reads afterwards - the scale it draws at, the far plane, the spawns -
   * comes out of whichever map the simulation is pointed at.
   */
  let entering = null;
  async function enterMatch(mapName) {
    if (!selectMap(mapName)) {
      link.dropLink(`this build has no map called "${mapName}". Reload the page.`, 0);
      return;
    }
    menu.show(false);
    say(`loading ${mapName}…`);
    document.body.classList.remove('running');
    await world.load(mapName);

    // The far plane is set from the map rather than left at a constant, and
    // kept as tight as the map allows. Depth precision is spent between near
    // and far, and ambient occlusion reads the depth buffer: at a far plane
    // of 500 there is not enough left to tell a crease from noise. The
    // diagonal plus a margin is the longest thing anyone can see.
    camera.far = Math.hypot(SIM.arenaHalfX, SIM.arenaHalfZ) * 2.2;
    camera.updateProjectionMatrix();

    document.body.classList.add('running');
  }

  // Browsers will not start an audio device except from a real gesture, so it
  // is started by the same click that captures the mouse. A player who has not
  // clicked has not started playing.
  canvas.addEventListener('mousedown', () => audio.resume());

  // A handle on the client's own state, for the browser console and for the
  // automated smoke test. Deliberately behind a flag: none of it lets anyone
  // cheat, since the server decides everything that matters, but a shipped
  // build has no reason to hand a scraper a tidy API onto the world.
  if (options.has('debug')) {
    window.solatel = {
      THREE, link, local, input, world, remotes, viewmodel, scene, camera, SIM,
      renderer, audio, hud, impacts, death, clips,
      get composer() {
        return composer;
      },
      /** The graphics level in force, and a way to set one - for perf.mjs. */
      get quality() {
        return quality.level;
      },
      setQuality(choice) {
        quality.choose(choice);
      },
      /** The current map's collision boxes, for scripts that need to know
       *  what is solid - a camera placed for a screenshot, say. */
      get brushes() {
        return BRUSHES;
      },
      /** The current map's spawns, x, y, z and yaw in fours - for tour.mjs. */
      get spawns() {
        return SPAWNS;
      },
      /** Every file fetched ahead for a map - for menu.mjs to check against
       *  what loading it then asked for. */
      prefetched(name) {
        return [...(prefetchMap(name)?.files.keys() ?? [])];
      },
      setComposer(on) {
        composer = on ? builtComposer : null;
      },
      setAo(on) {
        if (aoPass) aoPass.enabled = on;
      },
      stats() {
        const info = renderer.info;
        return {
          fps: hud.fps,
          drawCalls: info.render.calls,
          triangles: info.render.triangles,
          programs: info.programs ? info.programs.length : null,
          geometries: info.memory.geometries,
          textures: info.memory.textures,
          updateMs: cpu.update,
          drawMs: cpu.draw,
          players: remotes.players.size,
        };
      },
    };
  }

  /**
   * The post-processing chain, built once and switched by the quality
   * setting (quality.js) rather than rebuilt.
   *
   * Ambient occlusion is the best-looking thing in it, and measured on an
   * Intel Iris Xe the difference between 60 fps and 23 - so only ultra has
   * it, and nothing picks ultra for a player. A smooth 60 beats a prettier
   * 23 every time in a shooter. `perf.mjs` measures every level.
   */
  const post = buildPost(renderer, scene, camera);
  const builtComposer = post?.composer ?? null;
  const aoPass = post?.aoPass ?? null;
  const bloomPass = post?.bloomPass ?? null;
  let composer = builtComposer;
  // `?ao` turns ambient occlusion on at any level, for measuring it.
  const forceAo = options.has('ao');

  const resize = () => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const aspect = width / height;
    renderer.setSize(width, height, false);
    if (composer) composer.setSize(width, height);
    camera.aspect = aspect;
    camera.fov = verticalFov(horizontalFov, aspect);
    camera.updateProjectionMatrix();
    // The weapon shares the view's angle, so it sits in the same perspective
    // as the world rather than in one of its own.
    viewmodel.setView(aspect, camera.fov);
  };
  window.addEventListener('resize', resize);
  resize();

  // The old box for ambient occlusion becomes the level that has it.
  try {
    if (window.localStorage.getItem(AO_KEY) === '1' && !window.localStorage.getItem('solatel.quality')) {
      window.localStorage.setItem('solatel.quality', 'ultra');
    }
    window.localStorage.removeItem(AO_KEY);
  } catch {
    /* private browsing */
  }
  const quality = new Quality(
    renderer,
    (level, preset) => {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, preset.ratio) * preset.scale);
      builtComposer?.setPixelRatio(renderer.getPixelRatio());
      composer = preset.post ? builtComposer : null;
      if (bloomPass) bloomPass.enabled = preset.bloom;
      if (aoPass) aoPass.enabled = preset.ao || forceAo;
      world.setShadowSize(preset.shadows);
      setNatureDetail({ grass: preset.grass, sky: preset.sky });
      resize();
    },
    { forced: options.get('quality') },
  );
  hud.bindQuality(quality.choice, (choice) => quality.choose(choice));
  quality.onChange = () => hud.setQualityNote(quality.describe());
  quality.onChange();

  hud.bindFov(horizontalFov, (value) => {
    horizontalFov = value;
    try {
      window.localStorage.setItem(FOV_KEY, String(value));
    } catch {
      /* private browsing */
    }
    resize();
  });

  say('');
  // The boot screen goes and the menu takes over. `running` is what uncovers
  // the canvas, and it is not set until a match has a map in it - there is
  // nothing to show before then.
  document.getElementById('boot').classList.add('hidden');

  /** The match this client has already loaded a map for. */
  let enteredMatch = null;
  const eye = new THREE.Vector3();
  // The baked light where the eye is, for the rifle in the player's hands.
  const here = { sky: 1, sun: 1 };
  // Where the player is and which way they are facing, for panning sound.
  // Read while handling messages, so they are a frame old - which is sixteen
  // milliseconds of listener movement, and inaudible.
  const forward = new THREE.Vector3(0, 0, -1);
  const tickDt = SIM.tickDt;
  let accumulator = 0;
  let previous = performance.now();

  /** Main-thread milliseconds a drawn frame spends before drawing (the
   *  network, the simulation, everybody's animation) and on drawing (three's
   *  own work handing the scene to the GPU), smoothed - for perf.mjs, which
   *  reads them to tell a frame the CPU is holding up from one the GPU is. */
  const cpu = { update: 0, draw: 0 };

  function frame(now) {
    requestAnimationFrame(frame);
    const frameStart = performance.now();

    const dt = Math.min((now - previous) / 1000, 0.25);
    previous = now;

    // 1. Network first, so this frame acts on the freshest world available.
    link.pump(now);
    for (const message of link.drain()) {
      local.handle(message, dt);
      if (message.t === 'snapshot') {
        // A straggler from a match this player has left is nothing to draw.
        if (message.match_id === local.matchId) remotes.record(message, now);
      } else if (message.t === 'shot_fired') {
        // Somebody else's tracer leaves the rifle as it is drawn; see
        // `muzzleOf`. Within a couple of metres of the server's `from`, or
        // something is wrong with the drawing and the server's is used.
        const muzzle = message.shooter === local.id ? null : remotes.muzzleOf(message.shooter, _muzzle);
        const from =
          muzzle && muzzle.distanceTo(_from.fromArray(message.from)) < 2.5
            ? [muzzle.x, muzzle.y, muzzle.z]
            : message.from;
        world.addTracer(from, message.to, message.hit_player);
        // Where it landed, as the server says: dust off a wall, a mist off
        // a player. Drawn for every shot, the player's own included, from
        // the server's account rather than this client's prediction.
        impacts.strike(message.from, message.to, message.hit_player, camera.position);
        const mine = message.shooter === local.id;
        // This player's own shot was already kicked, flashed and heard when
        // they fired it - see the predicted shots below. Doing it again here
        // would be every shot twice, the second a round trip late. Everyone
        // else's is wherever the server says it was, which is what gives a
        // shot a direction and a distance. The round landing is a second
        // sound from a second place - often the more useful one, because it
        // is where the shooter was aiming.
        if (!mine) {
          audio.shot(message.from, eye, forward);
          remotes.onShot(message.shooter);
        }
        if (!message.hit_player) audio.impact(message.to, eye, forward);
        if (mine && message.hit_player) audio.hitConfirmed(false);
      } else if (message.t === 'damaged') {
        audio.hurt();
        // Which way it came from, held on screen as the player turns, and a
        // flinch: the view rolls a little and comes back. A roll only - the
        // middle of the screen, where a shot goes, stays where it was aimed.
        hud.damageFrom(now, remotes.positionOf(message.attacker), message.amount);
        flinch = (Math.random() < 0.5 ? -1 : 1) * Math.min(1, Math.abs(flinch) + message.amount / 40);
      } else if (message.t === 'hit_confirmed') {
        // The server's own confirmation, which is the one that counts. The
        // tracer's `hit_player` is drawn the instant the shot goes out; this
        // arrives with the damage and the part of the body it landed on.
        audio.hitConfirmed(message.killed);
      } else if (
        message.t === 'deposited' ||
        message.t === 'withdrawal' ||
        message.t === 'withdrawal_refused'
      ) {
        menu.walletEvent(message);
      } else if (message.t === 'welcome') {
        // A reconnection. The server may have restarted with a different
        // wallet, and a new account may have been made.
        menu.setPlayer(link.playerId, link.inviteCode);
        menu.setWallet(link.wallet);
        menu.setSolana(link.solanaPubkey);
      } else if (message.t === 'wallet_challenge') {
        menu.walletChallenge(message.message);
      } else if (message.t === 'wallet_signed_in') {
        menu.walletSignedIn(message);
      } else if (message.t === 'wallet_refused') {
        menu.walletRefused(message.reason);
      } else if (message.t === 'scoreboard') {
        hud.setScores(message.entries);
      } else if (message.t === 'match_found') {
        audio.matchFound();
      } else if (message.t === 'exploded') {
        world.explode(message.at);
        audio.boom(message.at, eye, forward);
        // Felt as well as heard and seen: the view rolls with it and the
        // rifle jolts, harder the nearer it went off. A roll only, like a
        // hit's flinch, so the middle of the screen stays where it was aimed.
        const near = Math.hypot(message.at[0] - eye.x, message.at[1] - eye.y, message.at[2] - eye.z);
        const shove = Math.max(0, 1 - near / 18);
        if (shove > 0) {
          flinch = (Math.random() < 0.5 ? -1 : 1) * Math.min(1, Math.abs(flinch) + shove * 0.9);
          viewmodel.onLanded(shove * 7);
        }
      } else if (message.t === 'killed') {
        hud.addKill(message);
        // This player's own death: kept, with where the killer was as last
        // drawn, for the few seconds of it that are played out.
        if (message.victim === local.id) death.noteKilled(message, remotes.positionOf(message.killer));
        if (message.killer === local.id) {
          // A kill is the only thing in this game that pays, so it gets the
          // only sound that means money and the reward on screen. The hit
          // confirmation stays under it: one says "you connected", the
          // other says "you got paid", and they are different pieces of
          // information. The reward is the one the server stated for this
          // table when the match started.
          const streak = hud.payout(message, local.tier?.kill_reward_micro_usd, {
            onLand: () => audio.landed(),
          });
          audio.paid(streak);
        }
      }
    }

    // 2. Aim, before the ticks that will carry it.
    input.checkForSilence(now);
    input.updateLook();

    // 3. Fixed-rate simulation.
    accumulator += dt;
    let ticks = 0;
    while (accumulator >= tickDt && ticks < MAX_TICKS_PER_FRAME) {
      local.fixedStep(tickDt);
      accumulator -= tickDt;
      ticks += 1;
    }
    // Behind by more than the server will wait for: the time is let go.
    // Short of that it is made up over the next few frames, so a long frame
    // costs nothing - the server has been guessing in the meantime and
    // re-runs the commands when they come - where letting it go left this
    // player's commands behind the server's clock for good.
    if (accumulator > tickDt * CATCH_UP_TICKS) accumulator = 0;

    // This player's own shots, the moment they leave the weapon.
    for (let shots = local.takePredictedShots(); shots > 0; shots -= 1) {
      viewmodel.onShotFired();
      audio.shot(Audio.OWN, eye, forward);
    }
    if (local.takeReloadStart()) audio.reload(SIM.reloadSeconds);
    if (local.takeThrow()) viewmodel.onThrow();

    // 4. Render state, interpolated between the last two ticks.
    const alpha = Math.min(1, accumulator / tickDt);
    local.eyePosition(alpha, eye, dt);
    camera.position.copy(eye);
    // Recoil rolls the view around its own axis and nothing else, so the
    // middle of the screen - where the shot goes - stays where it was aimed.
    flinch *= Math.exp(-dt * 9);
    camera.rotation.set(input.pitch, input.yaw, viewmodel.cameraRoll + flinch * 0.045, 'YXZ');
    camera.getWorldDirection(forward);

    // A debug-only detached camera, for looking at things that are otherwise
    // only ever seen from someone else's eyes - a character's animation, or
    // whether the weapon really is in its hand. It moves the view and nothing
    // else: the player stays where the server put them.
    const override = window.solatel?.cameraOverride;
    if (override) {
      camera.position.set(override.x, override.y, override.z);
      camera.lookAt(override.tx, override.ty, override.tz);
    }

    const landing = local.takeLanding();
    if (landing > 0) {
      audio.land(landing);
      viewmodel.onLanded(landing);
    }

    // A match has started for this client. The map arrives with it, and
    // loading it is asynchronous - so the frame loop keeps running over an
    // empty scene until it is in.
    if (local.matchId && local.matchId !== enteredMatch && !entering && !link.parked) {
      enteredMatch = local.matchId;
      // Loading a map compiles shaders for seconds; none of that is a
      // judgement on the machine.
      quality.reset(now);
      entering = enterMatch(local.mapName).finally(() => {
        entering = null;
      });
    }
    // Face the way this player's spawn does, once a snapshot has said which
    // spawn that is: they are dealt out afresh every match, and each faces
    // into the map. Before this the view was turned to the table's first
    // spawn, which on a shuffled table is somebody else's, so a player
    // could start the match looking at a wall. Only the view turns; the
    // server hears it in the next command, as it would a turn of the mouse.
    if (local.faceSpawn && local.seenSnapshot && local.matchId === enteredMatch) {
      local.faceSpawn = false;
      const yaw = spawnFacing(local.serverPosition);
      if (yaw !== null) {
        input.yaw = yaw;
        input.pitch = 0;
      }
    }
    // A life that has just ended is played out before the menu: see death.js.
    let dying = death.playing ? death.frame(now, deathPose) : null;
    if (!dying && wasDying) {
      wasDying = false;
      audio.recover();
    }
    if ((!local.matchId || link.parked) && enteredMatch && !dying) {
      if (link.parked) {
        death.end();
      } else if (
        local.eliminated &&
        death.begin(now, eye, input.yaw, input.pitch, {
          stake: local.tier?.entry_fee_micro_usd ?? 0,
          winnings: local.winningsMicroUsd ?? 0,
          eyeHeight: SIM.halfExtentY + (local.eyeOffset ?? SIM.eyeOffset),
        })
      ) {
        wasDying = true;
        audio.dying();
        dying = death.frame(now, deathPose);
      }
    }
    if ((!local.matchId || link.parked) && enteredMatch && !dying) {
      // Out of it: killed, or the whistle went, or another tab has taken
      // this player. Back to the menu, and the world stops being drawn
      // rather than being left standing behind it.
      enteredMatch = null;
      menu.show(true);
      document.body.classList.remove('running');
      // Give the mouse back. A player reading a menu wants a cursor, and
      // taking the pointer to a screen full of buttons is how the lobby felt
      // broken before it was a screen at all.
      if (document.pointerLockElement) document.exitPointerLock();
    }

    const playing = Boolean(local.matchId) && world.ready && !link.parked;

    // Searching, found, loading: the screens between a click on a table and
    // standing on the map.
    const table = (local.tables ?? []).find((t) => {
      const map = local.queuedMap ?? local.queueRequested?.map;
      const dollars = local.queuedFor ?? local.queueRequested?.dollars;
      return t.map === map && t.dollars === dollars;
    });
    const tierOf = (dollars) => (link.tiers ?? []).find((t) => t.dollars === dollars);
    let view = { phase: null };
    /** How far the map's files have come; starts the download if it had not. */
    const fetching = (name) => prefetchMap(name)?.progress() ?? null;
    if (!link.parked) {
      if (local.searching) {
        const dollars = local.queuedFor ?? local.queueRequested?.dollars;
        const mapName = local.queuedMap ?? local.queueRequested?.map;
        const tier = tierOf(dollars);
        view = {
          phase: 'searching',
          map: mapName,
          dollars,
          confirmed: local.queuedFor !== null && local.queuedFor !== undefined,
          elapsedMs: local.queuedAt === null ? 0 : performance.now() - local.queuedAt,
          waiting: table?.waiting ?? 0,
          needed: table?.needed ?? 0,
          seats: table?.seats ?? (link.maps ?? []).find((m) => m.name === mapName)?.seats ?? 0,
          formingInMs: local.formingInMs,
          place: local.place,
          entry: tier ? formatDollars(tier.entry_fee_micro_usd) : null,
          reward: tier ? formatDollars(tier.kill_reward_micro_usd) : null,
          download: fetching(mapName),
        };
      } else if (local.found && !local.matchId) {
        const tier = local.found.tier;
        view = {
          phase: 'found',
          foundKey: local.found.matchId,
          map: local.found.map,
          dollars: tier?.dollars,
          players: local.found.players,
          entry: tier ? formatDollars(tier.entry_fee_micro_usd) : null,
          download: fetching(local.found.map),
        };
      } else if (local.matchId && !playing) {
        view = {
          phase: 'loading',
          map: local.mapName,
          dollars: local.tier?.dollars,
          players: local.matchPlayers,
          download: fetching(local.mapName),
        };
      }
      view.inMatch = Boolean(local.matchId);
    }
    matchmaking.update(view);

    // The last seconds of the warm-up tick, and the start is heard.
    const second = local.warmingUp ? Math.ceil(local.startsInMs / 1000) : null;
    if (second !== warmupSecond) {
      if (second !== null && second <= 3 && second >= 1) audio.countdown();
      if (second === null && warmupSecond !== null && local.inMatch) audio.go();
      warmupSecond = second;
    }
    // No sights while the rifle is on its side for a reload.
    viewmodel.setAiming(playing && input.aiming && local.health > 0 && local.reloadMs === 0);
    viewmodel.setReload(
      local.reloadMs > 0 ? 1 - local.reloadMs / (SIM.reloadSeconds * 1000) : null,
    );
    viewmodel.setEyeOffset(local.eyeOffset ?? SIM.eyeOffset);
    if (dying) {
      // The world held and slowed, seen from the floor. Nothing here is
      // predicted or sent: the match is over for this player.
      const slow = dt * DEATH_TIME_SCALE;
      world.update(slow);
      impacts.update(slow);
      world.followWithShadows(dying.position);
      world.positionSky(dying.position, camera.far);
      remotes.update(now, slow, local.id, dying.position, camera);
      camera.position.copy(dying.position);
      camera.rotation.set(dying.pitch, dying.yaw, dying.roll, 'YXZ');
      const fov = verticalFov(horizontalFov, camera.aspect, 1);
      if (Math.abs(fov - camera.fov) > 1e-4) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }
      renderer.info.reset();
      renderer.clear();
      if (composer) composer.render();
      else renderer.render(scene, camera);
      clips.capture(renderer.domElement, now);
      return;
    }
    if (!playing) {
      menu.update(local, link);
      renderer.clear();
      return;
    }

    local.tickTimers(dt);
    world.update(dt);
    impacts.update(dt);
    // A debug camera (`cameraOverride`) takes the shadows and the sky with
    // it, so a picture taken from it shows what a player standing there sees.
    const viewer = window.solatel?.cameraOverride ? camera.position : eye;
    world.followWithShadows(viewer);
    world.positionSky(viewer, camera.far);
    world.setZone(local.zoneRadius);
    world.setGrenades(local.matchId ? local.liveGrenades : []);
    remotes.update(now, dt, local.id, camera.position, camera);
    for (const at of remotes.takeReloads()) audio.reloadAt(at, eye, forward, SIM.reloadSeconds);
    viewmodel.update(dt, input.yaw, input.pitch, local.speed, local.onGround, eye);
    lightHere(eye, here);
    viewmodel.setLight(dt, here.sky, here.sun);
    hud.update(now, link, local, input);
    hud.updateDamage(now, eye, input.yaw);

    // The sights narrow the world's view, and turning slows by the same
    // factor so a flick covers the same part of the screen either way. The
    // weapon's own camera narrows by its own factor, to enlarge the sights.
    // Compared against the camera itself, so a resize or the FOV slider
    // moving with the sights up is caught the same way.
    const zoom = viewmodel.zoom;
    const fov = verticalFov(horizontalFov, camera.aspect, zoom);
    if (Math.abs(fov - camera.fov) > 1e-4) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    input.lookScale = zoom;
    const weaponFov = verticalFov(horizontalFov, camera.aspect, viewmodel.weaponZoom);
    if (Math.abs(weaponFov - viewmodel.camera.fov) > 1e-4) {
      viewmodel.setView(camera.aspect, weaponFov);
    }
    hud.setCrosshairOpacity(viewmodel.crosshairOpacity);

    // Counters cover the whole frame, not the last pass of it. Three.js
    // clears `info.render` at the top of every `render` call, so with the
    // default the weapon - drawn last, three meshes of it - was the only thing
    // ever counted, and a map of a thousand meshes reported three draw calls.
    // A diagnostic that cannot see the expensive half of the frame is worse
    // than none, because it is believed.
    const drawStart = performance.now();
    renderer.info.reset();
    renderer.clear();
    if (composer) composer.render();
    else renderer.render(scene, camera);
    // The weapon is drawn last over a cleared depth buffer, which is what
    // stops a wall the player is standing against cutting through it. It is
    // outside the composer deliberately: a weapon held at arm's length has no
    // creases at world scale for ambient occlusion to find, and running it
    // through the pass only costs frames.
    renderer.clearDepth();
    renderer.render(viewmodel.scene, viewmodel.camera);
    // While the canvas still holds the frame.
    clips.capture(renderer.domElement, now);
    const frameEnd = performance.now();
    cpu.update += (drawStart - frameStart - cpu.update) * 0.1;
    cpu.draw += (frameEnd - drawStart - cpu.draw) * 0.1;

    // Only frames of a match being drawn say anything about the machine.
    quality.sample(now, dt * 1000);
  }

  renderer.autoClear = false;
  renderer.info.autoReset = false;
  requestAnimationFrame(frame);
}

boot().catch((err) => {
  console.error(err);
  const status = document.getElementById('boot-status');
  if (status) {
    status.className = 'error';
    status.textContent = `failed to start: ${err?.message ?? err}`;
  }
});

/** Micro-USD as dollars and cents, for the matchmaking screens. */
function formatDollars(micros) {
  const cents = Math.round(micros / 10000);
  return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}
