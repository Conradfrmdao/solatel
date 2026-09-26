// The passes a frame goes through after it is drawn.
//
// Rendered into a multisampled half-float target, so edges stay smooth
// through the passes and bright things - the sun on water, a muzzle flash -
// keep their brightness for the bloom to find. Then, in order: ambient
// occlusion (a setting, because it is the expensive one), a restrained
// bloom, tonemapping to the screen, and a light colour grade.

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

/**
 * The last pass: a light colour grade, in display space.
 *
 * A gentle S-curve for contrast, a touch more saturation in the mid-tones,
 * shadows pulled a hair towards blue-green and highlights towards warm - the
 * split every film grade starts from - and a soft vignette that keeps the
 * eye in the middle of the screen, where the crosshair is.
 */
export const GRADE = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      vec3 c = texel.rgb;
      float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(luma), c, 1.08);
      c = c + (c - c * c) * 0.18 * (c - 0.5) * 2.0;
      c += vec3(-0.012, 0.004, 0.014) * (1.0 - luma) + vec3(0.012, 0.004, -0.01) * luma;
      vec2 d = vUv - 0.5;
      c *= 1.0 - dot(d, d) * 0.42;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), texel.a);
    }`,
};

/**
 * The composer, and its ambient occlusion pass so a setting can turn it on
 * and off. Null if the device cannot run it, in which case the caller
 * renders directly.
 */
export function buildPost(renderer, scene, camera) {
  try {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const target = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      samples: 4,
    });
    const composer = new EffectComposer(renderer, target);
    composer.addPass(new RenderPass(scene, camera));
    const ao = new GTAOPass(scene, camera, width, height);
    ao.output = window.location.search.includes('aoonly')
      ? GTAOPass.OUTPUT.Denoise
      : GTAOPass.OUTPUT.Default;
    // The radius is in world metres, and the arena is built at 4x: crates
    // are two metres on a side and doorways three.
    ao.updateGtaoMaterial({
      radius: 2.0,
      distanceExponent: 1.0,
      thickness: 1.0,
      scale: 1.0,
      samples: 16,
    });
    ao.blendIntensity = 1.0;
    composer.addPass(ao);
    // Only what is genuinely bright blooms: glints, the flash, the sky round
    // the sun. A soft haze over everything is what makes a game look cheap.
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(width, height), 0.22, 0.55, 0.92));
    // Tonemapping and colour space are applied once, here: a composer
    // bypasses the renderer's own output stage.
    composer.addPass(new OutputPass());
    composer.addPass(new ShaderPass(GRADE));
    return { composer, aoPass: ao };
  } catch (err) {
    console.warn('post-processing unavailable:', err);
    return null;
  }
}
