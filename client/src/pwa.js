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
    <p class="pwa-brand">SOLATEL</p><h2 id="pwa-title">GET THE BEST SOLATEL EXPERIENCE</h2>
    <div id="pwa-overview"><p>Install Solatel on your home screen for more room to play.</p>
    <ul><li>More screen space for gameplay</li><li>A layout made for landscape</li><li>Quick access from your home screen</li></ul></div>
    <div id="pwa-guide" hidden></div><p id="pwa-note" aria-live="polite"></p>
    <div class="pwa-actions"><button id="pwa-add" type="button">ADD TO HOME SCREEN</button>
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
    if (installed || isInstalled() || activeMatch() || document.body.classList.contains('booting')) return;
    if (!manual && (dismissed || !document.body.classList.contains('in-menu'))) return;
    if (!panel.hidden) return;
    guide.hidden = true; add.hidden = false; note.textContent = '';
    panel.querySelector('#pwa-overview').hidden = false;
    panel.hidden = false;
  };
  const showGuide = () => {
    panel.querySelector('#pwa-overview').hidden = true;
    guide.hidden = false; add.hidden = true;
    guide.innerHTML = ios
      ? `<h3>Install Solatel on iPhone</h3><ol><li>Open Solatel in Safari if you are using another browser.</li><li>Open Safari's Share menu.</li><li>Choose <b>Add to Home Screen</b>.</li><li>Enable <b>Open as Web App</b> where available.</li><li>Tap <b>Add</b>, then launch the new Solatel icon.</li></ol><p>Turn your phone sideways. iOS may still show its status bar and may not lock rotation.</p>`
      : `<h3>Install from your browser</h3><ol><li>Open the browser menu.</li><li>Choose <b>Install app</b> or <b>Add to Home Screen</b>, if offered.</li><li>Confirm, then launch Solatel from the new icon.</li></ol>`;
  };
  add.addEventListener('click', async () => {
    if (!nativePrompt) { showGuide(); return; }
    const prompt = nativePrompt; nativePrompt = null;
    try {
      await prompt.prompt();
      await prompt.userChoice;
      close(); // Only appinstalled confirms installation; accepting a prompt does not.
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
