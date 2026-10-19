import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {endpointHitsWorld,pathMayHitPlayer} from './src/predicted-impact.js';
import {loadSim,selectMap,SPAWNS} from './src/sim.js';
import {Rounds} from './src/rounds.js';

await loadSim(await readFile(new URL('./generated/solatel_sim_bg.wasm',import.meta.url)));
selectMap('yard');

test('only a collision endpoint predicts a wall hit, and soldiers intercept the curved path',()=>{
 const path=[0,1,0,0,1,-5,0,.9,-10];
 assert.equal(endpointHitsWorld(path,[-2,0,-11,2,3,-10]),true);
 assert.equal(endpointHitsWorld(path,[-2,0,-20,2,3,-19]),false);
 const player={diedAt:null,root:{position:{x:0,y:0,z:-5}}};
 assert.equal(pathMayHitPlayer(path,[player]),true);
 player.root.position.x=3;
 assert.equal(pathMayHitPlayer(path,[player]),false);
 player.root.position.x=0;player.diedAt=1;
 assert.equal(pathMayHitPlayer(path,[player]),false);
});

test('shared ballistic wall impact appears before delayed confirmation and is not duplicated',()=>{
 for(const latency of [.1,.25,.5]) {
  const rounds=new Rounds({add(){}});let flashes=0,confirmed=0;
  rounds.add({key:null,weapon:'rifle',from:[SPAWNS[0],SPAWNS[1]+.8,SPAWNS[2]],
   velocity:[0,-800,0],own:true,predictWorldImpact:()=>{flashes++;return true;}});
  assert.equal(rounds.live.length,1);
  const round=rounds.live[0];const at=Array.from(round.path.slice(-3));
  rounds.update(.02);
  assert.equal(flashes,1,'wall effect should appear at ballistic arrival, without waiting for RTT');
  rounds.update(latency);
  rounds.land('server:1',{at,struck:true,hit_player:false},0,true,alreadyShown=>{
   confirmed++;if(!alreadyShown)flashes++;
  });
  rounds.update(.02);
  assert.equal(confirmed,1);assert.equal(flashes,1);
 }
});

test('authoritative player hit takes precedence over a pending wall effect',()=>{
 const rounds=new Rounds({add(){}});let predicted=0,confirmed=0;
 rounds.add({key:null,weapon:'rifle',from:[SPAWNS[0],SPAWNS[1]+.8,SPAWNS[2]],
  velocity:[0,-800,0],own:true,predictWorldImpact:()=>{predicted++;return true;}});
 rounds.land('server:1',{at:[SPAWNS[0],SPAWNS[1],SPAWNS[2]],struck:true,hit_player:true},0,true,alreadyShown=>{
  assert.equal(alreadyShown,false);confirmed++;
 });
 rounds.update(.1);
 assert.equal(predicted,0);assert.equal(confirmed,1);
});
