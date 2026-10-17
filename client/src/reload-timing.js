// A heavy magazine takes time to retrieve and align, not to move every limb.
// Sound and pose use the same clock, keeping the server's total duration.
const POSES = [0, .04, .12, .26, .34, .42, .56, .62, .7, .76, .8, .82, .95, 1];
function times(seconds) {
  const stretch = Math.min(1, seconds / 2.4);
  return [0, .08, .24, .48, .64, seconds - 1.32 * stretch,
    seconds - 1.04 * stretch, seconds - .9 * stretch,
    seconds - .7 * stretch, seconds - .55 * stretch,
    seconds - .44 * stretch, seconds - .36 * stretch,
    seconds - .08 * stretch, seconds];
}
function interpolate(value, from, to) {
  value = Math.max(from[0], Math.min(from.at(-1), value));
  const i = Math.max(1, from.findIndex(x => x >= value));
  return to[i - 1] + (to[i] - to[i - 1]) * (value - from[i - 1]) / (from[i] - from[i - 1]);
}
export function reloadPose(progress, seconds, weapon) {
  return weapon === 'lmg' && seconds >= 2.4
    ? interpolate(progress * seconds, times(seconds), POSES) : progress;
}
export function reloadCue(phase, seconds, weapon) {
  return weapon === 'lmg' && seconds >= 2.4
    ? interpolate(phase, POSES, times(seconds)) : phase * seconds;
}
