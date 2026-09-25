// The sound of the game, synthesised rather than downloaded.
//
// # Why there are no audio files
//
// Every byte in `assets/` is downloaded by every player before they can move,
// and a set of gunshot samples worth having is megabytes. What is here instead
// is a few hundred lines of WebAudio that costs nothing to fetch and nothing to
// decode, and it is not a compromise for the sounds this game actually needs:
// a gunshot is a noise burst with a pitched thump under it, and that is exactly
// what a synthesiser is good at. Samples would win for voices or music. There
// are none.
//
// # Why it matters more than it sounds
//
// Sound is half of knowing where someone is. On a map two hundred and fifty
// metres long, a shot behind you and a shot across the yard have to be
// distinguishable before you can turn the right way, so every shot carries
// three cues a player reads without thinking about them:
//
// * where it came from, panned by the angle to the listener,
// * how far away it was, as loudness and as dullness - distant sound loses its
//   top end to the air long before it loses its volume,
// * and when it happened, delayed by the time sound actually takes to arrive.
//   At the far end of the yard that is most of a second, which is long enough
//   to notice and exactly what makes a large space feel large.
//
// The server decides who shot and from where, as it decides everything else.
// This module only says how it sounded.

/** How loud, before the player's own setting. Kept low: these are synthesised
 *  and synthesised transients are harsher than recorded ones. */
const MASTER_GAIN = 0.35;

/** Metres per second. Used for the arrival delay on distant shots. */
const SPEED_OF_SOUND = 343;

/** Past this, a shot is not worth hearing at all - and on a map this size that
 *  is a real saving, since a firefight at the other end would otherwise build a
 *  graph of nodes a frame for nothing. */
const MAX_AUDIBLE = 220;

/** Where the player's own weapon sits: close, centred, and not distance-faded.
 *  Passing zero distance through the same path would work, but a rifle at the
 *  shoulder is a different sound from the same rifle heard at one metre. */
const OWN_WEAPON = Symbol('own weapon');

const VOLUME_KEY = 'solatel.volume';

/** Loud enough to be information rather than decoration, for a player who has
 *  never opened the settings. */
const DEFAULT_VOLUME = 0.7;

export class Audio {
  constructor() {
    this.volume = storedVolume();
    this.context = null;
    this.master = null;
    this.noise = null;
    this.failed = false;
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
        this.master.connect(this.context.destination);
        this.noise = whiteNoise(this.context);
      }
      if (this.context.state === 'suspended') this.context.resume();
    } catch {
      // No audio device, or a policy that will not allow one. The game is
      // entirely playable without it, so this is not worth failing over.
      this.failed = true;
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
   * A rifle shot.
   *
   * `at` is where it was fired from - an `[x, y, z]` off the wire, the way
   * every position in the protocol arrives - and `listener` is where the
   * player is. Pass `Audio.OWN` as `at` for the player's own weapon.
   * `forward` is the direction they are looking, which is what turns a
   * position into a left or a right.
   *
   * Four layers, because a gunshot is four things happening at once and any
   * three of them sound like a toy.
   */
  shot(at, listener, forward) {
    if (!this.ready) return;
    const place = this.place(at, listener, forward);
    if (!place) return;

    const { context } = this;
    const start = context.currentTime + place.delay;
    const out = place.input;
    const close = place.close;

    // 1. The crack. Almost all of the loudness, almost none of the duration,
    // and no attack worth the name - a pressure wave does not fade in. This
    // is also the layer that carries the direction, because the ear locates
    // high frequencies far better than low ones.
    this.burst(out, start, {
      gain: 1.6 * place.gain,
      attack: 0.0002,
      decay: close ? 0.028 : 0.05,
      type: 'highpass',
      frequency: close ? 2200 : 1100,
      q: 0.6,
    });

    // 2. The blast: the mid-range thump of the charge, band-limited so it
    // reads as coming out of a barrel rather than a speaker.
    this.burst(out, start, {
      gain: 1.1 * place.gain,
      attack: 0.0004,
      decay: close ? 0.09 : 0.13,
      type: 'bandpass',
      frequency: close ? 420 : 300,
      q: 0.8,
    });

    // 3. The body, an octave below anything a sine alone gives: a sawtooth
    // dropping fast, which is what makes a shot land in the chest rather
    // than the ears.
    const body = context.createOscillator();
    const bodyGain = context.createGain();
    const bodyFilter = context.createBiquadFilter();
    bodyFilter.type = 'lowpass';
    bodyFilter.frequency.setValueAtTime(close ? 900 : 500, start);
    bodyFilter.frequency.exponentialRampToValueAtTime(90, start + 0.1);
    body.type = 'sawtooth';
    body.frequency.setValueAtTime(close ? 150 : 110, start);
    body.frequency.exponentialRampToValueAtTime(38, start + 0.11);
    bodyGain.gain.setValueAtTime(0.0001, start);
    bodyGain.gain.exponentialRampToValueAtTime(0.9 * place.gain, start + 0.002);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
    body.connect(bodyFilter).connect(bodyGain).connect(out);
    body.start(start);
    body.stop(start + 0.2);

    // 4. The yard answering. Delayed by the time sound takes to reach the
    // nearest thing worth bouncing off and come back, duller than the shot
    // because a wall absorbs the top end, and longer the further away the
    // shot was.
    this.burst(out, start + (close ? 0.035 : 0.06), {
      gain: (close ? 0.3 : 0.5) * place.gain,
      attack: 0.012,
      decay: close ? 0.34 : 0.8,
      type: 'lowpass',
      frequency: close ? 1100 : 620,
      q: 0.4,
    });

    // The player's own weapon also has a mechanism, and hearing it is most of
    // what makes a gun feel like an object rather than an effect.
    if (close) {
      this.burst(out, start + 0.045, {
        gain: 0.3,
        attack: 0.0004,
        decay: 0.022,
        type: 'bandpass',
        frequency: 3400,
        q: 3.0,
      });
    }
  }

  /** A round striking the world, at the far end of a shot that missed. */
  impact(at, listener, forward) {
    if (!this.ready) return;
    const place = this.place(at, listener, forward);
    if (!place) return;
    this.burst(place.input, this.context.currentTime + place.delay, {
      gain: 0.5 * place.gain,
      attack: 0.0008,
      decay: 0.07,
      type: 'bandpass',
      frequency: 2600,
      q: 1.2,
    });
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
   */
  paid() {
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
    strike(now, 1180, 0.5);
    strike(now + 0.09, 1770, 0.42);
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
  }

  /** Landing. Scaled by how hard, so a hop and a drop are different events. */
  land(speed) {
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
  }

  /**
   * Turns a world position into gain, panning, filtering and a delay.
   *
   * Returns null for anything too far away to bother with, which is also what
   * keeps a distant firefight from costing anything.
   */
  place(at, listener, forward) {
    const { context } = this;
    if (at === OWN_WEAPON) {
      return { gain: 1, delay: 0, close: true, input: this.master };
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

    // Not inverse-square. Real falloff over two hundred metres takes a shot
    // from deafening to inaudible across the first ten, which is useless as a
    // cue; this keeps distant shots present while still ranking them.
    const gain = 1 / (1 + distance / 18);

    // Which side it is on: the component of the direction to the source along
    // the listener's right. Flat, because height tells a player very little
    // and pretending otherwise mostly produces confident wrong answers.
    const right = { x: -forward.z, z: forward.x };
    const length = Math.hypot(dx, dz) || 1;
    const pan = Math.max(-1, Math.min(1, ((dx * right.x + dz * right.z) / length) * 0.85));

    const panner = context.createStereoPanner
      ? context.createStereoPanner()
      : context.createGain();
    if (panner.pan) panner.pan.value = Number.isFinite(pan) ? pan : 0;
    panner.connect(this.master);

    return {
      gain,
      // Sound takes time to arrive. Across this map that is most of a second,
      // and hearing the shot after seeing the tracer is what the distance
      // actually feels like.
      delay: distance / SPEED_OF_SOUND,
      close: distance < 12,
      input: panner,
    };
  }

  /**
   * A shaped burst of noise: the building block of nearly everything here.
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
