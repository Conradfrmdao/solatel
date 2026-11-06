const STORAGE_KEY = 'solatel.touchLayout.v1';
const ACTIONS = ['move', 'sprint', 'grenade', 'fire', 'aim', 'jump', 'crouch', 'reload', 'swap'];
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function readLayout() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY));
    if (!raw || typeof raw !== 'object') return { opacity: 1, controls: {} };
    const controls = {};
    for (const name of ACTIONS) {
      const item = raw.controls?.[name];
      if (Number.isFinite(item?.x) && Number.isFinite(item?.y) && Number.isFinite(item?.scale)) {
        controls[name] = {
          x: clamp(item.x, 0, 1), y: clamp(item.y, 0, 1),
          scale: clamp(item.scale, .7, 1.5),
        };
      }
    }
    return { opacity: Number.isFinite(raw.opacity) ? clamp(raw.opacity, .35, 1) : 1, controls };
  } catch { return { opacity: 1, controls: {} }; }
}

/** Draggable, locally saved phone controls. Percent positions follow viewport
 *  changes; each device keeps its own layout in browser storage. */
export function installTouchLayout(layer, onEditingChange) {
  let layout = readLayout();
  let editing = false;
  let selected = null;
  let drag = null;
  const elements = Object.fromEntries(ACTIONS.map((name) => [name,
    name === 'move' ? layer.querySelector('.touch-stick') : layer.querySelector(`[data-touch="${name}"]`)]));
  const editor = document.createElement('div');
  editor.id = 'touch-editor';
  editor.innerHTML = `<div class="touch-editor-bar">
    <strong>CUSTOMIZE CONTROLS</strong><span>Drag a control to move it. Tap to resize.</span>
    <label>Size <input id="touch-size" type="range" min="70" max="150" value="100"></label>
    <label>Opacity <input id="touch-opacity" type="range" min="35" max="100" value="100"></label>
    <button type="button" id="touch-reset">RESET</button>
    <button type="button" id="touch-done">DONE</button>
  </div>`;
  document.body.append(editor);
  const size = editor.querySelector('#touch-size');
  const opacity = editor.querySelector('#touch-opacity');
  const save = () => {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout)); } catch { /* private browsing */ }
  };
  const place = (name) => {
    const element = elements[name];
    const item = layout.controls[name];
    if (!item) {
      for (const property of ['left', 'top', 'right', 'bottom', 'transform']) element.style[property] = '';
      return;
    }
    const halfW = element.offsetWidth * item.scale / 2 + 4;
    const halfH = element.offsetHeight * item.scale / 2 + 4;
    const bounds = layer.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const safe = getComputedStyle(layer);
    const inset = (edge) => parseFloat(safe.getPropertyValue(`--safe-${edge}`)) || 0;
    const cx = clamp(item.x * bounds.width, halfW + inset('left'), bounds.width - halfW - inset('right'));
    const cy = clamp(item.y * bounds.height, halfH + inset('top'), bounds.height - halfH - inset('bottom'));
    item.x = cx / bounds.width; item.y = cy / bounds.height;
    element.style.left = `${item.x * 100}%`;
    element.style.top = `${item.y * 100}%`;
    element.style.right = 'auto'; element.style.bottom = 'auto';
    element.style.transform = `translate(-50%, -50%) scale(${item.scale})`;
  };
  const apply = () => {
    for (const name of ACTIONS) place(name);
    layer.style.opacity = String(layout.opacity);
    opacity.value = String(Math.round(layout.opacity * 100));
  };
  const choose = (name) => {
    selected = name;
    for (const [key, element] of Object.entries(elements)) element.classList.toggle('touch-selected', key === name);
    size.disabled = false;
    size.value = String(Math.round((layout.controls[name]?.scale ?? 1) * 100));
  };
  const ensure = (name) => {
    if (!layout.controls[name]) {
      const rect = elements[name].getBoundingClientRect();
      const bounds = layer.getBoundingClientRect();
      layout.controls[name] = {
        x: (rect.left + rect.width / 2 - bounds.left) / bounds.width,
        y: (rect.top + rect.height / 2 - bounds.top) / bounds.height,
        scale: 1,
      };
    }
    return layout.controls[name];
  };
  const close = () => {
    editing = false; drag = null;
    document.body.classList.remove('editing-controls');
    for (const element of Object.values(elements)) element.classList.remove('touch-selected');
    onEditingChange(false);
    save();
  };
  const open = () => {
    if (editing) return;
    editing = true; selected = null; size.disabled = true;
    document.body.classList.add('editing-controls');
    onEditingChange(true);
    apply();
  };
  document.addEventListener('solatel:edit-touch', open);
  layer.querySelector('#touch-customize').addEventListener('click', open);
  editor.querySelector('#touch-done').addEventListener('click', close);
  editor.querySelector('#touch-reset').addEventListener('click', () => {
    layout = { opacity: 1, controls: {} };
    selected = null; size.disabled = true;
    for (const element of Object.values(elements)) element.classList.remove('touch-selected');
    apply(); save();
  });
  size.addEventListener('input', () => {
    if (!selected) return;
    ensure(selected).scale = Number(size.value) / 100;
    place(selected); save();
  });
  opacity.addEventListener('input', () => {
    layout.opacity = Number(opacity.value) / 100;
    layer.style.opacity = String(layout.opacity); save();
  });
  for (const [name, element] of Object.entries(elements)) {
    element.addEventListener('pointerdown', (event) => {
      if (!editing) return;
      event.preventDefault();
      choose(name);
      const rect = element.getBoundingClientRect();
      drag = { name, id: event.pointerId,
        offsetX: event.clientX - (rect.left + rect.width / 2),
        offsetY: event.clientY - (rect.top + rect.height / 2) };
      element.setPointerCapture(event.pointerId);
    });
    element.addEventListener('pointermove', (event) => {
      if (!drag || drag.name !== name || drag.id !== event.pointerId) return;
      const item = ensure(name);
      const bounds = layer.getBoundingClientRect();
      item.x = (event.clientX - drag.offsetX - bounds.left) / bounds.width;
      item.y = (event.clientY - drag.offsetY - bounds.top) / bounds.height;
      place(name);
    });
    const stop = (event) => {
      if (!drag || drag.name !== name || drag.id !== event.pointerId) return;
      drag = null; save();
    };
    element.addEventListener('pointerup', stop);
    element.addEventListener('pointercancel', stop);
  }
  window.addEventListener('resize', apply);
  window.addEventListener('solatel:viewport', apply);
  new MutationObserver(() => {
    if (getComputedStyle(layer).display !== 'none') apply();
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  apply();
  return { open, close, get editing() { return editing; } };
}
