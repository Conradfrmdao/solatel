// Blood: what a round does to a body, seen.
//
// A hit throws a spray out of the far side of whoever it struck and a little
// back out of the near side, and drops that fall and leave spots where they
// land; a death leaves a pool spreading under the body once it is down. All
// of it is drawn from the server's own account - where a round landed, who
// was killed - and none of it decides anything. It is the same at every
// graphics level, and nothing in it is big enough or lasts long enough in
// the air to hide anybody.
//
// The marks lie flat on the floor at the victim's feet: the server's own
// height for where they stood. A mark on a wall would want the wall's exact
// surface, which the client does not have (see `impacts.js`); a floor is
// level and its height is known, so a mark there neither floats nor sinks.
//
// Everything is pooled and reused oldest first, so a long match allocates
// nothing and a massacre costs what one hit does.

import * as THREE from 'three';
import { lightMaterial } from './light.js';

/** Sprites of spray, droplets in the air, spots on the floor, pools. */
const SPRAY = 64;
const DROPS = 192;
const SPOTS = 384;
const POOLS = 32;

/** How long a spot and a pool stay, in seconds, the last few shrinking. */
const SPOT_LIFE = 45;
const POOL_LIFE = 90;
const DRY = 5;

/** How long a pool takes to spread, and how wide it ends, in metres. */
const POOL_SPREAD = 5;
const POOL_SIZE = [1.1, 1.6];

/** Past this nothing is thrown: it would be a few pixels. */
const VISIBLE = 90;

const GRAVITY = 9.8;

/** How far above the floor a mark lies, so it never fights the floor. */
const LIFT = 0.012;

/** A red that reads as blood under the maps' light, not paint. */
const RED = 0x5a0707;

// Scratch.
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _flat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const _spin = new THREE.Quaternion();
const _y = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _hidden = new THREE.Matrix4().makeScale(0, 0, 0);

/** A canvas texture of `draw` on a transparent square. */
function canvasTexture(size, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  draw(g, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** A splash: a blob with a ragged edge and droplets thrown round it. White
 *  on transparent; the material gives it its colour. */
function splat(g, size) {
  const c = size / 2;
  g.fillStyle = '#fff';
  g.beginPath();
  const lobes = 9;
  for (let i = 0; i <= 64; i += 1) {
    const a = (i / 64) * Math.PI * 2;
    const r = size * (0.2 + 0.05 * Math.sin(a * lobes + 1.3) + 0.03 * Math.sin(a * 17));
    g.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
  }
  g.fill();
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 26; i += 1) {
    const a = random() * Math.PI * 2;
    const r = size * (0.26 + random() * 0.2);
    g.beginPath();
    g.arc(c + Math.cos(a) * r, c + Math.sin(a) * r, size * (0.008 + random() * 0.028), 0, Math.PI * 2);
    g.fill();
  }
}

/** A pool: round, a soft rim, its edge pushed out in a few places. */
function pool(g, size) {
  const c = size / 2;
  const gradient = g.createRadialGradient(c, c, size * 0.3, c, c, size * 0.48);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gradient;
  g.beginPath();
  for (let i = 0; i <= 96; i += 1) {
    const a = (i / 96) * Math.PI * 2;
    const r = size * (0.42 + 0.04 * Math.sin(a * 3 + 0.4) + 0.025 * Math.sin(a * 7 + 2));
    g.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
  }
  g.fill();
}

/** A soft round puff, for the spray. */
function puff(g, size) {
  const c = size / 2;
  const gradient = g.createRadialGradient(c, c, 0, c, c, c);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.5, 'rgba(255,255,255,0.6)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gradient;
  g.fillRect(0, 0, size, size);
}

/** A flat mark material: lit by the map like the floor it is on, glossy
 *  while it is wet, and drawn over the floor without fighting it. */
function markMaterial(texture) {
  return lightMaterial(
    new THREE.MeshStandardMaterial({
      color: RED,
      alphaMap: texture,
      transparent: true,
      depthWrite: false,
      roughness: 0.18,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    }),
  );
}

/** An instanced set of flat marks, every slot hidden until it is used. */
function marks(scene, count, material) {
  const geometry = new THREE.PlaneGeometry(1, 1);
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  mesh.receiveShadow = true;
  for (let i = 0; i < count; i += 1) mesh.setMatrixAt(i, _hidden);
  scene.add(mesh);
  return mesh;
}

export class Blood {
  constructor(scene) {
    this.scene = scene;
    const splatTexture = canvasTexture(128, splat);
    const poolTexture = canvasTexture(128, pool);
    const puffTexture = canvasTexture(64, puff);

    this.spray = [];
    const sprayMaterial = new THREE.SpriteMaterial({
      map: puffTexture, color: 0x6e0909, transparent: true, depthWrite: false, opacity: 0,
    });
    for (let i = 0; i < SPRAY; i += 1) {
      const sprite = new THREE.Sprite(sprayMaterial.clone());
      sprite.visible = false;
      sprite.renderOrder = 4;
      scene.add(sprite);
      this.spray.push({ sprite, age: 1, life: 1, velocity: new THREE.Vector3(), from: 0, to: 0, fade: 0 });
    }
    this._nextSpray = 0;

    this.drops = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.011, 5, 4),
      new THREE.MeshBasicMaterial({ color: 0x3a0303 }),
      DROPS,
    );
    this.drops.frustumCulled = false;
    for (let i = 0; i < DROPS; i += 1) this.drops.setMatrixAt(i, _hidden);
    scene.add(this.drops);
    this.dropState = Array.from({ length: DROPS }, () => ({
      live: false, position: new THREE.Vector3(), velocity: new THREE.Vector3(), floor: 0,
    }));
    this._nextDrop = 0;

    this.spots = marks(scene, SPOTS, markMaterial(splatTexture));
    this.spotState = Array.from({ length: SPOTS }, () => ({ live: false, age: 0, x: 0, y: 0, z: 0, size: 0, turn: 0 }));
    this._nextSpot = 0;

    this.pools = marks(scene, POOLS, markMaterial(poolTexture));
    this.poolState = Array.from({ length: POOLS }, () => ({ live: false, age: 0, x: 0, y: 0, z: 0, size: 0, turn: 0, wait: 0 }));
    this._nextPool = 0;
  }

  /**
   * A round into somebody: at `at`, fired from `from` (both `[x, y, z]` off
   * the wire), with the floor they stood on at `floor`. `eye` is the camera,
   * for leaving out what is too far off to see.
   */
  hit(at, from, floor, eye, heavy = false) {
    _p.set(at[0], at[1], at[2]);
    if (eye && _p.distanceTo(eye) > VISIBLE) return;
    _dir.set(at[0] - from[0], at[1] - from[1], at[2] - from[2]);
    const length = _dir.length();
    if (!(length > 0)) return;
    _dir.divideScalar(length);
    const scale = heavy ? 1.5 : 1;

    // Out of the far side, fast and wide; a little back out of the near.
    for (let i = 0; i < 7; i += 1) {
      const out = i < 5;
      const s = this.spray[this._nextSpray];
      this._nextSpray = (this._nextSpray + 1) % SPRAY;
      s.sprite.position.copy(_p).addScaledVector(_dir, out ? 0.12 : -0.08);
      s.velocity.copy(_dir).multiplyScalar((out ? 1.8 + Math.random() * 2.8 : -(0.6 + Math.random())) * scale);
      s.velocity.x += (Math.random() - 0.5) * 1.6;
      s.velocity.y += (Math.random() - 0.3) * 1.4;
      s.velocity.z += (Math.random() - 0.5) * 1.6;
      s.age = 0;
      s.life = 0.28 + Math.random() * 0.3;
      s.from = 0.05 * scale;
      s.to = (out ? 0.32 + Math.random() * 0.25 : 0.18) * scale;
      s.fade = out ? 0.95 : 0.7;
      s.sprite.material.rotation = Math.random() * Math.PI * 2;
      s.sprite.scale.setScalar(s.from);
      s.sprite.material.opacity = s.fade;
      s.sprite.visible = true;
    }

    // Drops that fall and mark the floor where they come down.
    if (floor === null || floor === undefined) return;
    const count = Math.round((10 + Math.random() * 8) * scale);
    for (let i = 0; i < count; i += 1) {
      const d = this.dropState[this._nextDrop];
      this._nextDrop = (this._nextDrop + 1) % DROPS;
      d.live = true;
      d.floor = floor;
      d.position.copy(_p).addScaledVector(_dir, 0.1);
      d.velocity.copy(_dir).multiplyScalar(0.6 + Math.random() * 3.2);
      d.velocity.x += (Math.random() - 0.5) * 2.2;
      d.velocity.y += Math.random() * 1.6;
      d.velocity.z += (Math.random() - 0.5) * 2.2;
    }
    // And one spot straight under them, where most of it ends up.
    this._spot(at[0] + _dir.x * 0.25, floor, at[2] + _dir.z * 0.25, (0.18 + Math.random() * 0.14) * scale);
  }

  /**
   * Somebody killed, lying at `at` (their feet) and gone down towards
   * `fall`: a pool spreads from under their chest once they are down,
   * `delay` seconds from now.
   */
  death(at, fall, delay = 1.1) {
    const p = this.poolState[this._nextPool];
    this._nextPool = (this._nextPool + 1) % POOLS;
    p.live = true;
    p.age = -delay;
    p.x = at.x + fall.x * 0.75;
    p.y = at.y;
    p.z = at.z + fall.z * 0.75;
    p.size = POOL_SIZE[0] + Math.random() * (POOL_SIZE[1] - POOL_SIZE[0]);
    p.turn = Math.random() * Math.PI * 2;
  }

  _spot(x, y, z, size) {
    const index = this._nextSpot;
    this._nextSpot = (index + 1) % SPOTS;
    const s = this.spotState[index];
    s.live = true;
    s.age = 0;
    s.x = x;
    s.y = y;
    s.z = z;
    s.size = size;
    s.turn = Math.random() * Math.PI * 2;
    this._place(this.spots, index, s, size);
  }

  _place(mesh, index, s, size) {
    _spin.setFromAxisAngle(_y, s.turn);
    _q.multiplyQuaternions(_spin, _flat);
    _s.set(size, size, size);
    _p.set(s.x, s.y + LIFT, s.z);
    mesh.setMatrixAt(index, _m.compose(_p, _q, _s));
    mesh.instanceMatrix.needsUpdate = true;
  }

  /** Everything gone: a new match is new ground. */
  clear() {
    for (const s of this.spray) s.sprite.visible = false;
    for (const d of this.dropState) d.live = false;
    for (const s of this.spotState) s.live = false;
    for (const p of this.poolState) p.live = false;
    for (const mesh of [this.drops, this.spots, this.pools]) {
      for (let i = 0; i < mesh.count; i += 1) mesh.setMatrixAt(i, _hidden);
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  update(dt) {
    for (const s of this.spray) {
      if (!s.sprite.visible) continue;
      s.age += dt;
      const t = s.age / s.life;
      if (t >= 1) {
        s.sprite.visible = false;
        continue;
      }
      s.velocity.multiplyScalar(Math.exp(-5 * dt));
      s.velocity.y -= GRAVITY * 0.35 * dt;
      s.sprite.position.addScaledVector(s.velocity, dt);
      s.sprite.scale.setScalar(s.from + (s.to - s.from) * Math.sqrt(t));
      s.sprite.material.opacity = s.fade * (1 - t) * (1 - t);
    }

    let moved = false;
    for (let i = 0; i < DROPS; i += 1) {
      const d = this.dropState[i];
      if (!d.live) continue;
      moved = true;
      d.velocity.y -= GRAVITY * dt;
      d.position.addScaledVector(d.velocity, dt);
      if (d.position.y <= d.floor + LIFT || d.position.y < d.floor - 4) {
        d.live = false;
        this.drops.setMatrixAt(i, _hidden);
        if (d.position.y > d.floor - 1) this._spot(d.position.x, d.floor, d.position.z, 0.04 + Math.random() * 0.09);
        continue;
      }
      this.drops.setMatrixAt(i, _m.makeTranslation(d.position.x, d.position.y, d.position.z));
    }
    if (moved) this.drops.instanceMatrix.needsUpdate = true;

    for (let i = 0; i < SPOTS; i += 1) {
      const s = this.spotState[i];
      if (!s.live) continue;
      s.age += dt;
      if (s.age >= SPOT_LIFE) {
        s.live = false;
        this.spots.setMatrixAt(i, _hidden);
        this.spots.instanceMatrix.needsUpdate = true;
      } else if (s.age > SPOT_LIFE - DRY) {
        this._place(this.spots, i, s, s.size * ((SPOT_LIFE - s.age) / DRY));
      }
    }

    for (let i = 0; i < POOLS; i += 1) {
      const p = this.poolState[i];
      if (!p.live) continue;
      p.age += dt;
      if (p.age < 0) continue;
      if (p.age >= POOL_LIFE) {
        p.live = false;
        this.pools.setMatrixAt(i, _hidden);
        this.pools.instanceMatrix.needsUpdate = true;
        continue;
      }
      // Spreading fast at first and slowing, as a pool does; drying away at
      // the very end.
      const spread = 1 - (1 - Math.min(1, p.age / POOL_SPREAD)) ** 2.4;
      const dry = p.age > POOL_LIFE - DRY ? (POOL_LIFE - p.age) / DRY : 1;
      if (p.age < POOL_SPREAD + dt || dry < 1) this._place(this.pools, i, p, p.size * Math.max(0.05, spread) * dry);
    }
  }
}
