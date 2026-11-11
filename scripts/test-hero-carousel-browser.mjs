// Hero carousel: rotates every 6s, keeps going with the pointer on the image,
// holds on the project pill, pause/play, wraps around, and still rotates (with
// no zoom) for reduced motion.
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
await p.locator('.bento-switch').hover({position:{x:20,y:10}});await p.waitForTimeout(7000);assert.equal(await active(p),'Stone Bellisimo','holds on the pill');
await p.locator('.bento-shot').hover({position:{x:700,y:300}});await p.waitForTimeout(6600);assert.equal(await active(p),'The Stock Room','keeps going with the pointer on the image');
await p.mouse.move(5,5);
await p.getByRole('button',{name:'Pause the slideshow'}).click();await p.mouse.move(5,5);await p.waitForTimeout(6600);assert.equal(await active(p),'The Stock Room','pause button stops it');
await p.getByRole('button',{name:'Play the slideshow'}).click();await p.mouse.move(5,5);
await p.locator('.bento-switch').getByRole('button',{name:'Bodega Project',exact:true}).click();await p.mouse.move(5,5);
await p.waitForTimeout(6600);assert.equal(await active(p),'Nexus Verium','wraps around');
// mid-fade frame for the transition
await p.waitForTimeout(5600);if(out)await p.screenshot({path:`${out}/mid-fade.png`});
await p.close();
const r=await b.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});await r.goto(s.resolvedUrls.local[0],{waitUntil:'networkidle'});
await r.waitForTimeout(6600);assert.equal(await active(r),'Stone Bellisimo','reduced motion still rotates');
assert.equal(await r.locator('.bento-shot img.is-active').evaluate(e=>getComputedStyle(e).transform),'none','no zoom for reduced motion');
assert.equal(await r.getByRole('button',{name:'Pause the slideshow'}).count(),1);await r.close();
assert.deepEqual(errors,[]);console.log('PASS carousel: rotates, ignores the pointer on the image, holds on the pill, pause/play, wraps, reduced motion fades without zoom');
await b.close();await s.close();
