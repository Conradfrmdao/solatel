export function initViewport() {
  const update = () => {
    const viewport = window.visualViewport;
    // VisualViewport becomes the tiny visible slice of a pinch-zoomed page.
    // Keep game surfaces at layout size if a browser still allows zooming.
    const zoomed = viewport && Math.abs(viewport.scale - 1) > 0.01;
    document.documentElement.style.setProperty('--app-height', `${Math.round(zoomed ? innerHeight : viewport?.height ?? innerHeight)}px`);
    document.documentElement.style.setProperty('--app-width', `${Math.round(zoomed ? innerWidth : viewport?.width ?? innerWidth)}px`);
    window.dispatchEvent(new Event('solatel:viewport'));
  };
  // iOS Safari can ignore the viewport scale limit. Cancel only multi-touch
  // browser gestures; single-finger scrolling in menus still works.
  for (const name of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(name, (event) => event.preventDefault(), { passive: false });
  }
  document.addEventListener('touchmove', (event) => {
    if (event.touches.length > 1) event.preventDefault();
  }, { passive: false });
  window.addEventListener('resize', update);
  window.visualViewport?.addEventListener('resize', update);
  window.addEventListener('orientationchange', update);
  update();
}
