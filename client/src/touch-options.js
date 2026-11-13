const KEY = 'solatel.touchOptions.v1';

export const TOUCH_OPTION_DEFAULTS = Object.freeze({
  sensitivity: 115,
  adsSensitivity: 90,
  moveSensitivity: 125,
  aim: 'toggle',
  crouch: 'toggle',
  sprint: 'toggle',
});

export function normalizeTouchOptions(value) {
  const source = value && typeof value === 'object' ? value : {};
  const options = {};
  for (const name of ['sensitivity', 'adsSensitivity', 'moveSensitivity']) {
    const value = Number(source[name]);
    options[name] = Number.isFinite(value) && value > 0
      ? Math.round(Math.max(50, Math.min(250, value)))
      : TOUCH_OPTION_DEFAULTS[name];
  }
  for (const action of ['aim', 'crouch', 'sprint']) {
    options[action] = source[action] === 'hold' || source[action] === 'toggle'
      ? source[action] : TOUCH_OPTION_DEFAULTS[action];
  }
  return options;
}

export function readTouchOptions() {
  try { return normalizeTouchOptions(JSON.parse(window.localStorage.getItem(KEY))); }
  catch { return { ...TOUCH_OPTION_DEFAULTS }; }
}

export function writeTouchOptions(options) {
  try { window.localStorage.setItem(KEY, JSON.stringify(normalizeTouchOptions(options))); }
  catch { /* Private browsing keeps these preferences for the open page. */ }
}
