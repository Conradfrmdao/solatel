import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
await mkdir('.artifacts/asset-research', { recursive: true });
const compiled = await build({ stdin:{contents:`import {Input} from './input.js'; import {Hud} from './hud.js'; import {initViewport} from './viewport.js'; import {initInstallation} from './pwa.js';
initViewport(); window.testInput = new Input(document.querySelector('canvas')); const hud = new Hud(document.querySelector('#hud')); hud.stats.hidden = true;
document.querySelector('#boot').hidden = true; document.querySelector('#boot').classList.add('hidden'); document.body.classList.remove('booting');
if(location.search.includes('pwa')) {document.body.classList.add('in-menu');initInstallation();}else{document.body.classList.add('running');}
`,resolveDir:resolve('client/src')},bundle:true,format:'esm',write:false});
const server=createServer(async(req,res)=>{try{const path=new URL(req.url,'http://localhost').pathname;if(path==='/fixture.js'){res.setHeader('content-type','text/javascript');res.end(compiled.outputFiles[0].contents);return;}let bytes=await readFile(resolve('web/dist',path==='/'?'index.html':path.slice(1)));if(path==='/')bytes=bytes.toString().replace(/src="solatel\.[^"]+\.js"/,'src="/fixture.js"');res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'}[extname(path==='/'?'index.html':path)]||'application/octet-stream'));res.end(bytes);}catch{res.statusCode=404;res.end();}});
await new Promise(r=>server.listen(8128,'127.0.0.1',r));
const browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--no-sandbox']});
try {
 for(const [width,height] of [[844,390],[568,320],[852,300]]){
 const page=await browser.newPage();await page.setViewport({width,height,isMobile:true,hasTouch:true,deviceScaleFactor:2});page.on('pageerror',e=>console.log('PAGE ERROR',e.message));await page.goto('http://127.0.0.1:8128/');await page.waitForFunction(()=>window.testInput);
 const stick=await page.$eval('.touch-stick',e=>e.getBoundingClientRect().toJSON());const cdp=await page.createCDPSession();
 const touch=async(type,x,y)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x,y,id:1}]});
 await touch('touchStart',stick.x+stick.width/2,stick.y+stick.height*.75);
 assert.equal(await page.evaluate(()=>testInput.sample().forward),0,'touchdown must be neutral');
 await touch('touchMove',stick.x+stick.width/2,stick.y+stick.height*.2);
 assert.ok(await page.evaluate(()=>testInput.sample().forward>0),'upward drag must move forward');
 await touch('touchEnd');assert.equal(await page.evaluate(()=>testInput.sample().forward),0);
 await page.tap('[data-touch=sprint]');assert.deepEqual(await page.evaluate(()=>{const c=testInput.sample();return [c.forward,c.sprint]}),[1,true]);
 await page.tap('[data-touch=sprint]');assert.equal(await page.evaluate(()=>testInput.sample().forward),0);
 await page.tap('[data-touch=aim]');assert.equal(await page.evaluate(()=>testInput.aiming),true);
 await page.tap('[data-touch=aim]');
 await page.tap('[data-touch=jump]');assert.equal(await page.evaluate(()=>testInput.sample().jump),true,'short jump tap lost');
 const grenade=await page.$eval('[data-touch=grenade]',e=>e.getBoundingClientRect().toJSON());
 const left=await page.touchscreen.touchStart(stick.x+stick.width/2,stick.y+stick.height/2);
 await left.move(stick.x+stick.width/2,stick.y+stick.height*.05);
 const right=await page.touchscreen.touchStart(grenade.x+grenade.width/2,grenade.y+grenade.height/2);
 let command=await page.evaluate(()=>testInput.sample());
 assert.ok(command.forward>0&&command.grenadeHeld&&!command.throw,'left-thumb movement must continue while the right thumb holds a grenade');
 const beforeAim=await page.evaluate(()=>({yaw:testInput.yaw,pitch:testInput.pitch}));
 await right.move(grenade.x+grenade.width/2+18,grenade.y+grenade.height/2-12);
 await page.waitForFunction(()=>Math.abs(testInput._touchDx)>0,{timeout:2000});
 const afterAim=await page.evaluate(()=>{testInput.updateLook();return {yaw:testInput.yaw,pitch:testInput.pitch,command:testInput.sample()};});
 assert.notEqual(afterAim.yaw,beforeAim.yaw,'dragging the held grenade must turn the view');
 assert.ok(afterAim.command.forward>0&&afterAim.command.grenadeHeld&&!afterAim.command.throw,'drag aiming cannot release the grenade or cancel movement');
 await right.end(); command=await page.evaluate(()=>testInput.sample());
 assert.ok(command.forward>0&&!command.grenadeHeld&&command.throw,'releasing the right thumb throws immediately while movement stays held');
 assert.equal(await page.evaluate(()=>testInput.sample().throw),false,'a release sends only one throw');
 await left.end();assert.equal(await page.evaluate(()=>testInput.sample().forward),0);
 await page.evaluate(()=>testInput.setTouchOptions({aim:'hold',crouch:'hold',sprint:'hold'}));
 for(const action of ['aim','crouch','sprint']){
  const r=await page.$eval(`[data-touch=${action}]`,e=>e.getBoundingClientRect().toJSON());
  const finger=await page.touchscreen.touchStart(r.x+r.width/2,r.y+r.height/2);
  assert.equal(await page.evaluate(name=>name==='aim'?testInput.aiming:testInput.sample()[name],action),true,`${action} hold did not activate`);
  await finger.end();assert.equal(await page.evaluate(name=>name==='aim'?testInput.aiming:testInput.sample()[name],action),false,`${action} hold stayed locked after release`);
 }
 await page.evaluate(()=>testInput.setTouchOptions({aim:'toggle',crouch:'toggle',sprint:'toggle'}));
 const rects=await page.evaluate(()=>({buttons:[...document.querySelectorAll('#touch-controls button')].map(e=>({action:e.dataset.touch||'settings',r:e.getBoundingClientRect().toJSON()})),weapon:document.querySelector('#weapon').getBoundingClientRect().toJSON()}));
 for(const {action,r}of rects.buttons)assert.ok(r.left>=0&&r.right<=width&&r.top>=0&&r.bottom<=height,`${action} clipped at ${width}`);
 assert.ok(rects.weapon.height<65,'weapon HUD too large');
 await page.screenshot({path:`.artifacts/asset-research/mobile-v2-${width}.png`});console.log({width,height,input:'neutral touch, sprint/ADS, hold modes and simultaneous movement/grenade drag/release passed',weapon:rects.weapon});
 if(width===844){
  await page.click('#touch-customize');await page.$eval('.touch-editor-options',e=>e.open=true);
  await page.select('#touch-mode-aim','hold');await page.select('#touch-mode-crouch','hold');await page.select('#touch-mode-sprint','hold');
  await page.$eval('#touch-sensitivity',e=>{e.value='130';e.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.click('#touch-done');await page.reload();await page.waitForFunction(()=>window.testInput);
  assert.deepEqual(await page.evaluate(()=>testInput.touchOptions),{sensitivity:130,aim:'hold',crouch:'hold',sprint:'hold'},'editor preferences must survive a page reload');
  await page.evaluate(()=>testInput.setTouchOptions({sensitivity:115,aim:'toggle',crouch:'toggle',sprint:'toggle'}));
  console.log('Touch editor sensitivity and hold/toggle preferences persist after reload');
 }
 await page.close();
 }
 const page=await browser.newPage();await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1');await page.evaluateOnNewDocument(()=>window.addEventListener('beforeinstallprompt',e=>{if(e.isTrusted){e.preventDefault();e.stopImmediatePropagation();}}));await page.goto('http://127.0.0.1:8128/?pwa');await page.waitForSelector('#pwa-install');assert.equal(await page.$eval('#pwa-install',e=>e.hidden),false);
 await page.click('#pwa-add');assert.equal(await page.$eval('#pwa-guide',e=>e.hidden),false);assert.ok(await page.$eval('#pwa-guide',e=>e.textContent.includes('Open as Web App')));await page.click('#pwa-dismiss');await page.reload();assert.equal(await page.$eval('#pwa-install',e=>e.hidden),true);
 await page.evaluate(()=>document.dispatchEvent(new Event('solatel:install')));assert.equal(await page.$eval('#pwa-install',e=>e.hidden),false);
 await page.evaluate(()=>{window.promptCalls=0;const e=new Event('beforeinstallprompt',{cancelable:true});e.prompt=async()=>{window.promptCalls++};e.userChoice=Promise.resolve({outcome:'dismissed'});window.dispatchEvent(e);});
 await page.click('#pwa-add');assert.equal(await page.evaluate(()=>window.promptCalls),1);assert.equal(await page.$eval('#pwa-install',e=>e.hidden),true);
 await page.evaluate(()=>document.dispatchEvent(new Event('solatel:install')));await page.evaluate(()=>document.body.classList.add('running'));await page.waitForFunction(()=>document.querySelector('#pwa-install').hidden);
 await page.evaluate(()=>{document.body.classList.remove('running');window.dispatchEvent(new Event('appinstalled'));document.dispatchEvent(new Event('solatel:install'));});assert.equal(await page.$eval('#pwa-install',e=>e.hidden),true);
 console.log('PWA manual guide, session dismissal, native prompt invocation, confirmed installation, settings reopen and match suppression passed');
 const installed=await browser.newPage();await installed.setViewport({width:844,height:390,isMobile:true,hasTouch:true});await installed.evaluateOnNewDocument(()=>Object.defineProperty(navigator,'standalone',{value:true}));await installed.goto('http://127.0.0.1:8128/?pwa');await installed.waitForSelector('#pwa-install');assert.equal(await installed.$eval('#pwa-install',e=>e.hidden),true);console.log('Standalone launch suppresses installation recommendation');
} finally {await browser.close();server.close();}
