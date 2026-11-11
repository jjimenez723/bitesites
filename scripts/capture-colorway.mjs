// Screenshots each homepage section in each colorway, for picking a palette.
//   COLORWAY_SHOTS=<dir> node scripts/capture-colorway.mjs [current lagoon navy]
import {createRequire} from 'node:module';
import {createServer} from 'vite';
const require=createRequire(process.cwd()+'/package.json');
const {chromium}=require('playwright');
const out=process.env.COLORWAY_SHOTS;
if(!out) throw new Error('Set COLORWAY_SHOTS to an output folder.');
const ways=process.argv.slice(2).length?process.argv.slice(2):['current','lagoon','navy'];
const server=await createServer({server:{host:'127.0.0.1',port:0},logLevel:'error'});
await server.listen();
const base=server.resolvedUrls.local[0];
const browser=await chromium.launch({headless:true});
for(const [label,viewport] of [['desktop',{width:1440,height:900}],['phone',{width:390,height:844}]]){
  for(const way of ways){
    const page=await browser.newPage({viewport});
    await page.goto(way==='current'?base:`${base}?colorway=${way}`,{waitUntil:'networkidle'});
    const total=await page.evaluate(()=>document.body.scrollHeight);
    let i=0;
    for(let y=0;y<total && i<Number(process.env.COLORWAY_PAGES||14);y+=viewport.height,i++){
      await page.evaluate(top=>window.scrollTo(0,top),y);
      await page.waitForTimeout(900);
      await page.screenshot({path:`${out}/${way}-${label}-${String(i).padStart(2,'0')}.png`});
    }
    await page.close();
  }
}
await browser.close();await server.close();
console.log('saved',ways.join(', '));
