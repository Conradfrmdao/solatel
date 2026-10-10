// Graphics quality: what the picture costs, never what a player can see.
//
// The PRD names browser performance on real devices as a launch risk, and a
// shooter that stutters is worse than one that looks plain. So there are four
// presets and an automatic choice, which is the default: it guesses a level
// from the graphics chip, then steps down while a match is running if the
// frame rate cannot keep up.
//
// The rule every level obeys: a preset changes what drawing the world costs,
// never what can be seen in it. Fog, the far plane, the trees and the players
// are the same at every level. A setting that thinned the foliage or pulled
// the fog in would be a setting that paid to be turned down, in a game that
// pays per kill. Shadows get coarser, never absent, because a shadow round a
// corner is information and "low" must not mean blind to it. Grass is
// planted nearer and sparser on low, which is safe only because it is too
// short to hide anybody (see nature.js).

/** Lowest first, so a step down is one index down. */
export const LEVELS = ['low', 'medium', 'high', 'ultra'];

/**
 * What each level spends.
 *
 * `ratio` caps the device pixel ratio and `scale` multiplies the result, so
 * low draws three quarters of a CSS pixel's worth and a 4K screen at ultra is
 * still capped at two. `post` is the whole composer (multisampled target,
 * grade); without it the frame is drawn straight to the canvas. `bloom` and
 * `ao` are its two expensive passes - ambient occlusion alone measured 60 fps
 * against 23 on an Intel Iris Xe. `shadows` is the shadow map's size in
 * texels over the same area at every level. `grass` is the share of the
 * map's tufts planted - fewer everywhere, never nearer - and `sky` whether
 * birds and chimney smoke are drawn.
 */
export const PRESETS = {
  low: { ratio: 1, scale: 0.75, post: false, bloom: false, ao: false, shadows: 1024, grass: 0.55, sky: false },
  medium: { ratio: 1, scale: 1, post: true, bloom: false, ao: false, shadows: 1024, grass: 0.8, sky: true },
  high: { ratio: 1.5, scale: 1, post: true, bloom: true, ao: false, shadows: 2048, grass: 1, sky: true },
  ultra: { ratio: 2, scale: 1, post: true, bloom: true, ao: true, shadows: 4096, grass: 1, sky: true },
};

const CHOICE_KEY = 'solatel.quality';
const AUTO_KEY = 'solatel.quality.auto';

/** Frames per second under which, sustained, the automatic choice steps down. */
const STEP_DOWN_FPS = 48;

/** How long a stretch of play the frame rate is judged over. */
const WINDOW_MS = 5000;

/** After a step, how long before the next judgement: the new level needs a
 *  moment for its first frames, and a shader compiling is not a slow machine. */
const SETTLE_MS = 4000;

function read(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null; // private browsing
  }
}

function write(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private browsing */
  }
}

/**
 * A first guess from what the browser says about the graphics chip.
 *
 * Deliberately never ultra - ambient occlusion is the one pass that halves
 * the frame rate on ordinary hardware, and a player should choose it - and
 * deliberately rough: the frame rate in a real match corrects it.
 */
export function guessLevel(renderer) {
  let chip = '';
  try {
    const gl = renderer.getContext();
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    chip = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
  } catch {
    /* no answer is an answer: use the middle */
  }
  if (/swiftshader|llvmpipe|software|basic render/i.test(chip)) return 'low';
  const phone = /android|iphone|ipad|mobile/i.test(navigator.userAgent);
  if (phone || /mali|adreno|powervr|apple gpu/i.test(chip)) return 'low';
  // Integrated graphics shares memory and power with the processor.
  if (/intel|uhd|iris|radeon\(tm\) graphics|vega \d+ graphics/i.test(chip)) return 'medium';
  if ((navigator.hardwareConcurrency ?? 8) <= 4) return 'medium';
  return 'high';
}

/**
 * The player's choice - `auto` or a level - and the level in force.
 *
 * `apply(level)` is the caller's: it is what actually changes the renderer,
 * and it is called whenever the level in force changes.
 */
export class Quality {
  constructor(renderer, apply, { forced = null } = {}) {
    this.apply = apply;
    const stored = read(CHOICE_KEY);
    /** 'auto', or one of LEVELS. A `?quality=` in the address wins, so a
     *  script can measure one level without touching anybody's setting. */
    this.choice = LEVELS.includes(forced) ? forced : LEVELS.includes(stored) ? stored : 'auto';
    /** What auto settled on last time, so a slow machine does not start
     *  every session too high and stutter its way back down. */
    const remembered = read(AUTO_KEY);
    this.autoLevel = LEVELS.includes(remembered) ? remembered : guessLevel(renderer);
    /** Why the level is what it is, for the settings pane. */
    this.reason = LEVELS.includes(remembered) ? 'remembered for this machine' : 'picked for this machine';
    this.level = null;
    this._frames = [];
    this._judgeAfter = 0;
    this.onChange = null;
    this._use(this.choice === 'auto' ? this.autoLevel : this.choice);
  }

  /** The player picked something in the settings. */
  choose(choice) {
    if (choice !== 'auto' && !LEVELS.includes(choice)) return;
    this.choice = choice;
    write(CHOICE_KEY, choice);
    this._use(choice === 'auto' ? this.autoLevel : choice);
  }

  /** One line for the settings pane saying what is in force and why. */
  describe() {
    if (this.choice !== 'auto') return 'your choice';
    return `${this.level}, ${this.reason}`;
  }

  /**
   * One frame's time, while a match is being drawn. Only the automatic
   * choice listens, and it only ever steps down: stepping back up on a good
   * stretch would oscillate, and a player who wants more can ask.
   */
  sample(now, frameMs) {
    if (this.choice !== 'auto' || now < this._judgeAfter) return;
    // A frame longer than a quarter of a second is a stall - a tab switch, a
    // map arriving - not a measure of the machine.
    if (frameMs > 250) return;
    this._frames.push([now, frameMs]);
    const first = this._frames[0][0];
    if (now - first < WINDOW_MS) return;
    const times = this._frames.map(([, ms]) => ms).sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    this._frames.length = 0;
    const fps = 1000 / median;
    const index = LEVELS.indexOf(this.level);
    if (fps < STEP_DOWN_FPS && index > 0) {
      this.autoLevel = LEVELS[index - 1];
      this.reason = `lowered to keep the frame rate up (it was ${Math.round(fps)} fps)`;
      write(AUTO_KEY, this.autoLevel);
      this._use(this.autoLevel);
    }
  }

  /** Start judging afresh, for a new match or a changed window. */
  reset(now) {
    this._frames.length = 0;
    this._judgeAfter = now + SETTLE_MS;
  }

  _use(level) {
    const changed = level !== this.level;
    this.level = level;
    this._frames.length = 0;
    this._judgeAfter = performance.now() + SETTLE_MS;
    if (changed) this.apply(level, PRESETS[level]);
    this.onChange?.();
  }
}
