// Where shots land: dust and chips off whatever a round struck, and a mist
// off whoever it struck.
//
// Drawn from the server's own account of every shot - `to` is where its ray
// stopped - so an impact is where the round actually went, not where this
// client thought it would. A shot that reached the end of its range struck
// nothing and raises nothing.
//
// Nothing here is a decal. A bullet hole wants the exact surface, and the
// surface the server's ray stops on is the collision: the art quantised to a
// quarter of a metre, so a flat mark placed there would float in front of
// some walls and sink into others. Dust is a volume, and forgives that.
//
// Everything is pooled and reused, so a long firefight allocates nothing.

import * as THREE from 'three';

/** Dust sprites, flashes, chips and mist, pooled. */
const DUST = 72;
const FLASHES = 12;
const CHIPS = 120;
const MIST = 24;

/** Past this the effect is a few pixels and not worth a sprite. */
const VISIBLE = 90;

const GRAVITY = 9.8;

function softTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** A pool of sprites that each live a moment and are reused oldest first. */
class Pool {
  constructor(scene, count, material) {
    this.items = [];
    for (let i = 0; i < count; i += 1) {
      const sprite = new THREE.Sprite(material.clone());
      sprite.visible = false;
      sprite.renderOrder = 4;
      scene.add(sprite);
      this.items.push({ sprite, age: 1, life: 1, velocity: new THREE.Vector3(), from: 0, to: 0, fade: 0 });
    }
    this.next = 0;
  }

  take() {
    const item = this.items[this.next];
    this.next = (this.next + 1) % this.items.length;
    return item;
  }

  update(dt, drag) {
    for (const item of this.items) {
      if (!item.sprite.visible) continue;
      item.age += dt;
      const t = item.age / item.life;
      if (t >= 1) {
        item.sprite.visible = false;
        continue;
      }
      item.velocity.multiplyScalar(Math.exp(-drag * dt));
      item.sprite.position.addScaledVector(item.velocity, dt);
      item.sprite.scale.setScalar(item.from + (item.to - item.from) * Math.sqrt(t));
      item.sprite.material.opacity = item.fade * (1 - t) * (1 - t);
    }
  }
}

export class Impacts {
  constructor(scene) {
    const soft = softTexture();
    this.dust = new Pool(
      scene,
      DUST,
      new THREE.SpriteMaterial({ map: soft, color: 0xcdc3ad, transparent: true, depthWrite: false, opacity: 0 }),
    );
    this.flashes = new Pool(
      scene,
      FLASHES,
      new THREE.SpriteMaterial({
        map: soft, color: 0xffe2a8, transparent: true, depthWrite: false, opacity: 0,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.mist = new Pool(
      scene,
      MIST,
      new THREE.SpriteMaterial({ map: soft, color: 0x6e1010, transparent: true, depthWrite: false, opacity: 0 }),
    );

    // Chips of whatever was struck, flung back out and falling: one draw.
    const chip = new THREE.BoxGeometry(0.05, 0.03, 0.045);
    this.chips = new THREE.InstancedMesh(
      chip,
      new THREE.MeshStandardMaterial({ color: 0x5d5850, roughness: 1 }),
      CHIPS,
    );
    this.chips.frustumCulled = false;
    this.chips.count = CHIPS;
    this.chipState = Array.from({ length: CHIPS }, () => ({
      age: 1, life: 1, position: new THREE.Vector3(), velocity: new THREE.Vector3(),
      spin: new THREE.Vector3(), rotation: new THREE.Euler(),
    }));
    this.nextChip = 0;
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < CHIPS; i += 1) this.chips.setMatrixAt(i, hidden);
    scene.add(this.chips);

    this._back = new THREE.Vector3();
    this._at = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3(1, 1, 1);
  }

  /** One shot, as the server reported it. `eye` is where the camera is. */
  strike(from, to, hitPlayer, eye) {
    const at = this._at.set(to[0], to[1], to[2]);
    if (eye && at.distanceTo(eye) > VISIBLE) return;
    const back = this._back.set(from[0] - to[0], from[1] - to[1], from[2] - to[2]);
    const length = back.length();
    back.divideScalar(length || 1);

    if (hitPlayer) {
      // A dark mist out of the far side, gone in a moment.
      for (let i = 0; i < 2; i += 1) {
        const m = this.mist.take();
        m.sprite.position.copy(at).addScaledVector(back, -0.05);
        m.velocity.copy(back).multiplyScalar(-(0.6 + Math.random() * 0.6)).add(jitter(0.5));
        start(m, 0.32 + Math.random() * 0.12, 0.08, 0.45, 0.7);
      }
      return;
    }

    // The strike itself, for a frame or two.
    const f = this.flashes.take();
    f.sprite.position.copy(at).addScaledVector(back, 0.04);
    f.velocity.set(0, 0, 0);
    start(f, 0.07, 0.34, 0.2, 1);

    // A dense burst at the strike, then dust back towards the shooter,
    // rising and spreading. Pale, so it reads against a dark wall, and
    // thick enough to read against a pale one.
    const burst = this.dust.take();
    burst.sprite.position.copy(at).addScaledVector(back, 0.08);
    burst.velocity.copy(back).multiplyScalar(1.6);
    start(burst, 0.28, 0.2, 0.55, 0.9);
    for (let i = 0; i < 2; i += 1) {
      const d = this.dust.take();
      d.sprite.position.copy(at).addScaledVector(back, 0.06);
      d.velocity.copy(back).multiplyScalar(0.6 + Math.random() * 1.0).add(jitter(0.35));
      d.velocity.y += 0.3;
      start(d, 0.9 + Math.random() * 0.5, 0.18, 0.95 + Math.random() * 0.45, 0.7);
    }

    // Chips flung back out of the surface.
    for (let i = 0; i < 6; i += 1) {
      const c = this.chipState[this.nextChip];
      this.nextChip = (this.nextChip + 1) % CHIPS;
      c.age = 0;
      c.life = 0.5 + Math.random() * 0.4;
      c.position.copy(at).addScaledVector(back, 0.03);
      c.velocity.copy(back).multiplyScalar(1.5 + Math.random() * 2.5).add(jitter(2.2));
      c.velocity.y += 1;
      c.spin.set(Math.random() * 20, Math.random() * 20, Math.random() * 20);
    }
  }

  update(dt) {
    this.dust.update(dt, 2.2);
    this.flashes.update(dt, 0);
    this.mist.update(dt, 4);

    let moved = false;
    for (let i = 0; i < CHIPS; i += 1) {
      const c = this.chipState[i];
      if (c.age >= c.life) continue;
      c.age += dt;
      moved = true;
      if (c.age >= c.life) {
        this.chips.setMatrixAt(i, this._m.makeScale(0, 0, 0));
        continue;
      }
      c.velocity.y -= GRAVITY * dt;
      c.position.addScaledVector(c.velocity, dt);
      c.rotation.x += c.spin.x * dt;
      c.rotation.y += c.spin.y * dt;
      c.rotation.z += c.spin.z * dt;
      const shrink = 1 - Math.max(0, (c.age / c.life - 0.7) / 0.3);
      this._q.setFromEuler(c.rotation);
      this._s.setScalar(shrink);
      this.chips.setMatrixAt(i, this._m.compose(c.position, this._q, this._s));
    }
    if (moved) this.chips.instanceMatrix.needsUpdate = true;
  }
}

function start(item, life, from, to, fade) {
  item.age = 0;
  item.life = life;
  item.from = from;
  item.to = to;
  item.fade = fade;
  item.sprite.material.rotation = Math.random() * Math.PI * 2;
  item.sprite.scale.setScalar(from);
  item.sprite.material.opacity = fade;
  item.sprite.visible = true;
}

const _jitter = new THREE.Vector3();
function jitter(amount) {
  return _jitter.set(
    (Math.random() - 0.5) * 2 * amount,
    (Math.random() - 0.5) * 2 * amount,
    (Math.random() - 0.5) * 2 * amount,
  );
}
