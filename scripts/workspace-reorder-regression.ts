import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createServer, transformWithEsbuild } from 'vite';
import { chromium, type Page } from 'playwright-core';
import { chromiumExecutable } from './browser.ts';

// Synthetic only, same isolated Vite convention as workspace-status-regression.
const root = resolve(import.meta.dir, '..');
const fixture = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Sidebar} from '/src/components/Sidebar.tsx';
import {SettingsProvider} from '/src/lib/settings.ts';
import '/src/styles.css';
const ids = ['a','b','c','d'];
const make = () => ({protocol:1,version:'fixture',agents:[],layouts:[],tabs:[],
 workspaces:ids.map(id=>({workspace_id:id,label:id.toUpperCase(),active_tab_id:id,focused:false,number:1,pane_count:1,tab_count:1})),
 panes:ids.flatMap((id,i)=>Array.from({length:[1,4,2,3][i]},(_,n)=>({pane_id:id+n,terminal_id:id+n,workspace_id:id,tab_id:id,focused:false,revision:0,agent_status:'idle',title:'Synthetic terminal '+n})))});
function Fixture(){
 const [snapshot,setSnapshot]=useState(make); const [mounted,setMounted]=useState(true); const [selection,setSelection]=useState('');
 window.fixture={status:()=>setSnapshot(s=>({...s,panes:s.panes.map(p=>({...p,agent_status:'working'}))})),
 structure:()=>setSnapshot(s=>({...s,workspaces:s.workspaces.filter(w=>w.workspace_id!=='d'),panes:s.panes.filter(p=>p.workspace_id!=='d')})),
 reset:()=>setSnapshot(make()),unmount:()=>setMounted(false)};
 const noop=()=>{}; const actions={selectPane:setSelection,selectAdjacentPane:noop,setView:noop,toggleView:noop,openNewSession:noop,openPalette:noop,openSettings:noop,openAddPc:noop,toggleSidebar:noop,toggleTheme:noop,lock:null,enableNotifications:null,refresh:noop,openFiles:null};
 return <><div className="machine-list" style={{height:620,width:360,overflowY:'auto'}}>{mounted&&<Sidebar snapshot={snapshot} selectedPaneId={null} actions={actions} onSelectWorkspace={setSelection}/>}</div><output>{selection}</output></>;
}
createRoot(document.getElementById('root')).render(<SettingsProvider><Fixture/></SettingsProvider>);
`;
const vite = await createServer({ root, configFile:false, cacheDir:'/tmp/termweave-reorder-vite-cache',
 optimizeDeps:{include:['react','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime','lucide-react']},
 esbuild:{jsx:'automatic'}, define:{__APP_VERSION__:JSON.stringify('fixture')},
 server:{host:'127.0.0.1',port:0}, plugins:[{name:'workspace-reorder-fixture',
 resolveId(id){if(id==='virtual:workspace-reorder-fixture')return '\0workspace-reorder-fixture.tsx';},
 async load(id){if(id==='\0workspace-reorder-fixture.tsx')return (await transformWithEsbuild(fixture,'workspace-reorder-fixture.tsx',{loader:'tsx',jsx:'automatic'})).code;},
 configureServer(server){server.middlewares.use((request,response,next)=>{
 if(request.url!=='/reorder-test')return next();
 void server.transformIndexHtml('/reorder-test','<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@id/virtual:workspace-reorder-fixture"></script></body></html>')
 .then(html=>{response.setHeader('Content-Type','text/html');response.end(html);});
 });}}] });
let browser: Awaited<ReturnType<typeof chromium.launch>>|undefined;
try {
 await vite.listen(); const port=(vite.httpServer!.address() as {port:number}).port;
 browser=await chromium.launch({executablePath:chromiumExecutable(),headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:900}});
 await page.addInitScript(()=>localStorage.setItem('termweave:settings',JSON.stringify({language:'en'})));
 const errors:string[]=[]; page.on('pageerror',error=>errors.push(error.message));
 let requests:{workspace_id:string;insert_index:number}[]=[];
 let fail=false; let release:(()=>void)|undefined; let hold=false;
 await page.route('**/api/**',async route=>{
  if(route.request().url().endsWith('/workspace/move')){
   requests=[...requests,route.request().postDataJSON()];
   if(hold)await new Promise<void>(resolve=>{release=resolve;});
   await route.fulfill(fail?{status:500,json:{error:{code:'fixture',message:'synthetic failure'}}}:{json:{ok:true}});
  } else await route.fulfill({json:{providers:[],machines:[],reports:[]}});
 });
 const section=(id:string)=>page.locator('[data-reorder-workspace="'+id+'"]');
 const handle=(id:string)=>section(id).locator('.sidebar-drag-handle');
 const order=()=>page.locator('[data-reorder-workspace]').evaluateAll(elements=>elements.map(e=>(e as HTMLElement).dataset.reorderWorkspace));
 const fresh=async()=>{await page.goto('http://127.0.0.1:'+port+'/reorder-test');await section('d').waitFor();requests=[];fail=false;hold=false;};
 const start=async(id='a')=>{
  await handle(id).focus();const box=(await handle(id).boundingBox())!;
  const point={x:box.x+box.width/2,y:box.y+box.height/2};
  await page.mouse.move(point.x,point.y);await page.mouse.down();return point;
 };
 const drag=async(id='a',delta=260)=>{const point=await start(id);await page.mouse.move(point.x,point.y+delta,{steps:12});return point;};
 const waitCount=async(count:number)=>{const deadline=Date.now()+5000;while(requests.length<count&&Date.now()<deadline)await page.waitForTimeout(20);assert.equal(requests.length,count);};
 const waitIdle=async()=>{await page.waitForTimeout(220);await page.waitForFunction(()=>!document.querySelector('.is-reordering')&&!document.querySelector('[aria-disabled="true"].sidebar-drag-handle'));};
 await fresh();
 const heights=await page.locator('.workspace').evaluateAll(elements=>elements.map(e=>e.getBoundingClientRect().height));
 assert.ok(new Set(heights).size>2,'mixed section heights');
 const original=(await section('a').boundingBox())!; const b=(await section('b').boundingBox())!;
 const point=await start();await page.mouse.move(point.x,point.y+4);
 assert.equal(await section('a').getAttribute('class'),'workspace','below 6px stays inactive');
 await page.mouse.move(point.x,point.y+160,{steps:10});
 const tracked=(await section('a').boundingBox())!;
 assert.ok(Math.abs(tracked.y-original.y-160)<2,'actual section tracks pointer without lag');
 assert.equal(await section('a').evaluate(e=>getComputedStyle(e).opacity),'1');
 assert.notEqual(await section('a').evaluate(e=>getComputedStyle(e).boxShadow),'none');
 const boundary=await section('b').evaluate(e=>(e as HTMLElement).offsetHeight/2);
 await page.mouse.move(point.x,point.y+boundary+9);await page.waitForTimeout(180);
 assert.ok(await section('b').evaluate(e=>(e as HTMLElement).style.transform!=='translateY(0px)'));
 await page.mouse.move(point.x,point.y+boundary-4);await page.waitForTimeout(180);
 assert.ok(await section('b').evaluate(e=>(e as HTMLElement).style.transform!=='translateY(0px)'),'reversal deadband resists jitter');
 await page.mouse.move(point.x,point.y+boundary-9);await page.waitForTimeout(180);
 assert.equal(await section('b').evaluate(e=>(e as HTMLElement).style.transform),'translateY(0px)','past deadband reverses displacement');
 await page.mouse.move(point.x,point.y+160);await page.waitForTimeout(180);
 assert.ok((await section('b').boundingBox())!.y<b.y-30,'siblings visibly displace');
 assert.deepEqual(await order(),['a','b','c','d'],'preview does not mutate persisted order');
 assert.equal(requests.length,0);
 await page.locator('.machine-list').screenshot({path:'/tmp/termweave-workspace-reorder-preview.png'});
 await page.mouse.up();await waitIdle();await page.waitForTimeout(250);
 assert.equal(requests.length,1);assert.equal(requests[0]!.workspace_id,'a');
 assert.notDeepEqual(await order(),['a','b','c','d']);
 assert.equal(await handle('a').evaluate(e=>document.activeElement===e),true,'grip focus survives reorder');
 console.log('PASS mixed heights, 6px activation, opaque live tracking, sibling displacement, preview isolation, settle, one request, focus');

 await fresh();fail=true;await drag();await page.mouse.up();await page.getByRole('alert').waitFor();await waitIdle();
 assert.deepEqual(await order(),['a','b','c','d']);assert.equal(requests.length,1);assert.match(await page.getByRole('alert').innerText(),/synthetic failure/);
 console.log('PASS failed request rollback');

 for(const reason of ['escape','pointercancel','lostcapture','structure','unmount'] as const){
  await fresh();await drag('a',160);
  if(reason==='escape')await page.keyboard.press('Escape');
  else if(reason==='structure'||reason==='unmount')await page.evaluate(r=>(window as any).fixture[r](),reason);
  else if(reason==='lostcapture')await handle('a').evaluate(e=>e.releasePointerCapture(1));
  else await handle('a').evaluate(e=>e.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,pointerId:1})));
  await page.mouse.up();await page.waitForTimeout(220);assert.equal(requests.length,0,reason+' must not commit');
  assert.equal(await page.locator('.is-reordering').count(),0);
 }
 console.log('PASS Escape, pointercancel, lost capture, structural change, unmount cancellation');

 await fresh();await drag('a',160);await page.evaluate(()=>(window as any).fixture.status());
 assert.equal(await section('a').evaluate(e=>e.classList.contains('is-dragging')),true,'status-only push preserves drag');
 await page.mouse.move(point.x,point.y+300,{steps:8});await page.mouse.up();await waitIdle();await page.waitForTimeout(250);assert.equal(requests.length,1);
 console.log('PASS status changes during drag');

 await fresh();hold=true;await handle('a').focus();await page.keyboard.press('Alt+ArrowDown');
 await page.waitForFunction(()=>document.querySelector('.sidebar-drag-handle[aria-disabled="true"]'));await waitCount(1);
 await page.evaluate(()=>(window as any).fixture.status());assert.deepEqual(await order(),['b','a','c','d'],'pending status push cannot reset optimistic order');
 await page.keyboard.press('Alt+ArrowDown');await drag('b',160);await page.mouse.up();assert.equal(requests.length,1,'no overlapping keyboard/pointer requests');
 hold=false;release!();await waitIdle();assert.equal(await handle('a').evaluate(e=>document.activeElement===e),false); // later explicit pointer focus is preserved
 await handle('a').focus();await page.keyboard.press('Alt+ArrowUp');await waitIdle();assert.deepEqual(await order(),['a','b','c','d']);
 assert.equal(await handle('a').evaluate(e=>document.activeElement===e),true);
 console.log('PASS Alt+Arrow ordering/focus, pending lock, status push protection');

 await fresh();hold=true;fail=true;await handle('a').focus();await page.keyboard.press('Alt+ArrowDown');
 await page.waitForFunction(()=>document.querySelector('.sidebar-drag-handle[aria-disabled="true"]'));await waitCount(1);
 await page.evaluate(()=>(window as any).fixture.structure());await section('d').waitFor({state:'detached'});assert.deepEqual(await order(),['a','b','c']);
 await page.keyboard.press('Alt+ArrowDown');assert.equal(requests.length,1);
 release!();await waitIdle();assert.deepEqual(await order(),['a','b','c'],'stale rejection cannot resurrect removed workspace');
 console.log('PASS pending structural reset and stale rollback protection');

 await fresh();await page.emulateMedia({reducedMotion:'reduce'});await drag('a',160);await page.mouse.up();await waitIdle();
 assert.equal(requests.length,1);assert.equal(await page.locator('.is-settling').count(),0);
 assert.equal(await section('a').evaluate(e=>e.getAnimations().length),0);
 console.log('PASS reduced motion skips settle animation');

 await fresh();await page.emulateMedia({reducedMotion:'no-preference'});
 await page.locator('.machine-list').evaluate(e=>(e as HTMLElement).style.height='250px');
 const scrollStart=await page.locator('.machine-list').evaluate(e=>e.scrollTop);
 const scrollPoint=await start();await page.mouse.move(scrollPoint.x,240,{steps:8});await page.waitForTimeout(300);
 assert.ok(await page.locator('.machine-list').evaluate(e=>e.scrollTop)>scrollStart,'actual machine-list scrolls');
 const scrollTracked=(await section('a').boundingBox())!;
 assert.ok(Math.abs((scrollTracked.y-original.y)-(240-scrollPoint.y))<2,'drag stays attached while ancestor scrolls');
 await page.keyboard.press('Escape');await page.mouse.up();assert.equal(requests.length,0);
 console.log('PASS machine-list auto-scroll and pointer attachment');

 await fresh();await section('a').locator('[data-workspace-id]').click();assert.equal(await page.locator('output').innerText(),'a');
 await section('a').locator('.workspace-disclosure').click();assert.equal(await section('a').locator('.workspace-terminals').isVisible(),false);
 await section('a').locator('.row-menu-toggle').click();await page.getByRole('menu').waitFor();await page.keyboard.press('Escape');
 assert.equal(requests.length,0);
 await section('a').locator('.workspace-disclosure').click();
 const row=(await section('a').locator('[data-workspace-id]').boundingBox())!;
 await page.mouse.move(row.x+row.width/2,row.y+row.height/2);await page.mouse.down();await page.mouse.move(row.x+row.width/2,row.y+180,{steps:8});await page.mouse.up();
 assert.equal(await page.locator('.is-reordering').count(),0,'non-handle rows cannot drag');assert.equal(requests.length,0);
 assert.deepEqual(errors,[]);
 console.log('PASS handle-only selection, disclosure, menu unaffected; no browser errors');
} finally { await browser?.close();await vite.close(); }
