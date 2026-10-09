// Pictures of the guns for the menu, drawn from the models themselves.
//
// Drawn ahead of time, by `client/portraits.mjs`, into `assets/menu/guns`
// and `assets/menu/skins`: drawing them in the page, as it once did, held the
// main thread for seconds just as the menu appeared - a second renderer, its
// shaders and its environment - and the menu now loads them as pictures.
//
// The menu says what each gun is, and nothing says it like the gun. So each
// is drawn once, side on, from the same model a player carries (`guns.js`),
// on a small renderer of its own that is thrown away afterwards, and handed
// back as an image the menu can put in a card. A studio's light and its
// reflections, because the guns are photographed steel and wood and steel
// with nothing to reflect is black.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { buildGun } from './guns.js';
import { CLOTH_MATERIAL, dressed } from './skins.js';

const WIDTH = 480;
const HEIGHT = 170;

/**
 * Images of `guns` - [weapon, optic] pairs - as data URLs, by `weapon:optic`.
 * Resolves to an empty map if the browser cannot draw (the menu then shows
 * the cards without pictures, which is what it did before there were any).
 */
export async function portraits(guns, { scale = 1, type = 'image/png', quality } = {}) {
  const out = new Map();
  let renderer;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH * scale;
    canvas.height = HEIGHT * scale;
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(WIDTH * scale, HEIGHT * scale, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.setClearColor(0x000000, 0);

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.55;
    pmrem.dispose();
    // The menu's night: a cool fill from above, a warm key from the front
    // like the key art's sunset, and a rim from behind to cut the outline.
    scene.add(new THREE.HemisphereLight(0xc8d6ea, 0x2a2420, 1.6));
    const key = new THREE.DirectionalLight(0xffd9a0, 3.2);
    key.position.set(2, 3, 4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x9fc4ff, 2.2);
    rim.position.set(-3, 2, -4);
    scene.add(rim);

    for (const [weapon, optic] of guns) {
      const gun = buildGun(weapon, optic);
      // Side on, muzzle to the right, its right side - the ejection port,
      // the handle, the selector - turned a little towards the eye.
      gun.rotation.set(0.0, -Math.PI / 2 - 0.28, 0);
      gun.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(gun);
      const size = box.getSize(new THREE.Vector3());
      const middle = box.getCenter(new THREE.Vector3());
      const across = Math.max(size.x / (WIDTH / HEIGHT), size.y) * 0.52;
      const camera = new THREE.OrthographicCamera(-across * (WIDTH / HEIGHT), across * (WIDTH / HEIGHT), across, -across, 0.1, 100);
      camera.position.set(middle.x, middle.y + across * 0.12, middle.z + 30);
      camera.lookAt(middle.x, middle.y, middle.z);
      scene.add(gun);
      renderer.clear();
      renderer.render(scene, camera);
      out.set(`${weapon}:${optic}`, canvas.toDataURL(type, quality));
      scene.remove(gun);
      // The geometry is the guns' own, shared with every copy: not disposed.
      // Let the page breathe between pictures: a software renderer takes a
      // moment over each.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } catch (error) {
    console.warn('could not draw the guns for the menu', error);
  } finally {
    if (renderer) {
      renderer.dispose();
      renderer.forceContextLoss();
    }
  }
  return out;
}

/** The soldier's pictures: a little taller than wide, as he is. */
const SOLDIER_WIDTH = 180;
const SOLDIER_HEIGHT = 240;

/**
 * Pictures of the soldier in each of `skins`, by skin, as data URLs: the
 * soldier everybody is drawn as (`template`), stood in `pose` - the low ready
 * - three quarters on, under the same studio light as the guns. Resolves to
 * an empty map if the browser cannot draw.
 */
export async function soldierPortraits(template, pose, skins, { scale = 1, type = 'image/png', quality } = {}) {
  const out = new Map();
  let renderer;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = SOLDIER_WIDTH * scale;
    canvas.height = SOLDIER_HEIGHT * scale;
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(SOLDIER_WIDTH * scale, SOLDIER_HEIGHT * scale, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.setClearColor(0x000000, 0);

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.5;
    pmrem.dispose();
    scene.add(new THREE.HemisphereLight(0xc8d6ea, 0x2a2420, 1.4));
    const key = new THREE.DirectionalLight(0xffd9a0, 2.8);
    key.position.set(2, 3, 4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x9fc4ff, 2.0);
    rim.position.set(-3, 2, -4);
    scene.add(rim);

    const body = cloneSkinned(template);
    const mixer = new THREE.AnimationMixer(body);
    if (pose) mixer.clipAction(pose).play();
    mixer.update(0);
    // Three quarters on, facing the light.
    body.rotation.y = 0.5;
    scene.add(body);
    body.updateMatrixWorld(true);
    const camera = new THREE.PerspectiveCamera(24, SOLDIER_WIDTH / SOLDIER_HEIGHT, 0.1, 50);
    camera.position.set(0, 1.0, 5.2);
    camera.lookAt(0, 0.93, 0);
    const meshes = [];
    body.traverse((node) => {
      if (node.isSkinnedMesh) {
        node.frustumCulled = false;
        meshes.push([node, node.material]);
      }
    });
    for (const skin of skins) {
      for (const [mesh, plain] of meshes) {
        mesh.material = dressed(plain, skin, { unit: 1, cloth: plain.name === CLOTH_MATERIAL });
      }
      renderer.clear();
      renderer.render(scene, camera);
      out.set(skin, canvas.toDataURL(type, quality));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    mixer.stopAllAction();
  } catch (error) {
    console.warn('could not draw the soldier for the menu', error);
  } finally {
    if (renderer) {
      renderer.dispose();
      renderer.forceContextLoss();
    }
  }
  return out;
}
