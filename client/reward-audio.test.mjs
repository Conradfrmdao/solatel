import test from 'node:test';
import assert from 'node:assert/strict';
import { Audio } from './src/audio.js';

test('reward voice stays local to its mix, avoids overlap/repeats, and honors mute/death',()=>{
  const sound=new Audio(),started=[];
  sound.volume=1;sound.master={name:'master',gain:{value:1}};
  sound.context={state:'running',currentTime:10,
    createGain:()=>({gain:{value:0},connect(to){this.output=to;return to;},disconnect(){}}),
    createBufferSource:()=>({connect(to){this.output=to;return to;},disconnect(){},start(at){started.push({source:this,at});},stop(){this.onended?.();}})};
  for(const name of ['money-in-the-bag','in-the-bag','got-him'])sound.buffers.set(`rewards/${name}`,{buffer:{duration:1.2}});
  sound._rewardLine();assert.equal(started.length,1);
  assert.equal(started[0].source.output.output,sound.master);
  const first=sound.lastReward;
  sound._rewardLine();assert.equal(started.length,1,'a second kill must not overlap dialogue');
  started[0].source.onended();sound.context.currentTime=11;
  sound._rewardLine();assert.equal(started.length,1,'cooldown persists after a short clip');
  sound.context.currentTime=14;sound._rewardLine();assert.equal(started.length,2);assert.notEqual(sound.lastReward,first);
  started[1].source.onended();sound.context.currentTime=20;
  sound.volume=0;sound._rewardLine();assert.equal(started.length,2);
  sound.volume=1;sound.rewardDead=true;sound._rewardLine();assert.equal(started.length,2);
  sound.rewardDead=false;sound.context.state='suspended';sound._rewardLine();assert.equal(started.length,2);
  sound.context.state='running';sound._rewardLine();assert.equal(started.length,3);
  sound.setVolume(0);assert.equal(sound.rewardVoice,null);assert.equal(sound.master.gain.value,0);
});
