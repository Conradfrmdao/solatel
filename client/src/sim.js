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
  optic_ids,
  optic_magnifications,
  round_path,
  select_map,
  spawns,
  weapon_fields,
  weapon_ids,
  weapon_names,
  weapon_optics,
  weapons,
} from '../generated/solatel_sim.js';

/** @type {Record<string, number>} */
export let SIM = {};

/** Collision brushes as [minX, minY, minZ, maxX, maxY, maxZ] per entry. */
export let BRUSHES = [];

/** Spawn points as [x, y, z, yaw] per entry. */
export let SPAWNS = [];

/**
 * Every gun, by its name on the wire: what it is called, how fast it fires,
 * its magazine, reload and draw, how its round flies, its damage by range and
 * the optics it can carry. The table the server enforces, read out of the
 * same Rust, so the client predicts a shot on the tick the server will
 * allow it and the menu states what a gun does rather than a copy of it.
 *
 * @type {Record<string, {
 *   id: string, index: number, name: string, automatic: boolean,
 *   fireTicks: number, magazine: number, reloadSeconds: number, drawSeconds: number,
 *   muzzleVelocity: number, drag: number, zero: number, range: number, zeroAngle: number,
 *   bands: {from: number, head: number, body: number, legs: number}[],
 *   optics: string[],
 * }>}
 */
export let WEAPONS = {};

/** How much each optic magnifies, by its name on the wire. */
export let OPTICS = {};

/** The guns a player may choose; the pistol is everybody's second. */
export const PRIMARIES = ['smg', 'rifle', 'lmg', 'sniper'];

/**
 * A round's flight from `from` (x, y, z) at `velocity` (metres per second), a
 * position per tick for `seconds`, along the flight the server judges. For
 * drawing a tracer and the marks on a scope's reticle; it decides nothing.
 */
export function roundPath(weapon, from, velocity, seconds) {
  const gun = WEAPONS[weapon] ?? WEAPONS.rifle;
  return round_path(gun.index, from[0], from[1], from[2], velocity[0], velocity[1], velocity[2], seconds);
}

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
  readWeapons();
  return SIM;
}

function readWeapons() {
  const fields = weapon_fields();
  const rows = weapons();
  const ids = weapon_ids();
  const names = weapon_names();
  const table = {};
  ids.forEach((id, index) => {
    const row = {};
    fields.forEach((field, column) => {
      row[field] = rows[index * fields.length + column];
    });
    const bands = [];
    for (let b = 0; b < row.bandCount; b += 1) {
      bands.push({
        from: row[`band${b}From`],
        head: row[`band${b}Head`],
        body: row[`band${b}Body`],
        legs: row[`band${b}Legs`],
      });
    }
    table[id] = Object.freeze({
      id,
      index,
      name: names[index],
      automatic: row.automatic > 0.5,
      fireTicks: row.fireTicks,
      magazine: row.magazine,
      reloadSeconds: row.reloadSeconds,
      drawSeconds: row.drawSeconds,
      muzzleVelocity: row.muzzleVelocity,
      drag: row.drag,
      zero: row.zero,
      range: row.range,
      zeroAngle: row.zeroAngle,
      bands: Object.freeze(bands),
      optics: Object.freeze(weapon_optics(index)),
    });
  });
  WEAPONS = Object.freeze(table);
  const optics = {};
  const magnifications = optic_magnifications();
  optic_ids().forEach((id, i) => {
    optics[id] = magnifications[i];
  });
  OPTICS = Object.freeze(optics);
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

/** How near a spawn point a player has to be to be standing on it. They are
 *  tens of metres apart; this is only room for settling onto the floor. */
const SPAWN_REACH = 1.5;

/**
 * Which way the spawn point at `position` faces, or null if there is none
 * within reach - a player taken back mid-match, say.
 *
 * Spawns are dealt out afresh every match (`Map::scatter`), so which one a
 * player was given is told by where the server put them, and each faces the
 * way the map generator chose for it: into the middle, never at a wall.
 */
export function spawnFacing(position) {
  let best = null;
  let nearest = SPAWN_REACH * SPAWN_REACH;
  for (let i = 0; i + 3 < SPAWNS.length; i += 4) {
    const dx = SPAWNS[i] - position.x;
    const dz = SPAWNS[i + 2] - position.z;
    const d = dx * dx + dz * dz;
    if (d < nearest) {
      nearest = d;
      best = SPAWNS[i + 3];
    }
  }
  return best;
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
