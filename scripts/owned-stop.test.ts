import {describe,expect,it} from 'bun:test';
import {copyFileSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {dirname,join,relative,resolve} from 'node:path';
import {acquireLock,lockPaths} from './lifecycle-lock.ts';
import {stateFile} from './lifecycle-state.ts';
import {processIdentity,windowsPowerShell,type ProcessIdentity} from './process-identity.ts';
import {bridgeProbe,launchOwned} from './lifecycle-launch.ts';
import {check,fullHealthOk,type Context,type Options} from './install-lifecycle.ts';
import {OWNED_STOP_HEADER,OWNED_STOP_PATH} from '../shared/machines.ts';
import {windowsProcessTable} from '../server/windows-processes.ts';
const repo=resolve(import.meta.dir,'..'),T=150_000,CLI=join(repo,'scripts','install-lifecycle.ts');
/** Bun's resolution of a relative specifier: the file itself, then `.ts`/`.tsx`, then a directory's `index.ts`. */
const resolveSpecifier=(path:string)=>[path,`${path}.ts`,`${path}.tsx`,join(path,'index.ts')].find(candidate=>lstatSync(candidate,{throwIfNoEntry:false})?.isFile());
/** A file and its whole relative import closure, copied so the fixture root runs the code under test. */
function copyClosure(root:string,entry:string){
 const pending=[resolve(repo,entry)],seen=new Set<string>();
 while(pending.length){
  const wanted=pending.pop()!,file=resolveSpecifier(wanted);if(!file)throw new Error(`unresolved relative import ${wanted}`);if(seen.has(file))continue;seen.add(file);
  const target=join(root,relative(repo,file));mkdirSync(dirname(target),{recursive:true});copyFileSync(file,target);
  for(const match of readFileSync(file,'utf8').matchAll(/(?:from|import)\s*['"](\.{1,2}\/[^'"]+)['"]/g))pending.push(resolve(dirname(file),match[1]!));
 }
}
const marker=(root:string)=>writeFileSync(join(root,'.termweave-owned.json'),JSON.stringify({product:'termweave',root,inventory:{}}));
/** Owned root running the real server/index.ts closure; its one package import (web-push) resolves through a node_modules junction. */
function realRoot(base:string){
 const root=resolve(base,'real');mkdirSync(root,{recursive:true});
 for(const entry of ['scripts/owned-server.ts','scripts/lifecycle-launch.ts','server/index.ts'])copyClosure(root,entry);
 symlinkSync(join(repo,'node_modules'),join(root,'node_modules'),'junction');marker(root);return root;
}
/**
 * Stands in for server/index.ts where the real one cannot be driven: full health ok (herdr up), and marker files that make it
 * herdr-down (`fixture-herdr-off`), silent on the bridge probe (`fixture-silent`), accept a stop without exiting (`fixture-hang`)
 * or bind its port only 7 s after it starts (`fixture-slow-bind`).
 * It takes the stop token the way the real server does: from its env, deleted at once.
 */
const FIXTURE_SERVER=`import {existsSync} from 'node:fs';import {join} from 'node:path';
if(process.env.TERMWEAVE_OWNED_LAUNCH!=='1')throw new Error('fixture requires the owned launcher');
const token=process.env.TERMWEAVE_STOP_TOKEN??'';delete process.env.TERMWEAVE_STOP_TOKEN;
const boot=process.env.HERDR_WEB_BOOT_ID??null,flag=name=>existsSync(join(import.meta.dir,'..','fixture-'+name));
if(flag('slow-bind'))await Bun.sleep(7_000);
const server=Bun.serve({port:Number(process.env.PORT),hostname:process.env.HOST,fetch(request){const url=new URL(request.url);
 if(url.pathname==='/api/health'&&url.searchParams.get('scope')==='bridge')return flag('silent')?new Promise(()=>{}):Response.json({ok:true,boot_id:boot});
 if(url.pathname==='/api/health')return flag('herdr-off')?Response.json({error:{code:'herdr_unavailable'}},{status:503}):Response.json({ok:true,web_ui:{boot_id:boot}});
 if(url.pathname===${JSON.stringify(OWNED_STOP_PATH)}&&request.method==='POST'&&token.length>=32&&request.headers.get(${JSON.stringify(OWNED_STOP_HEADER)})===token){
  if(!flag('hang'))setTimeout(()=>process.exit(0),100);return Response.json({ok:true,stopping:true},{status:202});}
 return new Response('fixture',{status:404});}});
console.log('fixture listening on '+server.hostname+':'+server.port+' boot '+boot);
`;
function fixtureRoot(base:string){
 const root=resolve(base,'fixture');mkdirSync(join(root,'server'),{recursive:true});
 for(const entry of ['scripts/owned-server.ts','scripts/lifecycle-launch.ts'])copyClosure(root,entry);
 writeFileSync(join(root,'server','index.ts'),FIXTURE_SERVER);marker(root);return root;
}
const flag=(root:string,name:string,on:boolean)=>on?writeFileSync(join(root,`fixture-${name}`),''):rmSync(join(root,`fixture-${name}`),{force:true});
const freePort=()=>{const probe=Bun.serve({port:0,hostname:'127.0.0.1',fetch:()=>new Response('')});const port=probe.port!;probe.stop(true);return port;};
/** Process rows whose command line names this test's temp base, from the CIM process table. */
async function cimRows(base:string){const rows=await windowsProcessTable();expect(rows.length).toBeGreaterThan(0);return {all:rows,ours:rows.filter(row=>(row.commandLine??'').toLowerCase().includes(base.toLowerCase()))};}
const cimCount=async(base:string)=>(await cimRows(base)).ours.length;
async function until(what:string,check:()=>boolean|Promise<boolean>,ms=20_000){const deadline=Date.now()+ms;while(!(await check())){if(Date.now()>deadline)throw new Error(`timed out waiting for ${what}`);await Bun.sleep(100);}}
/** Lifecycle CLI env: herdr is off (no socket there), and the server's state, home and bridge registry stay inside the temp base. */
const cliEnv=(base:string)=>({...process.env,HERDR_WEB_STATE_DIR:join(base,'state'),USERPROFILE:join(base,'home'),XDG_CONFIG_HOME:join(base,'home','.config'),HERDR_SOCKET:join(base,'no-herdr.sock')}) as Record<string,string>;
async function cli(base:string,args:string[]){
 const child=Bun.spawn([process.execPath,CLI,...args],{cwd:base,env:cliEnv(base),stdin:'ignore',stdout:'pipe',stderr:'pipe',windowsHide:true});
 const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 return {code,out,err,pid:child.pid};
}
type State={status:string;pid:number;port:number;boot_id:string;startedAt:string;exe:string;launcher:number;stop_token:string;launcher_identity:{pid:number;startedAt:string}};
const readState=(root:string)=>JSON.parse(readFileSync(stateFile(root),'utf8')) as State;
const stopRequest=(port:number,init:RequestInit={})=>fetch(`http://127.0.0.1:${port}${OWNED_STOP_PATH}`,{method:'POST',...init,signal:AbortSignal.timeout(3_000)});
/** Owned processes this file started; cleanup only ends a PID whose identity (start time) still matches what was recorded. */
const owned=new Map<number,ProcessIdentity>();
const track=(pid:number)=>{const identity=processIdentity(pid);if(identity.state==='alive')owned.set(pid,identity);return identity;};
function endOwned(pid:number){const recorded=owned.get(pid),now=processIdentity(pid);if(recorded&&now.state==='alive'&&now.startedAt===recorded.startedAt)try{process.kill(pid);}catch{}}
const gone=(pid:number)=>processIdentity(pid).state==='gone';
/** The token is in lifecycle.json (inside the owned root) only: never in the server log, any process command line, or a CLI's output. */
async function expectTokenHidden(base:string,log:string|null,token:string,...outputs:string[]){
 expect(token.length).toBeGreaterThanOrEqual(32);
 if(log!==null)expect(readFileSync(log,'utf8')).not.toContain(token);
 const {all}=await cimRows(base);expect(all.filter(row=>(row.commandLine??'').includes(token))).toEqual([]);
 for(const output of outputs)expect(output).not.toContain(token);
}
async function withBase(name:string,fn:(base:string)=>Promise<void>){
 const base=realpathSync(mkdtempSync(join(tmpdir(),name)));
 try{await fn(base);}
 finally{
  for(const pid of owned.keys())endOwned(pid);owned.clear();
  await until('fixture processes to exit (CIM count 0)',async()=>await cimCount(base)===0);
  // The node_modules junction goes first and alone, so removing the base can never reach the repository's node_modules.
  const junction=join(base,'real','node_modules');
  if(lstatSync(junction,{throwIfNoEntry:false})?.isSymbolicLink())unlinkSync(junction);
  if(existsSync(junction))throw new Error(`junction ${junction} still present; base ${base} left in place`);
  rmSync(base,{recursive:true,force:true});
 }
}
describe.if(process.platform==='win32')('owned stop (real server, herdr off)',()=>{
 it('bridge probe answers with herdr off, browser/foreign/unauthenticated stops are refused, stop and a repeated stop succeed, N→0',()=>withBase('tw-stop-real-',async base=>{
  const root=realRoot(base),port=freePort();
  const started=await cli(base,['start','--dir',root,'--port',String(port)]);
  // herdr off: the bridge is up and reported as started; the start reports the missing herdr and exits 1 without making it stale.
  expect(started.out).toContain(`ok    started on http://127.0.0.1:${port}`);expect(started.err).toContain('MISS  herdr is not ready');expect(started.code).toBe(1);
  const state=readState(root);track(state.pid);track(state.launcher);
  expect(state).toMatchObject({status:'running',port});
  expect(await bridgeProbe(port)).toEqual({kind:'boot',boot_id:state.boot_id});
  expect(await fullHealthOk(port)).toBe(false);
  expect(await cimCount(base)).toBe(2);
  const children=(await cimRows(base)).all.filter(row=>row.parent===state.pid).map(row=>row.pid);
  const token=state.stop_token;await expectTokenHidden(base,join(root,'server.log'),token,started.out,started.err);
  // Refused: GET, no token, a wrong token, the token in the URL, same-origin browser headers, another Host. The server stays up.
  const wrong=token.replace(/^./,c=>c==='A'?'B':'A');
  const refusals:[string,Promise<Response>,number][]=[
   ['GET',fetch(`http://127.0.0.1:${port}${OWNED_STOP_PATH}`,{headers:{[OWNED_STOP_HEADER]:token},signal:AbortSignal.timeout(3_000)}),405],
   ['no token',stopRequest(port),403],
   ['wrong token',stopRequest(port,{headers:{[OWNED_STOP_HEADER]:wrong}}),403],
   ['token in URL',fetch(`http://127.0.0.1:${port}${OWNED_STOP_PATH}?token=${token}&${OWNED_STOP_HEADER}=${token}`,{method:'POST',signal:AbortSignal.timeout(3_000)}),403],
   ['same-origin Origin',stopRequest(port,{headers:{[OWNED_STOP_HEADER]:token,origin:`http://127.0.0.1:${port}`}}),403],
   ['Sec-Fetch-Site',stopRequest(port,{headers:{[OWNED_STOP_HEADER]:token,'sec-fetch-site':'same-origin'}}),403],
   ['other Host',stopRequest(port,{headers:{[OWNED_STOP_HEADER]:token,host:`example.com:${port}`}}),403],
  ];
  for(const [name,response,status] of refusals)expect([name,(await response).status]).toEqual([name,status]);
  await Bun.sleep(500);expect(await bridgeProbe(port)).toEqual({kind:'boot',boot_id:state.boot_id});expect(gone(state.pid)).toBe(false);
  // Another boot answering on the recorded port: no stop request is sent, the server stays up, lifecycle.json is kept as it was.
  const recorded=readFileSync(stateFile(root),'utf8');
  writeFileSync(stateFile(root),JSON.stringify({...state,boot_id:'another-boot'}));
  const foreign=await cli(base,['stop','--dir',root]);
  expect(foreign.code).toBe(1);expect(foreign.err).toContain('answers with another boot id; no stop request was sent');
  expect(foreign.err).toContain(`bridge probe  boot ${state.boot_id} (record has another-boot)`);
  await Bun.sleep(500);expect(await bridgeProbe(port)).toEqual({kind:'boot',boot_id:state.boot_id});
  expect(readState(root)).toMatchObject({status:'running',boot_id:'another-boot'});
  writeFileSync(stateFile(root),recorded);
  // An explicit --port other than the recorded one fails before any request.
  const otherPort=await cli(base,['stop','--dir',root,'--port',String(port===65535?port-1:port+1)]);
  expect(otherPort.code).toBe(1);expect(otherPort.err).toContain(`does not match the recorded port ${port}; no request was sent`);
  expect(await bridgeProbe(port)).toEqual({kind:'boot',boot_id:state.boot_id});
  // Two stops at once: one sends the request and waits for the exit; the other waits for the lock and finds nothing to stop.
  const [first,second]=await Promise.all([cli(base,['stop','--dir',root]),cli(base,['stop','--dir',root])]);
  expect([first.code,second.code]).toEqual([0,0]);
  expect([first.out,second.out].sort()).toEqual(['ok    not running (nothing to stop)\n',`ok    stopped (server pid ${state.pid} on port ${port})\n`].sort());
  expect(gone(state.pid)).toBe(true);expect(gone(state.launcher)).toBe(true);for(const pid of children)expect(gone(pid)).toBe(true);
  expect(existsSync(stateFile(root))).toBe(false);expect(existsSync(lockPaths(root).lock)).toBe(false);expect(existsSync(lockPaths(root).guard)).toBe(false);
  const log=readFileSync(join(root,'server.log'),'utf8');expect(log).toContain(`server pid ${state.pid} exited with 0`);
  await expectTokenHidden(base,join(root,'server.log'),token,foreign.err,otherPort.err,first.out,first.err,second.out,second.err);
  expect(await cimCount(base)).toBe(0);
  const again=await cli(base,['stop','--dir',root]);expect([again.code,again.out]).toEqual([0,'ok    not running (nothing to stop)\n']);
 }),T);
 it('repeated stop requests are answered alike and stop once; the launcher cleans up and exits 0',()=>withBase('tw-stop-repeat-',async base=>{
  const root=realRoot(base),port=freePort();
  const started=await cli(base,['start','--dir',root,'--port',String(port)]);expect(started.out).toContain('ok    started on');
  const state=readState(root);track(state.pid);track(state.launcher);
  const answers=await Promise.all([1,2,3].map(()=>stopRequest(port,{headers:{[OWNED_STOP_HEADER]:state.stop_token}})));
  expect(answers.map(answer=>answer.status)).toEqual([202,202,202]);
  for(const answer of answers)expect(await answer.json()).toEqual({ok:true,stopping:true});
  await until('server and launcher exit',()=>gone(state.pid)&&gone(state.launcher));
  expect(existsSync(stateFile(root))).toBe(false);
  expect(readFileSync(join(root,'server.log'),'utf8')).toContain(`server pid ${state.pid} exited with 0`);
  expect(await cimCount(base)).toBe(0);
 }),T);
 it('Ctrl+C to a foreground launcher sends the graceful HTTP stop (no SIGTERM to the server) and both exit 0',()=>withBase('tw-stop-sigint-',async base=>{
  const root=realRoot(base),port=freePort(),trigger=join(base,'sigint'),hook=join(base,'sigint-hook.ts');
  // Test-only preload: delivers SIGINT to the launcher's own listeners once the trigger file appears, as a console Ctrl+C would.
  writeFileSync(hook,`import {existsSync} from 'node:fs';const timer=setInterval(()=>{if(existsSync(${JSON.stringify(trigger)})){clearInterval(timer);process.emit('SIGINT');}},50);timer.unref();`);
  const launcher=Bun.spawn([process.execPath,'--preload',hook,join(root,'scripts','owned-server.ts'),'start'],{cwd:root,env:{...cliEnv(base),PORT:String(port)},stdin:'ignore',stdout:'pipe',stderr:'pipe',windowsHide:true});
  const output=Promise.all([new Response(launcher.stdout).text(),new Response(launcher.stderr).text()]);
  await until('running state',()=>{try{return readState(root).status==='running';}catch{return false;}},40_000);
  const state=readState(root);track(state.pid);track(launcher.pid);
  writeFileSync(trigger,'');
  expect(await launcher.exited).toBe(0);
  const [out,err]=await output;
  expect(err).toContain(`stop requested for server pid ${state.pid}`);expect(err).toContain(`server pid ${state.pid} exited with 0`);expect(err).not.toContain('SIGTERM');
  expect(gone(state.pid)).toBe(true);expect(existsSync(stateFile(root))).toBe(false);
  // In the foreground the launcher and server write to these pipes instead of server.log.
  expect(existsSync(join(root,'server.log'))).toBe(false);
  await expectTokenHidden(base,null,state.stop_token,out,err);
  expect(await cimCount(base)).toBe(0);
 }),T);
});
describe.if(process.platform==='win32')('owned stop and check (stand-in server)',()=>{
 /** check() with fake prerequisites on PATH (never run) and the CLI's real full-health probe. */
 function checkContext(base:string){
  const bin=join(base,'tools');mkdirSync(bin,{recursive:true});for(const name of ['git','bun','herdr'])writeFileSync(join(bin,`${name}.exe`),'');
  const out:string[]=[],err:string[]=[];
  const context:Context={env:{USERPROFILE:join(base,'home'),LOCALAPPDATA:join(base,'home','AppData','Local'),PATHEXT:'.COM;.EXE;.BAT;.CMD',Path:bin},platform:'win32',cwd:base,
   out:line=>out.push(line),err:line=>err.push(line),healthy:fullHealthOk,source:repo,version:executable=>executable.endsWith('herdr.exe')?'0.9.1':executable.endsWith('git.exe')?'2.47.0':'1.4.0'};
  return {context,out,err};
 }
 it('check is 0 only for the owned running instance with full health ok; herdr down or another boot is 1',()=>withBase('tw-check-',async base=>{
  const root=fixtureRoot(base),port=freePort();
  const started=await cli(base,['start','--dir',root,'--port',String(port)]);expect(started.err).toBe('');expect(started.code).toBe(0);
  const state=readState(root);track(state.pid);track(state.launcher);
  const options:Options={command:'check',dir:root,port:7317,start:true,yes:false};
  const up=checkContext(base);expect(await check(options,up.context)).toBe(0);
  expect(up.out).toContain(`ok    own instance running on port ${port} (boot ${state.boot_id})`);expect(up.out).toContain(`ok    server answers http://127.0.0.1:${port}/api/health`);
  flag(root,'herdr-off',true);
  const down=checkContext(base);expect(await check(options,down.context)).toBe(1);
  expect(down.out).toContain(`ok    own instance running on port ${port} (boot ${state.boot_id})`);expect(down.err.some(line=>line.startsWith('MISS  herdr is not ready'))).toBe(true);
  flag(root,'herdr-off',false);
  const recorded=readFileSync(stateFile(root),'utf8');writeFileSync(stateFile(root),JSON.stringify({...state,boot_id:'another-boot'}));
  const other=checkContext(base);expect(await check(options,other.context)).toBe(1);
  expect(other.err).toContain(`MISS  port ${port} answers with another boot id: another server, not this install's instance`);
  writeFileSync(stateFile(root),recorded);
  // stop with herdr up through the stand-in as well
  const stopped=await cli(base,['stop','--dir',root]);expect([stopped.code,stopped.out]).toEqual([0,`ok    stopped (server pid ${state.pid} on port ${port})\n`]);
  const after=checkContext(base);expect(await check(options,after.context)).toBe(1);
  expect(await cimCount(base)).toBe(0);
 }),T);
 it('stop waits for an install in progress, then stops',()=>withBase('tw-stop-wait-',async base=>{
  const root=fixtureRoot(base),port=freePort();
  const started=await cli(base,['start','--dir',root,'--port',String(port)]);expect(started.code).toBe(0);
  const state=readState(root);track(state.pid);track(state.launcher);
  // This test process holds the install work lock (a live owner), as a running install would.
  const install=acquireLock(root,'install',{identity:processIdentity});
  let settled=false;const stopping=cli(base,['stop','--dir',root]).finally(()=>{settled=true;});
  await Bun.sleep(3_000);
  expect(settled).toBe(false);expect(readState(root).status).toBe('running');expect(gone(state.pid)).toBe(false);
  expect(install.release()).toBe(true);
  const result=await stopping;expect([result.code,result.out]).toEqual([0,`ok    stopped (server pid ${state.pid} on port ${port})\n`]);
  expect(gone(state.launcher)).toBe(true);expect(existsSync(stateFile(root))).toBe(false);
  expect(await cimCount(base)).toBe(0);
 }),T);
 it('a silent probe and a stop timeout report diagnostics without the token, kill nothing, and the manual recovery re-checks identity',()=>withBase('tw-stop-timeout-',async base=>{
  const root=fixtureRoot(base),port=freePort();
  const started=await cli(base,['start','--dir',root,'--port',String(port)]);expect(started.code).toBe(0);
  const state=readState(root);track(state.pid);track(state.launcher);const token=state.stop_token;
  // Identity matches, the bridge probe is silent: uncertain, no stop request, nothing removed.
  flag(root,'silent',true);
  const silent=await cli(base,['stop','--dir',root]);flag(root,'silent',false);
  expect(silent.code).toBe(1);expect(silent.err).toContain('bridge probe on port');expect(silent.err).toContain('bridge probe  silent (no answer)');
  expect(silent.err).toContain('The server process is alive but does not answer');
  expect(readState(root).status).toBe('running');expect(gone(state.pid)).toBe(false);
  // The server accepts the stop but never exits: the 10 s stop budget runs out.
  flag(root,'hang',true);
  const begun=Date.now(),timeout=await cli(base,['stop','--dir',root]);
  expect(Date.now()-begun).toBeGreaterThanOrEqual(10_000);
  expect(timeout.code).toBe(1);
  for(const part of ['FAIL  stop: the server did not exit within 10000 ms after accepting the stop request','checked at    ',
   `server        pid ${state.pid}, started ${state.startedAt}, exe ${state.exe} (recorded, status running)`,'server now    alive',
   `launcher      pid ${state.launcher}`,`port          ${port} (recorded in lifecycle.json)`,`bridge probe  boot ${state.boot_id} (matches the record)`,
   'The server accepted the stop request but has not exited','Nothing was killed.',`Stop-Process -Id ${state.pid}`,'Do not reuse the PID number alone',`check --dir "${root}"`])expect(timeout.err).toContain(part);
  expect(gone(state.pid)).toBe(false);expect(readState(root).status).toBe('stopping');
  await expectTokenHidden(base,join(root,'server.log'),token,silent.out,silent.err,timeout.out,timeout.err);
  // The printed recovery command stops nothing when the process no longer matches (here: another start time), and ends it when it does.
  const recovery=timeout.err.split('\n').map(line=>line.trim()).find(line=>line.startsWith('$p=Get-CimInstance'))!;
  expect(recovery).toContain(`-eq '${state.startedAt}'`);expect(recovery).not.toContain('ExecutablePath');
  const powershell=(script:string)=>{const result=Bun.spawnSync([windowsPowerShell(),'-NoProfile','-NonInteractive','-Command',script],{stdout:'pipe',stderr:'pipe',windowsHide:true});return result.stdout.toString().trim();};
  expect(powershell(recovery.replace(`'${state.startedAt}'`,"'2000-01-01T00:00:00.0000000Z'"))).toBe(`Process ${state.pid} changed or is gone: not stopped`);
  expect(gone(state.pid)).toBe(false);
  powershell(recovery);
  await until('launcher exit after the manual recovery',()=>gone(state.pid)&&gone(state.launcher));
  expect(existsSync(stateFile(root))).toBe(false);
  expect(await cimCount(base)).toBe(0);
 }),T);
 it('readiness needs this launch\'s boot id: another boot answering the bridge probe never makes a launch ready',()=>withBase('tw-ready-',async base=>{
  const port=freePort();
  const foreign=Bun.serve({port,hostname:'127.0.0.1',fetch:request=>new URL(request.url).searchParams.get('scope')==='bridge'?Response.json({ok:true,boot_id:'foreign-boot'}):new Response('foreign',{status:404})});
  try{
   // The owned launcher: while another boot answers on the port, the state stays starting.
   const root=fixtureRoot(base);flag(root,'slow-bind',true);
   const starting=cli(base,['start','--dir',root,'--port',String(port)]);
   await until('lifecycle.json',()=>{try{return !!readState(root).status;}catch{return false;}},30_000);
   const state=readState(root);track(state.pid);track(state.launcher);
   expect(state.status).toBe('starting');
   for(const deadline=Date.now()+1_500;Date.now()<deadline;await Bun.sleep(100))expect(readState(root).status).toBe('starting');
   foreign.stop(true);
   const started=await starting;expect(started.code).toBe(0);
   expect(readState(root)).toMatchObject({status:'running',boot_id:state.boot_id});expect(await bridgeProbe(port)).toEqual({kind:'boot',boot_id:state.boot_id});
   const stopped=await cli(base,['stop','--dir',root]);expect(stopped.code).toBe(0);
  }finally{foreign.stop(true);}
  // launchOwned: lifecycle.json names this launch as running, yet the port answers with another boot: not ready, it gives up.
  const other=Bun.serve({port,hostname:'127.0.0.1',fetch:()=>Response.json({ok:true,boot_id:'foreign-boot'})});
  try{
   const root=resolve(base,'claims');mkdirSync(join(root,'scripts'),{recursive:true});marker(root);
   writeFileSync(join(root,'scripts','owned-server.ts'),`import {writeFileSync} from 'node:fs';import {join} from 'node:path';
writeFileSync(join(import.meta.dir,'..','lifecycle.json'),JSON.stringify({status:'running',pid:process.pid,port:Number(process.env.PORT),boot_id:process.env.HERDR_WEB_BOOT_ID}));
setTimeout(()=>{},6_000);`);
   await expect(launchOwned(root,{port,budgetMs:3_000})).rejects.toThrow(`Owned server did not become ready on port ${port} within 3000 ms`);
   expect(readState(root).status).toBe('running');
  }finally{other.stop(true);}
 }),T);
 it('a leftover guard is diagnosed apart from a stop timeout and is never removed',()=>withBase('tw-stop-guard-',async base=>{
  const root=fixtureRoot(base),{guard}=lockPaths(root);
  const record={pid:999_999,startedAt:'2000-01-01T00:00:00.0000000Z',exe:'C:\\gone\\bun.exe',command:'owned-server.ts',operation:'start',nonce:'left-behind'};
  writeFileSync(guard,JSON.stringify(record));
  const result=await cli(base,['stop','--dir',root]);
  expect(result.code).toBe(1);
  for(const part of ['FAIL  stop: the lifecycle guard is still held (this is not a server stop timeout; no stop request was sent)',`guard         ${guard}`,
   'guard owner   pid 999999, started 2000-01-01T00:00:00.0000000Z, exe C:\\gone\\bun.exe, operation start (recorded)','owner now     gone',
   'The guard is never removed automatically, even when its owner is gone.','Offline manual recovery'])expect(result.err).toContain(part);
  expect(result.err).not.toContain('did not exit within');
  expect(JSON.parse(readFileSync(guard,'utf8'))).toEqual(record);
  rmSync(guard);
 }),T);
});
