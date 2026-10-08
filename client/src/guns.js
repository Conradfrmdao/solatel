// Every gun but the rifle, and every optic, built here rather than downloaded.
//
// Like the rifle (`rifle.js`) and for the same reason: a game that charges
// money cannot ship somebody else's model on a guess about its licence. Each
// is built in the rifle model's own frame and units with the same kit
// (`gunkit.js`) - muzzle down -Z, bore at `BORE`, the pistol grip where the
// right palm closes (`GRIP` in `grip.js`) - so the hands that hold the rifle
// hold every one of them without being told anything new. The long guns put
// their support - a handguard, a fore-end - under the rifle's left palm too
// (`SUPPORT`), which is what lets other players' soldiers, posed for the
// rifle, hold them as they are.
//
// What each one is, in the pattern of a real gun and named by what it is:
//
//   pistol  a 9 mm polymer-framed service pistol, 0.19 m
//   smg     a compact AR-pattern submachine gun with a straight magazine
//           and a short handguard, 0.58 m
//   lmg     a belt-fed light machine gun in the pattern of an M249: feed
//           cover, hundred-round pouch, carry handle, folded bipod, 1.04 m
//   sniper  a bolt-action .308 in the pattern of an M24: composite stock,
//           heavy free-floated barrel, five-round box, 1.09 m
//
// And the optics, each a lathed body on a mount that sits on whatever rail or
// handle the gun has (`rail` in `POINTS`): the rifle's red dot, a compact 2x
// prism, a 3x, and a 4x - a short ACOG-like prism on the rifle and the machine
// gun, a long tube scope on the sniper rifle.

import * as THREE from 'three';
import { BORE, assemble, block, gather, pin, rod, side, turned } from './gunkit.js';
import { buildRifle, gunMaterials } from './rifle.js';

/** Where the rifle's support hand closes, in model units; every long gun puts
 *  something to hold there. Matches `arms.leftPalm` in `weapons.js`. */
export const SUPPORT = [0, -0.2, -0.75];

/**
 * Each gun's landmarks, in model units:
 *
 *   muzzle    the face of the muzzle, on the bore
 *   magazine  where a hand takes the magazine out, for a reload
 *   port      where spent cases leave, for the first person
 *   support   where the left palm closes (the pistol's cups the right hand)
 *   rail      where an optic's mount sits: its top, and how far back and
 *             forward along it the optic may sit
 *   irons     the sights' line, as [height, z] at the front and the rear, for
 *             a gun aimed without an optic
 */
export const POINTS = {
  rifle: {
    muzzle: [0, BORE, -2.306],
    magazine: [0, -0.62, 0.1],
    port: [0.08, 0.08, 0.0],
    support: SUPPORT,
    rail: { top: 0.49, z: 0.36 },
    irons: { front: [0.395, -1.37], rear: [0.47, 0.52] },
  },
  pistol: {
    muzzle: [0, BORE, -0.27],
    magazine: [0, -0.8, 0.72],
    port: [0.07, 0.13, 0.3],
    // Cupped under the right hand: the base of the grip, a little forward.
    support: [-0.02, -0.62, 0.48],
    rail: null,
    irons: { front: [0.262, -0.15], rear: [0.262, 0.7] },
  },
  smg: {
    muzzle: [0, BORE, -1.52],
    magazine: [0, -0.55, -0.05],
    port: [0.08, 0.08, 0.05],
    support: SUPPORT,
    rail: { top: 0.27, z: 0.3 },
    irons: { front: [0.38, -0.95], rear: [0.38, 0.55] },
  },
  lmg: {
    muzzle: [0, BORE, -3.35],
    magazine: [-0.06, -0.75, -0.1],
    port: [0.1, 0.0, 0.05],
    support: SUPPORT,
    rail: { top: 0.39, z: 0.25 },
    irons: { front: [0.33, -3.1], rear: [0.42, 0.62] },
  },
  sniper: {
    muzzle: [0, BORE, -3.6],
    magazine: [0, -0.42, -0.05],
    port: [0.1, 0.1, -0.05],
    support: SUPPORT,
    rail: { top: 0.24, z: 0.15 },
    irons: { front: [0.5, -2.5], rear: [0.5, 0.4] },
  },
};

// ---- the pistol -------------------------------------------------------------

function pistolParts() {
  const polymer = [];
  const steel = [];
  const dark = [];
  const metal = [];
  // The slide: square-shouldered, chamfered along the top, the front a
  // little narrower, with serrations at the back for the hand that racks it.
  steel.push(
    side(
      [[0.84, -0.03], [0.84, 0.2], [0.8, 0.245], [-0.2, 0.245], [-0.255, 0.2], [-0.255, -0.03]],
      0.17,
      { bevel: 0.018 },
    ),
  );
  for (let i = 0; i < 6; i += 1) {
    const z = 0.56 + i * 0.045;
    for (const sx of [1, -1]) dark.push(block(sx * 0.086, 0.02, z - 0.011, sx * 0.09, 0.21, z + 0.011));
  }
  // The ejection port on the right, and the barrel's hood showing in it.
  dark.push(block(0.084, 0.09, 0.2, 0.09, 0.2, 0.42));
  metal.push(block(-0.05, 0.12, 0.22, 0.05, 0.2, 0.4));
  // The muzzle: the barrel's crown inside the slide's front.
  dark.push(rod(-0.25, -0.262, 0.04, { segments: 14 }));
  // Sights: a post at the front, a notched blade at the back, white dots.
  dark.push(block(-0.016, 0.24, -0.18, 0.016, 0.262, -0.12));
  dark.push(block(-0.05, 0.24, 0.66, -0.012, 0.262, 0.74));
  dark.push(block(0.012, 0.24, 0.66, 0.05, 0.262, 0.74));
  // The frame: polymer, a dust cover forward under the slide with a short
  // rail, the trigger guard squared at the front, and the grip raked back
  // with a beavertail into the web of the hand.
  polymer.push(
    side(
      [
        [0.86, -0.02], [0.86, -0.08], [0.98, -0.16], [0.95, -0.2], [0.82, -0.18], [0.9, -0.74],
        [0.88, -0.8], [0.52, -0.8], [0.5, -0.74], [0.42, -0.24], [0.42, -0.2], [0.02, -0.2],
        [-0.02, -0.16], [-0.24, -0.12], [-0.24, -0.02],
      ],
      0.155,
      { bevel: 0.02, segments: 3, holes: [[[0.4, -0.08], [0.4, -0.18], [0.08, -0.18], [0.04, -0.12], [0.06, -0.08]]] },
    ),
  );
  // Texture on the grip's sides: a stippled panel, in recess.
  for (const sx of [1, -1]) dark.push(side([[0.86, -0.3], [0.82, -0.7], [0.56, -0.7], [0.52, -0.32]], 0.008, { x: sx * 0.079, bevel: 0.002 }));
  // The trigger, a takedown lever, the slide stop, the magazine's base.
  dark.push(side([[0.3, -0.09], [0.28, -0.15], [0.24, -0.17], [0.25, -0.12], [0.27, -0.09]], 0.03, { bevel: 0.004 }));
  dark.push(block(-0.09, -0.06, 0.12, -0.078, -0.03, 0.26));
  dark.push(block(-0.09, -0.02, 0.36, -0.078, 0.01, 0.56));
  dark.push(side([[0.9, -0.79], [0.9, -0.84], [0.5, -0.84], [0.52, -0.79]], 0.16, { bevel: 0.01 }));
  return { polymer, steel, dark, metal };
}

// ---- the submachine gun -----------------------------------------------------

function smgParts() {
  const metal = [];
  const steel = [];
  const polymer = [];
  const dark = [];
  // Upper: a flat top with a rail along it, the ejection port, the charging
  // handle at the back.
  metal.push(side([[0.71, -0.07], [0.71, 0.17], [0.66, 0.21], [-0.22, 0.21], [-0.24, 0.17], [-0.24, -0.07]], 0.16, { bevel: 0.016 }));
  for (let i = 0; i < 12; i += 1) {
    const z = 0.62 - i * 0.07;
    metal.push(block(-0.07, 0.21, z - 0.022, 0.07, 0.27, z + 0.022));
  }
  dark.push(block(-0.05, 0.215, -0.2, 0.05, 0.245, 0.66));
  dark.push(block(0.078, 0.02, -0.08, 0.084, 0.12, 0.16));
  metal.push(side([[0.82, 0.12], [0.82, 0.17], [0.7, 0.17], [0.7, 0.12]], 0.19, { bevel: 0.01 }));
  // Lower: the magazine well flared at its mouth, the trigger guard, and the
  // grip raked back.
  metal.push(
    side(
      [[0.71, -0.07], [0.71, -0.13], [0.62, -0.15], [0.12, -0.15], [0.12, -0.28], [0.16, -0.31], [-0.2, -0.31], [-0.17, -0.27], [-0.2, -0.15], [-0.24, -0.11], [-0.24, -0.07]],
      0.14,
      { bevel: 0.014 },
    ),
  );
  metal.push(side([[0.56, -0.15], [0.56, -0.24], [0.5, -0.31], [0.13, -0.31], [0.13, -0.26], [0.48, -0.26], [0.52, -0.21], [0.52, -0.15]], 0.045, { bevel: 0.008 }));
  dark.push(side([[0.38, -0.15], [0.375, -0.19], [0.355, -0.235], [0.33, -0.25], [0.335, -0.225], [0.35, -0.19], [0.355, -0.15]], 0.03, { bevel: 0.004 }));
  dark.push(side([[0.53, -0.03], [0.53, -0.015], [0.42, 0.01], [0.42, -0.01]], 0.02, { x: -0.084, bevel: 0.004 }));
  polymer.push(
    side(
      [[0.66, -0.13], [0.47, -0.13], [0.5, -0.3], [0.58, -0.62], [0.62, -0.66], [0.83, -0.66], [0.84, -0.62], [0.78, -0.3], [0.74, -0.16], [0.7, -0.13]],
      0.11,
      { bevel: 0.022, segments: 3 },
    ),
  );
  // A straight thirty-round magazine for a pistol cartridge: narrower than
  // the rifle's, square, ribbed.
  const mag = [[0.1, -0.31], [0.1, -0.86], [0.06, -0.9], [-0.18, -0.9], [-0.18, -0.31]];
  metal.push(side(mag, 0.11, { bevel: 0.01 }));
  dark.push(side([[0.12, -0.86], [0.12, -0.92], [-0.2, -0.92], [-0.2, -0.86]], 0.13, { bevel: 0.01 }));
  for (const y of [-0.45, -0.6, -0.75]) for (const sx of [1, -1]) dark.push(block(sx * 0.052, y - 0.012, -0.15, sx * 0.058, y + 0.012, 0.07));
  // The handguard: a short square tube with slots, round the barrel, under
  // the support hand.
  polymer.push(side([[-0.24, -0.11], [-0.24, 0.18], [-1.12, 0.18], [-1.16, 0.14], [-1.16, -0.1], [-1.12, -0.14], [-0.28, -0.14]], 0.2, { bevel: 0.025, segments: 3 }));
  for (let i = 0; i < 5; i += 1) {
    const z = -0.42 - i * 0.15;
    for (const sx of [1, -1]) dark.push(block(sx * 0.098, -0.02, z - 0.05, sx * 0.103, 0.1, z + 0.05));
    dark.push(block(-0.05, -0.143, z - 0.05, 0.05, -0.139, z + 0.05));
  }
  for (let i = 0; i < 7; i += 1) {
    const z = -0.3 - i * 0.12;
    metal.push(block(-0.07, 0.18, z - 0.022, 0.07, 0.235, z + 0.022));
  }
  // Barrel out of the handguard, a flash hider.
  steel.push(rod(-1.16, -1.32, 0.04));
  steel.push(turned([[-1.3, 0], [-1.3, 0.05], [-1.32, 0.056], [-1.5, 0.056], [-1.52, 0.048], [-1.52, 0]], { segments: 18 }));
  for (let k = 0; k < 4; k += 1) {
    const g = block(-0.008, 0.044, -1.49, 0.008, 0.06, -1.37);
    g.rotateZ((k / 4) * Math.PI * 2 + Math.PI / 4);
    g.translate(0, BORE, 0);
    dark.push(g);
  }
  // Folding sights on the rails, down.
  dark.push(block(-0.03, 0.235, -0.96, 0.03, 0.29, -0.86));
  dark.push(block(-0.04, 0.27, 0.52, 0.04, 0.31, 0.62));
  // A collapsing stock: two rods and a butt, short.
  polymer.push(rod(0.74, 1.5, 0.06, { y: 0.09, segments: 14 }));
  polymer.push(side([[1.2, 0.17], [1.82, 0.17], [1.84, 0.13], [1.84, -0.42], [1.78, -0.45], [1.66, -0.3], [1.44, -0.06], [1.2, -0.02]], 0.12, { bevel: 0.02, segments: 3, holes: [[[1.46, -0.08], [1.64, -0.08], [1.7, -0.2], [1.64, -0.28], [1.58, -0.22]]] }));
  dark.push(side([[1.84, 0.18], [1.88, 0.18], [1.88, -0.45], [1.84, -0.45]], 0.13, { bevel: 0.012 }));
  return { metal, steel, polymer, dark };
}

// ---- the light machine gun -------------------------------------------------

function lmgParts() {
  const metal = [];
  const steel = [];
  const polymer = [];
  const dark = [];
  // The receiver: long, slab-sided steel, with the feed tray cover hinged on
  // top - its rail is where an optic goes - and the charging handle on the
  // right.
  steel.push(side([[0.78, -0.12], [0.78, 0.2], [0.7, 0.24], [-0.66, 0.24], [-0.7, 0.18], [-0.7, -0.12]], 0.2, { bevel: 0.016 }));
  metal.push(side([[0.6, 0.24], [0.6, 0.31], [0.52, 0.36], [-0.5, 0.36], [-0.56, 0.3], [-0.56, 0.24]], 0.22, { bevel: 0.02, segments: 3 }));
  for (let i = 0; i < 9; i += 1) {
    const z = 0.45 - i * 0.1;
    dark.push(block(-0.07, 0.36, z - 0.025, 0.07, 0.39, z + 0.025));
  }
  dark.push(block(0.1, 0.02, -0.1, 0.106, 0.16, 0.3));
  steel.push(side([[0.0, 0.0], [0.0, 0.08], [-0.24, 0.08], [-0.24, 0.0]], 0.05, { x: 0.12, bevel: 0.01 }));
  steel.push(pin(-0.2, 0.04, 0.035, 0.12, { x: 0.18 }));
  // The feed: a tray under the cover, and the hundred-round pouch hung under
  // the left of the receiver, its belt rising into the tray.
  dark.push(block(-0.17, 0.12, -0.12, -0.1, 0.22, 0.14));
  polymer.push(side([[0.2, -0.12], [0.2, -0.7], [0.12, -0.78], [-0.4, -0.78], [-0.48, -0.7], [-0.48, -0.12]], 0.26, { x: -0.06, bevel: 0.035, segments: 3 }));
  dark.push(side([[0.18, -0.4], [0.18, -0.46], [-0.46, -0.46], [-0.46, -0.4]], 0.27, { x: -0.06, bevel: 0.006 }));
  for (let i = 0; i < 5; i += 1) {
    const z = 0.08 - i * 0.11;
    metal.push(block(-0.2, -0.13, z - 0.03, -0.14, 0.12, z + 0.03));
  }
  // The trigger group and the grip.
  polymer.push(side([[0.78, -0.12], [0.78, -0.2], [0.3, -0.2], [0.3, -0.12]], 0.16, { bevel: 0.014 }));
  polymer.push(side([[0.56, -0.2], [0.56, -0.28], [0.5, -0.35], [0.24, -0.35], [0.24, -0.3], [0.48, -0.3], [0.52, -0.25], [0.52, -0.2]], 0.045, { bevel: 0.008 }));
  dark.push(side([[0.42, -0.2], [0.415, -0.24], [0.395, -0.285], [0.37, -0.3], [0.375, -0.275], [0.39, -0.24], [0.395, -0.2]], 0.03, { bevel: 0.004 }));
  polymer.push(side([[0.66, -0.15], [0.47, -0.15], [0.5, -0.32], [0.58, -0.64], [0.62, -0.68], [0.83, -0.68], [0.84, -0.64], [0.78, -0.32], [0.74, -0.18], [0.7, -0.15]], 0.12, { bevel: 0.022, segments: 3 }));
  // The handguard, ribbed, under the support hand; the gas tube under the
  // barrel; a heat shield over it.
  polymer.push(side([[-0.7, -0.12], [-0.7, 0.16], [-1.55, 0.16], [-1.6, 0.12], [-1.6, -0.16], [-1.52, -0.2], [-0.76, -0.2]], 0.24, { bevel: 0.03, segments: 3 }));
  for (let i = 0; i < 8; i += 1) {
    const z = -0.8 - i * 0.09;
    for (const sx of [1, -1]) dark.push(block(sx * 0.118, -0.14, z - 0.02, sx * 0.124, 0.12, z + 0.02));
  }
  steel.push(rod(-1.6, -2.4, 0.05, { y: BORE - 0.13 }));
  steel.push(rod(-0.7, -3.18, 0.058));
  metal.push(turned([[-1.62, 0], [-1.62, 0.1], [-2.6, 0.1], [-2.6, 0]], { y: BORE + 0.02, segments: 22 }));
  for (let i = 0; i < 10; i += 1) {
    const z = -1.7 - i * 0.09;
    dark.push(block(-0.03, BORE + 0.105, z - 0.025, 0.03, BORE + 0.12, z + 0.025));
  }
  // A carry handle over the barrel's chamber end.
  steel.push(side([[-0.78, 0.2], [-0.78, 0.46], [-0.86, 0.5], [-1.3, 0.5], [-1.38, 0.46], [-1.38, 0.2], [-1.3, 0.2], [-1.3, 0.42], [-0.86, 0.42], [-0.86, 0.2]], 0.07, { bevel: 0.012 }));
  // The bipod, folded under the barrel: two legs and their feet.
  for (const sx of [1, -1]) {
    steel.push(side([[-2.42, -0.06], [-2.42, -0.0], [-3.02, -0.03], [-3.02, -0.09]], 0.04, { x: sx * 0.07, bevel: 0.01 }));
    dark.push(block(sx * 0.07 - 0.03, -0.1, -3.08, sx * 0.07 + 0.03, -0.0, -3.0));
  }
  steel.push(rod(-2.36, -2.48, 0.07, { y: BORE - 0.08 }));
  // The front sight on its post, and a flash hider.
  steel.push(side([[-3.02, 0.05], [-3.02, 0.22], [-3.06, 0.33], [-3.14, 0.33], [-3.18, 0.05]], 0.06, { bevel: 0.01 }));
  steel.push(turned([[-3.16, 0], [-3.16, 0.064], [-3.18, 0.07], [-3.35, 0.07], [-3.35, 0]], { segments: 18 }));
  for (let k = 0; k < 6; k += 1) {
    const g = block(-0.009, 0.056, -3.33, 0.009, 0.074, -3.2);
    g.rotateZ((k / 6) * Math.PI * 2);
    g.translate(0, BORE, 0);
    dark.push(g);
  }
  // The stock: fixed, deep, with a shoulder rest.
  polymer.push(side([[0.78, 0.18], [0.78, -0.1], [1.0, -0.24], [2.3, -0.5], [2.42, -0.5], [2.42, 0.2], [2.36, 0.24], [1.0, 0.22]], 0.16, { bevel: 0.03, segments: 3, holes: [[[1.25, 0.08], [2.1, 0.08], [2.1, -0.18], [1.25, -0.06]]] }));
  dark.push(side([[2.42, 0.22], [2.47, 0.22], [2.47, -0.52], [2.42, -0.52]], 0.17, { bevel: 0.014 }));
  return { metal, steel, polymer, dark };
}

// ---- the sniper rifle --------------------------------------------------------

function sniperParts() {
  const steel = [];
  const dark = [];
  const tan = [];
  const metal = [];
  // The stock, in one piece: a fore-end long enough to rest the barrel
  // over (and the support hand under), a vertical-ish grip, a raised cheek
  // piece and a deep butt. Composite, in coyote.
  tan.push(
    side(
      [
        [-1.92, -0.04], [-1.92, -0.2], [-1.86, -0.26], [-0.25, -0.26], [-0.1, -0.28], [0.12, -0.28], [0.3, -0.24],
        [0.46, -0.2], [0.52, -0.38], [0.6, -0.7], [0.66, -0.74], [0.86, -0.72], [0.9, -0.64], [0.86, -0.42],
        [1.2, -0.42], [2.36, -0.6], [2.42, -0.58], [2.42, 0.18], [2.3, 0.24], [1.3, 0.26], [1.15, 0.3],
        [0.95, 0.3], [0.85, 0.06], [0.68, 0.0], [-0.62, 0.0], [-0.7, -0.04],
      ],
      0.2,
      { bevel: 0.035, segments: 4, holes: [[[0.44, -0.12], [0.42, -0.26], [0.22, -0.26], [0.16, -0.18], [0.24, -0.12]]] },
    ),
  );
  dark.push(side([[2.42, 0.2], [2.48, 0.2], [2.48, -0.6], [2.42, -0.6]], 0.21, { bevel: 0.016 }));
  // A sling stud, the trigger in its guard.
  dark.push(pin(-1.75, -0.29, 0.02, 0.06));
  dark.push(side([[0.34, -0.12], [0.335, -0.16], [0.315, -0.2], [0.29, -0.215], [0.295, -0.19], [0.31, -0.16], [0.315, -0.12]], 0.03, { bevel: 0.004 }));
  // The action: a round receiver, the bolt behind it, its handle out to the
  // right and down with a tactical knob, a box magazine under it.
  steel.push(rod(0.62, -0.62, 0.105, { segments: 24 }));
  steel.push(rod(0.78, 0.62, 0.075, { segments: 20 }));
  // The handle out across to the right, and its knob.
  steel.push(pin(0.53, 0.04, 0.032, 0.3, { x: 0.25, segments: 12 }));
  dark.push(pin(0.53, 0.0, 0.065, 0.11, { x: 0.43, segments: 16 }));
  dark.push(block(0.06, 0.06, -0.3, 0.07, 0.1, 0.1));
  dark.push(side([[0.12, -0.26], [0.12, -0.42], [0.08, -0.45], [-0.2, -0.45], [-0.22, -0.42], [-0.22, -0.26]], 0.11, { bevel: 0.01 }));
  // A one-piece base over the action for the optic's rings.
  metal.push(block(-0.07, 0.1, -0.58, 0.07, 0.24, 0.6));
  for (let i = 0; i < 13; i += 1) {
    const z = 0.54 - i * 0.09;
    dark.push(block(-0.072, 0.2, z - 0.02, 0.072, 0.24, z + 0.02));
  }
  // The barrel: heavy, fluted, free over the fore-end; a brake at the end.
  steel.push(turned([[-0.62, 0], [-0.62, 0.085], [-0.8, 0.08], [-3.3, 0.06], [-3.3, 0]], { segments: 26 }));
  for (let k = 0; k < 6; k += 1) {
    const g = block(-0.01, 0.06, -2.9, 0.01, 0.075, -0.95);
    g.rotateZ((k / 6) * Math.PI * 2);
    g.translate(0, BORE, 0);
    dark.push(g);
  }
  steel.push(turned([[-3.28, 0], [-3.28, 0.085], [-3.6, 0.085], [-3.6, 0]], { segments: 18 }));
  for (const z of [-3.36, -3.44, -3.52]) for (const sx of [1, -1]) dark.push(block(sx * 0.07, BORE - 0.03, z - 0.025, sx * 0.09, BORE + 0.03, z + 0.025));
  return { steel, dark, tan, metal };
}

// ---- optics -----------------------------------------------------------------

/** How thick an optic's tube is: its inside is this much of its outside. */
const WALL = 0.86;

/**
 * A scope or sight: a lathed body along the bore from `front` to `rear` at
 * `height`, its outside following `profile` ([fraction along, radius]
 * pairs), on rings or a block down to the rail at `base`. Returned as parts
 * plus the glass and anything drawn unlit, which do not merge with the
 * rest.
 */
function scopeParts({ base, height, front, rear, profile, rings = [0.3, 0.7], turrets = false, prism = false, fibre = false }) {
  const metal = [];
  const dark = [];
  const length = rear - front;
  // A wall, not a skin: out along the outside, back along the inside, so the
  // tube can be looked down and is solid from either side.
  const outside = profile.map(([f, r]) => [front + f * length, r]);
  const inside = outside.map(([z, r]) => [z, r * WALL]).reverse();
  dark.push(turned([...outside, ...inside, outside[0]], { y: height, segments: 32 }));
  // A lip at each end, so the rims read as rims: rings, open in the middle.
  const first = outside[0][1];
  const last = outside[outside.length - 1][1];
  const ring = (z0, z1, r) => [[z0, r * WALL], [z0, r * 1.04], [z1, r * 1.04], [z1, r * WALL], [z0, r * WALL]];
  metal.push(turned(ring(front - 0.005, front + 0.03, first), { y: height, segments: 32 }));
  metal.push(turned(ring(rear - 0.03, rear + 0.005, last), { y: height, segments: 32 }));
  if (prism) {
    // A prism sight's body is a box under the tube, not rings.
    metal.push(block(-0.1, base, front + length * 0.18, 0.1, height - 0.02, front + length * 0.82));
  } else {
    for (const at of rings) {
      const z = front + at * length;
      const r = profile.reduce((best, [f, rr]) => (Math.abs(f - at) < Math.abs(best[0] - at) ? [f, rr] : best))[1];
      metal.push(turned([[z - 0.05, 0], [z - 0.05, r * 1.2], [z + 0.05, r * 1.2], [z + 0.05, 0]], { y: height, segments: 24 }));
      metal.push(block(-0.07, base, z - 0.05, 0.07, height - r, z + 0.05));
      metal.push(pin(z, height - r * 0.7, 0.025, r * 2.8, { segments: 8 }));
    }
  }
  if (turrets) {
    const z = front + length * 0.5;
    const r = profile[Math.floor(profile.length / 2)][1];
    metal.push(turned([[0, 0], [0, 0.07], [0.1, 0.07], [0.1, 0]], { y: 0, segments: 18 }).rotateX(-Math.PI / 2).translate(0, height + r, z));
    metal.push(turned([[0, 0], [0, 0.07], [0.1, 0.07], [0.1, 0]], { y: 0, segments: 18 }).rotateX(-Math.PI / 2).rotateZ(-Math.PI / 2).translate(r, height, z));
  }
  if (fibre) {
    // The fibre that lights an ACOG's reticle, along the top.
    metal.push(block(-0.03, height + first * 0.8, front + length * 0.25, 0.03, height + first * 0.95, front + length * 0.75));
  }
  return { metal, dark };
}

/** The tinted glass at each end of an optic, and for a red dot its dot. */
function glassFor({ height, front, rear, profile, dot = 0 }) {
  const group = new THREE.Group();
  const glass = new THREE.MeshBasicMaterial({
    color: 0x7fb8c8,
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const length = rear - front;
  for (const [f, z] of [[profile[0], front + 0.02], [profile[profile.length - 1], rear - 0.02]]) {
    const disc = new THREE.Mesh(new THREE.CircleGeometry(f[1] * 0.86, 32), glass);
    disc.position.set(0, height, z);
    group.add(disc);
  }
  if (dot > 0) {
    const red = new THREE.Mesh(
      new THREE.CircleGeometry(dot, 20),
      new THREE.MeshBasicMaterial({ color: 0xff2a20, side: THREE.DoubleSide }),
    );
    red.position.set(0, height, front + length * 0.05);
    group.add(red);
    const halo = new THREE.Mesh(
      new THREE.CircleGeometry(dot * 1.9, 20),
      new THREE.MeshBasicMaterial({
        color: 0xff3a2a,
        transparent: true,
        opacity: 0.22,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    );
    halo.position.set(0, height, front + length * 0.051);
    group.add(halo);
  }
  return group;
}

/**
 * What each optic is, on a rail whose top is at `base` and centred at `z`.
 * `height` is the line of sight - where the eye looks down it - and `front`
 * and `rear` its ends: the sights' line for aiming through it.
 */
export function opticShape(optic, weapon, rail) {
  const base = rail.top;
  const z = rail.z;
  switch (optic) {
    case 'red_dot': {
      // The rifle's tube red dot, as it always was on the carry handle.
      const height = base + 0.15;
      return { base, height, front: z - 0.16, rear: z + 0.16, profile: [[0, 0.12], [0.12, 0.12], [0.88, 0.12], [1, 0.12]], dot: 0.011, rings: [0.5], turrets: true };
    }
    case 'x2': {
      // A compact prism: a short squat tube on a block.
      const height = base + 0.16;
      return { base, height, front: z - 0.32, rear: z + 0.2, profile: [[0, 0.13], [0.2, 0.12], [0.8, 0.12], [1, 0.11]], prism: true, turrets: true };
    }
    case 'x3': {
      if (weapon === 'sniper') {
        const height = base + 0.19;
        return { base, height, front: z - 0.95, rear: z + 0.65, profile: [[0, 0.17], [0.16, 0.17], [0.26, 0.085], [0.74, 0.085], [0.84, 0.15], [1, 0.15]], turrets: true };
      }
      const height = base + 0.17;
      return { base, height, front: z - 0.45, rear: z + 0.25, profile: [[0, 0.14], [0.25, 0.12], [0.75, 0.11], [1, 0.12]], prism: true, turrets: true };
    }
    case 'x4':
    default: {
      if (weapon === 'sniper') {
        // A long tube: an objective bell, a thirty-millimetre tube with
        // turrets in the middle, an ocular bell at the eye.
        const height = base + 0.21;
        return { base, height, front: z - 1.15, rear: z + 0.75, profile: [[0, 0.2], [0.18, 0.2], [0.28, 0.085], [0.72, 0.085], [0.82, 0.16], [1, 0.16]], turrets: true };
      }
      // An ACOG-like prism: wide at the front, tapered to the eye, the
      // fibre along the top.
      const height = base + 0.18;
      return { base, height, front: z - 0.55, rear: z + 0.25, profile: [[0, 0.16], [0.35, 0.15], [0.7, 0.11], [1, 0.1]], prism: true, fibre: true };
    }
  }
}

// ---- building ---------------------------------------------------------------

let materials = null;
function allMaterials() {
  if (materials) return materials;
  materials = {
    ...gunMaterials(),
    // Composite furniture in coyote, for the sniper rifle's stock.
    tan: new THREE.MeshStandardMaterial({ name: 'gun_tan', color: 0x7d6a4f, roughness: 0.82, metalness: 0.02 }),
  };
  return materials;
}

const KINDS = ['metal', 'steel', 'polymer', 'dark', 'tan'];

/** Mount points, and the optic's own pieces, as a group. */
function buildOptic(optic, weapon) {
  const rail = POINTS[weapon].rail;
  if (!rail) return null;
  const shape = opticShape(optic, weapon, rail);
  const group = assemble(`optic_${optic}`, gather([scopeParts(shape)], KINDS), allMaterials());
  group.add(glassFor(shape));
  group.userData.sight = shape;
  return group;
}

/**
 * A gun, with its optic, as one group in the rifle model's frame. The rifle
 * is `rifle.js`'s; the rest are built here. `userData.sight` is the line the
 * eye aims down, `[height, z]` at the front and the rear: the optic's, or the
 * gun's iron sights.
 */
export function buildGun(weapon, optic) {
  let group;
  switch (weapon) {
    case 'pistol':
      group = assemble('pistol', gather([pistolParts()], KINDS), allMaterials());
      break;
    case 'smg':
      group = assemble('smg', gather([smgParts()], KINDS), allMaterials());
      break;
    case 'lmg':
      group = assemble('lmg', gather([lmgParts()], KINDS), allMaterials());
      break;
    case 'sniper':
      group = assemble('sniper', gather([sniperParts()], KINDS), allMaterials());
      break;
    case 'rifle':
    default:
      group = buildRifle();
      break;
  }
  const points = POINTS[weapon] ?? POINTS.rifle;
  const sight = optic && optic !== 'irons' ? buildOptic(optic, weapon) : null;
  if (sight) {
    group.add(sight);
    const s = sight.userData.sight;
    group.userData.sight = { front: [s.height, s.front], rear: [s.height, s.rear], optic };
  } else {
    group.userData.sight = { front: points.irons.front, rear: points.irons.rear, optic: 'irons' };
  }
  group.userData.weapon = weapon;
  group.userData.points = points;
  return group;
}

/** Every gun there is, by its name on the wire. */
export const WEAPON_IDS = ['pistol', 'smg', 'rifle', 'lmg', 'sniper'];
