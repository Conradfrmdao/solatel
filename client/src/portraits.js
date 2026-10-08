// Pictures of the guns for the menu, drawn from the models themselves.
//
// The menu says what each gun is, and nothing says it like the gun. So each
// is drawn once, side on, from the same model a player carries (`guns.js`),
// on a small renderer of its own that is thrown away afterwards, and handed
// back as an image the menu can put in a card. Nothing is downloaded.

import * as THREE from 'three';
import { buildGun } from './guns.js';

const WIDTH = 480;
const HEIGHT = 170;

/**
 * Images of `guns` - [weapon, optic] pairs - as data URLs, by `weapon:optic`.
 * Resolves to an empty map if the browser cannot draw (the menu then shows
 * the cards without pictures, which is what it did before there were any).
 */
export async function portraits(guns) {
  const out = new Map();
  let renderer;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(WIDTH, HEIGHT, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.setClearColor(0x000000, 0);

    const scene = new THREE.Scene();
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
      // Side on, muzzle to the right, turned a little towards the eye.
      gun.rotation.set(0.0, Math.PI / 2 + 0.28, 0);
      gun.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(gun);
      const size = box.getSize(new THREE.Vector3());
      const middle = box.getCenter(new THREE.Vector3());
      const across = Math.max(size.x / (WIDTH / HEIGHT), size.y) * 0.56;
      const camera = new THREE.OrthographicCamera(-across * (WIDTH / HEIGHT), across * (WIDTH / HEIGHT), across, -across, 0.1, 100);
      camera.position.set(middle.x, middle.y + across * 0.12, middle.z + 30);
      camera.lookAt(middle.x, middle.y, middle.z);
      scene.add(gun);
      renderer.clear();
      renderer.render(scene, camera);
      out.set(`${weapon}:${optic}`, canvas.toDataURL('image/png'));
      scene.remove(gun);
      gun.traverse((node) => node.geometry?.dispose());
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
