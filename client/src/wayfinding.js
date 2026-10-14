// Industrial identification panels fixed to real walls. These are surface
// details: no new cover, obstruction or client-only collision. A panel is
// omitted unless its whole footprint is supported by the same flat wall.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { lightMaterial } from './light.js';

const LABELS = {
  facility: [
    ['01', 'PROCESSING', 'INDUSTRIAL OPERATIONS', '#d3a55f'],
    ['02', 'CONTROL', 'AUTHORIZED PERSONNEL', '#7fa4ad'],
    ['03', 'LOGISTICS', 'RECEIVING / DISPATCH', '#d3a55f'],
    ['04', 'MAINTENANCE', 'TECHNICAL SERVICES', '#7fa4ad'],
    ['05', 'WEST GATE', 'FACILITY PERIMETER', '#d3a55f'],
    ['06', 'EAST GATE', 'FACILITY PERIMETER', '#7fa4ad'],
  ],
  yard: [
    ['01', 'NORTH YARD', 'SOLATEL FREIGHT TERMINAL', '#d3a55f'],
    ['02', 'RECEIVING', 'KEEP ACCESS CLEAR', '#7fa4ad'],
    ['03', 'TRANSFER', 'SOLATEL FREIGHT TERMINAL', '#d3a55f'],
    ['04', 'STORAGE', 'AUTHORIZED PERSONNEL', '#7fa4ad'],
    ['05', 'DISPATCH', 'KEEP ACCESS CLEAR', '#d3a55f'],
    ['06', 'SOUTH YARD', 'SOLATEL FREIGHT TERMINAL', '#7fa4ad'],
  ],
  arena: [
    ['A', 'TRAINING', 'SOLATEL / LIVE FIRE RANGE', '#d3a55f'],
    ['B', 'OVERWATCH', 'SOLATEL / LIVE FIRE RANGE', '#7fa4ad'],
    ['C', 'CROSSING', 'SOLATEL / LIVE FIRE RANGE', '#d3a55f'],
    ['D', 'SOUTH BLOCK', 'SOLATEL / LIVE FIRE RANGE', '#7fa4ad'],
  ],
};

function atlas(labels) {
  const canvas = document.createElement('canvas');
  canvas.width = 2048;
  canvas.height = 1024;
  const c = canvas.getContext('2d');
  labels.forEach(([number, name, subtitle, accent], i) => {
    c.save();
    c.translate((i % 2) * 1024, Math.floor(i / 2) * 256);
    c.fillStyle = '#1e292d';
    c.fillRect(0, 0, 1024, 256);
    c.fillStyle = accent;
    c.fillRect(12, 12, 190, 232);
    c.fillStyle = '#182327';
    c.font = '800 144px "Saira Condensed", sans-serif';
    c.textAlign = 'center';
    c.fillText(number, 106, 188);
    c.textAlign = 'left';
    c.fillStyle = '#e8e5dc';
    c.font = '600 65px "Saira Condensed", sans-serif';
    c.fillText(name, 230, 117, 755);
    c.fillStyle = accent;
    c.fillRect(232, 140, 735, 3);
    c.fillStyle = '#b7c2c3';
    c.font = '500 25px Barlow, sans-serif';
    c.fillText(subtitle, 234, 195, 730);
    // Fasteners and restrained wear; legibility matters more than distress.
    for (const x of [23, 1001]) for (const y of [23, 233]) {
      c.fillStyle = '#647074';
      c.beginPath(); c.arc(x, y, 5, 0, Math.PI * 2); c.fill();
    }
    let seed = i + 1;
    for (let n = 0; n < 350; n += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const x = seed % 1024;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      c.fillStyle = 'rgba(0,0,0,0.09)';
      c.fillRect(x, seed % 256, 1 + (seed % 5), 1);
    }
    c.restore();
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

export function addWayfinding(map, name) {
  const labels = LABELS[name];
  if (!labels) return;
  map.updateMatrixWorld(true);
  const walls = [];
  map.traverse((node) => {
    if (node.isMesh && node.visible && !node.userData.collision_only
      && !node.userData.scenery && !node.isInstancedMesh) walls.push(node);
  });
  const ray = new THREE.Raycaster();
  const up = new THREE.Vector3(0, 1, 0);
  const panels = [];
  const placed = [];
  const views = [];
  const inverse = map.matrixWorld.clone().invert();
  // Origins in game metres, outside the intended wall. Facility names match
  // the authored buildings; the other maps use their north/south sectors.
  const candidates = name === 'facility' ? [
    [[-20, 4.6, 12], [0, 0, 1]], [[25, 5.5, 14], [0, 0, 1]],
    [[104, 6, -118], [0, 0, 1]], [[110, 5.8, -66], [0, 0, 1]],
    [[-65, 2.4, -18], [1, 0, 0]], [[65, 2.4, -30], [-1, 0, 0]],
  ] : name === 'yard' ? [
    [[-20, 2.6, -65], [-1, 0, 0]], [[20, 2.6, -55], [1, 0, 0]],
    [[-20, 2.6, -10], [-1, 0, 0]], [[20, 2.6, 10], [1, 0, 0]],
    [[-20, 2.6, 55], [-1, 0, 0]], [[20, 2.6, 65], [1, 0, 0]],
  ] : [
    [[-10, 2.6, -20], [-1, 0, 0]], [[10, 2.6, -20], [1, 0, 0]],
    [[-10, 2.6, 20], [-1, 0, 0]], [[10, 2.6, 20], [1, 0, 0]],
  ];
  candidates.forEach(([origin, direction], index) => {
    ray.set(new THREE.Vector3(...origin), new THREE.Vector3(...direction));
    ray.near = 0.1; ray.far = name === 'facility' ? 10 : 28;
    const hit = ray.intersectObjects(walls, false)[0];
    if (!hit?.face) return;
    const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    if (Math.abs(normal.y) > 0.08) return;
    if (normal.dot(ray.ray.direction) > 0) normal.negate();
    if (placed.some((point) => point.distanceTo(hit.point) < 7)) return;
    const horizontal = new THREE.Vector3().crossVectors(up, normal).normalize();
    const width = name === 'facility' ? 5.6 : 2.4;
    const height = width / 4;
    // Nine samples catch door/window apertures as well as panel overhangs.
    for (const x of [-0.5, 0, 0.5]) for (const y of [-0.5, 0, 0.5]) {
      const point = hit.point.clone().addScaledVector(horizontal, x * width)
        .addScaledVector(up, y * height);
      ray.set(point.clone().addScaledVector(normal, 0.25), normal.clone().negate());
      ray.near = 0; ray.far = 0.32;
      const support = ray.intersectObjects(walls, false)[0];
      if (!support || support.point.distanceTo(point) > 0.025) return;
    }
    const geometry = new THREE.PlaneGeometry(width, height);
    const uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i += 1) {
      uv.setXY(i, (index % 2 + uv.getX(i)) / 2,
        1 - (Math.floor(index / 2) + 1 - uv.getY(i)) / 4);
    }
    const pose = new THREE.Matrix4().makeBasis(horizontal, up, normal);
    pose.setPosition(hit.point.clone().addScaledVector(normal, 0.015));
    geometry.applyMatrix4(inverse.clone().multiply(pose));
    panels.push(geometry);
    placed.push(hit.point.clone());
    views.push({ at: hit.point.toArray(), normal: normal.toArray(), label: labels[index][1] });
  });
  if (!panels.length) return;
  const material = lightMaterial(new THREE.MeshStandardMaterial({
    map: atlas(labels), roughness: 0.82, metalness: 0.08,
  }));
  const mesh = new THREE.Mesh(mergeGeometries(panels), material);
  mesh.name = 'industrial-wayfinding';
  mesh.userData.scenery = true;
  mesh.receiveShadow = true;
  map.add(mesh);
  map.userData.wayfinding = views;
  for (const geometry of panels) geometry.dispose();
}
