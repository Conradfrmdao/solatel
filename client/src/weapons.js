// How each weapon handles, as numbers to tune rather than code to edit.
//
// Everything here is the first-person *feel* of a weapon: where it sits, how
// it moves, how it kicks. None of it reaches the server and none of it decides
// a hit - the shot goes where the crosshair is, and the server says whether it
// landed. So all of it can be tuned during playtesting without touching the
// simulation, and a second weapon is a second entry here.
//
// Units: metres and radians in the viewmodel's own space, seconds for time.
// The viewmodel camera looks down -Z with +X right and +Y up, so a position
// of (0.3, -0.3, -0.45) is right, down and in front of the eye.

export const RIFLE = {
  name: 'rifle',

  /** The model is 4.405 units nose to stock; this draws it at 0.79 m. */
  scale: 0.18,
  /** Where the model's origin sits inside the weapon rig. Pushed forward so
   *  the stock does not sit on the near plane. */
  modelOffset: [0, 0, -0.1],
  /** Bore height and muzzle face in model units, for the flash. */
  boreHeight: 0.065,
  muzzleFace: -2.306,

  /**
   * A red-dot sight on the carry handle, in the model's units (the rifle's
   * top is at 0.49 there; the rifle is 4.4 units long). A tube: `radius` outside, `bore` inside, from
   * `front` to `rear` along the barrel, its axis `height` above the model's
   * origin. The glass is at the front and the dot is on the glass, so looking
   * down the tube puts the dot in the middle of two rings - the near rim big,
   * the far rim smaller - which is what aiming through one looks like.
   */
  optic: {
    // A real red dot is about 30-40 mm across on an 840 mm rifle; these
    // are in model units, 0.18 m each in first person.
    height: 0.64,
    front: 0.2,
    rear: 0.52,
    radius: 0.12,
    bore: 0.106,
    /** The mount, from the carry handle up to the tube. */
    base: 0.49,
    dotRadius: 0.011,
  },

  /** From the hip: down and out into the corner, turned in so the muzzle
   *  points near the crosshair. Rotation is [pitch, yaw, roll]. High enough
   *  that the support hand and its forearm are in the frame: any lower and
   *  the bottom of the screen cuts the arm off at the wrist. */
  hip: {
    position: [0.27, -0.25, -0.45],
    rotation: [-0.03, 0.085, 0],
  },

  /**
   * Down the sights. The position is not stated: it is worked out from the
   * sight line in the model, so the front post lands on the middle of the
   * screen whatever the scale or offset above.
   */
  ads: {
    /**
     * The two points the eye lines up, in model units as [height, z],
     * measured off the geometry: the top of the front sight post, and the
     * rear sight's notch just under the top of its housing. The rear sits
     * higher than the front, so the rifle is tipped nose-up by exactly the
     * angle between them to make the line level, and then moved so the front
     * post lands on the middle of the screen.
     */
    /** Through the red dot: the tube's axis at both ends, which is level. */
    frontSight: [0.64, 0.2],
    rearSight: [0.64, 0.52],
    /** How far in front of the eye the back of the sight sits, in metres.
     *  Closer makes its rings bigger on screen; at 0.13 the near rim fills
     *  about a third of the screen's height. */
    eyeRelief: 0.13,
    /** How far the view narrows: the tangent of the half-angle is scaled by
     *  this, so 0.8 is a 1.25x zoom. */
    zoom: 0.8,
    /** The same for the weapon's own view: 0.7 draws the rifle and its
     *  sights 1.4x larger with the sights up, which is what makes the ring
     *  read as something to look through rather than a speck. Magnifying
     *  about the middle of the screen leaves the sights where they are. */
    weaponZoom: 0.8,
    /** Seconds from hip to sights, and back. */
    duration: 0.18,
    /** How much of the hip's sway, bob and recoil survives into ADS. */
    swayScale: 0.3,
    bobScale: 0.2,
    recoilScale: 0.55,
    /** How visible the crosshair stays with the sights up. */
    crosshairOpacity: 0.35,
  },

  /** The weapon lagging a turn of the view, and settling. */
  sway: {
    /** Metres of offset per radian turned in a frame. */
    position: 0.035,
    /** Radians of weapon rotation per radian turned in a frame. */
    rotation: 0.45,
    maxPosition: 0.04,
    maxRotation: 0.06,
    /** How fast it settles back, per second. */
    recovery: 9,
  },

  /** Standing still: a slow breath, barely there. */
  idle: {
    position: 0.0015,
    rotation: 0.004,
    /** Breaths per second. */
    rate: 0.22,
  },

  /** Moving: a figure-of-eight driven by distance covered, so it quickens
   *  with speed rather than playing at a fixed rate. */
  bob: {
    /** Metres of sideways travel at full speed; vertical is half this. */
    amount: 0.011,
    roll: 0.012,
    /** Cycles per metre walked. Each cycle is two footfalls. */
    cyclesPerMetre: 0.2,
    /** How fast the bob fades in and out when starting and stopping. */
    fade: 8,
  },

  /** Off the ground: the weapon rides up a little. On landing it dips by an
   *  amount that grows with how hard the landing was. */
  air: { lift: 0.012, rate: 8 },
  land: { dipPerMetrePerSecond: 0.004, maxDip: 0.035, recovery: 10 },

  /**
   * Kick. Visual only: none of this moves the aim that is sent to the server.
   *
   * Each shot pushes the weapon back and up and turns it sideways by the next
   * step of `pattern`, so a burst climbs and wanders the same way every time
   * - learnable, not random. The camera gets a small roll, which shakes the
   * view without moving the crosshair off where the shots are going.
   */
  recoil: {
    back: 0.045,
    rise: 0.05,
    maxRise: 0.18,
    sideways: 0.012,
    roll: 0.02,
    /** Sideways direction of each shot in a burst, in units of `sideways`. */
    pattern: [0, 0.4, -0.6, 0.8, -0.3, 0.6, -0.9, 0.5],
    /** A gap this long between shots starts the pattern again. */
    patternReset: 0.3,
    recovery: 12,
    cameraRoll: 0.006,
    cameraRecovery: 16,
  },

  /** How long the muzzle flash is lit. Shorter than the fire interval, so
   *  rapid fire reads as separate flashes. */
  flashSeconds: 0.04,

  /**
   * The arms, in the viewmodel camera's space (metres; +X right, +Y up, -Z
   * ahead). Each hangs from `shoulder` - below the bottom of the screen, so
   * no shoulder or upper arm is ever seen and the forearm comes up into the
   * frame - and bends its elbow towards `elbow`. The hands close on the
   * rifle the way the third-person soldier's do.
   */
  arms: {
    right: { shoulder: [0.3, -0.5, 0.02], elbow: [0.9, -0.7, 0.3] },
    left: { shoulder: [0.06, -0.5, -0.25], elbow: [-0.7, -0.8, 0.1] },
    /** Where the left palm closes, in model units: under the handguard,
     *  towards its back, where a real support hand sits. */
    leftPalm: [0, -0.2, -0.75],
  },

  /**
   * Spent cases, thrown out of the ejection port to the right and a little
   * up and back, the way a rifle of this pattern throws them. They fly in
   * the world rather than on the screen - turn and they are left behind -
   * bounce once off the floor under the player, and are gone.
   */
  casings: {
    /** The ejection port, in model units: right side of the receiver,
     *  level with the bore, over the magazine well. */
    port: [0.08, 0.08, 0.0],
    /** Metres per second out to the right, and up: a range, so no two
     *  cases take the same path. More up than out, so a case arcs up into
     *  view past the receiver rather than leaving the screen at its edge. */
    speed: [0.9, 1.3],
    lift: [1.6, 2.1],
    /** Metres per second back towards the shooter. */
    back: 0.4,
    /** Radians per second of tumble, at most, on each axis. */
    spin: 28,
    /** A 5.56 case: 5.7 mm across, 45 mm long. */
    radius: 0.0029,
    length: 0.045,
    /** Of its speed, how much a case keeps when it hits the floor. */
    bounce: 0.3,
    seconds: 1.1,
  },

  /**
   * A puff of smoke at the muzzle every shot. It hangs where it was fired -
   * in the world, not on the screen - drifts forward and up, spreads and
   * thins. Faint on purpose, and fainter with the sights up: it is between
   * the eye and the target, and a burst must never become a smoke screen
   * in front of the player's own aim.
   */
  smoke: {
    seconds: 0.9,
    /** Metres across, when it leaves the muzzle and when it is gone. */
    size: [0.06, 0.4],
    opacity: 0.28,
    adsOpacity: 0.1,
    /** Metres per second: along the barrel at first, then rising. */
    drift: 0.7,
    rise: 0.28,
    /** How fast the drift dies away, per second. */
    drag: 3,
  },
};

// ---- every other gun --------------------------------------------------------
//
// Each starts from the rifle and says only what differs: where it sits, how
// long it takes to bring up, how it kicks, what it throws out. Kick is still
// only drawn - none of it moves the aim the server is sent.

function variant(base, changes) {
  const out = { ...base };
  for (const [key, value] of Object.entries(changes)) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value) && base[key]
      ? { ...base[key], ...value }
      : value;
  }
  return out;
}

/** A 9 mm pistol: held out in both hands, near the middle; a sharp, quick
 *  flip of a kick; small cases. */
export const PISTOL = variant(RIFLE, {
  name: 'pistol',
  boreHeight: 0.066,
  muzzleFace: -0.27,
  hip: { position: [0.17, -0.19, -0.42], rotation: [-0.02, 0.07, 0] },
  ads: { eyeRelief: 0.3, duration: 0.14, swayScale: 0.35, bobScale: 0.25, recoilScale: 0.7 },
  sway: { position: 0.03, rotation: 0.4 },
  recoil: {
    back: 0.035,
    rise: 0.13,
    maxRise: 0.22,
    sideways: 0.01,
    roll: 0.025,
    pattern: [0, 0.5, -0.5, 0.4, -0.4],
    patternReset: 0.35,
    recovery: 14,
    cameraRoll: 0.005,
    cameraRecovery: 18,
  },
  flashSeconds: 0.035,
  arms: {
    right: { shoulder: [0.24, -0.5, 0.05], elbow: [0.9, -0.7, 0.2] },
    left: { shoulder: [-0.12, -0.5, 0.0], elbow: [-0.9, -0.8, 0.1] },
    leftPalm: [-0.02, -0.62, 0.48],
  },
  casings: { port: [0.07, 0.13, 0.3], speed: [1.0, 1.4], lift: [1.4, 1.9], radius: 0.0049, length: 0.019 },
  smoke: { size: [0.04, 0.28], opacity: 0.22 },
});

/** A compact SMG: a little further in, quicker to the shoulder, a light
 *  buzz of a kick with more of it sideways. */
export const SMG = variant(RIFLE, {
  name: 'smg',
  muzzleFace: -1.52,
  hip: { position: [0.25, -0.24, -0.42], rotation: [-0.03, 0.08, 0] },
  ads: { duration: 0.15 },
  recoil: {
    back: 0.028,
    rise: 0.03,
    maxRise: 0.14,
    sideways: 0.014,
    roll: 0.016,
    pattern: [0, 0.6, -0.8, 0.9, -0.5, 0.7, -1.0, 0.6],
    patternReset: 0.22,
    recovery: 14,
    cameraRoll: 0.004,
    cameraRecovery: 18,
  },
  flashSeconds: 0.03,
  casings: { port: [0.08, 0.08, 0.05], radius: 0.0027, length: 0.03 },
  smoke: { size: [0.05, 0.32], opacity: 0.22 },
});

/** A belt-fed machine gun: heavy, slow to the shoulder, a deep shove of a
 *  kick that walks. */
export const LMG = variant(RIFLE, {
  name: 'lmg',
  muzzleFace: -3.35,
  hip: { position: [0.29, -0.27, -0.47], rotation: [-0.035, 0.09, 0] },
  ads: { duration: 0.3, swayScale: 0.35 },
  sway: { position: 0.045, rotation: 0.55, recovery: 7 },
  bob: { amount: 0.014 },
  recoil: {
    back: 0.05,
    rise: 0.04,
    maxRise: 0.16,
    sideways: 0.016,
    roll: 0.022,
    pattern: [0, 0.5, -0.7, 0.9, -0.6, 0.8, -1.0, 0.7],
    patternReset: 0.3,
    recovery: 10,
    cameraRoll: 0.007,
    cameraRecovery: 14,
  },
  flashSeconds: 0.045,
  casings: { port: [0.1, 0.0, 0.05], lift: [0.9, 1.3], radius: 0.0029, length: 0.045 },
});

/** A bolt-action .308: long, heavy, a big slow kick, and the case comes out
 *  when the bolt is worked rather than with the shot. */
export const SNIPER = variant(RIFLE, {
  name: 'sniper',
  muzzleFace: -3.6,
  hip: { position: [0.28, -0.26, -0.46], rotation: [-0.03, 0.09, 0] },
  ads: { duration: 0.3, swayScale: 0.25 },
  sway: { position: 0.045, rotation: 0.55, recovery: 7 },
  recoil: {
    back: 0.11,
    rise: 0.15,
    maxRise: 0.3,
    sideways: 0.008,
    roll: 0.035,
    pattern: [0],
    patternReset: 1,
    recovery: 6,
    cameraRoll: 0.018,
    cameraRecovery: 8,
  },
  flashSeconds: 0.06,
  casings: { port: [0.1, 0.1, -0.05], radius: 0.006, length: 0.051, delay: 0.55, seconds: 1.4 },
  smoke: { size: [0.09, 0.55], opacity: 0.32 },
});

export const GUNS = { pistol: PISTOL, smg: SMG, rifle: RIFLE, lmg: LMG, sniper: SNIPER };

/**
 * How each optic is looked through: how far in front of the eye it sits and
 * how much its own view narrows. A magnified optic is looked *through* - at
 * the sights, the picture is the scope's own: the world magnified in a round
 * eyepiece, the reticle over it, and nothing of the gun.
 */
const OPTIC_FEEL = {
  irons: { eyeRelief: null, weaponZoom: 0.85, scoped: false, slower: 0 },
  red_dot: { eyeRelief: 0.13, weaponZoom: 0.8, scoped: false, slower: 0 },
  x2: { eyeRelief: 0.09, weaponZoom: 0.8, scoped: true, slower: 0.03 },
  x3: { eyeRelief: 0.08, weaponZoom: 0.8, scoped: true, slower: 0.05 },
  x4: { eyeRelief: 0.07, weaponZoom: 0.8, scoped: true, slower: 0.07 },
};

/**
 * The feel of `weapon` carrying `optic`, with the sights read off the model
 * that was built for it (`sight`, from `buildGun`): the line the eye aims
 * down, and how much the view narrows - by the optic's own magnification,
 * as the shared table states it.
 */
export function feelFor(weapon, optic, sight, magnification) {
  const base = GUNS[weapon] ?? RIFLE;
  const look = OPTIC_FEEL[optic] ?? OPTIC_FEEL.red_dot;
  return {
    ...base,
    optic: undefined,
    ads: {
      ...base.ads,
      frontSight: sight.front,
      rearSight: sight.rear,
      eyeRelief: look.eyeRelief ?? base.ads.eyeRelief,
      zoom: 1 / magnification,
      weaponZoom: look.weaponZoom,
      duration: base.ads.duration + look.slower,
      scoped: look.scoped,
      opticId: optic,
    },
  };
}
