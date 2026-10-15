// Original frag-grenade prop, in metres. Held and flying views share it.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
const shell = new THREE.MeshStandardMaterial({color:0x46503a,roughness:.72,metalness:.28});
const grooves = new THREE.MeshStandardMaterial({color:0x232c23,roughness:.8,metalness:.2});
const steel = new THREE.MeshStandardMaterial({color:0x8c938c,roughness:.36,metalness:.85});
const band = new THREE.MeshStandardMaterial({color:0xbea656,roughness:.65,metalness:.15});
let template;
export function makeGrenade({held=false}={}) {
  if (!template) {
    template=new THREE.Group();
    // Flattened base, tapered shoulder and recessed cast grip panels.
    const profile=[[-.039,.012],[-.035,.022],[-.021,.029],[0,.031],[.021,.028],[.034,.019],[.037,.014]];
    template.add(new THREE.Mesh(new THREE.LatheGeometry(profile.map(([y,r])=>new THREE.Vector2(r,y)),32),grooves));
    const panels=[];
    for(let row=0;row<profile.length-1;row++) {
      const [y0,r0]=profile[row], [y1,r1]=profile[row+1];
      for(let col=0;col<12;col++) {
        panels.push(new THREE.LatheGeometry([new THREE.Vector2(r0+.0008,y0+.001),new THREE.Vector2(r1+.0008,y1-.001)],3,col*Math.PI/6+.025,Math.PI/6-.05));
      }
    }
    template.add(new THREE.Mesh(mergeGeometries(panels),shell));
    panels.forEach(g=>g.dispose());
    const neck=new THREE.Mesh(new THREE.CylinderGeometry(.011,.014,.017,16),steel);
    neck.position.y=.044;template.add(neck);
    const stripe=new THREE.Mesh(new THREE.TorusGeometry(.023,.0017,6,32),band);
    stripe.rotation.x=Math.PI/2;stripe.position.y=.028;template.add(stripe);
    const spoon=new THREE.Shape();
    spoon.moveTo(-.013,.055);spoon.lineTo(.020,.055);spoon.lineTo(.037,.025);
    spoon.lineTo(.039,-.024);spoon.lineTo(.034,-.025);spoon.lineTo(.032,.023);
    spoon.lineTo(.017,.050);spoon.lineTo(-.013,.050);spoon.closePath();
    const lever=new THREE.Mesh(new THREE.ExtrudeGeometry(spoon,{depth:.009,bevelEnabled:true,bevelSize:.0008,bevelThickness:.0008,bevelSegments:1,steps:1}),steel);
    lever.position.z=-.0045;template.add(lever);
    const hinge=new THREE.Mesh(new THREE.CylinderGeometry(.003,.003,.016,8),steel);
    hinge.rotation.x=Math.PI/2;hinge.position.set(-.007,.05,0);template.add(hinge);
    const pin=new THREE.Mesh(new THREE.TorusGeometry(.011,.0013,6,24),steel);
    pin.position.set(-.021,.046,.002);pin.name='safety-ring';template.add(pin);
    const canvas=document.createElement('canvas');canvas.width=128;canvas.height=64;
    const c=canvas.getContext('2d');c.fillStyle='#d3c895';c.textAlign='center';c.font='bold 15px monospace';
    c.fillText('FRAG',64,26);c.font='10px monospace';c.fillText('STL / 067',64,44);
    const map=new THREE.CanvasTexture(canvas);map.colorSpace=THREE.SRGBColorSpace;
    const stencil=new THREE.Mesh(new THREE.PlaneGeometry(.034,.017),new THREE.MeshStandardMaterial({map,transparent:true,depthWrite:false,roughness:.8}));
    stencil.position.set(0,.002,.0318);template.add(stencil);
    template.traverse(n=>{if(n.isMesh){n.castShadow=true;n.receiveShadow=true;}});
  }
  const copy=template.clone(true);
  copy.getObjectByName('safety-ring').visible=held;
  return copy;
}
