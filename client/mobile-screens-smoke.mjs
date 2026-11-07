// Run after `node client/build.mjs`. Uses real UI components with fixture data;
// no match, wallet or payment requests are sent to the live game.
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

const output = '.artifacts/mobile-screens';
await mkdir(output, { recursive: true });
const fixture = await build({
  stdin: {
    resolveDir: resolve('client/src'),
    contents: `
      import { Input } from './input.js';
      import { Hud } from './hud.js';
      import { Menu } from './menu.js';
      import { Matchmaking } from './matchmaking.js';
      import { Debrief } from './debrief.js';
      import { initViewport } from './viewport.js';
      import { loadSim } from './sim.js';
      import { asset } from './assets.js';
      initViewport();
      await loadSim(asset('sim/solatel_sim_bg.wasm'));
      const input = new Input(document.querySelector('canvas'));
      const hud = new Hud(document.querySelector('#hud'));
      hud.stats.hidden = true;
      const menu = new Menu(document.querySelector('#menu'));
      menu.setOffer([{name:'arena',seats:20},{name:'yard',seats:20}], [{dollars:1,kill_reward_micro_usd:900000}]);
      menu.setName('Player mobile');
      const debrief = new Debrief();
      let leaves = 0;
      const mm = new Matchmaking(document.querySelector('#matchmaking'), {onLeave:()=>{leaves++;mm.update({phase:null});}});
      const boot = document.querySelector('#boot');
      const show = (name) => {
        input.touchLayout?.close();
        debrief.hide(); mm.update({phase:null});
        menu.show(false); boot.classList.add('hidden');
        document.body.classList.remove('booting','running','dying','editing-controls','mobile-bypass-portrait');
        if (name === 'boot') {
          document.body.classList.add('booting'); boot.classList.remove('hidden');
          document.querySelector('#boot-status').textContent = 'connecting…';
        } else if (name === 'menu' || name === 'settings') {
          menu.show(true); menu.showPane(name === 'settings' ? 'settings' : 'play');
        } else if (name === 'matchmaking') {
          menu.show(true);
          mm.update({phase:'searching',map:'arena',dollars:1,elapsedMs:3000,seats:20,waiting:1,
            confirmed:true,needed:1,formingInMs:41000,place:1,entry:'$1.00',reward:'$0.90',
            download:{loaded:44800000,total:46800000,done:false}});
          mm.root.scrollTop = 0;
        } else if (name === 'debrief') {
          menu.show(true);
          debrief.show({place:1,players:6,standing:1,alive_ms:244000,stake_micro_usd:1000000,
            stake_back_micro_usd:900000,stats:{alive:false,kills:0,headshots:0,shots_fired:93,shots_hit:0,damage_dealt:0}},
            {you:1,map:'arena',tier:{dollars:1},killed:{how:'caught outside the zone'},balance:99900000,
             board:Array.from({length:5},(_,i)=>({id:i+1,name:i?'Player '+(i+1):'Player mobile',kills:0,alive:i===0}))});
          debrief.root.scrollTop = 0;
        } else {
          document.body.classList.add('running');
          if (name !== 'editor') document.body.classList.add('mobile-bypass-portrait');
          if (name === 'editor') input.touchLayout.open();
        }
      };
      window.mobileScreens = {show,input,menu,mm,debrief,get leaves(){return leaves;}};
      show('boot');
    `,
  },
  bundle: true, format: 'esm', write: false,
});
const root = resolve('web/dist');
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/fixture.js') {
      response.setHeader('content-type', 'text/javascript');
      response.end(fixture.outputFiles[0].contents); return;
    }
    // Menu background requests stay inside this fixture server.
    if (path === '/proof' || path === '/board') { response.setHeader('content-type','application/json'); response.end('{}'); return; }
    const target = resolve(root, path === '/' ? 'index.html' : path.slice(1));
    if (target !== root && !target.startsWith(root + sep)) throw new Error('outside fixture');
    let bytes = await readFile(target);
    if (path === '/') bytes = bytes.toString().replace(/src="solatel\.[^"]+\.js"/, 'src="/fixture.js"');
    const mime = {'.html':'text/html','.js':'text/javascript','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.woff2':'font/woff2','.wasm':'application/wasm'};
    response.setHeader('content-type', mime[extname(target)] || 'application/octet-stream');
    response.end(bytes);
  } catch { response.statusCode = 404; response.end(); }
});
await new Promise((done) => server.listen(8130, '127.0.0.1', done));
const browser = await puppeteer.launch({
  executablePath: process.env.SOLATEL_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true, args: ['--no-sandbox'],
});
const failures = [];
const check = (condition, description) => { if (!condition) failures.push(description); };
const sizes = [[844,390],[568,320],[852,300],[390,844]];

async function settle(page) {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
}
async function safeRect(page, selector) {
  return page.$eval(selector, (element) => {
    const r = element.getBoundingClientRect();
    const style = getComputedStyle(document.documentElement);
    const inset = (side) => parseFloat(style.getPropertyValue('--ui-safe-'+side)) || 0;
    return {rect:r.toJSON(),safe:{left:inset('left'),right:innerWidth-inset('right'),top:inset('top'),bottom:innerHeight-inset('bottom')},scrollWidth:element.scrollWidth,clientWidth:element.clientWidth};
  });
}
function within(rect, safe, vertical = true) {
  return rect.left >= safe.left-1 && rect.right <= safe.right+1 && (!vertical || (rect.top >= safe.top-1 && rect.bottom <= safe.bottom+1));
}
async function reachable(page, selector) {
  await page.$eval(selector, (e) => e.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'}));
  await settle(page);
  return page.$eval(selector, (e) => {
    const r=e.getBoundingClientRect();
    const top=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
    return {rect:r.toJSON(),hits:top===e || e.contains(top)};
  });
}

try {
  for (const [width,height] of sizes) {
    const page=await browser.newPage();
    const errors=[];
    page.on('pageerror',(e)=>errors.push(e.message));
    await page.setViewport({width,height,isMobile:true,hasTouch:true,deviceScaleFactor:2});
    await page.goto('http://127.0.0.1:8130/',{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.mobileScreens,{timeout:30000});
    await page.addStyleTag({content:'#debrief,.db-card{animation:none!important}'});
    const insets=width>height?{left:59,right:27,top:0,bottom:21}:{left:0,right:0,top:47,bottom:34};
    await page.evaluate((values)=>{for(const [side,n] of Object.entries(values))document.documentElement.style.setProperty('--ui-safe-'+side,n+'px');},insets);
    await settle(page);
    const prefix=`${output}/${width}x${height}`;
    for (const state of ['boot','menu','matchmaking','debrief','gameplay','editor','settings']) {
      await page.evaluate((name)=>mobileScreens.show(name),state); await settle(page);
      await page.screenshot({path:`${prefix}-${state}.png`});
      const html=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
      check(html.scroll<=html.width+1,`${width} ${state}: horizontal document overflow`);
      if(state==='boot'){
        const boot=await page.$eval('#boot h1',(e)=>({backgroundImage:getComputedStyle(e).backgroundImage,backgroundSize:getComputedStyle(e).backgroundSize,rect:e.getBoundingClientRect().toJSON()}));
        check(/logo[^/]*\.svg/.test(boot.backgroundImage)&&boot.backgroundSize!=='cover',`${width} boot: full independent wordmark not used`);
      }
      if(state==='matchmaking'||state==='debrief'){
        const cardSelector=state==='matchmaking'?'.mm-card':'.db-card';
        const card=await safeRect(page,cardSelector);
        check(within(card.rect,card.safe,false),`${width} ${state}: card outside horizontal safe region`);
        check(card.rect.top>=card.safe.top-1,`${width} ${state}: card top cropped (${card.rect.top})`);
        check(card.scrollWidth<=card.clientWidth+1,`${width} ${state}: card horizontal overflow`);
        const selector=state==='matchmaking'?'.mm-leave':'.db-go';
        const button=await reachable(page,selector);
        check(within(button.rect,card.safe),`${width} ${state}: action cannot be scrolled inside safe region`);
        check(button.hits,`${width} ${state}: action is obstructed`);
        await page.tap(selector);
        check(await page.evaluate((name)=>name==='debrief'?!mobileScreens.debrief.open:mobileScreens.leaves>0,state),`${width} ${state}: button did not activate`);
      }
      if(state==='gameplay'){
        const controls=await page.$$eval('#touch-controls button,.touch-stick',(elements)=>elements.map(e=>({name:e.dataset.touch||e.id||'joystick',rect:e.getBoundingClientRect().toJSON()})));
        const safe={left:insets.left,right:width-insets.right,top:insets.top,bottom:height-insets.bottom};
        for(const control of controls)check(within(control.rect,safe),`${width} gameplay: ${control.name} outside safe region`);
      }
      if(state==='menu'){
        for(const selector of ['.brand','#purse',".map[data-map='arena']",".map[data-map='yard']"]){
          const target=await safeRect(page,selector);
          check(within(target.rect,target.safe,false),`${width} menu: ${selector} outside horizontal safe region`);
        }
      }
      if(state==='editor'){
        const bar=await safeRect(page,'.touch-editor-bar');
        check(within(bar.rect,bar.safe),`${width} editor: toolbar clipped`);
        const done=await reachable(page,'#touch-done');
        check(done.hits&&within(done.rect,bar.safe),`${width} editor: Done inaccessible`);
        await page.$eval('.touch-editor-options',(e)=>{e.open=true;});
        await settle(page);
        await page.screenshot({path:`${prefix}-editor-expanded.png`});
        const expanded=await safeRect(page,'.touch-editor-bar');
        check(within(expanded.rect,expanded.safe),`${width} expanded editor: toolbar clipped`);
        for(const selector of ['#touch-sensitivity','#touch-mode-aim','#touch-mode-crouch','#touch-mode-sprint']){
          const option=await reachable(page,selector);
          check(option.hits&&within(option.rect,expanded.safe),`${width} expanded editor: ${selector} inaccessible`);
        }
        const finish=await reachable(page,'#touch-done');
        check(finish.hits&&within(finish.rect,expanded.safe),`${width} expanded editor: Done inaccessible`);
        await page.tap('#touch-done');
        check(await page.evaluate(()=>!mobileScreens.input.touchLayout.editing),`${width} editor: Done did not close`);
      }
      if(state==='settings'){
        const edit=await reachable(page,'#edit-touch-controls');
        const safe=(await safeRect(page,'#edit-touch-controls')).safe;
        check(edit.hits&&within(edit.rect,safe),`${width} settings: customize controls inaccessible`);
      }
    }
    // Model browser bars reducing the current page, then an orientation change.
    await page.evaluate(()=>mobileScreens.show('matchmaking'));
    await page.setViewport({width,height:Math.max(240,height-60),isMobile:true,hasTouch:true,deviceScaleFactor:2});
    await settle(page);
    const shrunk=await page.$eval('#matchmaking',(e)=>e.getBoundingClientRect().toJSON());
    check(shrunk.bottom<=Math.max(240,height-60)+1,`${width} toolbar resize: overlay exceeds viewport`);
    await page.setViewport({width:height,height:width,isMobile:true,hasTouch:true,deviceScaleFactor:2});
    await settle(page);
    const rotated=await page.$eval('#matchmaking',(e)=>e.getBoundingClientRect().toJSON());
    if(rotated.right>height+1||rotated.bottom>width+1) console.log('rotation measurement',await page.evaluate(()=>({inner:[innerWidth,innerHeight],visual:[visualViewport.width,visualViewport.height],app:[getComputedStyle(document.documentElement).getPropertyValue('--app-width'),getComputedStyle(document.documentElement).getPropertyValue('--app-height')]})),rotated);
    check(rotated.right<=height+1&&rotated.bottom<=width+1,`${width} rotation: overlay exceeds viewport`);
    check(errors.length===0,`${width}: page errors ${errors.join('; ')}`);
    console.log(`${width}x${height}: captured boot, menu, matchmaking, debrief, gameplay, editor and settings`);
    await page.close();
  }
  console.log(JSON.stringify({failures,screenshots:output},null,2));
  if(failures.length)process.exitCode=1;
} finally {await browser.close();await new Promise((done)=>server.close(done));}
