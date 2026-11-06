export function initViewport() {
  const update = () => {
    const viewport = window.visualViewport;
    document.documentElement.style.setProperty('--app-height', `${Math.round(viewport?.height ?? innerHeight)}px`);
    document.documentElement.style.setProperty('--app-width', `${Math.round(viewport?.width ?? innerWidth)}px`);
    window.dispatchEvent(new Event('solatel:viewport'));
  };
  window.addEventListener('resize', update);
  window.visualViewport?.addEventListener('resize', update);
  window.addEventListener('orientationchange', update);
  update();
}
