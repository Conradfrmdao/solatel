// Offline-packaged, CC0 PBR assets. Instanced by mesh: repeats cost no extra draws.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptSimplifier } from 'three/examples/jsm/libs/meshopt_simplifier.module.js';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { asset } from './assets.js';
import { lightMaterial } from './light.js';

// Separate draw bounds let the renderer skip off-camera sections of the
// terminal. Geometry/materials are still shared, and no props are removed.
const PROP_CELL = 24;

export async function terminalFloor() {
  const gltf = await new GLTFLoader().loadAsync(asset('assets/props/smooth_concrete_floor.glb'));
  const scan = await gltf.parser.getDependency('material',0);
  const material = new THREE.MeshPhysicalMaterial({
    map: scan.map, normalMap: scan.normalMap, roughnessMap: scan.roughnessMap,
    metalnessMap: scan.metalnessMap, aoMap: scan.aoMap,
    color: scan.color, metalness: 0, roughness: .34,
    // A thin seal catches broad skylight streaks over the worn substrate.
    clearcoat: .2, clearcoatRoughness: .2,
  });
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
  // The reference is sealed, polished concrete. The photographed roughness
  // still varies per scuff; the lower mean lets the HDR skylight read in it.
  material.flatShading=true;
  material.normalScale.setScalar(.12);
  material.envMapIntensity=.78;
  material.defines = { ...material.defines, BAKED_STATIC_SUN: 1 };
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
    // Keep the scan visible: flattening it into beige concealed every joint
    // and wear mark and made the floor read like untextured game geometry.
    shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',
      '#include <map_fragment>\n diffuseColor.rgb=mix(vec3(.255,.264,.23),diffuseColor.rgb,.62);');
  };
  material.customProgramCacheKey=()=> 'terminal-sealed-floor-v2';
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
  addFloorDetail(map);
  addFloorReflection(map);
  await addDisplays(map);
}

// Ultra quality only: a low-resolution planar pass adds the roof and column
// reflections that an HDR sky alone cannot contain. A faint transparent pass
// preserves the photographed concrete and floor markings underneath. Other
// quality levels keep the PBR finish without paying for another world render.
function addFloorReflection(map) {
  const shader={
    ...Reflector.ReflectorShader,
    fragmentShader: Reflector.ReflectorShader.fragmentShader.replace(
      'vec4( blendOverlay( base.rgb, color ), 1.0 )',
      'vec4( base.rgb, 0.16 )',
    ),
  };
  const reflection=new Reflector(new THREE.PlaneGeometry(72,108),{
    textureWidth:768,textureHeight:432,multisample:0,clipBias:.002,shader,
  });
  reflection.name='terminal-polished-floor-reflection';
  reflection.rotation.x=-Math.PI/2;
  reflection.position.y=.02;
  reflection.material.transparent=true;
  reflection.material.depthWrite=false;
  reflection.visible=false;
  map.userData.floorReflector=reflection;
  map.add(reflection);
}

// Fine expansion joints and drainage slots give the broad polished slab a
// scale in the player's view. One transparent overlay is cheaper than a mesh
// per line and stays below cover, stair treads and objective markings.
function addFloorDetail(map) {
  const canvas=document.createElement('canvas');
  canvas.width=1536;canvas.height=2304;
  const c=canvas.getContext('2d');
  const X=x=>(x+36)/72*canvas.width;
  const Z=z=>(z+54)/108*canvas.height;
  c.strokeStyle='rgba(25,32,35,.26)';c.lineWidth=2;
  for(let x=-36;x<=36;x+=6){c.beginPath();c.moveTo(X(x),0);c.lineTo(X(x),canvas.height);c.stroke();}
  for(let z=-54;z<=54;z+=6){c.beginPath();c.moveTo(0,Z(z));c.lineTo(canvas.width,Z(z));c.stroke();}
  // Paired yellow safety lanes, interrupted at crossing bays.
  c.strokeStyle='rgba(214,147,43,.66)';c.lineWidth=7;
  for(const x of [-16,16])for(const offset of [0,.3]){
    c.beginPath();c.moveTo(X(x+offset),Z(-49));c.lineTo(X(x+offset),Z(49));c.stroke();
  }
  c.strokeStyle='rgba(23,30,31,.55)';c.lineWidth=4;
  for(const z of [-31,-8,14,37]){
    c.fillStyle='rgba(22,30,33,.28)';
    c.fillRect(X(-28),Z(z)-5,X(-23)-X(-28),10);
    c.fillRect(X(23),Z(z)-5,X(28)-X(23),10);
    for(let x=-28;x<-23;x+=.22){c.beginPath();c.moveTo(X(x),Z(z)-4);c.lineTo(X(x),Z(z)+4);c.stroke();}
    for(let x=23;x<28;x+=.22){c.beginPath();c.moveTo(X(x),Z(z)-4);c.lineTo(X(x),Z(z)+4);c.stroke();}
  }
  const texture=new THREE.CanvasTexture(canvas);
  texture.colorSpace=THREE.SRGBColorSpace;
  texture.anisotropy=8;
  const material=new THREE.MeshBasicMaterial({map:texture,transparent:true,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2,side:THREE.DoubleSide});
  const mesh=new THREE.Mesh(new THREE.PlaneGeometry(72,108),material);
  mesh.rotation.x=-Math.PI/2;
  mesh.position.y=.013;
  mesh.name='terminal-floor-joints-and-drains';
  mesh.renderOrder=1;
  map.add(mesh);
}

// The four full-height cover screens carry the game's real key art. The
// protective steel-and-glass casings are part of the collision map already;
// these lit faces only dress them and never change a firing lane.
async function addDisplays(map) {
  const cover = await new THREE.TextureLoader().loadAsync(asset('assets/menu/splash.webp'));
  const canvas = document.createElement('canvas');
  canvas.width = 1600;
  canvas.height = 640;
  const c = canvas.getContext('2d');
  c.fillStyle = '#071016';
  c.fillRect(0, 0, canvas.width, canvas.height);
  // Preserve the complete Solatel mark, soldier, and daylight artwork.
  c.drawImage(cover.image, 0, 0, 1120, 640);
  const shade = c.createLinearGradient(760, 0, 1170, 0);
  shade.addColorStop(0, '#07101600');
  shade.addColorStop(1, '#071016');
  c.fillStyle = shade;
  c.fillRect(760, 0, 420, 640);
  c.fillStyle = '#d69338';
  c.fillRect(1160, 80, 8, 480);
  c.fillStyle = '#f2eee6';
  c.textAlign = 'left';
  c.font = '700 74px "Saira Condensed", sans-serif';
  c.fillText('PLAY', 1208, 200);
  c.fillText('KILL', 1208, 302);
  c.fillText('EARN', 1208, 404);
  c.fillStyle = '#d69338';
  c.fillRect(1208, 439, 295, 3);
  c.fillStyle = '#c5d0d0';
  c.font = '600 29px "Saira Condensed", sans-serif';
  c.fillText('DAYBREAK TERMINAL', 1208, 505);
  c.fillText('SOLATEL / 01', 1208, 548);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  const material = new THREE.MeshBasicMaterial({map: texture, toneMapped: false, side: THREE.FrontSide});
  const displays = new THREE.Group();
  displays.name = 'terminal-solatel-displays';
  for (const [x, z, width] of [[1, -43, 6], [-19, -17, 8], [17, 17, 7], [-2, 54, 6]]) {
    for (const side of [-1, 1]) {
      const face = new THREE.Mesh(new THREE.PlaneGeometry(width * .75 - .3, 2.4), material);
      face.name = 'solatel-cover-display';
      face.position.set(x * .75, 1.42, z * .75 + side * .185);
      if (side < 0) face.rotation.y = Math.PI;
      displays.add(face);
    }
  }
  // Portrait campaign graphics mounted on the central structural columns.
  // They stay above head height and preserve every existing combat lane.
  const portrait=document.createElement('canvas');
  portrait.width=512;portrait.height=1024;
  const pc=portrait.getContext('2d');
  pc.fillStyle='#091015';pc.fillRect(0,0,512,1024);
  pc.drawImage(cover.image,440,0,640,cover.image.height,0,110,512,690);
  const fade=pc.createLinearGradient(0,550,0,920);
  fade.addColorStop(0,'#09101500');fade.addColorStop(1,'#091015');
  pc.fillStyle=fade;pc.fillRect(0,550,512,370);
  pc.fillStyle='#eeeae0';pc.font='700 76px "Saira Condensed",sans-serif';
  pc.fillText('SOLATEL',38,100);
  pc.fillStyle='#e0a142';pc.font='700 62px "Saira Condensed",sans-serif';
  pc.fillText('PLAY',38,805);pc.fillText('KILL',38,872);pc.fillText('EARN',38,939);
  const portraitTexture=new THREE.CanvasTexture(portrait);
  portraitTexture.colorSpace=THREE.SRGBColorSpace;
  portraitTexture.anisotropy=8;
  const portraitMat=new THREE.MeshBasicMaterial({map:portraitTexture,toneMapped:false});
  for(const [x,z] of [[-9,-20],[17,20],[-26,20]]){
    const face=new THREE.Mesh(new THREE.PlaneGeometry(2.15,5.25),portraitMat);
    face.name='solatel-column-banner';
    face.position.set(x*.75,8.0,z*.75-.51);
    face.rotation.y=Math.PI;
    displays.add(face);
  }
  map.add(displays);
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
