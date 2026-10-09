import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {createServer,transformWithEsbuild} from 'vite';
import {chromium} from 'playwright-core';
import {chromiumExecutable} from './browser.ts';
const root=resolve(import.meta.dir,'..');
const fixture=`import React,{useState}from'react';import{createRoot}from'react-dom/client';import{SettingsProvider}from'/src/lib/settings.ts';import{ChatView}from'/src/components/ChatView.tsx';import'/src/styles.css';function App(){const[id,setId]=useState('a');return <><button id="switch" onClick={()=>setId('b')}>Switch</button><div style={{height:600,position:"relative"}}><ChatView paneId={id} refreshKey={0} connected={true} ended={false} agent="claude"/></div></>};createRoot(document.getElementById('root')).render(<SettingsProvider><App/></SettingsProvider>);`;
const vite=await createServer({root,server:{host:'127.0.0.1',port:0},plugins:[{name:'transcript-fixture',resolveId(id){if(id==='virtual:chat')return id},async load(id){if(id==='virtual:chat')return(await transformWithEsbuild(fixture,'fixture.tsx',{loader:'tsx',jsx:'automatic'})).code},configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/chat-test')return next();void server.transformIndexHtml('/chat-test','<!doctype html><html><body><div id="root"></div><script type="module" src="/@id/virtual:chat"></script></body></html>').then(html=>{res.setHeader('Content-Type','text/html');res.end(html)})})}}]});
let browser;
try{
 await vite.listen();browser=await chromium.launch({executablePath:chromiumExecutable(),headless:true});const page=await browser.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{Object.defineProperty(navigator,'clipboard',{value:{writeText:async()=>{throw Error('denied')}}});});
 let failed=false,failReads=0;
 await page.route('**/api/**',async route=>{const url=new URL(route.request().url());if(url.pathname.endsWith('/pane/conversation')){if(failed){failReads++;return route.fulfill({status:503,contentType:'application/json',body:'{"error":"temporarily offline"}'})}const id=url.searchParams.get('pane_id');return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({source:'claude-transcript',history_id:id,cursor:null,turns:[{role:'assistant',ts:null,parts:[{kind:'text',text:'Verified transcript '+id}]}]})})}return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({prompt:null})})});
 await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}/chat-test`);
 await page.getByText('Verified transcript a',{exact:true}).waitFor();
 await page.locator('.chat-meta-btn').filter({hasText:'MD'}).first().click();await page.locator('.chat-copy-fallback').waitFor();assert.match(await page.locator('.chat-copy-fallback').inputValue(),/Verified transcript a/);
 failed=true;await new Promise<void>((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{if(failReads){clearInterval(timer);resolve()}else if(Date.now()-start>6000){clearInterval(timer);reject(Error('poll did not run'))}},100)});
 assert.equal(await page.locator('.chat-turn-agent').count(),1);assert.match(await page.locator('.chat-turn-agent').innerText(),/Verified transcript a/);
 failed=false;await page.locator('#switch').click();await page.getByText('Verified transcript b',{exact:true}).waitFor();assert.equal(await page.getByText('Verified transcript a',{exact:true}).count(),0);
 assert.deepEqual(errors,[]);await page.screenshot({path:resolve(root,'../chat-transcript.png')});console.log('PASS real ChatView retains transcript after 503, replaces pane history, provides copy fallback without unhandled rejection');
}finally{await browser?.close();await vite.close()}
