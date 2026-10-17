import test from 'node:test';
import assert from 'node:assert/strict';
import { reloadPose, reloadCue } from './src/reload-timing.js';
import { Rounds } from './src/rounds.js';

test('long machine-gun reload keeps brisk actions and synchronized sounds', () => {
  for (const seconds of [2.4, 3.6, 5]) {
    for (const phase of [.13, .6, .79]) {
      assert.ok(Math.abs(reloadPose(reloadCue(phase,seconds,'lmg')/seconds,seconds,'lmg')-phase)<1e-8);
    }
    assert.ok(reloadCue(.26,seconds,'lmg')-reloadCue(.12,seconds,'lmg')<.3);
    assert.ok(reloadCue(.8,seconds,'lmg')-reloadCue(.7,seconds,'lmg')<.3);
    assert.equal(reloadPose(1,seconds,'lmg'),1);
    assert.equal(reloadPose(.5,seconds,'rifle'),.5);
  }
});

test('confirmed impacts do not replay flight after network delivery', () => {
  for (const elapsed of [0, .1, .3]) {
    const rounds = new Rounds({add(){}});
    let arrivals=0;
    const round={key:'1:1',own:true,path:[0,0,0,0,0,-10],t:elapsed,end:1,
      line:rounds.pool[0],onArrive:null,landing:null};
    rounds.live.push(round);
    rounds.land('1:1',{at:[0,0,-10],hit_player:false},0,true,()=>arrivals++);
    assert.equal(arrivals,1,'server-confirmed landing must appear this frame');
    rounds.update(.016);
    assert.equal(arrivals,1,'one impact per round');
    assert.equal(round.line.visible,false);
  }
  const rounds=new Rounds({add(){}});let arrivals=0;
  rounds.land('expired',{at:[0,0,-10]},0,true,()=>arrivals++);
  assert.equal(arrivals,1,'a tracer removed from the pool must not delay impact');
});
