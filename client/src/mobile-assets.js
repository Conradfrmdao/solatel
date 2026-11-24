// Same geometry and image dimensions; only the GPU storage format differs.
export function mobileTextures() {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.('(pointer: coarse)').matches);
}

export function terminalPropPath(name) {
  return `assets/${mobileTextures() ? 'mobile/' : ''}props/${name}.glb`;
}
