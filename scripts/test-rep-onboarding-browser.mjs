// Walks a new rep through the welcome, lessons and quiz with the real course
// content. Only the server calls are faked, so no account or AI call is used.
import {createRequire} from 'node:module';
import {createServer} from 'vite';
import {gradeRepQuiz,publicRepCourse} from '../functions/rep-course.js';
const require=createRequire(process.cwd()+'/package.json');
const {chromium}=require('playwright');
const shots=process.env.REP_ONBOARDING_SHOTS||'';
const server=await createServer({server:{host:'127.0.0.1',port:0}});
await server.listen();
const base=server.resolvedUrls.local[0];
const browser=await chromium.launch({headless:true});
const errors=[];
const open=async viewport=>{
 const page=await browser.newPage({viewport});
 page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
 await page.exposeFunction('gradeQuiz',answers=>gradeRepQuiz('bitesites',answers));
 await page.route('**/*',route=>{
  const u=new URL(route.request().url());
  if(u.hostname!=='127.0.0.1')return route.abort();
  if(u.pathname==='/__course')return route.fulfill({contentType:'text/html; charset=utf-8',body:`<html><head><meta charset="utf-8"><link rel="stylesheet" href="/src/admin/admin.css"><link rel="stylesheet" href="/src/admin/outbound/outbound.css"></head><body class="bs-admin"><div id="root"></div><script type="module">
   import React from '/node_modules/.vite/deps/react.js';
   import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
   import RefreshRuntime from '/@react-refresh';
   RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
   const {default:RepCourse}=await import('/src/admin/outbound/RepCourse.jsx');
   ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(RepCourse,{accountId:'bitesites',accountName:'BiteSites',onPassed:async()=>{window.passed=true}}));
  </script></body></html>`});
  if(u.pathname==='/src/admin/outbound/data.js')return route.fulfill({contentType:'application/javascript',body:`export const outbound={repCourse:async()=>({course:${JSON.stringify(publicRepCourse('bitesites'))}}),submitRepCourseQuiz:(id,answers)=>window.gradeQuiz(answers)}`});
  return route.continue();
 });
 return page;
};
const fits=async(page,label)=>{if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error(`${label} scrolls sideways`)};
try{
 for(const [name,viewport] of [['desktop',{width:1280,height:900}],['phone',{width:375,height:812}]]){
  const page=await open(viewport);
  await page.goto(new URL('/__course',base).href);
  await page.getByRole('heading',{name:'We’re really glad you’re here.'}).waitFor();
  await page.getByRole('button',{name:'Start lesson 1'}).click();
  const lessons=publicRepCourse('bitesites').lessons;
  for(const [index,lesson] of lessons.entries()){
   await page.getByRole('heading',{name:lesson.title,exact:true}).waitFor();
   await fits(page,`${lesson.title} on ${name}`);
   if(lesson.id==='pricing'){
    await page.getByText('Growth Site: From $2,500').waitFor();
    if(shots)await page.screenshot({path:`${shots}/course-pricing-${name}.png`,fullPage:true});
   }
   await page.getByRole('button',{name:index===lessons.length-1?'Take the quiz':'Next lesson'}).click();
  }
  const submit=page.getByRole('button',{name:'Submit quiz'});
  if(await submit.isEnabled())throw new Error('An unfinished quiz can be submitted');
  const questions=publicRepCourse('bitesites').quiz;
  for(const [index] of questions.entries())await page.locator('fieldset').nth(index).getByRole('radio').first().check();
  await submit.click();
  await page.getByText('Almost there. Try again.').waitFor();
  if(await page.evaluate(()=>window.passed))throw new Error('A failed quiz unlocked practice');
  const key={'close-definition':1,'first-move':2,'price-start':2,'price-social':0,'price-asked':1,'heard-yes':1,pushback:2,'clear-no':1,'do-not-call':2,promises:2};
  for(const [index,item] of questions.entries())await page.locator('fieldset').nth(index).getByRole('radio').nth(key[item.id]).check();
  await fits(page,`quiz on ${name}`);
  if(shots)await page.screenshot({path:`${shots}/course-quiz-${name}.png`,fullPage:true});
  await submit.click();
  await page.waitForFunction(()=>window.passed===true);
  await page.close();
 }
 for(const [name,viewport] of [['desktop',{width:1280,height:900}],['phone',{width:375,height:812}],['small',{width:320,height:700}]]){
  const page=await browser.newPage({viewport});
  await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  await page.goto(new URL('/join',base).href);
  await page.getByRole('heading',{name:'We’re so glad you’re here.'}).waitFor();
  await page.getByRole('button',{name:'Create my account'}).waitFor();
  await fits(page,`join on ${name}`);
  if(shots)await page.screenshot({path:`${shots}/join-${name}.png`,fullPage:true});
  await page.getByRole('button',{name:'Already have an account? Sign in'}).click();
  await page.getByRole('heading',{name:'Welcome back'}).waitFor();
  await page.close();
 }
 const guide=publicRepCourse('bitesites').fieldGuide;
 for(const [name,viewport] of [['desktop',{width:1280,height:900}],['phone',{width:375,height:812}],['small',{width:320,height:700}]]){
  const page=await browser.newPage({viewport});
  page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
  await page.route('**/*',route=>{
   const u=new URL(route.request().url());
   if(u.hostname!=='127.0.0.1')return route.abort();
   if(u.pathname==='/__guide')return route.fulfill({contentType:'text/html; charset=utf-8',body:`<html><head><meta charset="utf-8"><link rel="stylesheet" href="/src/admin/admin.css"><link rel="stylesheet" href="/src/admin/outbound/outbound.css"></head><body class="bs-admin"><div id="root"></div><script type="module">
    import React from '/node_modules/.vite/deps/react.js';
    import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
    import RefreshRuntime from '/@react-refresh';
    RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
    const {default:RepFieldGuide}=await import('/src/admin/outbound/RepFieldGuide.jsx');
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(RepFieldGuide,{guide:${JSON.stringify(guide)}}));
   </script></body></html>`});
   return route.continue();
  });
  await page.goto(new URL('/__guide',base).href);
  await page.getByRole('button',{name:'Show guide'}).click();
  await page.getByRole('heading',{name:guide.promise}).waitFor();
  await page.getByText('Growth Site from $2,500').waitFor();
  await page.getByText('End the call and press Do not call.').waitFor();
  await fits(page,`field guide on ${name}`);
  if(shots)await page.screenshot({path:`${shots}/field-guide-${name}.png`,fullPage:true});
  if(name==='desktop'){
   // Print exactly what the Print button puts in its frame: the sheet alone on a letter page.
   await page.evaluate(()=>{
    const sheet=document.querySelector('.rep-guide').outerHTML;
    document.body.className='bs-admin rep-guide-print';
    document.body.innerHTML=sheet;
    const style=document.createElement('style');style.textContent='@page { size: letter; margin: .35in; }';document.head.append(style);
   });
   await page.emulateMedia({media:'print'});
   const pdf=await page.pdf({preferCSSPageSize:true,printBackground:true,...(shots?{path:`${shots}/field-guide.pdf`}:{})});
   const pages=(pdf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g)||[]).length;
   if(pages!==1)throw new Error(`The printed field guide is ${pages} pages, not 1`);
  } else {
   await page.getByRole('button',{name:'Hide guide'}).click();
   if(await page.locator('.rep-guide').count())throw new Error('Hide guide did not close the sheet');
  }
  await page.close();
 }
 {
  // Practice: the guide opens on its own and sits beside the call.
  const page=await browser.newPage({viewport:{width:1366,height:900}});
  page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
  const account={accountId:'bitesites',accountName:'BiteSites',ready:true,courseRequired:true,quizPassed:true,passed:false,trainingExempt:false,completedScenarioIds:[],requiredScenarioCount:6};
  await page.route('**/*',route=>{
   const u=new URL(route.request().url());
   if(u.hostname!=='127.0.0.1')return route.abort();
   if(u.pathname==='/__practice')return route.fulfill({contentType:'text/html; charset=utf-8',body:`<html><head><meta charset="utf-8"><link rel="stylesheet" href="/src/admin/admin.css"><link rel="stylesheet" href="/src/admin/outbound/outbound.css"></head><body class="bs-admin"><div id="root"></div><script type="module">
    import React from '/node_modules/.vite/deps/react.js';
    import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
    import RefreshRuntime from '/@react-refresh';
    RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
    const {default:RepTraining}=await import('/src/admin/outbound/RepTraining.jsx');
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(RepTraining,{accounts:[${JSON.stringify(account)}]}));
   </script></body></html>`});
   if(u.pathname==='/src/admin/outbound/data.js')return route.fulfill({contentType:'application/javascript',body:`export const outbound={repCourse:async()=>({course:${JSON.stringify(publicRepCourse('bitesites'))}})}`});
   if(u.pathname==='/src/admin/outbound/practice-call-client.js')return route.fulfill({contentType:'application/javascript',body:'export const startPracticeCall=async()=>{throw new Error("not in this test")}'});
   return route.continue();
  });
  await page.goto(new URL('/__practice',base).href);
  await page.getByRole('button',{name:'Start role-play'}).waitFor();
  await page.getByRole('heading',{name:guide.promise}).waitFor();
  const side=await page.evaluate(()=>{const a=document.querySelector('.rep-training-session').getBoundingClientRect(),b=document.querySelector('.rep-guide-shell').getBoundingClientRect();return b.left>=a.right-1&&Math.abs(b.top-a.top)<4});
  if(!side)throw new Error('The guide is not beside the practice call');
  await fits(page,'practice with guide');
  if(shots)await page.screenshot({path:`${shots}/practice-with-guide.png`});
  await page.close();
 }
 if(errors.length)throw new Error(errors.join('\n'));
 console.log('Browser passed: welcome, all lessons, pricing, quiz retry and pass, join page, and the field guide (opens, hides, fits phones, prints on one page, opens beside practice).');
}finally{await browser.close();await server.close()}
