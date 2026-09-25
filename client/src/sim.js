// The shared movement simulation, borrowed from the server.
//
// Everything in this file comes out of `crates/solatel-sim-wasm`, which is the
// same Rust the server runs. That is the whole point of it: the client predicts
// its own movement so the controls feel instant, and prediction only settles if
// both sides step the player identically. Reimplementing the movement in
// JavaScript would have meant two descriptions of how a player moves, drifting
// apart one rounding error at a time - in a game that pays per kill.
//
// The wasm is about fifty kilobytes. The engine it replaced was eighty
// megabytes.

import init, {
  Predictor,
  brushes,
  constants,
  constant_names,
  map_name,
  select_map,
  spawns,
} from '../generated/solatel_sim.js';

/** @type {Record<string, number>} */
export let SIM = {};

/** Collision brushes as [minX, minY, minZ, maxX, maxY, maxZ] per entry. */
export let BRUSHES = [];

/** Spawn points as [x, y, z, yaw] per entry. */
export let SPAWNS = [];

export { Predictor };

/**
 * Loads the simulation and reads the constants out of it.
 *
 * Nothing here is duplicated on the JavaScript side - not the tick rate, not
 * the player's size, not the arena's scale. Every one of them is a number the
 * server also uses, and a second copy is a second thing to get wrong.
 */
export async function loadSim(wasmUrl) {
  await init({ module_or_path: wasmUrl });
  readTables();
  return SIM;
}

/**
 * Points this client at the map its next match is played on.
 *
 * Everything the simulation reports - the brushes, the spawns, the scale the
 * model is drawn at - depends on which map is active, so the tables are read
 * again afterwards. Returns false if this build has never heard of that map,
 * which is a client and server that disagree about the world and should say
 * so loudly rather than quietly predict against the wrong arena.
 *
 * Call it **between matches only**. Several matches run at once on the server
 * and they are not all on the same map, so a client follows whichever it has
 * been put into; but doing this while a match is running would put the
 * player's prediction on different ground from the server's, which is the one
 * disagreement this whole design exists to prevent.
 */
export function selectMap(name) {
  if (!select_map(name)) return false;
  readTables();
  return true;
}

export function activeMap() {
  return map_name();
}

function readTables() {
  const values = constants();
  const names = constant_names();
  const table = {};
  for (let i = 0; i < names.length; i += 1) {
    table[names[i]] = values[i];
  }
  SIM = Object.freeze(table);

  BRUSHES = brushes();
  SPAWNS = spawns();
}

/** Wraps an angle into -PI..PI, matching `sim::wrap_angle`. */
export function wrapAngle(angle) {
  const TAU = Math.PI * 2;
  let wrapped = angle % TAU;
  if (wrapped < 0) wrapped += TAU;
  return wrapped > Math.PI ? wrapped - TAU : wrapped;
}

/**
 * Unit look vector for a yaw/pitch pair.
 *
 * Mirrors `sim::look_direction`, and the convention it encodes: -Z is forward,
 * +Y is up. Three.js uses the same one, which is one fewer thing to convert.
 */
export function lookDirection(yaw, pitch, out) {
  const sy = Math.sin(yaw);
  const cy = Math.cos(yaw);
  const sp = Math.sin(pitch);
  const cp = Math.cos(pitch);
  out.set(-sy * cp, sp, -cy * cp);
  return out;
}

/** Shortest-path interpolation between two angles, for turning players. */
export function lerpAngle(from, to, alpha) {
  return wrapAngle(from + wrapAngle(to - from) * alpha);
}
