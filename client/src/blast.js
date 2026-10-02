// A grenade going off, drawn.
//
// It used to be a ball of light that grew for a fifth of a second and seven
// dark grey lumps that floated up, which from across a yard read as somebody
// lighting a bonfire. What a frag does, in the order the eye takes it in:
//
// - a white flash, and the light of it on everything round;
// - a fireball that rolls out and goes from white to orange to nothing in
//   under half a second;
// - sparks and grit thrown out hard, falling as they go;
// - a ring of dust shoved along the ground, and the shock of it;
// - then smoke, pale and lit by the fire for a moment and grey after, that
//   swells, rises and thins for a few seconds.
//
// All of it is drawn from the server's `Exploded` and nothing else, and none
// of it hides anybody for longer than the flash: the smoke is thin by the
// time it is big. Damage arrives as `Damaged`, separately, as it always did.

import * as THREE from 'three';
import { flashTexture } from './viewmodel.js';
import { lightHere, lightMaterial } from './light.js';
import { BRUSHES } from './sim.js';

/** Seconds from the bang until the last of the smoke has gone. */
const LIFE = 4.2;

/** How many blasts can be in the air at once. Two grenades a life, and the
 *  pool is reused oldest first, so this is plenty. */
const POOL = 4;

const FIRE = 9;
const SMOKE = 16;
const DUST = 12;
const SPARKS = 44;
const CHUNKS = 14;

/** The light of the flash, in three's units for a point light. */
const FLASH_LIGHT = 900;

/** What the fire lights the first of the smoke. */
const WARM = new THREE.Color(1.0, 0.62, 0.32);

function canvasTexture(size, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  draw(canvas.getContext('2d'), size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A lick of flame: a hot middle with a ragged edge, white for the
 *  sprite's colour to tint. */
function flameTexture() {
  return canvasTexture(128, (g, w) => {
    const random = seeded(7);
    for (let i = 0; i < 22; i += 1) {
      const a = random() * Math.PI * 2;
      const d = random() * w * 0.22;
      const x = w / 2 + Math.cos(a) * d;
      const y = w / 2 + Math.sin(a) * d;
      const r = w * (0.12 + random() * 0.2);
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, 'rgba(255,255,255,0.55)');
      grad.addColorStop(0.5, 'rgba(255,255,255,0.22)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, w, w);
    }
  });
}

/** A billow of smoke: lumpy, soft-edged, denser in the middle. */
function smokeTexture() {
  return canvasTexture(128, (g, w) => {
    const random = seeded(23);
    for (let i = 0; i < 30; i += 1) {
      const a = random() * Math.PI * 2;
      const d = Math.sqrt(random()) * w * 0.26;
      const x = w / 2 + Math.cos(a) * d;
      const y = w / 2 + Math.sin(a) * d;
      const r = w * (0.1 + random() * 0.16);
      const shade = 200 + Math.floor(random() * 55);
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, `rgba(${shade},${shade},${shade},0.32)`);
      grad.addColorStop(1, `rgba(${shade},${shade},${shade},0)`);
      g.fillStyle = grad;
      g.fillRect(0, 0, w, w);
    }
  });
}

/** A ring for the shock along the ground: bright at its edge, clear inside. */
function ringTexture() {
  return canvasTexture(128, (g, w) => {
    const grad = g.createRadialGradient(w / 2, w / 2, w * 0.3, w / 2, w / 2, w / 2);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.75, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, w);
  });
}

/** The top of whatever is under `at`, within a few metres, or null. The
 *  brushes are six floats each, minimum corner then maximum. */
function floorUnder(at) {
  let best = null;
  for (let i = 0; i + 5 < BRUSHES.length; i += 6) {
    if (at.x < BRUSHES[i] || at.x > BRUSHES[i + 3] || at.z < BRUSHES[i + 2] || at.z > BRUSHES[i + 5]) continue;
    const top = BRUSHES[i + 4];
    if (top > at.y + 0.3 || top < at.y - 3) continue;
    if (best === null || top > best) best = top;
  }
  return best;
}

function sprite(map, blending) {
  const material = new THREE.SpriteMaterial({
    map,
    blending,
    transparent: true,
    depthWrite: false,
    opacity: 0,
  });
  const s = new THREE.Sprite(material);
  s.visible = false;
  return s;
}

class Blast {
  constructor(scene, textures) {
    this.group = new THREE.Group();
    this.group.visible = false;
    this.age = LIFE;
    scene.add(this.group);

    this.flash = sprite(textures.flash, THREE.AdditiveBlending);
    this.group.add(this.flash);
    this.fire = Array.from({ length: FIRE }, () => {
      const s = sprite(textures.flame, THREE.AdditiveBlending);
      this.group.add(s);
      return { sprite: s, velocity: new THREE.Vector3(), spin: 0, size: 1 };
    });
    this.smoke = Array.from({ length: SMOKE }, () => {
      const s = sprite(textures.smoke, THREE.NormalBlending);
      this.group.add(s);
      return { sprite: s, velocity: new THREE.Vector3(), spin: 0, size: 1, life: LIFE, delay: 0 };
    });
    this.dust = Array.from({ length: DUST }, () => {
      const s = sprite(textures.smoke, THREE.NormalBlending);
      this.group.add(s);
      return { sprite: s, velocity: new THREE.Vector3(), size: 1 };
    });

    this.ring = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({
        map: textures.ring,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        color: 0xffe2b8,
        opacity: 0,
      }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.group.add(this.ring);

    // Sparks as short streaks, each drawn back along its own velocity so a
    // fast one is a long one. Faded by darkening: on an additive material,
    // black is nothing.
    const geometry = new THREE.BufferGeometry();
    this.sparkPositions = new Float32Array(SPARKS * 6);
    this.sparkColours = new Float32Array(SPARKS * 6);
    geometry.setAttribute('position', new THREE.BufferAttribute(this.sparkPositions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('color', new THREE.BufferAttribute(this.sparkColours, 3).setUsage(THREE.DynamicDrawUsage));
    this.sparkLines = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.sparkLines.frustumCulled = false;
    this.group.add(this.sparkLines);
    this.sparks = Array.from({ length: SPARKS }, () => ({
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      life: 0,
    }));

    // Grit and stones, lit like the world so they read as solid.
    this.chunkMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      lightMaterial(new THREE.MeshStandardMaterial({ color: 0x4a4038, roughness: 0.95 })),
      CHUNKS,
    );
    this.chunkMesh.frustumCulled = false;
    this.group.add(this.chunkMesh);
    this.chunks = Array.from({ length: CHUNKS }, () => ({
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      spin: new THREE.Vector3(),
      rotation: new THREE.Euler(),
      size: 0.05,
      resting: false,
    }));
    this._matrix = new THREE.Matrix4();
    this._quaternion = new THREE.Quaternion();
    this._scale = new THREE.Vector3();
    this._smokeLit = new THREE.Color();
    this._dustLit = new THREE.Color();
  }

  start(at) {
    this.age = 0;
    this.group.visible = true;
    this.group.position.set(at.x, at.y, at.z);
    this.floor = floorUnder(at);
    const ground = this.floor === null ? null : this.floor - at.y;
    this.ground = ground;

    // How lit the air is here, from the bake: smoke in a dark room is not
    // the smoke in the open yard.
    const here = lightHere(at);
    const lit = Math.min(1.2, 0.3 + here.sky * 0.45 + here.sun * 0.35);
    this._smokeLit.setRGB(0.62 * lit, 0.6 * lit, 0.57 * lit);
    this._dustLit.setRGB(0.62 * lit, 0.54 * lit, 0.43 * lit);

    const random = Math.random;
    const outward = (v, spread, lift) => {
      const a = random() * Math.PI * 2;
      const up = lift + random() * (1 - lift);
      const flat = Math.sqrt(Math.max(0, 1 - up * up));
      return v.set(Math.cos(a) * flat * spread, up, Math.sin(a) * flat * spread).normalize();
    };

    for (const f of this.fire) {
      outward(f.velocity, 1, 0.05).multiplyScalar(3 + random() * 6);
      f.sprite.position.set(0, 0.2, 0);
      f.spin = (random() - 0.5) * 3;
      f.sprite.material.rotation = random() * Math.PI * 2;
      f.size = 1.6 + random() * 1.6;
      f.sprite.visible = true;
    }
    for (const s of this.smoke) {
      outward(s.velocity, 1, 0.2);
      s.velocity.x *= 2 + random() * 2.5;
      s.velocity.z *= 2 + random() * 2.5;
      s.velocity.y = 1.2 + random() * 2.4;
      s.sprite.position.set((random() - 0.5) * 0.6, 0.3 + random() * 0.5, (random() - 0.5) * 0.6);
      s.spin = (random() - 0.5) * 0.5;
      s.sprite.material.rotation = random() * Math.PI * 2;
      s.size = 3.4 + random() * 2.6;
      s.life = LIFE * (0.65 + random() * 0.35);
      s.delay = random() * 0.08;
      s.sprite.visible = false;
    }
    for (const d of this.dust) {
      const a = random() * Math.PI * 2;
      const speed = 7 + random() * 5;
      d.velocity.set(Math.cos(a) * speed, 0.4 + random() * 0.8, Math.sin(a) * speed);
      d.sprite.position.set(0, (ground ?? -0.2) + 0.35, 0);
      d.size = 1.8 + random() * 1.6;
      d.sprite.visible = ground !== null;
    }
    for (const spark of this.sparks) {
      outward(spark.velocity, 1, -0.2).multiplyScalar(9 + random() * 16);
      spark.position.set(0, 0.15, 0);
      spark.life = 0.25 + random() * 0.6;
    }
    for (const chunk of this.chunks) {
      outward(chunk.velocity, 1, 0.25).multiplyScalar(4 + random() * 8);
      chunk.position.set(0, 0.15, 0);
      chunk.spin.set(random() * 20 - 10, random() * 20 - 10, random() * 20 - 10);
      chunk.rotation.set(random() * 6, random() * 6, random() * 6);
      chunk.size = 0.04 + random() * 0.09;
      chunk.resting = false;
    }
    this.ring.position.set(0, (ground ?? 0) + 0.06, 0);
    this.ring.visible = ground !== null;
  }

  /** Steps it on; the light's strength from this blast, for whoever owns
   *  the one light all blasts share. */
  update(dt) {
    if (this.age >= LIFE) return 0;
    this.age += dt;
    const t = this.age;
    if (t >= LIFE) {
      this.group.visible = false;
      return 0;
    }

    // The flash: a tenth of a second, very bright, so the bloom takes it.
    const flash = Math.max(0, 1 - t / 0.11);
    this.flash.visible = flash > 0;
    if (flash > 0) {
      this.flash.scale.setScalar(3 + (1 - flash) * 4);
      this.flash.material.color.setScalar(5 * flash * flash);
      this.flash.material.opacity = 1;
    }

    // The fireball: rolls out, slows, cools from white through orange to
    // nothing. Colour carries the fade - black adds nothing.
    for (const f of this.fire) {
      if (!f.sprite.visible) continue;
      if (t > 0.5) {
        f.sprite.visible = false;
        continue;
      }
      f.velocity.multiplyScalar(Math.exp(-7 * dt));
      f.velocity.y += 2.5 * dt;
      f.sprite.position.addScaledVector(f.velocity, dt);
      f.sprite.material.rotation += f.spin * dt;
      const grow = 1 - Math.exp(-t / 0.08);
      f.sprite.scale.setScalar(0.5 + f.size * grow);
      const heat = Math.max(0, 1 - t / 0.5);
      const c = f.sprite.material.color;
      if (t < 0.12) c.setRGB(3.2, 2.6, 1.6);
      else if (t < 0.28) c.setRGB(2.4, 1.1, 0.35);
      else c.setRGB(1.2, 0.4, 0.1);
      c.multiplyScalar(heat * heat);
      f.sprite.material.opacity = 1;
    }

    // Smoke: lit by the fire for its first moments, then the grey of the
    // air it is in; swells, rises, slows and thins out.
    for (const s of this.smoke) {
      const own = t - s.delay;
      if (own < 0) continue;
      if (own > s.life) {
        s.sprite.visible = false;
        continue;
      }
      s.sprite.visible = true;
      const drag = Math.exp(-1.8 * dt);
      s.velocity.x *= drag;
      s.velocity.z *= drag;
      s.velocity.y = s.velocity.y * Math.exp(-0.9 * dt) + (own < 1.2 ? 0.8 : 0.2) * dt;
      s.sprite.position.addScaledVector(s.velocity, dt);
      s.sprite.material.rotation += s.spin * dt;
      s.sprite.scale.setScalar(0.8 + s.size * (1 - Math.exp(-own / 0.7)));
      const warm = Math.max(0, 1 - own / 0.35);
      const c = s.sprite.material.color;
      c.copy(this._smokeLit).lerp(WARM, warm * 0.8);
      const life = own / s.life;
      s.sprite.material.opacity = Math.min(1, own / 0.06) * 0.62 * (1 - life ** 1.6);
    }

    // Dust shoved out along the ground.
    for (const d of this.dust) {
      if (!d.sprite.visible) continue;
      if (t > 1.6) {
        d.sprite.visible = false;
        continue;
      }
      d.velocity.multiplyScalar(Math.exp(-3.2 * dt));
      d.sprite.position.addScaledVector(d.velocity, dt);
      d.sprite.scale.setScalar(0.6 + d.size * (1 - Math.exp(-t / 0.3)));
      d.sprite.material.color.copy(this._dustLit);
      d.sprite.material.opacity = 0.55 * (1 - t / 1.6) * Math.min(1, t / 0.04);
    }

    // The shock along the ground: out to eight metres in a third of a second.
    if (this.ring.visible) {
      const r = 0.3 + 7.7 * (1 - Math.exp(-t / 0.1));
      this.ring.scale.setScalar(r);
      this.ring.material.opacity = 0.5 * Math.max(0, 1 - t / 0.35) ** 2;
    }

    // Sparks.
    let k = 0;
    for (const spark of this.sparks) {
      const alive = t < spark.life;
      if (alive) {
        spark.velocity.multiplyScalar(Math.exp(-1.6 * dt));
        spark.velocity.y -= 14 * dt;
        spark.position.addScaledVector(spark.velocity, dt);
      }
      const p = spark.position;
      const v = spark.velocity;
      const tail = 0.03;
      this.sparkPositions.set([p.x, p.y, p.z, p.x - v.x * tail, p.y - v.y * tail, p.z - v.z * tail], k * 6);
      const glow = alive ? 2.6 * (1 - t / spark.life) : 0;
      this.sparkColours.set([glow, glow * 0.72, glow * 0.32, glow * 0.5, glow * 0.25, glow * 0.08], k * 6);
      k += 1;
    }
    this.sparkLines.geometry.attributes.position.needsUpdate = true;
    this.sparkLines.geometry.attributes.color.needsUpdate = true;

    // Grit: thrown, falling, coming to rest on the floor it was thrown from.
    const floor = this.ground ?? -0.15;
    for (let i = 0; i < CHUNKS; i += 1) {
      const chunk = this.chunks[i];
      if (!chunk.resting) {
        chunk.velocity.y -= 23 * dt;
        chunk.position.addScaledVector(chunk.velocity, dt);
        chunk.rotation.x += chunk.spin.x * dt;
        chunk.rotation.y += chunk.spin.y * dt;
        chunk.rotation.z += chunk.spin.z * dt;
        if (chunk.position.y < floor + chunk.size / 2 && chunk.velocity.y < 0) {
          chunk.position.y = floor + chunk.size / 2;
          chunk.resting = true;
        }
      }
      const shown = t < 2.4 ? chunk.size : 0;
      this._quaternion.setFromEuler(chunk.rotation);
      this._scale.setScalar(shown);
      this._matrix.compose(chunk.position, this._quaternion, this._scale);
      this.chunkMesh.setMatrixAt(i, this._matrix);
    }
    this.chunkMesh.instanceMatrix.needsUpdate = true;

    // The light: the flash, and the fireball's glow after it.
    return FLASH_LIGHT * Math.exp(-t / 0.05) + 110 * Math.max(0, 1 - t / 0.45);
  }
}

/** Every grenade going off, pooled, and the one light they share. */
export class Blasts {
  constructor(scene) {
    this.scene = scene;
    this.textures = {
      flash: flashTexture(),
      flame: flameTexture(),
      smoke: smokeTexture(),
      ring: ringTexture(),
    };
    this.pool = [];
    // One light, always in the scene, dark until something goes off. A light
    // added or removed changes how many every lit material is compiled for,
    // and the first grenade of a session would then stall the frame while
    // the whole map's shaders were rebuilt.
    this.light = new THREE.PointLight(0xffb070, 0, 22, 2);
    this.light.position.set(0, -1000, 0);
    scene.add(this.light);
    this._at = null;
  }

  explode(at) {
    let blast = this.pool.find((b) => b.age >= LIFE);
    if (!blast) {
      if (this.pool.length < POOL) {
        blast = new Blast(this.scene, this.textures);
        this.pool.push(blast);
      } else {
        blast = this.pool.reduce((oldest, b) => (b.age > oldest.age ? b : oldest));
      }
    }
    const where = new THREE.Vector3(at[0], at[1], at[2]);
    blast.start(where);
    this._at = where.clone();
    this.light.position.copy(where).add(new THREE.Vector3(0, 0.6, 0));
  }

  update(dt) {
    let brightest = 0;
    for (const blast of this.pool) {
      const strength = blast.update(dt);
      brightest = Math.max(brightest, strength);
    }
    this.light.intensity = brightest;
  }
}
