const KEY = 'solatel.touchOptions.v1';

export const TOUCH_OPTION_DEFAULTS = Object.freeze({
  sensitivity: 115,
  aim: 'toggle',
  crouch: 'toggle',
  sprint: 'toggle',
});

export function normalizeTouchOptions(value) {
  const source = value && typeof value === 'object' ? value : {};
  const sensitivity = Number(source.sensitivity);
  const options = {
    sensitivity: Number.isFinite(sensitivity) && sensitivity > 0
      ? Math.round(Math.max(50, Math.min(250, sensitivity)))
      : TOUCH_OPTION_DEFAULTS.sensitivity,
  };
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
