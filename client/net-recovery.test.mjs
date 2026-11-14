import assert from 'node:assert/strict';
import test from 'node:test';
import { Link, LinkState } from './src/net.js';
import { SIM } from './src/sim.js';
import { LocalPlayer } from './src/localplayer.js';

test('an expired resume returns to the lobby, while a valid resume retains the match', () => {
  const player = {id:'old',matchId:'match',inMatch:true,warmingUp:true,seenSnapshot:true,
    unacked:[],clearCorrection(){},input:{resetCrouch(){}},queueRequested:{},grenadeHeld:true};
  LocalPlayer.prototype.handle.call(player,{t:'welcome',player_id:'old',resumed:true});
  assert.equal(player.matchId,'match');
  LocalPlayer.prototype.handle.call(player,{t:'welcome',player_id:'new',resumed:false});
  assert.equal(player.matchId,null);
  assert.equal(player.inMatch,false);
  assert.equal(player.grenadeHeld,false);
  assert.equal(player.queueRequested,null);
});

test('mobile recovery replaces silent sockets, ignores old events and preserves resume credentials', async () => {
  const memory = new Map();
  const storage = {getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v)};
  globalThis.window = new EventTarget();
  Object.assign(window, {location:{protocol:'http:',host:'localhost'},sessionStorage:storage,localStorage:storage});
  globalThis.document = new EventTarget(); document.hidden = false;
  class Socket extends EventTarget {
    static OPEN=1;
    readyState=1; bufferedAmount=0; sent=[];
    send(s){this.sent.push(JSON.parse(s));}
    close(){this.readyState=3;}
  }
  globalThis.WebSocket=Socket;
  const link=new Link('test','tester');
  const welcome=()=>link.handleServerMessage(JSON.stringify({t:'welcome',map_version:SIM.mapVersion,
    player_id:'player',session_id:'session',resume_token:'resume-test'}),performance.now());
  welcome(); await link.firstWelcome;
  link.inbox = [{t:'snapshot',match_id:'a',seq:1}, {t:'hit_confirmed'},
    {t:'snapshot',match_id:'a',seq:2}, {t:'killed'}, {t:'balance',amount:10}];
  assert.deepEqual(link.drain(),[{t:'hit_confirmed'},{t:'snapshot',match_id:'a',seq:2},{t:'killed'},{t:'balance',amount:10}]);
  const old=link.socket;
  document.hidden=true; document.dispatchEvent(new Event('visibilitychange'));
  link.hiddenAt=performance.now()-2500;
  document.hidden=false; document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(link.state,LinkState.Down);
  link.pump(performance.now());
  const replacement=link.socket;
  replacement.dispatchEvent(new Event('open'));
  assert.equal(replacement.sent[0].resume,'resume-test');
  old.dispatchEvent(new Event('close'));
  old.dispatchEvent(new Event('error'));
  assert.equal(link.socket,replacement);
  welcome();
  link.lastReceivedAt=performance.now()-6500;
  link.pump(performance.now());
  assert.notEqual(link.socket,replacement,'silent OPEN sockets must be replaced');
  welcome();
  link.socket.bufferedAmount=100000;
  link.send({t:'inputs',commands:[]});
  assert.equal(link.state,LinkState.Down,'stale movement must not queue indefinitely');
  link.parked=true;
  link.pump(performance.now()+20000);
  assert.equal(link.socket,null,'never steal a player back from another device');
});
