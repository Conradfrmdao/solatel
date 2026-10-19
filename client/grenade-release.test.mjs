import test from 'node:test';
import assert from 'node:assert/strict';
import {LocalPlayer} from './src/localplayer.js';

test('release survives later movement commands without predicting duplicate grenades',()=>{
  let release=true, predicted=0; const commands=[];
  const player={link:{isReady:true,send:m=>commands.push(m.commands.at(-1))},
    input:{sample:()=>({throw:release}),yaw:0,pitch:0},
    predictor:{step(){},grenade_path(){predicted++;return [0,1,0,0,1,-1]}},
    _readPredictor(){},_predictArms(){},previous:{},current:{x:0,y:1,z:0},
    nextSeq:1,unacked:[],matchId:1,health:100,grenades:2};
  LocalPlayer.prototype.fixedStep.call(player,1/64);
  const releaseBits=commands[0].buttons;
  assert.notEqual(releaseBits,0);
  release=false;
  for(let i=0;i<30;i++)LocalPlayer.prototype.fixedStep.call(player,1/64);
  assert.ok(commands.every(c=>c.buttons===releaseBits),'latest command still carries release after an input backlog');
  assert.equal(predicted,1);
  player.health=0;
  LocalPlayer.prototype.fixedStep.call(player,1/64);
  assert.equal(commands.at(-1).buttons,0,'death cancels any unacknowledged release');
});
