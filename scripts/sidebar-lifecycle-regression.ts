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
 const choose=async(p,button,label,touch=false)=>{if(touch)await button.tap();else await button.click();const item=p.locator('.row-menu [role="menuitem"], .row-sheet-item').filter({hasText:label});if(touch)await item.tap();else await item.click();};
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
 await page.reload();await row.waitFor();assert.equal((await snapshot()).panes.find(p=>p.terminal_id===a.terminal_id).global_pane_number,a.global_pane_number);
 await row.locator(`[data-terminal-pane="${a.pane_id}"]`).click();
 const screenClose=page.locator(`.dock-group[data-pane-id="${a.pane_id}"] .dock-delete`);await screenClose.click();await page.getByRole('button',{name:'종료',exact:true}).click();await screenClose.waitFor({state:'detached',timeout:15000});assert.ok(!(await sessionSnapshot()).panes.some(p=>p.terminal_id===a.terminal_id));
 // Touch controls must remain usable in a real app, not only a modal fixture.
 const mobileOwned=await workspaceCreate({cwd:root,label:'모바일 터미널 사용성 검사'});owned.push(mobileOwned);
 const mobilePane=(await snapshot()).panes.find(p=>p.terminal_id===mobileOwned.root_pane.terminal_id);
 const mobile=await browser.newPage({viewport:{width:375,height:812},isMobile:true,hasTouch:true});mobile.on('pageerror',e=>errors.push(e.message));
 await mobile.addInitScript(()=>localStorage.setItem('termweave:settings',JSON.stringify({language:'ko'})));
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
 await choose(mobile,mobileRow.locator('.terminal-menu-toggle'),'삭제',true);await mobile.getByRole('button',{name:'종료',exact:true}).tap();await mobileRow.locator('.terminal-menu-toggle').waitFor({state:'detached'});
 assert.ok(!(await sessionSnapshot()).panes.some(p=>p.terminal_id===mobilePane.terminal_id));await mobile.close();
 assert.deepEqual(errors,[]);console.log('PASS global numbers, sidebar and main rename/reload, lookup, collapse/reload, cancel, failed-close retention, sidebar native shell termination, main-view termination; mobile touch 320/375/430/768 widths and 375x360 keyboard-sized viewport, 44px targets, native rename/reload and termination');
}finally{
 await browser?.close();server?.stop();for(const item of owned){if((await sessionSnapshot()).workspaces.some(w=>w.workspace_id===item.workspace.workspace_id))await workspaceClose(item.workspace.workspace_id);}
 rmSync(root,{recursive:true,force:true});
}
