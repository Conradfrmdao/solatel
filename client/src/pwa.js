export function isInstalled() {
  return Boolean(window.matchMedia?.('(display-mode: standalone)').matches ||
    window.matchMedia?.('(display-mode: fullscreen)').matches || navigator.standalone === true);
}

// This game needs a live connection. No service worker intercepts or caches
// multiplayer, account, payment or wallet traffic.
export function initInstallation() {
  if (!window.matchMedia?.('(pointer: coarse)').matches) return;
  let nativePrompt = null;
  let installed = isInstalled();
  document.body.classList.toggle('installed-app', installed);
  let dismissed = false;
  try { dismissed = sessionStorage.getItem('solatel.install.dismissed') === '1'; } catch { /* private mode */ }
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const panel = document.createElement('div');
  panel.id = 'pwa-install'; panel.hidden = true;
  panel.innerHTML = `<section role="dialog" aria-modal="true" aria-labelledby="pwa-title">
    <p class="pwa-brand">SOLATEL</p><h2 id="pwa-title">${ios ? 'PLAY FROM YOUR HOME SCREEN' : 'INSTALL SOLATEL'}</h2>
    <div id="pwa-overview"><p>${ios ? 'In Safari, tap Share, then Add to Home Screen. Open the Solatel icon to play with more screen space.' : 'Add Solatel to your home screen for more room to play. No app-store download is needed.'}</p>
    <ul><li>More screen space for gameplay</li><li>A layout made for landscape</li><li>Quick access from your home screen</li></ul></div>
    <div id="pwa-guide" hidden></div><p id="pwa-note" aria-live="polite"></p>
    <div class="pwa-actions"><button id="pwa-add" type="button">${ios ? 'SHOW INSTALL STEPS' : 'ADD TO HOME SCREEN'}</button>
    <button id="pwa-dismiss" type="button">CONTINUE IN BROWSER</button></div></section>`;
  document.body.append(panel);
  const add = panel.querySelector('#pwa-add');
  const guide = panel.querySelector('#pwa-guide');
  const note = panel.querySelector('#pwa-note');
  const activeMatch = () => document.body.classList.contains('running') || document.body.classList.contains('dying');
  const close = () => {
    panel.hidden = true; dismissed = true;
    try { sessionStorage.setItem('solatel.install.dismissed', '1'); } catch { /* private mode */ }
  };
  const show = (manual = false) => {
    if (installed || isInstalled() || activeMatch()) return;
    if (!manual && dismissed) return;
    if (!panel.hidden) return;
    guide.hidden = true; add.hidden = false; note.textContent = '';
    panel.querySelector('#pwa-overview').hidden = false;
    panel.hidden = false;
  };
  const showGuide = () => {
    panel.querySelector('#pwa-overview').hidden = true;
    guide.hidden = false; add.hidden = true;
    guide.innerHTML = ios
      ? `<h3>Three steps in Safari</h3><ol><li>Tap <b>Share</b> in Safari's toolbar. If it is inside the browser menu, open that menu first.</li><li>Scroll through the actions and choose <b>Add to Home Screen</b>. Leave <b>Open as Web App</b> enabled if shown.</li><li>Tap <b>Add</b>, then open <b>Solatel</b> from your home screen.</li></ol><p>Turn your phone sideways when you enter a match. If it will not turn, switch off Portrait Orientation Lock in Control Center.</p>`
      : `<h3>Install from your browser</h3><ol><li>Open the browser menu.</li><li>Choose <b>Install app</b> or <b>Add to Home Screen</b>, if offered.</li><li>Confirm, then launch Solatel from the new icon.</li></ol>`;
  };
  add.addEventListener('click', async () => {
    if (!nativePrompt) { showGuide(); return; }
    const prompt = nativePrompt; nativePrompt = null;
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice.outcome === 'accepted') close();
      else note.textContent = 'You can install later from Settings, or continue in your browser.';
    } catch { showGuide(); }
  });
  panel.querySelector('#pwa-dismiss').addEventListener('click', close);
  window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); nativePrompt = event; });
  window.addEventListener('appinstalled', () => { installed = true; document.body.classList.add('installed-app'); close(); });
  document.addEventListener('solatel:install', () => show(true));
  new MutationObserver(() => {
    if (activeMatch()) panel.hidden = true;
    else show();
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  show();
}
