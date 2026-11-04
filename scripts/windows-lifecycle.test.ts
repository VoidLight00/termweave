import {describe,expect,it} from 'bun:test';
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {dirname,join,relative,resolve} from 'node:path';
import {acquireLock,lockPaths,observeFile,parseLockRecord,signalIdentity,type LockRecord} from './lifecycle-lock.ts';
import {parseLifecycleRecord,stateFile} from './lifecycle-state.ts';
import {processIdentity,type ProcessIdentity} from './process-identity.ts';
import {windowsProcessTable} from '../server/windows-processes.ts';
const repo=resolve(import.meta.dir,'..'),T=90_000;
/** The real owned-server.ts and its whole relative import closure, copied so the fixture root runs the code under test. */
function copyClosure(root:string,entry:string){
 const pending=[resolve(repo,entry)],seen=new Set<string>();
 while(pending.length){
  const file=pending.pop()!;if(seen.has(file))continue;seen.add(file);
  const target=join(root,relative(repo,file));mkdirSync(dirname(target),{recursive:true});copyFileSync(file,target);
  for(const match of readFileSync(file,'utf8').matchAll(/(?:from|import)\s*['"](\.{1,2}\/[^'"]+)['"]/g))pending.push(resolve(dirname(file),match[1]!));
 }
}
/** Stands in for server/index.ts: the same plain `Bun.serve({port,hostname})` bind, health in the full and bridge shapes. */
const FIXTURE_SERVER=`if(process.env.TERMWEAVE_OWNED_LAUNCH!=='1')throw new Error('fixture requires the owned launcher');
const boot=process.env.HERDR_WEB_BOOT_ID??null;
const server=Bun.serve({port:Number(process.env.PORT),hostname:process.env.HOST,fetch(request){const url=new URL(request.url);
 if(url.pathname==='/api/health')return Response.json(url.searchParams.get('scope')==='bridge'?{ok:true,boot_id:boot}:{ok:true,web_ui:{boot_id:boot}});
 return new Response('fixture',{status:404});}});
console.log('fixture listening on '+server.hostname+':'+server.port+' boot '+boot);
`;
function fixtureRoot(base:string,name:string){
 const root=resolve(base,name);mkdirSync(join(root,'server'),{recursive:true});
 copyClosure(root,'scripts/owned-server.ts');copyClosure(root,'scripts/lifecycle-launch.ts');
 writeFileSync(join(root,'server','index.ts'),FIXTURE_SERVER);
 writeFileSync(join(root,'.termweave-owned.json'),JSON.stringify({product:'termweave',root,inventory:{}}));
 return root;
}
const freePort=()=>{const probe=Bun.serve({port:0,hostname:'127.0.0.1',fetch:()=>new Response('')});const port=probe.port!;probe.stop(true);return port;};
/** Processes whose command line names this test's temp base, counted from the CIM process table. */
async function cimCount(base:string){const rows=await windowsProcessTable();expect(rows.length).toBeGreaterThan(0);return rows.filter(row=>(row.commandLine??'').toLowerCase().includes(base.toLowerCase())).length;}
async function bootOf(port:number){try{const body=await (await fetch(`http://127.0.0.1:${port}/api/health`,{signal:AbortSignal.timeout(2_000)})).json() as {web_ui?:{boot_id?:string}};return body.web_ui?.boot_id;}catch{return undefined;}}
async function until(what:string,check:()=>boolean|Promise<boolean>,ms=15_000){const deadline=Date.now()+ms;while(!(await check())){if(Date.now()>deadline)throw new Error(`timed out waiting for ${what}`);await Bun.sleep(50);}}
/** A launch from a separate Bun that exits as soon as launchOwned resolves, like an install command whose console then closes. */
async function launchFromParent(root:string,port:number){
 const script=`import {launchOwned} from ${JSON.stringify(join(root,'scripts','lifecycle-launch.ts').replaceAll('\\','/'))};
try{console.log(JSON.stringify(await launchOwned(${JSON.stringify(root)},{port:${port}})));}catch(error){console.error(String(error));process.exit(3);}`;
 const parent=Bun.spawn([process.execPath,'-e',script],{cwd:root,stdin:'ignore',stdout:'pipe',stderr:'pipe',windowsHide:true});
 const [code,out,err]=await Promise.all([parent.exited,new Response(parent.stdout).text(),new Response(parent.stderr).text()]);
 return {parentPid:parent.pid,code,out,err};
}
/** Owned processes this file started; cleanup only ends a PID whose kernel identity (start time) still matches what was recorded. */
const owned=new Map<number,ProcessIdentity>();
const track=(pid:number)=>{const identity=processIdentity(pid);if(identity.state==='alive')owned.set(pid,identity);return identity;};
function endOwned(pid:number){const recorded=owned.get(pid),now=processIdentity(pid);if(recorded&&now.state==='alive'&&now.startedAt===recorded.startedAt)try{process.kill(pid);}catch{}}
/** Ends the server (as a crash/forced stop would) and proves the launcher withdraws its state and exits on its own. */
async function stopInstance(root:string,launcher:number,server:number){
 endOwned(server);
 await until('launcher exit after server exit',()=>processIdentity(launcher).state==='gone');
 expect(existsSync(stateFile(root))).toBe(false);
}
async function withBase(name:string,fn:(base:string)=>Promise<void>){
 const base=realpathSync(mkdtempSync(join(tmpdir(),name)));
 try{await fn(base);}
 finally{
  for(const pid of owned.keys())endOwned(pid);owned.clear();
  await until('fixture processes to exit (CIM count 0)',async()=>await cimCount(base)===0,20_000);
  rmSync(base,{recursive:true,force:true});
 }
}
describe.if(process.platform==='win32')('Windows owned lifecycle (kernel process identity)',()=>{
 it('detached launch outlives its parent, writes server.log, records identities and holds no work lock while running',()=>withBase('tw-detach-',async base=>{
  const root=fixtureRoot(base,'owned'),port=freePort();
  const launched=await launchFromParent(root,port);expect(launched.err).toBe('');expect(launched.code).toBe(0);
  const result=JSON.parse(launched.out) as {launcher:number;pid:number;port:number;boot_id:string;log:string};
  const launcher=track(result.launcher),server=track(result.pid);
  // The launching parent is gone (kernel identity, not a signal probe); launcher and server survive it.
  expect(processIdentity(launched.parentPid).state).toBe('gone');
  await Bun.sleep(500);
  expect(launcher.state).toBe('alive');expect(processIdentity(result.launcher).startedAt).toBe(launcher.startedAt);
  expect(server.state).toBe('alive');expect(server.parentPid).toBe(result.launcher);expect(launcher.parentPid).toBe(launched.parentPid);
  expect(await bootOf(port)).toBe(result.boot_id);
  const state=JSON.parse(readFileSync(stateFile(root),'utf8'));
  expect(state).toMatchObject({status:'running',pid:result.pid,startedAt:server.startedAt,exe:server.exe,port,boot_id:result.boot_id,launcher:result.launcher});
  expect(state.launcher_identity).toMatchObject({pid:result.launcher,state:'alive',startedAt:launcher.startedAt});
  expect(state.parent).toMatchObject({pid:launched.parentPid,state:'alive'});
  expect(observeFile(lockPaths(root).lock,parseLockRecord).kind).toBe('absent');
  expect(existsSync(lockPaths(root).guard)).toBe(false);
  expect(result.log).toBe(join(root,'server.log'));
  const log=readFileSync(result.log,'utf8');
  expect(log).toContain(`fixture listening on 127.0.0.1:${port} boot ${result.boot_id}`);expect(log).toContain(`running server pid ${result.pid}`);
  expect(await cimCount(base)).toBe(2);
  await stopInstance(root,result.launcher,result.pid);
  expect(readFileSync(result.log,'utf8')).toContain(`server pid ${result.pid} exited`);
  expect(await cimCount(base)).toBe(0);
 }),T);
 it('a second bind of the same port fails with EADDRINUSE and the first instance stays up',()=>withBase('tw-bind-',async base=>{
  // Source guard: the real server binds once, plainly, without port sharing.
  const source=readFileSync(join(repo,'server','index.ts'),'utf8');expect(source).not.toContain('reusePort');expect(FIXTURE_SERVER).not.toContain('reusePort');
  expect(source).toMatch(/Bun\.serve<SocketData>\(\{\s*port: options\.port \?\? \(envPort \? Number\(envPort\) : DEFAULT_PORT\),\s*hostname,/);
  const first=fixtureRoot(base,'first'),second=fixtureRoot(base,'second'),port=freePort();
  const a=await launchFromParent(first,port);expect(a.code).toBe(0);
  const result=JSON.parse(a.out) as {launcher:number;pid:number;boot_id:string};track(result.launcher);track(result.pid);
  const b=await launchFromParent(second,port);
  expect(b.code).toBe(3);expect(b.err).toContain('launcher exited');expect(b.err).toContain(join(second,'server.log'));
  const log=readFileSync(join(second,'server.log'),'utf8');expect(log).toContain('EADDRINUSE');expect(log).toMatch(/Server exited \(code [1-9]/);
  expect(existsSync(stateFile(second))).toBe(false);expect(observeFile(lockPaths(second).lock,parseLockRecord).kind).toBe('absent');
  // The first instance is untouched: same boot answers, same server process, its state still running.
  expect(await bootOf(port)).toBe(result.boot_id);expect(processIdentity(result.pid).state).toBe('alive');
  expect(JSON.parse(readFileSync(stateFile(first),'utf8'))).toMatchObject({status:'running',pid:result.pid,boot_id:result.boot_id});
  expect(await cimCount(base)).toBe(2);
  await stopInstance(first,result.launcher,result.pid);expect(await cimCount(base)).toBe(0);
 }),T);
 it('stale reclaim uses the kernel process identity: a reused PID is reclaimed, a live owner is not',()=>withBase('tw-reclaim-',async base=>{
  const root=fixtureRoot(base,'owned'),paths=lockPaths(root);
  // A live process whose PID the stale records name; it is never the owner they describe unless its exact identity is recorded.
  const sleeper=Bun.spawn([process.execPath,'-e',`setTimeout(()=>{},120000);// ${base}`],{stdin:'ignore',stdout:'ignore',stderr:'ignore',windowsHide:true});
  const live=track(sleeper.pid);expect(live.state).toBe('alive');
  const lock=(record:Partial<LockRecord>)=>writeFileSync(paths.lock,JSON.stringify({pid:sleeper.pid,startedAt:live.startedAt,exe:live.exe,command:'owned-server.ts',operation:'start',nonce:'old-nonce',...record}));
  const reused={startedAt:'2000-01-01T00:00:00.0000000Z'};
  // Negative control: the conservative signal probe cannot see the reuse, so it waits on the "live" owner and reclaims nothing.
  lock(reused);
  expect(()=>acquireLock(root,'start',{identity:signalIdentity,budgetMs:300})).toThrow('held by a live owner');
  expect((observeFile(paths.lock,parseLockRecord) as {record:LockRecord}).record.nonce).toBe('old-nonce');
  // Kernel identity: the creation time differs on the same PID, so the lock is reclaimed under the guard.
  const events:string[]=[];
  const reclaimed=acquireLock(root,'start',{identity:processIdentity,budgetMs:20_000,trace:event=>events.push(event)});
  expect(events).toContain('reclaimed');expect(reclaimed.release()).toBe(true);
  // The kernel identity of the live owner matches exactly: never reclaimed, the record stays.
  lock({});
  expect(()=>acquireLock(root,'start',{identity:processIdentity,budgetMs:1_500})).toThrow('held by a live owner');
  expect((observeFile(paths.lock,parseLockRecord) as {record:LockRecord}).record.nonce).toBe('old-nonce');
  // Through owned-server: a live owner's state refuses the start and stays; a reused-PID state is reclaimed and the start runs.
  const port=freePort(),state=(record:object)=>writeFileSync(stateFile(root),JSON.stringify({status:'running',pid:sleeper.pid,startedAt:live.startedAt,exe:live.exe,port,boot_id:'old-boot',...record}));
  rmSync(paths.lock);state({});
  const refused=await launchFromParent(root,port);expect(refused.code).toBe(3);
  expect(readFileSync(join(root,'server.log'),'utf8')).toContain(`Active or uncertain process state: running pid ${sleeper.pid} (owner alive)`);
  expect(observeFile(stateFile(root),parseLifecycleRecord)).toMatchObject({kind:'record',record:{boot_id:'old-boot'}});
  lock(reused);state(reused);
  const started=await launchFromParent(root,port);expect(started.err).toBe('');expect(started.code).toBe(0);
  const result=JSON.parse(started.out) as {launcher:number;pid:number;boot_id:string};track(result.launcher);track(result.pid);
  expect(readFileSync(join(root,'server.log'),'utf8')).toContain(`reclaimed stale lifecycle.json of pid ${sleeper.pid} (mismatch)`);
  expect(JSON.parse(readFileSync(stateFile(root),'utf8'))).toMatchObject({status:'running',pid:result.pid,boot_id:result.boot_id});
  expect(observeFile(paths.lock,parseLockRecord).kind).toBe('absent');expect(processIdentity(sleeper.pid).state).toBe('alive');
  expect(await cimCount(base)).toBe(3);
  await stopInstance(root,result.launcher,result.pid);
  sleeper.kill();await sleeper.exited;expect(await cimCount(base)).toBe(0);
 }),T);
});
