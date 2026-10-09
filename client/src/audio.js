// The sound of the game.
//
// # Recorded, and synthesised
//
// Gunshots, footsteps, rounds striking, bodies falling and men crying out are
// recordings (`assets/sounds`, cut by `scripts/build-sounds.py` from CC0
// libraries - see ATTRIBUTION.md). They used to be synthesised, to save the
// download, and a synthesised gunshot is what it is: a noise burst with a
// thump under it, which next to photographed maps and real rifles sounded
// like a toy. The recordings are 1.2 MB, fetched at boot with the guns and
// kept for good.
//
// Everything that is a message rather than a sound in the world - the till,
// the hit tick, the countdown - is still synthesised, and so is what has no
// recording worth having: the crack of a round going past, a reload's
// clicks, a landing. So is any gunshot heard before its recording has
// decoded, which is the first second of a page at most.
//
// # Why it matters more than it sounds
//
// Sound is half of knowing where someone is. On a map two hundred and fifty
// metres long, a shot behind you and a shot across the yard have to be
// distinguishable before you can turn the right way, so every shot carries
// four cues a player reads without thinking about them:
//
// * where it came from: placed in three dimensions round the listener's head
//   (an HRTF), so behind is heard as behind and not only as left or right,
// * how far away it was: a gun was recorded beside the shooter and again from
//   out in front, and the two are crossed by distance - near, the crack and
//   the action; far, the boom and the land answering it - and then dulled
//   by the air, which takes the top end long before it takes the volume,
// * when it happened, delayed by the time sound actually takes to arrive.
//   At the far end of the yard that is most of a second, which is long enough
//   to notice and exactly what makes a large space feel large,
// * and, when a round comes close, the crack of it going past, from where it
//   passed - so being shot at is heard as being shot at.
//
// The server decides who shot and from where, as it decides everything else.
// This module only says how it sounded.

import { asset } from './assets.js';
import { SOUND_SETS } from './sound-sets.js';

/** How loud, before the player's own setting. */
const MASTER_GAIN = 0.35;

/** Metres per second. Used for the arrival delay on distant shots. */
const SPEED_OF_SOUND = 343;

/** Past this, a shot is not worth hearing at all - and on a map this size that
 *  is a real saving, since a firefight at the other end would otherwise build a
 *  graph of nodes a frame for nothing. */
const MAX_AUDIBLE = 220;

/** How far away somebody else's reload can be heard, in metres. */
const RELOAD_AUDIBLE = 22;

/** Under this many metres a shot is all its near recording; past `FAR_FROM`,
 *  all its far one; between, the two crossed. */
const NEAR_UNTIL = 14;
const FAR_FROM = 70;

/** Each gun's loudness against the others, recordings being normalised to
 *  the same peak: the sniper rifle is the loudest thing in the game and the
 *  submachine gun the quietest gun in it. */
const LOUDNESS = { rifle: 0.82, lmg: 0.92, smg: 0.6, pistol: 0.68, sniper: 1.0 };

/** The player's own gun, under everybody else's at the same distance - it
 *  would otherwise drown every cue in the match - before `LOUDNESS`. */
const OWN_LOUDNESS = 0.7;

/** How a gun's last shot is put away when it fires again, in seconds: long
 *  enough to keep a burst from sounding dry, short enough that ten shots a
 *  second do not stack ten tails. The last one rings out. */
const STEAL_SECONDS = 0.12;

/** How far footsteps carry, by gait, in metres. A crouched player is nearly
 *  silent: moving slowly to be unheard is a choice, and it should work. */
const STEPS_AUDIBLE = { run: 30, walk: 16, crouch: 6 };

/** Least time between one player's cries of pain, in seconds. */
const PAIN_EVERY = 0.55;

/** Where the player's own weapon sits: close, centred, and not distance-faded.
 *  Passing zero distance through the same path would work, but a rifle at the
 *  shoulder is a different sound from the same rifle heard at one metre. */
const OWN_WEAPON = Symbol('own weapon');

const VOLUME_KEY = 'solatel.volume';

/** Loud enough to be information rather than decoration, for a player who has
 *  never opened the settings. */
const DEFAULT_VOLUME = 0.7;

/** The four men whose voices are in the game; a player keeps one for a match. */
const VOICES = ['a', 'b', 'c', 'd'];

/**
 * How each gun sounds when synthesised - before its recording has decoded -
 * as numbers on the one synthesised shot: the crack's loudness and pitch,
 * the thump of the charge, the body's pitch, how long it all lasts
 * (`length`, on the rifle's), the echo, and the mechanism. Pairs are [up
 * close, far off].
 */
const VOICINGS = {
  rifle: {
    crack: 1.6, crackFrequency: [2200, 1100],
    thump: 1.1, thumpFrequency: [420, 300], thumpDecay: [0.09, 0.13],
    body: [150, 110], bodyGain: 0.9, length: 1,
    tail: [0.34, 0.8], tailGain: [0.3, 0.5],
    mechanism: 3400,
  },
  pistol: {
    crack: 1.3, crackFrequency: [2700, 1400],
    thump: 0.8, thumpFrequency: [540, 380], thumpDecay: [0.06, 0.1],
    body: [190, 140], bodyGain: 0.55, length: 0.75,
    tail: [0.24, 0.6], tailGain: [0.22, 0.38],
    mechanism: 4300,
  },
  smg: {
    crack: 1.2, crackFrequency: [2900, 1500],
    thump: 0.85, thumpFrequency: [500, 350], thumpDecay: [0.06, 0.1],
    body: [175, 128], bodyGain: 0.6, length: 0.8,
    tail: [0.26, 0.6], tailGain: [0.22, 0.4],
    mechanism: 3900,
  },
  lmg: {
    crack: 1.7, crackFrequency: [2000, 1000],
    thump: 1.3, thumpFrequency: [380, 270], thumpDecay: [0.1, 0.15],
    body: [135, 100], bodyGain: 1.0, length: 1.15,
    tail: [0.4, 0.9], tailGain: [0.34, 0.55],
    mechanism: 2900,
  },
  sniper: {
    crack: 2.0, crackFrequency: [1800, 900],
    thump: 1.6, thumpFrequency: [300, 220], thumpDecay: [0.14, 0.2],
    body: [110, 80], bodyGain: 1.2, length: 1.6,
    tail: [0.7, 1.5], tailGain: [0.45, 0.7],
    mechanism: 2400, bolt: true,
  },
};

/** Which of the four voices a player has: from their id, so it is the same
 *  for everybody listening and for the whole match. */
export function voiceOf(id) {
  let h = 2166136261;
  for (const c of String(id ?? '')) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return VOICES[(h >>> 0) % VOICES.length];
}

export class Audio {
  constructor() {
    this.volume = storedVolume();
    this.context = null;
    this.master = null;
    this.noise = null;
    this.failed = false;
    /** Fetched and not yet decoded, by name. */
    this.raw = new Map();
    /** Decoded: `{ buffer, onset }` by name. */
    this.buffers = new Map();
    /** The last variation played from each set, so none plays twice running. */
    this.last = new Map();
    /** Each shooter's sounding shot, to be put away when they fire again. */
    this.voices = new Map();
    /** When each player last cried out. */
    this.cried = new Map();
  }

  /**
   * Fetches every recording, so they are in hand by the time anything is
   * fired. Called at boot; nothing waits on it. Decoding needs the audio
   * device, which a browser only starts from a gesture, so what arrives
   * first is kept and decoded in `resume`.
   */
  preload() {
    if (this._fetching) return this._fetching;
    const names = [...new Set(Object.values(SOUND_SETS).flat())];
    this._fetching = Promise.all(
      names.map(async (name) => {
        try {
          const response = await fetch(asset(`assets/sounds/${name}.mp3`));
          if (!response.ok) return;
          this.raw.set(name, await response.arrayBuffer());
          this._decode(name);
        } catch {
          // A sound that did not arrive is a sound synthesised or not
          // played; nothing in the game waits on one.
        }
      }),
    );
    return this._fetching;
  }

  _decode(name) {
    if (!this.context || !this.raw.has(name)) return;
    const bytes = this.raw.get(name);
    this.raw.delete(name);
    this.context.decodeAudioData(bytes).then(
      (buffer) => this.buffers.set(name, { buffer, onset: onsetOf(buffer) }),
      () => {},
    );
  }

  /**
   * Starts the audio device, which browsers will only do from a gesture.
   *
   * Safe to call on every click: an already-running context is left alone. It
   * has to be called from a real user gesture, so the click that takes pointer
   * lock is the natural place - a player who has not clicked yet is a player
   * who has not started.
   */
  resume() {
    if (this.failed) return;
    try {
      if (!this.context) {
        const Ctor = window.AudioContext ?? window.webkitAudioContext;
        if (!Ctor) {
          this.failed = true;
          return;
        }
        this.context = new Ctor();
        this.master = this.context.createGain();
        this.master.gain.value = MASTER_GAIN * this.volume;
        // Recorded gunshots peak at full scale, and a firefight is several at
        // once: a limiter holds the sum under clipping rather than letting it
        // crackle, and leaves a single shot alone.
        const limiter = this.context.createDynamicsCompressor();
        limiter.threshold.value = -9;
        limiter.knee.value = 6;
        limiter.ratio.value = 8;
        limiter.attack.value = 0.002;
        limiter.release.value = 0.25;
        // Everything passes a low-pass that is wide open, so a death can
        // close it: the world going dull is most of how it sounds.
        this.muffle = this.context.createBiquadFilter();
        this.muffle.type = 'lowpass';
        this.muffle.frequency.value = 20000;
        this.muffle.Q.value = 0.5;
        this.master.connect(limiter).connect(this.muffle).connect(this.context.destination);
        this.noise = whiteNoise(this.context);
        for (const name of [...this.raw.keys()]) this._decode(name);
      }
      if (this.context.state === 'suspended') this.context.resume();
    } catch {
      // No audio device, or a policy that will not allow one. The game is
      // entirely playable without it, so this is not worth failing over.
      this.failed = true;
    }
  }

  /**
   * Killed: the world goes dull and far off, a ring rises in the ears, and
   * one slow heartbeat. `recover` opens it all again.
   */
  dying() {
    if (!this.ready) return;
    const { context } = this;
    const now = context.currentTime;
    this.muffle.frequency.cancelScheduledValues(now);
    this.muffle.frequency.setValueAtTime(this.muffle.frequency.value, now);
    this.muffle.frequency.exponentialRampToValueAtTime(520, now + 0.35);
    // The ring: a pure tone, high, faint, fading over the whole of it.
    const ring = context.createOscillator();
    ring.type = 'sine';
    ring.frequency.value = 3150;
    const ringGain = context.createGain();
    ringGain.gain.setValueAtTime(0.0001, now);
    ringGain.gain.exponentialRampToValueAtTime(0.035 * this.volume, now + 0.25);
    ringGain.gain.exponentialRampToValueAtTime(0.0001, now + 3.2);
    // Straight to the output: it is in the ears, not in the world, so the
    // muffle does not touch it.
    ring.connect(ringGain).connect(context.destination);
    ring.start(now);
    ring.stop(now + 3.3);
    this._heartbeat(context.destination, now + 0.5, MASTER_GAIN * this.volume * 0.5);
  }

  recover() {
    if (!this.ready || !this.muffle) return;
    const now = this.context.currentTime;
    this.muffle.frequency.cancelScheduledValues(now);
    this.muffle.frequency.setValueAtTime(Math.max(this.muffle.frequency.value, 1), now);
    this.muffle.frequency.exponentialRampToValueAtTime(20000, now + 0.6);
  }

  /**
   * One beat of the heart, for a player badly hurt: called by the frame loop
   * about once a second while their health is low, louder the lower it is.
   */
  pulse(strength) {
    if (!this.ready || !(strength > 0)) return;
    this._heartbeat(this.master, this.context.currentTime, 0.9 * Math.min(1, strength));
  }

  /** Two thumps, the second softer, low enough to be felt more than heard. */
  _heartbeat(output, start, level) {
    const { context } = this;
    for (const [at, share] of [[0, 1], [0.28, 0.64]]) {
      const thump = context.createOscillator();
      thump.type = 'sine';
      thump.frequency.setValueAtTime(62, start + at);
      thump.frequency.exponentialRampToValueAtTime(38, start + at + 0.16);
      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, start + at);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, level * share), start + at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + at + 0.22);
      thump.connect(gain).connect(output);
      thump.start(start + at);
      thump.stop(start + at + 0.25);
    }
  }

  get ready() {
    return Boolean(this.context) && this.context.state === 'running';
  }

  setVolume(value) {
    this.volume = Math.min(Math.max(value, 0), 1);
    if (this.master) this.master.gain.value = MASTER_GAIN * this.volume;
    try {
      window.localStorage.setItem(VOLUME_KEY, String(this.volume));
    } catch {
      /* private browsing */
    }
  }

  /**
   * A gunshot.
   *
   * `at` is where it was fired from - an `[x, y, z]` off the wire, the way
   * every position in the protocol arrives - and `listener` is where the
   * player is. Pass `Audio.OWN` as `at` for the player's own weapon.
   * `forward` is the direction they are looking, which is what turns a
   * position into a side. `shooter` names whose gun it was, so their last
   * shot can be put away when the next rings out.
   */
  shot(at, listener, forward, weapon = 'rifle', shooter = null) {
    if (!this.ready) return;
    const place = this.place(at, listener, forward);
    if (!place) return;
    const near = this._has(`${weapon}-near`);
    if (!near) {
      this._synthesisedShot(place, weapon);
      return;
    }
    const { context } = this;
    const start = context.currentTime + place.delay;
    const loud = LOUDNESS[weapon] ?? LOUDNESS.rifle;
    // Every shot through one gain of its own, which is what is turned down
    // when the same gun fires again.
    const voice = context.createGain();
    const rate = 0.97 + Math.random() * 0.06;
    if (at === OWN_WEAPON) {
      voice.connect(place.input);
      this._play(`${weapon}-near`, voice, start, loud * OWN_LOUDNESS, rate);
      this._mechanism(place.input, start, weapon);
    } else {
      // The air between: the further, the less top end - a shot across the
      // yard is a boom, not a crack.
      const air = context.createBiquadFilter();
      air.type = 'lowpass';
      air.frequency.value = Math.max(1600, 19000 * Math.exp(-place.distance / 95));
      air.Q.value = 0.5;
      voice.connect(air).connect(place.input);
      const far = Math.min(1, Math.max(0, (place.distance - NEAR_UNTIL) / (FAR_FROM - NEAR_UNTIL)));
      if (far < 0.99) this._play(`${weapon}-near`, voice, start, loud * place.gain * Math.sqrt(1 - far), rate);
      if (far > 0.01 && this._has(`${weapon}-far`)) {
        // The far recordings were made out in front of the gun at a distance
        // and are quieter for it; brought up to stand in for the near one.
        this._play(`${weapon}-far`, voice, start, loud * place.gain * Math.sqrt(far) * 1.6, rate);
      }
    }
    this._steal(at === OWN_WEAPON ? OWN_WEAPON : shooter, voice, start);
  }

  /** The player's own gun's mechanism: heard only up close, and for a bolt
   *  action, the bolt worked a moment after the shot. The recordings carry
   *  their own action; this is the hand on it. */
  _mechanism(output, start, weapon) {
    const v = VOICINGS[weapon] ?? VOICINGS.rifle;
    if (!v.bolt) return;
    for (const [after, frequency] of [[0.42, 1900], [0.58, 2600]]) {
      this.burst(output, start + after, {
        gain: 0.28, attack: 0.0006, decay: 0.03, type: 'bandpass', frequency, q: 2.4,
      });
    }
  }

  /** Puts away `key`'s last shot as `voice` starts, and remembers `voice`. */
  _steal(key, voice, start) {
    if (key === null || key === undefined) return;
    const old = this.voices.get(key);
    if (old && old !== voice) {
      const at = Math.max(start, this.context.currentTime);
      old.gain.cancelScheduledValues(at);
      old.gain.setValueAtTime(1, at);
      old.gain.linearRampToValueAtTime(0, at + STEAL_SECONDS);
    }
    this.voices.set(key, voice);
  }

  /**
   * The synthesised shot, for before the recordings are in. Four layers,
   * because a gunshot is four things happening at once and any three of them
   * sound like a toy.
   */
  _synthesisedShot(place, weapon) {
    const v = VOICINGS[weapon] ?? VOICINGS.rifle;
    const pick = ([near, far]) => (place.close ? near : far);
    const { context } = this;
    const start = context.currentTime + place.delay;
    const out = place.input;
    const close = place.close;
    this.burst(out, start, {
      gain: v.crack * place.gain, attack: 0.0002, decay: close ? 0.028 : 0.05,
      type: 'highpass', frequency: pick(v.crackFrequency), q: 0.6,
    });
    this.burst(out, start, {
      gain: v.thump * place.gain, attack: 0.0004, decay: pick(v.thumpDecay),
      type: 'bandpass', frequency: pick(v.thumpFrequency), q: 0.8,
    });
    const body = context.createOscillator();
    const bodyGain = context.createGain();
    const bodyFilter = context.createBiquadFilter();
    bodyFilter.type = 'lowpass';
    bodyFilter.frequency.setValueAtTime(close ? 900 : 500, start);
    bodyFilter.frequency.exponentialRampToValueAtTime(90, start + 0.1 * v.length);
    body.type = 'sawtooth';
    body.frequency.setValueAtTime(pick(v.body), start);
    body.frequency.exponentialRampToValueAtTime(38, start + 0.11 * v.length);
    bodyGain.gain.setValueAtTime(0.0001, start);
    bodyGain.gain.exponentialRampToValueAtTime(v.bodyGain * place.gain, start + 0.002);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18 * v.length);
    body.connect(bodyFilter).connect(bodyGain).connect(out);
    body.start(start);
    body.stop(start + 0.2 * v.length);
    this.burst(out, start + (close ? 0.035 : 0.06), {
      gain: pick(v.tailGain) * place.gain, attack: 0.012, decay: pick(v.tail),
      type: 'lowpass', frequency: close ? 1100 : 620, q: 0.4,
    });
    if (close) {
      this.burst(out, start + 0.045, {
        gain: 0.3, attack: 0.0004, decay: 0.022, type: 'bandpass', frequency: v.mechanism, q: 3.0,
      });
      this._mechanism(out, start, weapon);
    }
  }

  /**
   * A round going past within a few metres: the crack of a supersonic round
   * (every gun's but the pistol's, whose .45 is slower than sound and buzzes
   * by instead), from where it passed, louder the closer. It arrives before
   * the shot that sent it, because the round outruns its own report - which
   * is how a player under fire hears it, and the report then says from where.
   */
  crack(at, listener, forward, supersonic, closeness) {
    if (!this.ready) return;
    const place = this.place(at, listener, forward);
    if (!place) return;
    const { context } = this;
    const start = context.currentTime;
    const level = 0.35 + 0.9 * Math.min(1, Math.max(0, closeness));
    if (supersonic) {
      // The shock wave: almost no duration, all top end.
      this.burst(place.input, start, {
        gain: 1.5 * level, attack: 0.0001, decay: 0.009, type: 'highpass', frequency: 2400, q: 0.7,
      });
      this.burst(place.input, start + 0.002, {
        gain: 0.6 * level, attack: 0.0004, decay: 0.03, type: 'bandpass', frequency: 1300, q: 1.1,
      });
    }
    // The zip of it going by, falling in pitch as it passes.
    const source = context.createBufferSource();
    source.buffer = this.noise;
    source.loop = true;
    const band = context.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = supersonic ? 3 : 6;
    band.frequency.setValueAtTime(supersonic ? 3200 : 1500, start);
    band.frequency.exponentialRampToValueAtTime(supersonic ? 900 : 520, start + (supersonic ? 0.07 : 0.16));
    const envelope = context.createGain();
    const length = supersonic ? 0.08 : 0.18;
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(Math.max(0.0002, (supersonic ? 0.5 : 0.9) * level), start + length * 0.35);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + length);
    source.connect(band).connect(envelope).connect(place.input);
    source.start(start, Math.random() * (this.noise.duration - 0.5));
    source.stop(start + length + 0.02);
  }

  /** A round striking the world, at the far end of a shot that missed. */
  impact(at, listener, forward) {
    if (!this.ready) return;
    const place = this.place(at, listener, forward);
    if (!place) return;
    const start = this.context.currentTime + place.delay;
    if (!this._play(Math.random() < 0.18 ? 'hit-metal' : 'hit-ground', place.input, start, 0.7 * place.gain)) {
      this.burst(place.input, start, {
        gain: 0.5 * place.gain, attack: 0.0008, decay: 0.07, type: 'bandpass', frequency: 2600, q: 1.2,
      });
    }
  }

  /** A round into somebody: a heavy, wet blow, from where they stood. */
  fleshHit(at, listener, forward) {
    if (!this.ready) return;
    const place = this.place(at, listener, forward);
    if (!place) return;
    const start = this.context.currentTime + place.delay;
    this._play('hit-flesh', place.input, start, 0.9 * place.gain, 0.92 + Math.random() * 0.12);
  }

  /** Somebody hurt crying out, in their own voice - at most every
   *  `PAIN_EVERY`, or a burst into them would be a stammer. */
  pain(at, listener, forward, id) {
    if (!this.ready) return;
    const now = this.context.currentTime;
    if (now - (this.cried.get(id) ?? -1) < PAIN_EVERY) return;
    const place = this.place(at, listener, forward);
    if (!place) return;
    this.cried.set(id, now);
    this._play(`voice-${voiceOf(id)}-pain`, place.input, now + place.delay, 0.85 * place.gain);
  }

  /** Somebody killed: their last cry, and their body hitting the ground. */
  death(at, listener, forward, id) {
    if (!this.ready) return;
    const place = this.place(at, listener, forward);
    if (!place) return;
    const start = this.context.currentTime + place.delay;
    this.cried.set(id, start);
    this._play(`voice-${voiceOf(id)}-death`, place.input, start, 0.95 * place.gain);
    this._play('fall', place.input, start + 0.55 + Math.random() * 0.2, 0.8 * place.gain);
  }

  /** This player hurt: their own cry, close and quiet, under the thud. */
  ownPain(id) {
    if (!this.ready) return;
    const now = this.context.currentTime;
    if (now - (this.cried.get(id) ?? -1) < PAIN_EVERY) return;
    this.cried.set(id, now);
    this._play(`voice-${voiceOf(id)}-pain`, this.master, now + 0.04, 0.32);
  }

  /**
   * A footstep. `surface` is what was walked on (`concrete`, `grass`,
   * `wood`, `metal`), `gait` how (`run`, `walk`, `crouch`). Somebody else's
   * is placed and fades out by `STEPS_AUDIBLE`; pass `Audio.OWN` for the
   * player's own, which are quiet and centred.
   */
  step(at, listener, forward, surface, gait) {
    if (!this.ready) return;
    const set = this._has(`step-${surface}`) ? `step-${surface}` : 'step-concrete';
    const rate = 0.92 + Math.random() * 0.16;
    if (at === OWN_WEAPON) {
      const level = { run: 0.22, walk: 0.15, crouch: 0.06 }[gait] ?? 0.15;
      this._play(set, this.master, this.context.currentTime, level, rate);
      return;
    }
    const reach = STEPS_AUDIBLE[gait] ?? STEPS_AUDIBLE.walk;
    const dx = at[0] - listener.x;
    const dy = at[1] - listener.y;
    const dz = at[2] - listener.z;
    const distance = Math.hypot(dx, dy, dz);
    if (!(distance < reach)) return;
    const place = this.place(at, listener, forward);
    if (!place) return;
    // Steeper than a gunshot's fall-off: a step is heard round the corner,
    // not across the yard.
    const fade = (1 - distance / reach) ** 1.6;
    const level = ({ run: 1, walk: 0.7, crouch: 0.4 }[gait] ?? 0.7) * fade;
    this._play(set, place.input, this.context.currentTime + place.delay, 0.9 * level, rate);
  }

  /**
   * The player's own shot connected.
   *
   * Deliberately unlike everything else here - a clean tone, centred, with no
   * distance on it. It is not a sound in the world, it is the game telling the
   * player something, and it has to be audible through a firefight.
   */
  hitConfirmed(killed) {
    if (!this.ready) return;
    const { context } = this;
    const now = context.currentTime;
    this.blip(now, killed ? 1180 : 1500, 0.5, 0.07);
    // A kill gets a second, higher note a moment later, so the two are told
    // apart without listening for them.
    if (killed) this.blip(now + 0.075, 1760, 0.45, 0.12);
  }

  /**
   * Money. Played when this player's shot kills someone.
   *
   * A till rather than a tone, and the only sound in the game that means
   * cash. Two struck bells a beat apart, each with an inharmonic partner so
   * they ring like metal instead of a synthesiser, over a short bright
   * shimmer of coin.
   *
   * `streak` is which kill this is in a run of quick ones. Each climbs two
   * semitones and the third onwards strikes a third bell, so a double kill
   * is heard as one without looking at the screen.
   */
  paid(streak = 1) {
    if (!this.ready) return;
    const { context } = this;
    const now = context.currentTime;

    // The shimmer: filtered noise, quick, sitting under the bells.
    this.burst(this.master, now, {
      gain: 0.35,
      attack: 0.002,
      decay: 0.16,
      type: 'bandpass',
      frequency: 5200,
      q: 1.4,
    });

    // Two strikes. The second is higher and a little quieter, which is the
    // shape every till in the world makes.
    const strike = (at, base, gain) => {
      // A bell is a fundamental plus partners that are *not* whole
      // multiples of it. Thirds of a semitone off is enough to stop it
      // sounding like an organ.
      for (const [ratio, share] of [[1, 1], [2.76, 0.42], [5.4, 0.16]]) {
        const osc = context.createOscillator();
        const envelope = context.createGain();
        osc.type = 'sine';
        osc.frequency.value = base * ratio;
        envelope.gain.setValueAtTime(0.0001, at);
        envelope.gain.exponentialRampToValueAtTime(gain * share, at + 0.004);
        // Higher partials die first, as they do on a struck bar.
        envelope.gain.exponentialRampToValueAtTime(0.0001, at + 0.5 / ratio);
        osc.connect(envelope).connect(this.master);
        osc.start(at);
        osc.stop(at + 0.6);
      }
    };
    const lift = 2 ** (Math.min(Math.max(streak, 1) - 1, 4) * (2 / 12));
    strike(now, 1180 * lift, 0.5);
    strike(now + 0.09, 1770 * lift, 0.42);
    if (streak >= 3) strike(now + 0.18, 2360 * lift, 0.34);
  }

  /**
   * The reward reaching the winnings counter: one small, bright tick, far
   * quieter than the till. It closes the moment the till opened.
   */
  landed() {
    if (!this.ready) return;
    const now = this.context.currentTime;
    this.blip(now, 2640, 0.14, 0.05);
    this.blip(now + 0.035, 3960, 0.08, 0.04);
  }

  /**
   * A match has been found. Three rising notes, bright and unmistakable,
   * because the player may be looking at another window while they wait -
   * which is exactly why every matchmaker has a sound for this.
   */
  matchFound() {
    if (!this.ready) return;
    const now = this.context.currentTime;
    this.blip(now, 660, 0.38, 0.14);
    this.blip(now + 0.12, 880, 0.38, 0.14);
    this.blip(now + 0.24, 1320, 0.42, 0.3);
  }

  /** The last seconds of the warm-up: one short tick a second. */
  countdown() {
    if (!this.ready) return;
    this.blip(this.context.currentTime, 740, 0.32, 0.09);
  }

  /** The warm-up is over. Higher and longer than the ticks before it. */
  go() {
    if (!this.ready) return;
    const now = this.context.currentTime;
    this.blip(now, 1480, 0.45, 0.35);
    this.burst(this.master, now, {
      gain: 0.18, attack: 0.002, decay: 0.25, type: 'bandpass', frequency: 3000, q: 0.8,
    });
  }

  /** Taking damage: dull, close and unpleasant, with no direction on it. */
  hurt() {
    if (!this.ready) return;
    const { context } = this;
    const now = context.currentTime;
    this.burst(this.master, now, {
      gain: 0.55,
      attack: 0.002,
      decay: 0.2,
      type: 'lowpass',
      frequency: 420,
      q: 0.6,
    });
    const thud = context.createOscillator();
    const gain = context.createGain();
    thud.type = 'sine';
    thud.frequency.setValueAtTime(160, now);
    thud.frequency.exponentialRampToValueAtTime(52, now + 0.22);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.6, now + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
    thud.connect(gain).connect(this.master);
    thud.start(now);
    thud.stop(now + 0.32);
    this._play('hit-flesh', this.master, now, 0.5, 0.85);
  }

  /**
   * A grenade going off: a crack, a long low roll, and debris after it.
   * Placed like a shot, so it has a side and arrives late from far away.
   */
  boom(at, listener, forward) {
    if (!this.ready) return;
    const place = this.place(at, listener, forward);
    if (!place) return;
    const { context } = this;
    const start = context.currentTime + place.delay;
    const out = place.input;
    this.burst(out, start, {
      gain: 1.8 * place.gain, attack: 0.001, decay: 0.08, type: 'bandpass', frequency: 1400, q: 0.5,
    });
    this.burst(out, start, {
      gain: 2.2 * place.gain, attack: 0.004, decay: 0.9, type: 'lowpass', frequency: 320, q: 0.7,
    });
    const thud = context.createOscillator();
    const gain = context.createGain();
    thud.type = 'sine';
    thud.frequency.setValueAtTime(90, start);
    thud.frequency.exponentialRampToValueAtTime(28, start + 0.6);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(1.4 * place.gain, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.8);
    thud.connect(gain).connect(out);
    thud.start(start);
    thud.stop(start + 0.85);
    this.burst(out, start + 0.25, {
      gain: 0.25 * place.gain, attack: 0.05, decay: 0.4, type: 'highpass', frequency: 2600, q: 0.4,
    });
    // Debris coming down after it.
    for (let i = 0; i < 3; i += 1) {
      this._play('hit-ground', out, start + 0.35 + Math.random() * 0.6, 0.35 * place.gain, 0.8 + Math.random() * 0.3);
    }
  }

  /** The magazine out, and a moment later the new one in and the bolt. */
  reload(seconds) {
    if (!this.ready) return;
    this._reloadClicks(this.master, this.context.currentTime, seconds, 1);
  }

  /**
   * Somebody else changing magazines: the same clicks, from where they
   * stand, and only close enough to matter. A reload is heard across a room,
   * not across a map, and hearing one round a corner is exactly the
   * information a player standing there would have.
   */
  reloadAt(at, listener, forward, seconds) {
    if (!this.ready) return;
    const distance = Math.hypot(at[0] - listener.x, at[1] - listener.y, at[2] - listener.z);
    if (!(distance < RELOAD_AUDIBLE)) return;
    const place = this.place(at, listener, forward);
    if (!place) return;
    const loudness = place.gain * (1 - distance / RELOAD_AUDIBLE);
    this._reloadClicks(place.input, this.context.currentTime + place.delay, seconds, loudness);
  }

  _reloadClicks(output, start, seconds, loudness) {
    const click = (at, frequency, gain) =>
      this.burst(output, at, {
        gain: gain * loudness, attack: 0.001, decay: 0.03, type: 'bandpass', frequency, q: 3,
      });
    click(start + 0.12, 1900, 0.35);
    click(start + seconds * 0.62, 1500, 0.45);
    click(start + seconds * 0.85, 2400, 0.4);
    click(start + seconds * 0.88, 1200, 0.35);
  }

  /** An empty magazine. */
  dryFire() {
    if (!this.ready) return;
    this.burst(this.master, this.context.currentTime, {
      gain: 0.25, attack: 0.001, decay: 0.02, type: 'bandpass', frequency: 2800, q: 4,
    });
  }

  /** Landing. Scaled by how hard, so a hop and a drop are different events. */
  land(speed, surface = 'concrete') {
    if (!this.ready || speed < 1.5) return;
    const force = Math.min(speed / 9, 1);
    this.burst(this.master, this.context.currentTime, {
      gain: 0.1 + 0.35 * force,
      attack: 0.002,
      decay: 0.06 + 0.1 * force,
      type: 'lowpass',
      frequency: 260 + 340 * force,
      q: 0.5,
    });
    // Both feet coming down, the second a beat after the first.
    const set = this._has(`step-${surface}`) ? `step-${surface}` : 'step-concrete';
    const now = this.context.currentTime;
    this._play(set, this.master, now, 0.18 + 0.2 * force, 0.85);
    this._play(set, this.master, now + 0.06, 0.12 + 0.15 * force, 0.9);
  }

  /** Somebody else landing from a height, from where they came down. */
  landAt(at, listener, forward, speed, surface = 'concrete') {
    if (!this.ready || speed < 4) return;
    this.step(at, listener, forward, surface, 'run');
    const place = this.place(at, listener, forward);
    if (!place || place.distance > STEPS_AUDIBLE.run) return;
    const fade = 1 - place.distance / STEPS_AUDIBLE.run;
    this.burst(place.input, this.context.currentTime + place.delay, {
      gain: 0.35 * fade * Math.min(1, speed / 9), attack: 0.002, decay: 0.12, type: 'lowpass', frequency: 420, q: 0.5,
    });
  }

  /**
   * Turns a world position into gain, a place round the listener's head and a
   * delay.
   *
   * The place is an HRTF panner set where the sound is relative to the
   * listener - the listener itself never moves, so nothing has to follow the
   * camera every frame and every browser agrees on where it is. Distance is
   * applied here rather than by the panner, by a curve chosen for the game:
   * not inverse-square, which over two hundred metres takes a shot from
   * deafening to inaudible across the first ten and is useless as a cue.
   *
   * Returns null for anything too far away to bother with, which is also what
   * keeps a distant firefight from costing anything.
   */
  place(at, listener, forward) {
    const { context } = this;
    if (at === OWN_WEAPON) {
      return { gain: 1, delay: 0, close: true, distance: 0, input: this.master };
    }

    // Positions cross the wire as three-element arrays, because that is how
    // glam's Vec3 serialises. Reading them as `.x` gives undefined, which
    // becomes NaN a few lines later and then a non-finite AudioParam.
    const dx = at[0] - listener.x;
    const dy = at[1] - listener.y;
    const dz = at[2] - listener.z;
    const distance = Math.hypot(dx, dy, dz);
    // Also catches a position that did not arrive as expected: NaN fails every
    // comparison, and a NaN reaching an AudioParam throws.
    if (!(distance <= MAX_AUDIBLE)) return null;

    const gain = 1 / (1 + distance / 18);

    // Into the listener's own frame, flat: right, up, and behind (the
    // panner's listener faces -z). The look's pitch is left out, because
    // height tells a player very little and pretending otherwise mostly
    // produces confident wrong answers.
    const flat = Math.hypot(forward.x, forward.z) || 1;
    const fx = forward.x / flat;
    const fz = forward.z / flat;
    const right = dx * -fz + dz * fx;
    const ahead = dx * fx + dz * fz;
    let input;
    if (context.createPanner) {
      const panner = context.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'linear';
      panner.rolloffFactor = 0;
      setPosition(panner, right, dy * 0.5, -ahead);
      panner.connect(this.master);
      input = panner;
    } else {
      input = this.master;
    }

    return {
      gain,
      // Sound takes time to arrive. Across this map that is most of a second,
      // and hearing the shot after seeing the tracer is what the distance
      // actually feels like.
      delay: distance / SPEED_OF_SOUND,
      close: distance < 12,
      distance,
      input,
    };
  }

  /** Whether any of set `name` has decoded. */
  _has(name) {
    const set = SOUND_SETS[name];
    return Boolean(set && set.some((n) => this.buffers.has(n)));
  }

  /**
   * One recording out of set `name`, never the one played last, into
   * `output` at `start`. Returns whether there was one to play.
   */
  _play(name, output, start, gain, rate = 1) {
    const set = SOUND_SETS[name];
    if (!set) return false;
    const ready = set.filter((n) => this.buffers.has(n));
    if (!ready.length) return false;
    const last = this.last.get(name);
    const choices = ready.length > 1 ? ready.filter((n) => n !== last) : ready;
    const pick = choices[Math.floor(Math.random() * choices.length)];
    this.last.set(name, pick);
    const { buffer, onset } = this.buffers.get(pick);
    const { context } = this;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    const level = context.createGain();
    level.gain.value = Math.max(0, gain);
    source.connect(level).connect(output);
    source.start(Math.max(start, context.currentTime), onset);
    return true;
  }

  /**
   * A shaped burst of noise: the building block of nearly everything
   * synthesised here.
   *
   * One reused noise buffer played from a random offset, through one filter,
   * through one envelope. Cheap enough to do several times a second without
   * thinking about it, and every node is short-lived and collected when it
   * stops.
   */
  burst(destination, start, { gain, attack, decay, type, frequency, q }) {
    const { context } = this;
    const source = context.createBufferSource();
    source.buffer = this.noise;
    // A random offset, so a burst of automatic fire is not the same waveform
    // several times in a row - which is audible, and reads as a machine rather
    // than a weapon.
    source.loop = true;
    const filter = context.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = q;
    const envelope = context.createGain();

    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(Math.max(gain, 0.0002), start + attack);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + attack + decay);

    source.connect(filter).connect(envelope).connect(destination);
    source.start(start, Math.random() * (this.noise.duration - 0.5));
    source.stop(start + attack + decay + 0.02);
  }

  /** A short clean tone, for the things that are messages rather than sounds. */
  blip(start, frequency, gain, length) {
    const { context } = this;
    const osc = context.createOscillator();
    const envelope = context.createGain();
    osc.type = 'sine';
    osc.frequency.value = frequency;
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(gain, start + 0.004);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + length);
    osc.connect(envelope).connect(this.master);
    osc.start(start);
    osc.stop(start + length + 0.02);
  }
}

Audio.OWN = OWN_WEAPON;

/** A panner's place: the AudioParams where a browser has them, the old
 *  setter where it does not. */
function setPosition(panner, x, y, z) {
  if (panner.positionX) {
    panner.positionX.value = x;
    panner.positionY.value = y;
    panner.positionZ.value = z;
  } else {
    panner.setPosition(x, y, z);
  }
}

/**
 * Seconds into a decoded recording at which it starts sounding, less a
 * millisecond. An MP3 encoder pads the front of what it encodes, and not
 * every browser's decoder takes the pad off again; a gunshot that starts
 * thirty milliseconds late is a gunshot that feels late.
 */
function onsetOf(buffer) {
  const samples = buffer.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) peak = Math.max(peak, Math.abs(samples[i]));
  const threshold = peak * 0.03;
  for (let i = 0; i < samples.length; i += 1) {
    if (Math.abs(samples[i]) > threshold) return Math.max(0, i / buffer.sampleRate - 0.001);
  }
  return 0;
}

/**
 * One second of white noise, generated once and played from random offsets.
 *
 * Filling a buffer per shot would allocate a hundred kilobytes several times a
 * second during automatic fire, which is exactly the kind of thing that puts
 * the collector in the middle of a firefight.
 */
function whiteNoise(context) {
  const buffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i += 1) samples[i] = Math.random() * 2 - 1;
  return buffer;
}

function storedVolume() {
  try {
    // `getItem` returns null when the key was never set, and `Number(null)` is
    // zero - which passes every range check and mutes the game for everyone
    // who has not touched the slider. The null has to be caught first.
    const raw = window.localStorage.getItem(VOLUME_KEY);
    if (raw !== null) {
      const stored = Number(raw);
      if (Number.isFinite(stored) && stored >= 0 && stored <= 1) return stored;
    }
  } catch {
    /* private browsing */
  }
  return DEFAULT_VOLUME;
}
