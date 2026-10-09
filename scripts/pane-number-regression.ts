import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {createServer,transformWithEsbuild} from 'vite';
import {chromium} from 'playwright-core';
import {chromiumExecutable} from './browser.ts';
const root=resolve(import.meta.dir,'..');
const fixture=`import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{SettingsProvider}from'/src/lib/settings.ts';import{SplitTerminals}from'/src/components/SplitTerminals.tsx';import{useShortcuts}from'/src/lib/shortcuts.ts';import{adjacentWorkspacePane}from'/src/lib/workspaceNavigation.ts';import'/src/styles.css';
const panes=[{pane_id:'w1:p1',workspace_id:'a',terminal_id:'A',global_pane_number:1,tab_id:'t1'},{pane_id:'w2:p1',workspace_id:'b',terminal_id:'B',global_pane_number:2,tab_id:'t2'},{pane_id:'w1:p2',workspace_id:'a',terminal_id:'C',global_pane_number:3,tab_id:'t3'}];
function App(){const[selected,setSelected]=useState('w1:p1');useShortcuts({selectAdjacentPane:d=>setSelected(id=>adjacentWorkspacePane(panes,id,d)??id)},true);return <div style={{height:800,width:'100%'}}><button className="workspace-terminal" id="choose-two" onClick={()=>setSelected("w1:p2")}>Choose terminal 2</button><output data-selected>{selected}</output><SplitTerminals machineId="local" panes={panes} primaryId={selected} terminal={{view:'terminal',role:'operate'}} onSelectPrimary={setSelected} onRefresh={async()=>{}} onOpenFile={()=>{}} onMoved={async()=>{}} onMovePending={()=>true} mutationBusy={false}/></div>};createRoot(document.getElementById('root')).render(<SettingsProvider><App/></SettingsProvider>);`;
const vite=await createServer({root,server:{host:'127.0.0.1',port:0},plugins:[{name:'focus-fixture',enforce:'pre',resolveId(id){if(id==='virtual:focus'||id.endsWith('/PaneTerminal.tsx')||id==='./PaneTerminal.tsx')return id==='virtual:focus'?id:'virtual:stub-terminal';},async load(id){if(id==='virtual:focus'||id==='virtual:stub-terminal')return(await transformWithEsbuild(id==='virtual:focus'?fixture:`import React from 'react';export function PaneTerminal(){return <textarea className="xterm-helper-textarea" style={{width:0,height:0,padding:0,border:0}}/>}`,'fixture.tsx',{loader:'tsx',jsx:'automatic'})).code;},configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/focus-test')return next();void server.transformIndexHtml('/focus-test','<!doctype html><html><body><div id="root"></div><script type="module" src="/@id/virtual:focus"></script></body></html>').then(html=>{res.setHeader('Content-Type','text/html');res.end(html);});});}}]});
let browser;
try{
 await vite.listen();browser=await chromium.launch({executablePath:chromiumExecutable(),headless:true});const page=await browser.newPage({viewport:{width:1400,height:900}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{localStorage.setItem('termweave:settings',JSON.stringify({language:'ko'}));localStorage.setItem('termweave:dock:workspace:v3:local:a',JSON.stringify({workspace:'a',primary:'w1:p1',tree:{kind:'split',id:'s',axis:'columns',ratio:.5,first:{kind:'group',id:'left',tabs:['w1:p1'],active:'w1:p1'},second:{kind:'group',id:'right',tabs:['w1:p2'],active:'w1:p2'}}}));});
 await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}/focus-test`);
 await page.locator('#choose-two').click();await page.waitForFunction(()=>document.activeElement?.closest('.dock-group')?.getAttribute('data-pane-id')==='w1:p2');
 await page.locator('.dock-group[data-pane-id="w1:p1"] textarea').focus();
 const mod=await page.evaluate(()=>/Mac|iPhone|iPad|iPod/i.test(navigator.platform||navigator.userAgent))?'Meta':'Control';
 for(const expected of ['w1:p2','w1:p1','w1:p2']){await page.keyboard.press(mod+'+Shift+ArrowDown');await page.waitForFunction(id=>document.activeElement?.closest('.dock-group')?.getAttribute('data-pane-id')===id,expected,{timeout:3000});assert.equal(await page.locator('[data-selected]').textContent(),expected);}
 assert.deepEqual(await page.locator('.dock-tab-strip .pane-number').allTextContents(),['P1','P3']);
 await page.reload();await page.locator('.dock-tab-strip .pane-number').first().waitFor();
 assert.deepEqual(await page.locator('.dock-tab-strip .pane-number').allTextContents(),['P1','P3']);
 assert.deepEqual(errors,[]);console.log('PASS global pane 1 and 3 label separate terminals; keyboard input follows each pane; reload retains native numbers');
}finally{await browser?.close();await vite.close();}
