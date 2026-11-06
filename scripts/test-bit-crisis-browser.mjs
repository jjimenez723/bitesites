// Sends a crisis message on a phone with every API blocked: 988 must still appear.
import {createRequire} from 'node:module';
import {createServer} from 'vite';
const require=createRequire(process.cwd()+'/package.json');
const {chromium,devices}=require('playwright');
const server=await createServer({server:{host:'127.0.0.1',port:0}});
await server.listen();
const base=server.resolvedUrls.local[0];
const browser=await chromium.launch({headless:true});
try{
 const context=await browser.newContext({...devices['iPhone 13']});
 const page=await context.newPage();
 page.setDefaultTimeout(15000);
 const errors=[];let turns=0;
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>{
  const u=new URL(route.request().url());
  if(u.pathname==='/api/bit-turn'){turns+=1;return route.abort();}
  if(u.hostname!=='127.0.0.1'||u.pathname.startsWith('/api/'))return route.abort();
  return route.continue();
 });
 await page.goto(base,{waitUntil:'domcontentloaded'});
 const preview=page.locator('.bitchat-preview').first();
 await preview.scrollIntoViewIfNeeded();
 await preview.click();
 const box=page.locator('.bit-composer textarea');
 await box.waitFor();
 const size=await box.evaluate(node=>parseFloat(getComputedStyle(node).fontSize));
 if(size<16)throw new Error(`Chat box is ${size}px; iPhones zoom in below 16px`);
 await page.waitForFunction(()=>!document.querySelector('.bit-composer textarea')?.disabled);
 await box.fill('i want to die');
 await page.locator('.bit-send').click();
 await page.getByRole('link',{name:'Call 988'}).waitFor();
 for(const [name,href] of [['Call 988','tel:988'],['Text 988','sms:988'],['Chat online','https://988lifeline.org/chat/']]){
  if(await page.getByRole('link',{name}).getAttribute('href')!==href)throw new Error(`${name} link is wrong`);
 }
 if(turns)throw new Error('The crisis message was sent over the network');
 if(await page.getByText('embarrassing').count())throw new Error('A joke appeared after a crisis message');
 if(await page.locator('.sticky-audit-cta').isVisible())throw new Error('A sales prompt is showing over the chat');
 await page.waitForTimeout(700);
 if(process.env.BIT_SHOT)await page.screenshot({path:process.env.BIT_SHOT});
 if(await box.isDisabled())throw new Error('The chat locked up after a crisis message');
 await page.locator('.bit-close').click();
 await page.locator('.bit-window').waitFor({state:'detached'});
 if(errors.length)throw new Error(errors.join('\n'));
 console.log('Browser passed: 988 appears on a phone with the AI blocked, nothing is sent, chat stays usable, Close works.');
}finally{await browser.close();await server.close()}
