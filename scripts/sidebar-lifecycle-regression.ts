import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,readFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright-core';
import {chromiumExecutable} from './browser.ts';
import {createServer} from '../server/index.ts';
import {workspaceCreate,workspaceClose,sessionSnapshot,paneSendText,paneSendKeys} from '../server/herdr/client.ts';
const {testSocketPath}=await import('./test-herdr.ts');
assert.equal(process.env.HERDR_SOCKET,testSocketPath());
assert.notEqual(process.env.HERDR_TEST_LIVE,'1');
const root=mkdtempSync(join(tmpdir(),'sidebar-life-'));
const owned=[];let server;let browser;
try{
 for(const name of ['owned-sidebar-a','owned-sidebar-b'])owned.push(await workspaceCreate({cwd:root,label:name}));
 server=createServer({port:0,hostname:'127.0.0.1',token:'',stateDir:join(root,'state'),tailscaleOwner:null});
 const origin=`http://127.0.0.1:${server.port}`;
 const snapshot=async()=>(await (await fetch(origin+'/api/session')).json()).snapshot;
 const before=await snapshot();const a=before.panes.find(p=>p.terminal_id===owned[0].root_pane.terminal_id);const b=before.panes.find(p=>p.terminal_id===owned[1].root_pane.terminal_id);
 assert.notEqual(a.global_pane_number,b.global_pane_number);
 const resolved=await(await fetch(origin+'/api/panes/by-number/'+b.global_pane_number)).json();assert.equal(resolved.terminal_id,b.terminal_id);
 const pidfile=join(root,'owned-shell.pid');await paneSendText(b.pane_id,`printf '%s' $$ > '${pidfile}'`);await paneSendKeys(b.pane_id,['Enter']);
 for(let i=0;i<60&&!existsSync(pidfile);i++)await Bun.sleep(100);
 assert.ok(existsSync(pidfile));const pid=Number(readFileSync(pidfile,'utf8'));assert.ok(Number.isInteger(pid)&&pid>1);
 browser=await chromium.launch({headless:true,executablePath:chromiumExecutable()});const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>localStorage.setItem('termweave:settings',JSON.stringify({language:'ko'})));
 await page.goto(origin+'/?pane='+encodeURIComponent(a.pane_id));
 const choose=async(p,button,label,touch=false)=>{
  if(touch)await button.tap();else await button.click();
  const item=p.locator('.row-menu [role="menuitem"], .row-sheet-item').filter({hasText:label});
  try{if(touch)await item.tap();else await item.click();}catch(error){
   if(process.env.DOCK_EVIDENCE){
    await p.screenshot({path:join(process.env.DOCK_EVIDENCE,'menu-failure.png')});
    await Bun.write(join(process.env.DOCK_EVIDENCE,'menu-failure.html'),await p.content());
    await Bun.write(join(process.env.DOCK_EVIDENCE,'menu-failure-events.json'),JSON.stringify(await p.evaluate(()=>window.__menuTrace??[]),null,2));
   }
   throw error;
  }
 };
 const row=page.locator('.workspace').filter({has:page.locator(`[data-workspace-id="${a.workspace_id}"]`)});
 const collapse=row.locator('.workspace-disclosure');await collapse.waitFor();await collapse.click();assert.equal(await collapse.getAttribute('aria-expanded'),'false');assert.equal(await row.locator('.workspace-terminals').isVisible(),false);
 assert.ok((await sessionSnapshot()).panes.some(p=>p.terminal_id===a.terminal_id));
 await page.reload();await collapse.waitFor();assert.equal(await collapse.getAttribute('aria-expanded'),'false');await collapse.press('Enter');assert.equal(await row.locator('.workspace-terminals').isVisible(),true);
 const rename=row.locator('.terminal-menu-toggle');await choose(page,rename,'터미널 이름 변경');await page.getByRole('textbox',{name:'터미널 이름',exact:true}).fill('검증한 터미널 이름');await page.getByRole('button',{name:'이름 바꾸기',exact:true}).click();
 await row.getByText('검증한 터미널 이름',{exact:true}).waitFor();await page.reload();await row.getByText('검증한 터미널 이름',{exact:true}).waitFor();assert.equal((await snapshot()).panes.find(p=>p.terminal_id===a.terminal_id).global_pane_number,a.global_pane_number);
 const activeGroup=page.locator(`.dock-group[data-pane-id="${a.pane_id}"]`);await activeGroup.getByRole('button',{name:'터미널 도구',exact:true}).click();const renameMain=activeGroup.getByRole('button',{name:`터미널 ${a.pane_id} 이름 변경`,exact:true});await renameMain.click();await page.getByRole('textbox',{name:'터미널 이름',exact:true}).fill('본문에서 변경한 이름');await page.getByRole('button',{name:'이름 바꾸기',exact:true}).click();await row.getByText('본문에서 변경한 이름',{exact:true}).waitFor();
 const close=page.locator(`.workspace-terminal-row`).filter({has:page.locator(`[data-terminal-pane="${b.pane_id}"]`)}).locator('.terminal-menu-toggle');
 await choose(page,close,'삭제');await page.getByRole('alertdialog').waitFor();await page.getByRole('button',{name:'취소',exact:true}).click();assert.ok((await sessionSnapshot()).panes.some(p=>p.terminal_id===b.terminal_id));
 // A failed close must keep the terminal visible and must not send an automatic retry.
 await page.route('**/pane/close',route=>route.fulfill({status:503,json:{error:'owned-failure'}}));
 await choose(page,close,'삭제');await page.getByRole('button',{name:'종료',exact:true}).click();await page.locator('.confirm-error').waitFor();assert.ok(await close.isVisible());
 await page.getByRole('button',{name:'취소',exact:true}).click();await page.unroute('**/pane/close');
 await choose(page,close,'삭제');await page.getByRole('button',{name:'종료',exact:true}).click();await close.waitFor({state:'detached',timeout:15000});
 assert.ok(!(await sessionSnapshot()).panes.some(p=>p.terminal_id===b.terminal_id));
 for(let i=0;i<50;i++){try{process.kill(pid,0);await Bun.sleep(100);}catch{break;}}
 assert.throws(()=>process.kill(pid,0),'native shell process must exit');
 assert.equal((await fetch(origin+'/api/panes/by-number/'+b.global_pane_number)).status,404);
 const replacement=await workspaceCreate({cwd:root,label:'owned-number-reuse'});owned.push(replacement);
 const replacementPane=(await snapshot()).panes.find(p=>p.terminal_id===replacement.root_pane.terminal_id);
 assert.equal(replacementPane.global_pane_number,b.global_pane_number);
 assert.notEqual(replacementPane.terminal_id,b.terminal_id);
 assert.equal((await snapshot()).panes.find(p=>p.terminal_id===a.terminal_id).global_pane_number,a.global_pane_number);
 const sentinel='TERMWEAVE_CONTEXT_SENTINEL';await paneSendText(replacementPane.pane_id,`printf '${sentinel}\\n'`);await paneSendKeys(replacementPane.pane_id,['Enter']);
 let context='';for(let i=0;i<40;i++){
  const child=Bun.spawn(['bun',join(import.meta.dir,'pane-context.ts'),`p${replacementPane.global_pane_number}`,'--lines','80'],{env:{...process.env,TERMWEAVE_URL:origin,HERDR_WEB_TOKEN:''},stdout:'pipe',stderr:'pipe'});
  context=await new Response(child.stdout).text();assert.equal(await child.exited,0);if(context.includes(sentinel))break;await Bun.sleep(100);
 }
 assert.ok(context.includes(sentinel));assert.ok(context.includes(replacementPane.pane_id));
 const wrong=await fetch(origin+'/api/pane/read?pane_id='+encodeURIComponent(replacementPane.pane_id)+'&terminal_id='+encodeURIComponent(b.terminal_id));assert.equal(wrong.status,409);
 await workspaceClose(replacement.workspace.workspace_id);
 await page.reload();await row.waitFor();assert.equal((await snapshot()).panes.find(p=>p.terminal_id===a.terminal_id).global_pane_number,a.global_pane_number);
 await row.locator(`[data-terminal-pane="${a.pane_id}"]`).click();
 const screenClose=page.locator(`.dock-group[data-pane-id="${a.pane_id}"] .dock-delete`);await screenClose.click();await page.getByRole('button',{name:'종료',exact:true}).click();await screenClose.waitFor({state:'detached',timeout:15000});assert.ok(!(await sessionSnapshot()).panes.some(p=>p.terminal_id===a.terminal_id));
 // Touch controls must remain usable in a real app, not only a modal fixture.
 const mobileOwned=await workspaceCreate({cwd:root,label:'모바일 터미널 사용성 검사'});owned.push(mobileOwned);
 const mobilePane=(await snapshot()).panes.find(p=>p.terminal_id===mobileOwned.root_pane.terminal_id);
 const mobile=await browser.newPage({viewport:{width:375,height:812},isMobile:true,hasTouch:true});mobile.on('pageerror',e=>errors.push(e.message));
 await mobile.addInitScript(()=>{
  localStorage.setItem('termweave:settings',JSON.stringify({language:'ko'}));
  window.__menuTrace=[];
  // Hold only the mount autofocus's readiness check, not the real socket or terminal input.
  if(location.search.includes('focusRace=1')){
   const observer=new MutationObserver(()=>{for(const group of document.querySelectorAll('.dock-group'))if(!group.querySelector('[data-focus-race]')){const marker=document.createElement('span');marker.className='terminal-banner';marker.dataset.focusRace='';group.append(marker);}});
   observer.observe(document,{childList:true,subtree:true});window.__releaseFocusRace=()=>{observer.disconnect();document.querySelectorAll('[data-focus-race]').forEach(el=>el.remove());};
  }
  for(const type of ['pointerdown','pointerup','touchstart','touchend','mousedown','click','focusin','focusout','scroll'])document.addEventListener(type,event=>{
   const el=event.target;window.__menuTrace=[...window.__menuTrace.slice(-79),{type,time:performance.now(),target:el instanceof Element?`${el.tagName}.${el.className}`:'other',related:event.relatedTarget instanceof Element?`${event.relatedTarget.tagName}.${event.relatedTarget.className}`:null,expanded:document.querySelector('.terminal-menu-toggle')?.getAttribute('aria-expanded'),menu:!!document.querySelector('.row-sheet,.row-menu')}];
  },true);
 });
 const mobileRow=mobile.locator('.workspace').filter({has:mobile.locator(`[data-workspace-id="${mobilePane.workspace_id}"]`)});
 const openDrawer=async()=>{await mobile.locator('.drawer-toggle').waitFor({state:'attached'});if(await mobile.locator('.drawer-toggle').isVisible()){await mobile.locator('.drawer-toggle').tap();await mobile.locator('.sidebar.is-open').waitFor();await mobile.locator('.sidebar.is-open').evaluate(el=>Promise.all(el.getAnimations().map(animation=>animation.finished.catch(()=>{}))));}await mobileRow.waitFor({state:'visible'});await mobileRow.scrollIntoViewIfNeeded();};
 const inViewport=async(locator,width,height)=>{const box=await locator.boundingBox();assert.ok(box&&box.x>=-1&&box.y>=-1&&box.x+box.width<=width+1&&box.y+box.height<=height+1,`control outside ${width}x${height}: ${JSON.stringify(box)}`);};
 for(const [width,height] of [[320,740],[375,812],[430,932],[768,1024],[844,390],[375,360]]){
  console.log(`CHECK mobile ${width}x${height}`);await mobile.setViewportSize({width,height});await mobile.goto(origin+'/?pane='+encodeURIComponent(mobilePane.pane_id));
  await openDrawer();
  for(const selector of ['.workspace-disclosure','.terminal-menu-toggle']){
   const control=mobileRow.locator(selector);const box=await control.boundingBox();assert.ok(box&&box.width>=44&&box.height>=44,`${selector} must have a 44px touch target`);await inViewport(control,width,height);
  }
  await mobileRow.locator('.workspace-disclosure').tap();assert.equal(await mobileRow.locator('.workspace-terminals').isVisible(),false);
  assert.ok((await sessionSnapshot()).panes.some(p=>p.terminal_id===mobilePane.terminal_id));await mobileRow.locator('.workspace-disclosure').tap();
  await choose(mobile,mobileRow.locator('.terminal-menu-toggle'),'터미널 이름 변경',true);const field=mobile.getByRole('textbox',{name:'터미널 이름',exact:true});
  assert.ok(await field.evaluate(el=>parseFloat(getComputedStyle(el).fontSize)>=16));
  await field.fill(`모바일에서도 구분할 수 있는 긴 한국어 터미널 이름 ${width}`);
  await inViewport(mobile.getByRole('dialog'),width,height);await inViewport(mobile.getByRole('button',{name:'이름 바꾸기',exact:true}),width,height);
  if(process.env.DOCK_EVIDENCE&&width===320){mkdirSync(process.env.DOCK_EVIDENCE,{recursive:true});await mobile.screenshot({path:join(process.env.DOCK_EVIDENCE,'mobile-rename-320.png')});}
  await mobile.getByRole('button',{name:'이름 바꾸기',exact:true}).tap();await mobile.getByRole('dialog').waitFor({state:'detached'});
  await mobile.reload();await openDrawer();await mobileRow.getByText(`모바일에서도 구분할 수 있는 긴 한국어 터미널 이름 ${width}`,{exact:true}).waitFor();
  const refreshed=(await snapshot()).panes.find(p=>p.terminal_id===mobilePane.terminal_id);assert.equal(refreshed.global_pane_number,mobilePane.global_pane_number);
  await choose(mobile,mobileRow.locator('.terminal-menu-toggle'),'삭제',true);await mobile.getByRole('alertdialog').waitFor();await inViewport(mobile.getByRole('alertdialog'),width,height);
  for(const name of ['취소','종료']){const control=mobile.getByRole('button',{name,exact:true});const box=await control.boundingBox();assert.ok(box&&box.height>=44);await inViewport(control,width,height);}
  await mobile.getByRole('button',{name:'취소',exact:true}).tap();assert.ok((await sessionSnapshot()).panes.some(p=>p.terminal_id===mobilePane.terminal_id));
  assert.ok(await mobile.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
  if(process.env.DOCK_EVIDENCE&&width===320)await mobile.screenshot({path:join(process.env.DOCK_EVIDENCE,'mobile-sidebar-320.png')});
 }
 // Terminal readiness arriving after a real sidebar tap must not dismiss its menu.
 for(const width of [375,844]){
  await mobile.setViewportSize({width,height:390});await mobile.goto(origin+'/?pane='+encodeURIComponent(mobilePane.pane_id)+'&focusRace=1');await openDrawer();
  await mobile.locator('[data-focus-race]').first().waitFor({state:'attached'});
  await mobileRow.locator('.terminal-menu-toggle').tap();
  const surface=mobile.locator('.row-sheet,.row-menu');await surface.waitFor({state:'visible'});
  if(process.env.DOCK_EVIDENCE){await mobile.screenshot({path:join(process.env.DOCK_EVIDENCE,`menu-focus-race-${width}.png`)});await Bun.write(join(process.env.DOCK_EVIDENCE,`menu-focus-race-${width}.html`),await mobile.content());}
  await mobile.evaluate(async()=>{window.__releaseFocusRace();for(let i=0;i<8;i++)await new Promise(requestAnimationFrame);});
  if(process.env.DOCK_EVIDENCE){await mobile.screenshot({path:join(process.env.DOCK_EVIDENCE,`menu-focus-race-after-${width}.png`)});await Bun.write(join(process.env.DOCK_EVIDENCE,`menu-focus-race-after-${width}.html`),await mobile.content());}
  assert.ok(await surface.isVisible(),'terminal readiness must not steal focus from the sidebar menu');
  assert.ok(await surface.evaluate(el=>el.contains(document.activeElement)));
  await mobile.locator('.row-menu [role="menuitem"], .row-sheet-item').filter({hasText:'삭제'}).tap();
  await mobile.getByRole('alertdialog').waitFor();await mobile.getByRole('button',{name:'취소',exact:true}).tap();
  await mobile.getByRole('alertdialog').waitFor({state:'detached'});
  assert.ok((await sessionSnapshot()).panes.some(p=>p.terminal_id===mobilePane.terminal_id));
 }
 await mobile.setViewportSize({width:375,height:360});await mobile.goto(origin+'/?pane='+encodeURIComponent(mobilePane.pane_id));await openDrawer();
 await choose(mobile,mobileRow.locator('.terminal-menu-toggle'),'삭제',true);await mobile.getByRole('button',{name:'종료',exact:true}).tap();await mobileRow.locator('.terminal-menu-toggle').waitFor({state:'detached'});
 assert.ok(!(await sessionSnapshot()).panes.some(p=>p.terminal_id===mobilePane.terminal_id));await mobile.close();
 assert.deepEqual(errors,[]);console.log('PASS global numbers, sidebar and main rename/reload, lookup, collapse/reload, cancel, failed-close retention, sidebar native shell termination, main-view termination; mobile touch 320/375/430/768 widths and 375x360 keyboard-sized viewport, 44px targets, native rename/reload and termination; delayed terminal focus yields to touch menu at 375/844 widths');
}finally{
 await browser?.close();server?.stop();for(const item of owned){if((await sessionSnapshot()).workspaces.some(w=>w.workspace_id===item.workspace.workspace_id))await workspaceClose(item.workspace.workspace_id);}
 rmSync(root,{recursive:true,force:true});
}
