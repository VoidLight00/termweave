import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createServer, transformWithEsbuild } from 'vite';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser.ts';
const root=resolve(import.meta.dir,'..');
const fixture=`
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {SettingsProvider} from '/src/lib/settings.ts';
import {DockGroup} from '/src/components/DockGroup.tsx';
import {TerminalAddress} from '/src/components/TerminalAddress.tsx';
import {useShortcuts} from '/src/lib/shortcuts.ts';
import {adjacentWorkspacePane} from '/src/lib/workspaceNavigation.ts';
import '/src/styles.css'; import '/src/components/DockLayout.css';
const panes=[{pane_id:'a1',workspace_id:'a',terminal_id:'terminal-A',title:'A'},{pane_id:'b1',workspace_id:'b',terminal_id:'terminal-B'},{pane_id:'a2',workspace_id:'a',terminal_id:'terminal-C',title:'C'}];
function Fixture(){
 const [selected,setSelected]=useState('a1');
 const actions={selectAdjacentPane:(d)=>setSelected(id=>adjacentWorkspacePane(panes,id,d)??id)};
 useShortcuts(actions,true);
 const pane=panes.find(p=>p.pane_id===selected);
 return <div style={{height:600,width:'100%'}}><output data-selected>{selected}</output><input aria-label="Draft" defaultValue="keep this" />
 <DockGroup node={{kind:'group',id:'main',tabs:['a1','a2'],active:selected}} panes={panes} busy={false} zoomed={false} groupIds={['main']} activate={setSelected} drop={()=>{}} add={()=>{}} split={()=>{}} canAdd={true} hide={()=>{}} zoom={()=>{}} detach={()=>{}} preview={null} acceptsDrag={()=>false} beginDrag={()=>{}} previewDrag={()=>{}} dragDrop={()=>{}}
 address={<TerminalAddress key={pane.pane_id} pane={pane} machineId="remote-alpha" />}><div>synthetic terminal</div></DockGroup></div>;
}
createRoot(document.getElementById('root')).render(<SettingsProvider><Fixture/></SettingsProvider>);
`;
const vite=await createServer({root,server:{host:'127.0.0.1',port:0},plugins:[{
 name:'cmux-fixture', resolveId(id){if(id==='virtual:cmux-fixture')return id;},async load(id){if(id==='virtual:cmux-fixture')return(await transformWithEsbuild(fixture,'fixture.tsx',{loader:'tsx',jsx:'automatic'})).code;},
 configureServer(server){server.middlewares.use((request,response,next)=>{if(!request.url?.startsWith('/cmux-test'))return next();void server.transformIndexHtml('/cmux-test','<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@id/virtual:cmux-fixture"></script></body></html>').then(html=>{response.setHeader('Content-Type','text/html');response.end(html);});});}
}]});
let browser;
try{
 await vite.listen();const origin=`http://127.0.0.1:${(vite.httpServer!.address() as any).port}`;
 browser=await chromium.launch({executablePath:chromiumExecutable(),headless:true});
 for(const [language,heading,newTab] of [['ko','터미널 주소','새 터미널 탭'],['en','Terminal address','New terminal tab'],['ja','ターミナルのアドレス','新しいターミナルタブ'],['zh','终端地址','新建终端标签']]){
  const context=await browser.newContext({permissions:['clipboard-read','clipboard-write']});
  await context.addInitScript(language=>localStorage.setItem('herdr-web-ui:settings',JSON.stringify({language})),language);
  const page=await context.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/cmux-test?token=private#private');
  await page.locator('.dock-address summary').click();assert.equal(await page.locator('.dock-address summary').textContent(),heading);
  assert.equal(await page.locator('.dock-tab-actions button').first().getAttribute('aria-label'),newTab);
  const address=page.locator('[data-address=link]');const link=new URL(await address.inputValue());
  assert.deepEqual([...link.searchParams],[['machine','remote-alpha'],['pane','a1']]);assert.equal(link.hash,'');
  await page.locator('[data-copy=link]').click();assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),link.toString());
  await page.locator('[data-copy=pane]').click();assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'a1');
  await page.locator('[data-copy=terminal]').click();assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'terminal-A');
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{value:{writeText:()=>Promise.reject(new Error('denied'))},configurable:true}));
  await page.locator('[data-copy=link]').click();
  assert.deepEqual(await address.evaluate((input:HTMLInputElement)=>[input.selectionStart,input.selectionEnd]),[0,link.toString().length]);
  assert.equal(await page.locator('[role=status]').count(),1);
  await page.locator('.dock-tab-actions button').first().focus();
  const mod=await page.evaluate(()=>/Mac|iPhone|iPad|iPod/i.test(navigator.platform||navigator.userAgent))?'Meta':'Control';
  await page.keyboard.press(mod+'+Shift+ArrowDown');assert.equal(await page.locator('[data-selected]').textContent(),'a2');
  assert.equal(await page.locator('.dock-address [role=status]').count(),0,'copy success cannot follow another terminal');
  await page.keyboard.press(mod+'+Shift+ArrowDown');assert.equal(await page.locator('[data-selected]').textContent(),'a1');
  await page.keyboard.press(mod+'+Shift+ArrowUp');assert.equal(await page.locator('[data-selected]').textContent(),'a2');
  await page.getByRole('textbox',{name:'Draft'}).focus();await page.keyboard.press(mod+'+Shift+ArrowDown');assert.equal(await page.locator('[data-selected]').textContent(),'a2');
  assert.equal(await page.getByRole('textbox',{name:'Draft'}).inputValue(),'keep this');
  await page.locator('.dock-address summary').click();
  for(const width of [320,375,414,768]){await page.setViewportSize({width,height:850});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),language+' width '+width);}
  assert.deepEqual(errors,[]);await page.setViewportSize({width:375,height:850});await page.screenshot({path:resolve(root,'../',`cmux-${language}.png`)});await context.close();
 }
 console.log('PASS four languages, exact address copy, no auth in URL, clipboard denial fallback, workspace-only shortcut cycle, draft safety, 320/375/414/768 widths');
}finally{await browser?.close();await vite.close();}
