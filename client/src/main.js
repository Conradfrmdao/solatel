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
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { Hud } from './hud.js';
import { Input } from './input.js';
import { Audio } from './audio.js';
import { Link, readAccountKey, writeAccountKey } from './net.js';
import { LocalPlayer } from './localplayer.js';
import { Remotes } from './remotes.js';
import { SIM, SPAWNS, loadSim, selectMap } from './sim.js';
import { Menu } from './menu.js';
import { Viewmodel } from './viewmodel.js';
import { World } from './world.js';

const CLIENT_BUILD = 'solatel-client-three/0.1.0';

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

/** Vertical angle three.js wants, from the horizontal one a player picks. */
function verticalFov(horizontal, aspect) {
  const half = (horizontal * Math.PI) / 360;
  return (2 * Math.atan(Math.tan(half) / aspect) * 180) / Math.PI;
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
 * A backgrounded tab stops rendering, and when it comes back the elapsed time
 * would otherwise be replayed as hundreds of ticks in one frame - a spike that
 * freezes the page and sends a burst of input the server will refuse anyway,
 * since it consumes exactly one command per tick. Dropping the backlog is the
 * honest response: that time was not played.
 */
const MAX_TICKS_PER_FRAME = 5;

async function boot() {
  const canvas = document.getElementById('solatel-canvas');
  const hudRoot = document.getElementById('hud');
  const status = document.getElementById('boot-status');

  const say = (text) => {
    if (status) status.textContent = text;
  };

  say('loading simulation…');
  await loadSim('sim/solatel_sim_bg.wasm');

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Capped at 2, not the raw ratio. A 4K display would otherwise ask the GPU
  // for four times the pixels for a difference nobody is looking for during a
  // firefight.
  // Filmic tonemapping is most of the difference between "flat coloured
  // shapes" and "a lit place". Without it, bright surfaces clip to their raw
  // material colour and the whole scene reads as a diagram.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

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

  const world = new World(scene);
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
  const link = new Link(CLIENT_BUILD, storedName());
  await link.firstWelcome;

  say('loading the weapon…');
  const rifle = await viewmodel.load('assets/weapons/rifle.glb');
  say('loading the soldier…');
  // The same rifle, handed on rather than fetched again.
  await remotes.load('assets/characters/soldier.glb', rifle);

  const local = new LocalPlayer(link, input);
  // The menu is built before the HUD, because the settings controls live in
  // the menu's markup and the HUD is what wires them up. A HUD constructed
  // first would look for sliders that did not exist yet.
  const menu = new Menu(document.getElementById('menu'));
  const hud = new Hud(hudRoot);
  const audio = new Audio();
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
    (mapName, dollars) => local.queue(mapName, dollars),
    () => local.leaveQueue(),
  );
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
  menu.setPlayer(link.playerId);
  menu.setWallet(link.wallet);
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
    await world.load(`assets/maps/${mapName}.glb`);

    // The far plane is set from the map rather than left at a constant, and
    // kept as tight as the map allows. Depth precision is spent between near
    // and far, and ambient occlusion reads the depth buffer: at a far plane
    // of 500 there is not enough left to tell a crease from noise. The
    // diagonal plus a margin is the longest thing anyone can see.
    camera.far = Math.hypot(SIM.arenaHalfX, SIM.arenaHalfZ) * 2.2;
    camera.updateProjectionMatrix();

    // Start looking the way a spawn faces, so the opening frame is open
    // ground rather than a wall. Only the camera: where the player actually
    // is is the server's answer, and it arrives a moment later.
    if (SPAWNS.length >= 4) input.yaw = SPAWNS[3];
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
      link, local, input, world, remotes, viewmodel, scene, camera, SIM,
      renderer, audio, hud,
      get composer() {
        return composer;
      },
      setComposer(on) {
        composer = on ? builtComposer : null;
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
        };
      },
    };
  }

  /**
   * Ambient occlusion - built, but off unless asked for.
   *
   * It is the best-looking thing available here: this arena is flat-shaded and
   * untextured, so darkening the creases where surfaces meet is most of what
   * turns a pile of coloured shapes into a pile of objects.
   *
   * It is also, measured on an Intel Iris Xe, the difference between 60 fps and
   * 23. That is not a trade worth making by default in a shooter - a smooth 60
   * beats a prettier 23 every time, and the player who wants it can say so.
   * `perf.mjs` is what produced those numbers and will produce them again.
   */
  let builtComposer = null;
  let composer = null;
  try {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const ao = new GTAOPass(scene, camera, window.innerWidth, window.innerHeight);
    ao.output = window.location.search.includes('aoonly')
      ? GTAOPass.OUTPUT.Denoise
      : GTAOPass.OUTPUT.Default;
    // The radius is in world metres, and the arena is built at 4x: crates are
    // two metres on a side and doorways three. A radius tuned for a one-metre
    // scene finds nothing here, which is exactly what the first attempt did.
    ao.updateGtaoMaterial({
      radius: 2.0,
      distanceExponent: 1.0,
      thickness: 1.0,
      scale: 1.0,
      samples: 16,
    });
    ao.blendIntensity = 1.0;
    composer.addPass(ao);
    // Tonemapping and colour space are applied once, at the end, rather than
    // by the renderer - a composer bypasses the renderer's own output stage.
    composer.addPass(new OutputPass());
    builtComposer = composer;
  } catch (err) {
    console.warn('ambient occlusion unavailable:', err);
    builtComposer = null;
  }
  // Off unless the player turns it on, or the URL asks for it.
  // Off unless the player turns it on, or the URL asks for it.
  let wantAo = options.has('ao');
  try {
    if (window.localStorage.getItem(AO_KEY) === '1') wantAo = true;
  } catch {
    /* private browsing */
  }
  composer = wantAo ? builtComposer : null;

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

  hud.bindQuality(Boolean(composer), (on) => {
    composer = on ? builtComposer : null;
    try {
      window.localStorage.setItem(AO_KEY, on ? '1' : '0');
    } catch {
      /* private browsing */
    }
  });

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
  // Where the player is and which way they are facing, for panning sound.
  // Read while handling messages, so they are a frame old - which is sixteen
  // milliseconds of listener movement, and inaudible.
  const forward = new THREE.Vector3(0, 0, -1);
  const tickDt = SIM.tickDt;
  let accumulator = 0;
  let previous = performance.now();

  function frame(now) {
    requestAnimationFrame(frame);

    const dt = Math.min((now - previous) / 1000, 0.25);
    previous = now;

    // 1. Network first, so this frame acts on the freshest world available.
    link.pump(now);
    for (const message of link.drain()) {
      local.handle(message, dt);
      if (message.t === 'snapshot') {
        remotes.record(message, now);
      } else if (message.t === 'shot_fired') {
        world.addTracer(message.from, message.to, message.hit_player);
        const mine = message.shooter === local.id;
        if (mine) viewmodel.onShotFired();
        // The player's own weapon is at their shoulder; everyone else's is
        // wherever the server says it was, which is what gives a shot a
        // direction and a distance. The round landing is a second sound from
        // a second place - often the more useful one, because it is where the
        // shooter was aiming.
        audio.shot(mine ? Audio.OWN : message.from, eye, forward);
        if (!message.hit_player) audio.impact(message.to, eye, forward);
        if (mine && message.hit_player) audio.hitConfirmed(false);
      } else if (message.t === 'damaged') {
        audio.hurt();
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
        menu.setPlayer(link.playerId);
        menu.setWallet(link.wallet);
      } else if (message.t === 'scoreboard') {
        hud.setScores(message.entries);
      } else if (message.t === 'killed') {
        hud.addKill(message);
        if (message.killer === local.id) {
          // A kill is the only thing in this game that pays, so it gets the
          // only sound that means money. The hit confirmation stays under
          // it: one says "you connected", the other says "you got paid",
          // and they are different pieces of information.
          audio.paid();
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
    if (accumulator > tickDt * MAX_TICKS_PER_FRAME) accumulator = 0;

    // 4. Render state, interpolated between the last two ticks.
    const alpha = Math.min(1, accumulator / tickDt);
    local.eyePosition(alpha, eye, dt);
    camera.position.copy(eye);
    camera.rotation.set(input.pitch, input.yaw, 0, 'YXZ');
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
    if (landing > 0) audio.land(landing);

    // A match has started for this client. The map arrives with it, and
    // loading it is asynchronous - so the frame loop keeps running over an
    // empty scene until it is in.
    if (local.matchId && local.matchId !== enteredMatch && !entering && !link.parked) {
      enteredMatch = local.matchId;
      entering = enterMatch(local.mapName).finally(() => {
        entering = null;
      });
    }
    if ((!local.matchId || link.parked) && enteredMatch) {
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
    if (!playing) {
      menu.update(local, link);
      renderer.clear();
      return;
    }

    local.tickTimers(dt);
    world.update(dt);
    world.followWithShadows(eye);
    world.positionSky(eye, camera.far);
    world.setZone(local.zoneRadius);
    remotes.update(now, dt, local.id);
    viewmodel.update(dt, input.yaw, input.pitch, local.speed, local.onGround);
    hud.update(now, link, local, input);

    // Counters cover the whole frame, not the last pass of it. Three.js
    // clears `info.render` at the top of every `render` call, so with the
    // default the weapon - drawn last, three meshes of it - was the only thing
    // ever counted, and a map of a thousand meshes reported three draw calls.
    // A diagnostic that cannot see the expensive half of the frame is worse
    // than none, because it is believed.
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
