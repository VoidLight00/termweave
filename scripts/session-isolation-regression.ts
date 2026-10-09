import { chromiumExecutable } from './browser.ts';
import './test-herdr.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from '../server/index.ts';
import { herdrRpc, paneSendText, sessionSnapshot, workspaceCreate, workspaceClose } from '../server/herdr/client.ts';

if (!process.env.HERDR_TEST_SESSION || process.env.HERDR_TEST_LIVE === '1' || !process.env.HERDR_STAGING_DIST) throw new Error('isolated staging required');
const root = mkdtempSync(join(tmpdir(), 'session-isolation-owned-'));
const own = await workspaceCreate({ cwd: root, label: 'isolation-owned' });
const a = own.root_pane.pane_id;
const other = await workspaceCreate({ cwd: root, label: 'workspace-B-owned' });
const b = other.root_pane.pane_id;
const existing = (await herdrRpc<{pane:{pane_id:string}}>('pane.split', { target_pane_id:a, workspace_id:own.workspace.workspace_id, direction:'right', cwd:root, focus:false })).pane.pane_id;
const nativeTab = (await herdrRpc<{root_pane:{pane_id:string}}>('tab.create',{workspace_id:own.workspace.workspace_id,cwd:root,focus:false})).root_pane.pane_id;
const server = createServer({ port:0, hostname:'127.0.0.1', stateDir:root, token:'' });
const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless:true });
const evidence = process.env.DOCK_EVIDENCE ?? join(import.meta.dir, '../evidence/session-isolation');
mkdirSync(evidence, {recursive:true});
try {
  const context = await browser.newContext({viewport:{width:1600,height:1050}});
  const page = await context.newPage();
  const errors:string[] = [], inputs:unknown[] = [];
  page.on('pageerror', e=>errors.push(e.message));
  page.on('websocket', s=>s.on('framesent', f=>{try { const m=JSON.parse(String(f.payload)); if(['input','keys'].includes(m.type)) inputs.push(m); } catch {}}));
  const origin = `http://127.0.0.1:${server.port}`;
  // Upgrade the deployed v2 format, with stale v1 and a second owner's layout.
  await context.addInitScript(({a,existing,workspace}) => {
    localStorage.setItem('termweave:settings', JSON.stringify({ language: 'en', alertsOn: false }));
    if (localStorage.getItem('workspace-upgrade-seeded')) return;
    localStorage.setItem('workspace-upgrade-seeded','1');
    const g=(id:string)=>({kind:'group',id:'main',tabs:[id],active:id});
    localStorage.setItem(`termweave:dock:session:v2:local:${encodeURIComponent(a)}`,JSON.stringify({workspace,primary:a,tree:g(a)}));
    localStorage.setItem(`termweave:dock:session:v2:local:${encodeURIComponent(existing)}`,JSON.stringify({workspace,primary:existing,tree:g(existing)}));
    localStorage.setItem(`termweave:dock:v1:local:${workspace}`,JSON.stringify(g('stale-v1')));
  },{a,existing,workspace:own.workspace.workspace_id});
  await page.goto(`${origin}/?pane=${a}`);
  await page.locator('.conn-live').waitFor();
  const rows = async() => { const snapshot=await sessionSnapshot(); assert.equal(await page.locator('.pane-select[data-workspace-id]').count(),snapshot.workspaces.length); };
  await rows();
  const originalRoster=(await sessionSnapshot()).panes.filter(p=>p.workspace_id===own.workspace.workspace_id);
  assert.ok(originalRoster.some(p=>p.pane_id===nativeTab && p.tab_id!==originalRoster.find(p=>p.pane_id===a)?.tab_id));
  assert.deepEqual(await page.getByLabel('Existing terminals',{exact:true}).locator('option').evaluateAll(options=>options.map(o=>(o as HTMLOptionElement).value).filter(Boolean)),originalRoster.map(p=>p.pane_id));
  const paneCountBeforeChooser=(await sessionSnapshot()).panes.length;
  for (const p of originalRoster) {
    await page.getByLabel('Existing terminals',{exact:true}).selectOption(p.pane_id);
    await page.waitForFunction(id=>Array.from(document.querySelectorAll('.dock-group')).some(g=>g.getAttribute('data-pane-id')===id),p.pane_id);
    await rows();
  }
  assert.equal((await sessionSnapshot()).panes.length,paneCountBeforeChooser);
  const legacy = await page.evaluate(()=>Object.fromEntries(Object.keys(localStorage).filter(k=>k.includes('dock:session:v2:')||k.includes('dock:v1:')).map(k=>[k,localStorage.getItem(k)])));
  await page.getByLabel('Existing terminals',{exact:true}).selectOption(existing);
  await page.waitForFunction(id=>document.querySelector('.dock-group')?.getAttribute('data-pane-id')===id,existing);
  await rows();
  await page.getByLabel('Existing terminals',{exact:true}).selectOption(a);
  await page.getByRole('button',{name:'New terminal tab',exact:true}).first().click();
  await page.waitForFunction(()=>document.querySelectorAll('[role=tab]').length===4);
  await rows();
  const click = async(id:string) => { await page.locator(`.pane-select[data-workspace-id="${id===a?own.workspace.workspace_id:other.workspace.workspace_id}"]`).click(); };
  const count = async(n:number) => { await page.waitForFunction(n=>document.querySelectorAll('.dock-group').length===n,n); };
  const saved = async(id:string) => page.evaluate(id=>JSON.parse(localStorage.getItem(`termweave:dock:workspace:v3:local:${encodeURIComponent(id)}`)!),id===a?own.workspace.workspace_id:other.workspace.workspace_id);
  await page.getByRole('button',{name:'Split terminal right',exact:true}).first().click(); await count(2);
  await page.getByRole('button',{name:'Split terminal below',exact:true}).first().click(); await count(3);
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('.dock-group')).every(g=>!!g.querySelector('.xterm-helper-textarea')));
  await page.getByRole('button',{name:'New terminal tab',exact:true}).first().waitFor();
  await page.waitForFunction(()=>Array.from(document.querySelectorAll<HTMLButtonElement>('.dock-tab-actions button')).filter(b=>b.textContent==='+').every(b=>!b.disabled));
  await page.waitForTimeout(300);
  const ids = await page.locator('.dock-group').evaluateAll(gs=>gs.map(g=>(g as HTMLElement).dataset.paneId!));
  const before = (await sessionSnapshot()).panes.filter(p=>p.workspace_id===own.workspace.workspace_id);
  // Only this test's fresh shells receive PID probes; never type into user terminals.
  for (const [i,p] of before.entries()) {
    await paneSendText(p.pane_id, `printf '%s' $$ > '${root}/pid-${i}'\n`);
    const deadline=Date.now()+10000;
    while(!existsSync(join(root,`pid-${i}`))) { assert.ok(Date.now()<deadline); await Bun.sleep(50); }
  }
  const pids=before.map((_,i)=>Number(readFileSync(join(root,`pid-${i}`),'utf8')));
  const processes=async()=>{const result=await Bun.$`ps -o pid=,ppid=,lstart= -p ${pids.join(',')}`.quiet(); assert.equal(result.exitCode,0);return result.text();};
  const identity=await processes();
  const divider = page.locator('.dock-divider').first();
  const box = await divider.boundingBox(); assert.ok(box);
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2); await page.mouse.down(); await page.mouse.move(box.x+box.width/2+130,box.y+box.height/2); await page.mouse.up();
  const focused=ids[2]!;
  await page.locator(`.dock-group[data-pane-id="${focused}"] .xterm-helper-textarea`).focus();
  await page.waitForTimeout(200);
  await rows();
  const a3=await saved(a);
  await page.screenshot({path:join(evidence,'A-three.png')});
  await click(b); await count(1); assert.equal(await page.locator('.dock-group').getAttribute('data-pane-id'),b);
  await page.screenshot({path:join(evidence,'B-single.png')});
  await click(a); await count(3); assert.deepEqual((await saved(a)).tree,a3.tree);
  await page.waitForFunction(id=>(document.activeElement as HTMLElement)?.closest<HTMLElement>('.dock-group')?.dataset.paneId===id,focused);
  await click(b); await count(1);
  await page.getByRole('button',{name:'Split terminal right',exact:true}).first().click(); await count(2);
  await page.waitForFunction(()=>Array.from(document.querySelectorAll<HTMLButtonElement>('.dock-tab-actions button')).filter(b=>b.textContent==='+').every(b=>!b.disabled));
  const bDivider=page.locator('.dock-divider').first(); await bDivider.focus(); await bDivider.press('ArrowLeft');
  await page.waitForTimeout(100);
  const b2=await saved(b);
  await click(a); await count(3); assert.deepEqual((await saved(a)).tree,a3.tree);
  await page.reload(); await count(3); assert.deepEqual((await saved(a)).tree,a3.tree);
  await page.waitForFunction(id=>(document.activeElement as HTMLElement)?.closest<HTMLElement>('.dock-group')?.dataset.paneId===id,focused);
  // Spatial focus changes active terminal, not the sidebar owner, and sends no PTY input.
  await page.locator(`.dock-group[data-pane-id="${focused}"] .xterm-helper-textarea`).press('Meta+Shift+ArrowLeft');
  assert.equal(await page.locator(`.pane-select[data-workspace-id="${own.workspace.workspace_id}"]`).getAttribute('aria-current'),'true'); await count(3);
  await click(b); await count(2); assert.deepEqual((await saved(b)).tree,b2.tree);
  await click(a); await count(3);
  // Drag within A and verify B's layout remains independent.
  const source=page.locator('[role=tab]').last(); const target=page.locator('.dock-tab-strip').first();
  const data=await page.evaluateHandle(()=>new DataTransfer());
  await source.dispatchEvent('dragstart',{dataTransfer:data}); await target.dispatchEvent('dragover',{dataTransfer:data}); await target.dispatchEvent('drop',{dataTransfer:data}); await count(2);
  await page.locator('[role=tab]').last().click(); await count(2);
  assert.equal(await page.locator(`.pane-select[data-workspace-id="${own.workspace.workspace_id}"]`).getAttribute('aria-current'),'true');
  const dragged=await saved(a); await click(b); await count(2); assert.deepEqual((await saved(b)).tree,b2.tree);
  await click(a); await count(2); assert.deepEqual((await saved(a)).tree,dragged.tree);
  await page.screenshot({path:join(evidence,'A-restored-drag.png')});
  // Delay the split response, navigate away while the native shell already exists.
  let release!:()=>void;
  const blocked=new Promise<void>(resolve=>{release=resolve;});
  let observed!:()=>void;
  const received=new Promise<void>(resolve=>{observed=resolve;});
  await page.route('**/api/pane/split',async route=>{ const response=await route.fetch(); observed(); await blocked; await route.fulfill({response}); });
  await page.getByRole('button',{name:'Split terminal right',exact:true}).first().click();
  await received; await click(b); await count(2);
  assert.deepEqual((await saved(b)).tree,b2.tree);
  // Return before the pending response too; its completion must update the current A.
  await click(a); await count(2); release();
  await count(3);
  await click(b); await count(2); assert.deepEqual((await saved(b)).tree,b2.tree);
  await click(a); await count(3);
  await page.unroute('**/api/pane/split');
  // Also complete while B stays mounted: completion must update only A's key.
  let releaseAway!:()=>void, observedAway!:()=>void;
  const blockedAway=new Promise<void>(resolve=>{releaseAway=resolve;});
  const receivedAway=new Promise<void>(resolve=>{observedAway=resolve;});
  await page.route('**/api/pane/split',async route=>{const response=await route.fetch();observedAway();await blockedAway;await route.fulfill({response});});
  await page.getByRole('button',{name:'Split terminal right',exact:true}).first().click();
  await receivedAway; await click(b); await count(2); releaseAway();
  await page.waitForFunction(workspace=>{
    const value=JSON.parse(localStorage.getItem(`termweave:dock:workspace:v3:local:${encodeURIComponent(workspace)}`)!);
    const groups=(node:any):number=>node.kind==='group'?1:groups(node.first)+groups(node.second);
    return groups(value.tree)===4;
  },own.workspace.workspace_id);
  assert.deepEqual((await saved(b)).tree,b2.tree);
  assert.equal(await page.locator(`.pane-select[data-workspace-id="${other.workspace.workspace_id}"]`).getAttribute('aria-current'),'true');
  await click(a); await count(4); await page.unroute('**/api/pane/split');
  const after=await sessionSnapshot();
  for(const p of before) {const current=after.panes.find(x=>x.pane_id===p.pane_id)!; for(const k of ['terminal_id','cwd','workspace_id','tab_id'] as const) assert.equal(current[k],p[k]);}
  assert.equal(await processes(),identity);
  await rows();
  assert.deepEqual(await page.evaluate(()=>Object.fromEntries(Object.keys(localStorage).filter(k=>k.includes('dock:session:v2:')||k.includes('dock:v1:')).map(k=>[k,localStorage.getItem(k)]))),legacy);
  const countBefore=(await sessionSnapshot()).panes.length;
  const deep = await context.newPage(); await deep.goto(`${origin}/?pane=${existing}`); await deep.locator('.conn-live').waitFor();
  await deep.waitForFunction(id=>Array.from(document.querySelectorAll('.dock-group')).some(g=>g.getAttribute('data-pane-id')===id),existing);
  assert.equal(await deep.locator(`.pane-select[data-workspace-id="${own.workspace.workspace_id}"]`).getAttribute('aria-current'),'true');
  assert.equal((await sessionSnapshot()).panes.length,countBefore); await deep.screenshot({path:join(evidence,'deep-link.png')}); await deep.close();
  // Notifications target a pane (not the workspace's previously remembered primary).
  await page.evaluate(id=>navigator.serviceWorker.dispatchEvent(new MessageEvent('message',{data:{type:'select-pane',machine_id:'local',pane_id:id}})),b);
  await count(2); assert.equal(await page.locator(`.pane-select[data-workspace-id="${other.workspace.workspace_id}"]`).getAttribute('aria-current'),'true');
  await page.evaluate(id=>navigator.serviceWorker.dispatchEvent(new MessageEvent('message',{data:{type:'select-pane',machine_id:'local',pane_id:id}})),nativeTab);
  await count(4); await page.waitForFunction(id=>Array.from(document.querySelectorAll('.dock-group')).some(g=>g.getAttribute('data-pane-id')===id),nativeTab);
  assert.equal(await page.locator(`.pane-select[data-workspace-id="${own.workspace.workspace_id}"]`).getAttribute('aria-current'),'true');
  assert.deepEqual(errors,[]); assert.deepEqual(inputs,[]);
  console.log('PASS native tabs + all existing panes reachable without new shells; sidebar row count == native workspace count; plus/split row stability; v2 upgrade preserves legacy keys; deep link exact pane; actual App sidebar A3 → B1 → A3; B2 independent; ratios/focus/reload; internal tab/drag/Command arrows preserve owner; native identities unchanged; zero PTY input');
} finally { await browser.close(); server.stop(); await workspaceClose(own.workspace.workspace_id); await workspaceClose(other.workspace.workspace_id); rmSync(root,{recursive:true,force:true}); }
