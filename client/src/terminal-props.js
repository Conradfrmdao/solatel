// Offline-packaged, CC0 PBR assets. Instanced by mesh: repeats cost no extra draws.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptSimplifier } from 'three/examples/jsm/libs/meshopt_simplifier.module.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { asset } from './assets.js';
import { lightMaterial } from './light.js';

// Separate draw bounds let the renderer skip off-camera sections of the
// terminal. Geometry/materials are still shared, and no props are removed.
const PROP_CELL = 24;

export async function terminalFloor() {
  const gltf = await new GLTFLoader().loadAsync(asset('assets/props/smooth_concrete_floor.glb'));
  const material = (await gltf.parser.getDependency('material',0)).clone();
  material.name = 'terminal_floor';
  // Keep the calibrated mean reflectance used by the offline light bake,
  // while retaining the scan's actual scuffs, scratches and roughness.
  const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;
  const context=canvas.getContext('2d',{willReadFrequently:true});
  context.drawImage(material.map.image,0,0,64,64);
  const pixels=context.getImageData(0,0,64,64).data;
  const average=[0,0,0];
  const linear=v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4;
  for(let i=0;i<pixels.length;i+=4) for(let c=0;c<3;c++) average[c]+=linear(pixels[i+c]/255)/(64*64);
  material.color.setRGB(.255/average[0],.264/average[1],.23/average[2]);
  material.roughness=.48;
  material.flatShading=true;
  material.metalness=0;
  material.normalScale.setScalar(.07);
  for(const key of ['map','normalMap','roughnessMap','metalnessMap','aoMap']) {
    const texture=material[key];if(!texture)continue;
    texture.wrapS=texture.wrapT=THREE.RepeatWrapping;
    texture.anisotropy=8;
    texture.needsUpdate=true;
  }
  lightMaterial(material);
  const lightCompile=material.onBeforeCompile;
  material.onBeforeCompile=function(shader,renderer) {
    lightCompile.call(this,shader,renderer);
    // A sealed warehouse finish keeps the scan's cracks and wear without
    // the source's strong brown mottling. Preserve its calibrated mean.
    shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',
      '#include <map_fragment>\n diffuseColor.rgb=mix(vec3(.255,.264,.23),diffuseColor.rgb,.32);');
  };
  material.customProgramCacheKey=()=> 'terminal-sealed-floor-v1';
  return material;
}

export async function dressTerminal(map) {
  const placements = map.userData.terminal_props;
  if (!placements?.length) return;
  await MeshoptSimplifier.ready;
  const loader = new GLTFLoader();
  const kinds = [...new Set(placements.map(p => p.model))];
  const sources = await Promise.all(kinds.map(name => loader.loadAsync(asset(`assets/props/${name}.glb`))));
  const result = new THREE.Group();
  result.name = 'terminal-pbr-props';
  const rotation = new THREE.Quaternion();
  const axis = new THREE.Vector3(0, 1, 0);
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  kinds.forEach((name, i) => {
    const source = sources[i].scene;
    // This download contains an open and a closed demonstration copy side
    // by side. Only the closed case is solid cover in this map.
    if (name === 'old_military_crate') {
      for (const node of [...source.children]) if (node.name.endsWith('_b')) source.remove(node);
    }
    source.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(source);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const copies = placements.filter(p => p.model === name);
    const foliage=name.startsWith('fern_') || name.startsWith('potted_');
    // Plants and the numerous cargo cases benefit from spatial culling.
    // Sparse fixtures/tool chests stay global to avoid excess draw calls.
    const spatial = foliage || name === 'old_military_crate';
    const cells = new Map();
    for (const p of copies) {
      const key = spatial ? `${Math.floor(p.at[0] / PROP_CELL)},${Math.floor(p.at[2] / PROP_CELL)}` : 'all';
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(p);
    }
    const partsByMaterial = new Map();
    source.traverse(part => {
      if (!part.isMesh) return;
      for (const material of [part.material].flat()) {
        lightMaterial(material);
        for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) {
          if (material[key]) material[key].anisotropy = 4;
        }
      }
      const geometry = part.geometry.clone().applyMatrix4(part.matrixWorld);
      if(foliage && geometry.index && geometry.index.count>12000) {
        const attribute=geometry.attributes.position;
        const points=new Float32Array(attribute.count*3);
        for(let v=0;v<attribute.count;v++)points.set([attribute.getX(v),attribute.getY(v),attribute.getZ(v)],v*3);
        const target=Math.floor(geometry.index.count*(name.startsWith('potted_')?.25:.55)/3)*3;
        const [indices]=MeshoptSimplifier.simplify(Uint32Array.from(geometry.index.array),points,3,target,.012);
        geometry.setIndex(new THREE.BufferAttribute(indices,1));
      }
      geometry.translate(-centre.x, -box.min.y, -centre.z);
      geometry.scale(1 / size.x, 1 / size.y, 1 / size.z);
      const key = Array.isArray(part.material) ? part.uuid : part.material.uuid;
      if (!partsByMaterial.has(key)) partsByMaterial.set(key, { material: part.material, geometries: [] });
      partsByMaterial.get(key).geometries.push(geometry);
    });
    for (const { material, geometries } of partsByMaterial.values()) {
      // GLTF props split hinges, lids and handles into separate meshes even
      // though they share a material. Join those once, preserving every
      // vertex attribute, before instancing them into spatial cells.
      const combined = geometries.length > 1 ? mergeGeometries(geometries) : null;
      const batches = combined ? [combined] : geometries;
      if (combined) for (const geometry of geometries) geometry.dispose();
      for (const geometry of batches) {
        for (const cell of cells.values()) {
          const mesh = new THREE.InstancedMesh(geometry, material, cell.length);
          mesh.name = name;
          // Tiny repeated leaves and fixtures otherwise redraw hundreds of
          // thousands of triangles into shadows. Large architecture/trees and
          // solid cover still cast the shadows that explain the combat space.
          mesh.castShadow = !foliage && name!=='industrial_wall_lamp';
          mesh.receiveShadow = true;
          cell.forEach((p, index) => {
            position.fromArray(p.at);
            rotation.setFromAxisAngle(axis, p.yaw ?? 0);
            matrix.compose(position, rotation, new THREE.Vector3(...p.dims));
            mesh.setMatrixAt(index, matrix);
          });
          // Bounds include complete transformed geometry, including parts
          // extending beyond their placement's cell. No cell-edge clipping.
          mesh.computeBoundingSphere();
          result.add(mesh);
        }
      }
    }
  });
  map.add(result);
  addMarkings(map);
}

function addMarkings(map) {
  const canvas = document.createElement('canvas');
  canvas.width = 2048;
  canvas.height = 1024;
  const c = canvas.getContext('2d');
  const labels = ['01 / FREIGHT', '02 / GLASSWORKS', '03 / ATRIUM', 'DAYBREAK', 'B1', 'B2', 'C1', 'C2'];
  labels.forEach((text, i) => {
    const x = (i % 2) * 1024, y = Math.floor(i / 2) * 256;
    c.fillStyle = i < 4 ? '#375d5b' : '#e8e3d5';
    c.font = `${i < 4 ? '600 100' : '700 200'}px "Saira Condensed", sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(text, x + 512, y + 128, 970);
    if (i < 4) {
      c.fillRect(x + 32, y + 215, 900, 5);
      c.beginPath(); c.moveTo(x+930,y+180);c.lineTo(x+970,y+215);c.lineTo(x+930,y+250);c.lineWidth=8;c.strokeStyle='#375d5b';c.stroke();
    }
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  const material = lightMaterial(new THREE.MeshStandardMaterial({map:texture, transparent:true, depthWrite:false, roughness:.75, polygonOffset:true, polygonOffsetFactor:-1}));
  function label(index, width, height, at, floor=false) {
    const geometry = new THREE.PlaneGeometry(width,height);
    const uv=geometry.attributes.uv;
    for(let i=0;i<uv.count;i++) uv.setXY(i, (uv.getX(i)+index%2)/2, (uv.getY(i)+3-Math.floor(index/2))/4);
    const mesh = new THREE.Mesh(geometry,material);
    mesh.position.set(...at);
    if(floor) mesh.rotation.x=-Math.PI/2;
    map.add(mesh);
  }
  for(const [i,z] of [[0,-34],[1,0],[2,37]]) label(i,8,2,[0,.045,z],true);
  for(const [i,x,z] of [[4,-6.75,-15],[5,6.75,-15],[6,-6.75,15],[7,12.75,15]]) label(i,.65,1.6,[x,3.1,z-.49]);
}
