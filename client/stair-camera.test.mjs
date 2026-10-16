import test from 'node:test';
import assert from 'node:assert/strict';
import {LocalPlayer} from './src/localplayer.js';

function cameraState() {
  return {previous:{x:0,y:.2,z:0},current:{x:0,y:.2,z:0},
    correction:{x:0,y:0,z:0},eyeOffset:1,eyeLift:1,feetY:0,
    onGround:false,_lastFall:0,_eyeAt:{x:0,z:0,set:true}};
}
const out={set(x,y,z){Object.assign(this,{x,y,z});}};
test('a brief lost tread contact does not snap the camera above its smoothing',()=>{
  const s=cameraState();LocalPlayer.prototype.eyePosition.call(s,1,out,1/60);
  assert.ok(s.feetY>0 && s.feetY<.1);
  const before=s.feetY;s.onGround=true;s.previous.y=s.current.y=.18;
  LocalPlayer.prototype.eyePosition.call(s,1,out,1/60);
  assert.ok(s.feetY>before,'next grounded frame must not pull the eye down');
});
test('jumping and genuine falls bypass stair smoothing',()=>{
  for(const speed of [5,-3]) {
    const s=cameraState();s._lastFall=speed;
    LocalPlayer.prototype.eyePosition.call(s,1,out,1/60);
    assert.equal(s.feetY,.2);
  }
});
