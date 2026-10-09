// The whole screen, where the browser allows it.
//
// Conrad asked for the game to cover the whole screen. A browser hands a
// page the whole screen only in answer to a click or a key, so it is asked
// for when a player presses play (unless they turned that off in the
// settings) and by the button in the top bar - never on its own.
//
// In fullscreen the Escape key is locked to the page where the browser can
// do that (`navigator.keyboard.lock`, Chrome and Edge): a short press then
// frees the mouse, as it always did (`input.js`), and holding it leaves
// fullscreen, which the browser says on screen. Without the lock every
// Escape that freed the mouse would also throw the player out of the whole
// screen.

const KEY = 'solatel.fullscreen';

/** Whether to take the whole screen on play: on unless turned off. */
export function fullscreenWanted() {
  try {
    return window.localStorage.getItem(KEY) !== '0';
  } catch {
    return true;
  }
}

export function setFullscreenWanted(on) {
  try {
    window.localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    /* private browsing: it stays on for this page */
  }
}

export function isFullscreen() {
  return Boolean(document.fullscreenElement);
}

/** Takes the whole screen; must be called from a click or a key. */
export async function enterFullscreen() {
  const page = document.documentElement;
  if (document.fullscreenElement || !page.requestFullscreen) return false;
  try {
    await page.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    // Refused - no gesture, an iframe that does not allow it, a phone.
    return false;
  }
  try {
    await navigator.keyboard?.lock?.(['Escape']);
  } catch {
    /* not this browser: Escape leaves fullscreen as well as freeing the mouse */
  }
  return true;
}

export async function exitFullscreen() {
  if (!document.fullscreenElement) return;
  try {
    await document.exitFullscreen();
  } catch {
    /* already gone */
  }
}

export function toggleFullscreen() {
  return isFullscreen() ? exitFullscreen() : enterFullscreen();
}
