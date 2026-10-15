// Original equipment fitted to the existing animated soldier, in bind-pose metres.
// Every part follows an existing bone; cosmetics do not change the hitbox.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { lightMaterial } from './light.js';

export const OPERATOR_IDS = new Set([5,6,7,8]);
const kits=new Map(), helmetless=new WeakMap();

export function operatorGeometry(geometry, materialName, id) {
  if(!OPERATOR_IDS.has(id) || materialName!=='Ch15_body1' || !geometry.index) return geometry;
  if(helmetless.has(geometry)) return helmetless.get(geometry);
  const index=geometry.index.array,p=geometry.attributes.position,keep=[];
  for(let i=0;i<index.length;i+=3) {
    // Remove only the original head equipment, retaining the textured face,
    // neck, clothing and all original skin weights in the other mesh.
    if((p.getY(index[i])+p.getY(index[i+1])+p.getY(index[i+2]))/3 < 1.60) keep.push(index[i],index[i+1],index[i+2]);
  }
  const out=geometry.clone();out.setIndex(keep);helmetless.set(geometry,out);return out;
}

function makeKit(id) {
  const groups=new Map();
  const olive=id===5,heavy=id===6,engineer=id===7;
  const cloth=olive?0x535942:heavy?0x343a3e:engineer?0x8d795c:0x484b50;
  const web=olive?0x71694e:heavy?0x494a46:engineer?0x72654e:0x4c4b45;
  const materials=[cloth,web,0x252b2c,0x727b7e,0x997b43].map((color,i)=>lightMaterial(new THREE.MeshStandardMaterial({color,roughness:i===3?.38:.83,metalness:i===3?.75:0})));
  const add=(bone,geometry,material,at=[0,0,0],rotation=[0,0,0])=>{
    const m=new THREE.Matrix4().compose(new THREE.Vector3(...at),new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)),new THREE.Vector3(1,1,1));
    geometry.applyMatrix4(m);
    const key=`${bone}/${material}`;
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(geometry);
  };
  const box=(bone,size,at,mat=1,r=.006,rotation=[0,0,0])=>{
    // Millimetre seams and webbing do not need 300 triangles each. Keep
    // the rounded silhouette of armor/pouches; simplify only tiny edging.
    const geometry=r<=.002
      ? new THREE.BoxGeometry(...size)
      : new RoundedBoxGeometry(...size,r<=.006?1:2,r);
    add(bone,geometry,mat,at,rotation);
  };
  const dome=(bone,r,scale,at,mat=0)=>{
    const g=new THREE.SphereGeometry(r,24,12,0,Math.PI*2,0,Math.PI*.58);g.scale(...scale);add(bone,g,mat,at);
  };
  const tube=(bone,points,r=.004,mat=2)=>add(bone,new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(...p))),16,r,5,false),mat);
  const pouch=(bone,x,y,z,w=.073,h=.105)=>{
    box(bone,[w,h,.046],[x,y,z],1,.009);
    box(bone,[w*.96,h*.30,.009],[x,y+h*.32,z+.025],0,.003);
    box(bone,[.014,h*.6,.004],[x,y-.015,z+.025],2,.002);
    box(bone,[.023,.013,.006],[x,y-.025,z+.031],3,.002);
    for(const side of [-1,1]) box(bone,[.0018,h*.85,.002],[x+side*w*.43,y,z+.025],4,.0005);
  };
  // Fitted carrier with a rounded perimeter, webbing, buckles and individual
  // magazine pouches. The same dimensions keep every operator readable.
  box('Spine2',[.285,heavy?.30:.25,.066],[0,1.335,.133],heavy?2:1,.022);
  for(const x of [-.113,.113]) {
    box('Spine2',[.038,.24,.025],[x,1.43,.102],1,.008,[0,0,x*.7]);
    box('Spine2',[.032,.032,.013],[x,1.43,.125],3,.004);
  }
  for(let row=0;row<3;row++) {
    box('Spine2',[.24,.012,.008],[0,1.34+row*.028,.17],0,.002);
    for(let x=-.10;x<=.101;x+=.04)box('Spine2',[.003,.014,.003],[x,1.34+row*.028,.176],2,.001);
  }
  for(const x of [-.085,0,.085])pouch('Spine2',x,1.265,.18);
  pouch('Hips',-.18,1.00,.08,.085,.10);
  // Radio and its flexible aerial.
  box('Spine2',[.047,.11,.037],[.16,1.34,.095],2,.008);
  tube('Spine2',[[.17,1.39,.09],[.17,1.47,.09],[.16,1.54,.075]],.003,2);
  for(const x of [-.102,.102]) {
    box('Head',[.037,.068,.050],[x,1.67,.012],2,.012);
    box('Head',[.025,.048,.033],[x*1.1,1.67,.012],1,.009);
  }
  tube('Head',[[-.12,1.65,.04],[-.115,1.615,.11],[-.065,1.605,.145]],.003,2);
  box('Head',[.025,.013,.012],[-.057,1.605,.145],2,.005);

  if(olive) {
    dome('Head',.102,[1,.66,1.12],[0,1.733,.015]);
    // Curved bill, not a rectangular plate across the eyes.
    const bill=new THREE.SphereGeometry(1,20,8,0,Math.PI*2,0,Math.PI*.5);
    bill.scale(.096,.009,.078);add('Head',bill,0,[0,1.745,.095]);
    box('Head',[.036,.023,.004],[0,1.77,.106],1,.004);
    box('Spine2',[.19,.25,.075],[0,1.345,-.156],1,.02);
    tube('Spine2',[[.08,1.45,-.15],[.10,1.51,-.03],[.10,1.44,.14]],.005,2);
  } else if(heavy) {
    dome('Head',.116,[1,.84,1.08],[0,1.718,.012],2);
    for(const x of [-.06,0,.06])tube('Head',[[x,1.728,.126],[x,1.809,.04],[x,1.78,-.08]],.004,3);
    box('Head',[.16,.038,.018],[0,1.76,.127],2,.009);
    for(const x of [-.043,.043])box('Head',[.062,.023,.012],[x,1.76,.139],3,.006);
    // Separate contoured shoulder and forearm guards, following each limb.
    for(const side of [-1,1]) {
      const arm=side<0?'Right':'Left';
      dome(`${arm}Arm`,.10,[1,.62,1.03],[side*.28,1.48,.012],2);
      box(`${arm}ForeArm`,[.16,.07,.09],[side*.57,1.43,.018],2,.022,[0,0,side*.10]);
      for(const y of [.40,.49]) box(`${arm}Leg`,[.12,.09,.045],[side*.105,y,.074],2,.018);
    }
    box('Hips',[.20,.15,.055],[0,1.035,.135],2,.024);
  } else if(engineer) {
    dome('Head',.108,[1,.78,1.12],[0,1.722,.01],1);
    for(const x of [-.09,.09])box('Head',[.025,.026,.09],[x,1.74,.015],2,.004);
    box('Head',[.037,.04,.022],[0,1.77,.124],2,.004);
    box('Spine2',[.25,.31,.12],[0,1.32,-.18],0,.034);
    for(const x of [-.08,.08])box('Spine2',[.014,.27,.01],[x,1.32,-.247],1,.002);
    pouch('Hips',.19,1.00,.05,.11,.15);
    // Visible pliers, wrench, cable roll and contrasting tool handles.
    for(const x of [.155,.195,.228]) {
      box('Hips',[.014,.10,.014],[x,1.045,.085],4,.004,[0,0,(x-.19)*3]);
      box('Hips',[.009,.055,.01],[x,1.11,.085],3,.002);
    }
    const coil=new THREE.TorusGeometry(.068,.009,6,24);
    for(let n=0;n<3;n++)add('Hips',coil.clone(),2,[-.205,.99,-.075-n*.012],[0,Math.PI/2,0]);
    coil.dispose();
  } else {
    // Soft hood around the retained balaclava, open at the face.
    const hood=new THREE.SphereGeometry(1,28,16,Math.PI/2+.55,Math.PI*2-1.1,0,Math.PI*.7);
    hood.scale(.117,.139,.124);add('Head',hood,0,[0,1.685,.005]);
    box('Spine2',[.20,.19,.06],[0,1.38,-.158],0,.028);
    for(const x of [-.044,.044])box('Head',[.068,.032,.016],[x,1.77,.113],2,.008);
    tube('Spine2',[[-.105,1.49,.10],[-.12,1.35,.155],[-.12,1.19,.13]],.003,3);
    pouch('RightUpLeg',-.15,.86,.085,.065,.13);
  }
  return [...groups].map(([key,geometries])=>{
    const [bone,index]=key.split('/');const geometry=mergeGeometries(geometries.map(g=>g.index?g.toNonIndexed():g));
    geometries.forEach(g=>g.dispose());return {bone,geometry,material:materials[Number(index)]};
  });
}

export function dressOperator(body,id) {
  for(const part of body.userData.operatorParts??[])part.removeFromParent();
  body.userData.operatorParts=[];
  if(!OPERATOR_IDS.has(id))return;
  if(!kits.has(id))kits.set(id,makeKit(id));
  let skeleton;
  body.traverse(node=>{if(node.isSkinnedMesh&&!skeleton)skeleton=node.skeleton;});
  if(!skeleton)return;
  for(const part of kits.get(id)) {
    const i=skeleton.bones.findIndex(b=>b.name.replace('mixamorig:','').replace('mixamorig','')===part.bone);
    if(i<0)continue;
    const mesh=new THREE.Mesh(part.geometry,part.material);
    mesh.matrixAutoUpdate=false;mesh.matrix.copy(skeleton.boneInverses[i]);
    mesh.castShadow=true;mesh.receiveShadow=true;
    mesh.userData.operatorDistance=part.bone==='Head'?50:part.bone==='Spine2'?32:20;
    skeleton.bones[i].add(mesh);body.userData.operatorParts.push(mesh);
  }
}
