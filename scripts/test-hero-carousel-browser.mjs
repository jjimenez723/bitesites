// Hero carousel: rotates every 6s, holds on hover, resumes, pause/play,
// wraps around, and never moves for reduced motion.
//   node scripts/test-hero-carousel-browser.mjs [screenshot-folder]
import {createRequire} from 'node:module';import {createServer} from 'vite';import assert from 'node:assert/strict';
const require=createRequire(process.cwd()+'/package.json');const {chromium}=require('playwright');
const s=await createServer({server:{host:'127.0.0.1',port:0},logLevel:'error'});await s.listen();
const b=await chromium.launch();const out=process.argv[2]||'';const errors=[];
const active=p=>p.locator('.bento-switch button[aria-pressed="true"]').textContent();
const p=await b.newPage({viewport:{width:1440,height:900}});p.on('pageerror',e=>errors.push(e.message));
await p.goto(s.resolvedUrls.local[0],{waitUntil:'networkidle'});await p.mouse.move(5,5);
assert.equal(await active(p),'Nexus Verium');
await p.waitForTimeout(6600);assert.equal(await active(p),'Stone Bellisimo','advances after 6s');
await p.waitForTimeout(400);if(out)await p.screenshot({path:`${out}/slide2.png`});
await p.locator('.bento-shot').hover({position:{x:700,y:300}});await p.waitForTimeout(7000);assert.equal(await active(p),'Stone Bellisimo','holds on hover');
await p.mouse.move(5,5);await p.waitForTimeout(6600);assert.equal(await active(p),'The Stock Room','resumes after hover');
await p.getByRole('button',{name:'Pause the slideshow'}).click();await p.mouse.move(5,5);await p.waitForTimeout(6600);assert.equal(await active(p),'The Stock Room','pause button stops it');
await p.getByRole('button',{name:'Play the slideshow'}).click();await p.mouse.move(5,5);
await p.locator('.bento-switch').getByRole('button',{name:'Bodega Project',exact:true}).click();await p.mouse.move(5,5);
await p.waitForTimeout(6600);assert.equal(await active(p),'Nexus Verium','wraps around');
// mid-fade frame for the transition
await p.waitForTimeout(5600);if(out)await p.screenshot({path:`${out}/mid-fade.png`});
await p.close();
const r=await b.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});await r.goto(s.resolvedUrls.local[0],{waitUntil:'networkidle'});
await r.waitForTimeout(7000);assert.equal(await active(r),'Nexus Verium','reduced motion never moves');
assert.equal(await r.getByRole('button',{name:/slideshow/}).count(),0);await r.close();
assert.deepEqual(errors,[]);console.log('PASS carousel: rotates, holds on hover, resumes, pause/play, wraps, reduced motion still');
await b.close();await s.close();
