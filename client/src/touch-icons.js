// Line icons are SVG so every mobile browser draws the same restrained shapes.
// Text symbols can turn into coloured emoji on iPhone Safari.
const icon = (body) => `<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">${body}</svg>`;

export const TOUCH_ICONS = {
  sprint: icon('<circle cx="19" cy="6" r="2.5"/><path d="m16 11-5 5 4 3 6-5m-5-3 5 1 4 5M15 19l-5 7m10-11 4 5 5 1M9 13l-5 3"/>'),
  grenade: icon('<path d="M12 9h8l3 4v11l-3 3h-8l-3-3V13zM14 9V5h5v4M19 5l3-2 4 2M12 16h9M12 21h9M16 13v11"/>'),
  fire: icon('<path d="M8 23 20 9l5-2-1 5-12 14zM5 12l6-1M4 18l5-1M16 27l1-6"/>'),
  aim: icon('<circle cx="16" cy="16" r="9"/><circle cx="16" cy="16" r="2"/><path d="M16 2v8m0 12v8M2 16h8m12 0h8"/>'),
  jump: icon('<circle cx="16" cy="5" r="2.5"/><path d="M16 10v9m0-7-7-6m7 6 7-6M16 19l-6 5-5-2m11-3 6 4-1 6"/>'),
  crouch: icon('<circle cx="18" cy="8" r="2"/><path d="m16 12-5 5 6 4h7m-7-9 5 4 4 1M11 17l-4 8h7m3-4-1 5h11"/>'),
  reload: icon('<path d="M26 13a10 10 0 1 0 0 7M26 5v8h-8"/>'),
  swap: icon('<path d="M4 10h23m-7-6 7 6-7 6M28 22H5m7-6-7 6 7 6"/>'),
  settings: icon('<circle cx="16" cy="16" r="4"/><path d="M14 3h4l1 4 3 1 3-2 3 3-2 3 1 3 4 1v4l-4 1-1 3 2 3-3 3-3-2-3 1-1 4h-4l-1-4-3-1-3 2-3-3 2-3-1-3-4-1v-4l4-1 1-3-2-3 3-3 3 2 3-1z"/>'),
};
