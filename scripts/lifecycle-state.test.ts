import {describe,expect,it} from 'bun:test';
import {existsSync,mkdirSync,mkdtempSync,readdirSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {dirname,join} from 'node:path';
import {acquireLock,judgeLock,lockPaths,matchOwner,signalIdentity,withGuard,type Identity,type LockRecord} from './lifecycle-lock.ts';
import {decide,inspectLifecycle,removeState,replaceState,stateFile,type LifecycleRecord,type Observation} from './lifecycle-state.ts';
import {processIdentity} from './process-identity.ts';import {uninstallOwned} from './uninstall.ts';

const STARTED='2026-01-01T00:00:00.000Z',EXE='/opt/bun/bin/bun';
const lockRecord=(over:Partial<LockRecord>={}):LockRecord=>({pid:4242,startedAt:STARTED,exe:EXE,command:'/owned/scripts/owned-server.ts',operation:'start',nonce:'n-1',...over});
const stateRecord=(over:Partial<LifecycleRecord>={}):LifecycleRecord=>({status:'running',pid:4343,startedAt:STARTED,exe:EXE,port:7317,boot_id:'boot-1',...over});
const alive:Identity={state:'alive',startedAt:STARTED,exe:EXE};
const absent={kind:'absent'} as const;
const obs=(over:Partial<Observation>):Observation=>({guard:false,lock:absent,state:absent,...over});
const withLock=(record:LockRecord,owner:Identity,over:Partial<Observation>={})=>obs({lock:{kind:'record',record,file:'1:1'},lockOwner:owner,...over});
const withState=(record:LifecycleRecord,owner:Identity,over:Partial<Observation>={})=>obs({state:{kind:'record',record,file:'1:2'},stateOwner:owner,...over});
/** Injected clock: sleeping advances time, so budgets and the grace period run without real waiting. */
const clock=()=>{const c={t:0,now:()=>c.t,sleep:(ms:number)=>{c.t+=ms;}};return c;};
/** Directory entries, without `.gone` names that are already deleted but still delete-pending on Windows. */
const listing=(dir:string)=>readdirSync(dir).filter(name=>!name.endsWith(".gone")).sort();
const fixture=()=>realpathSync(mkdtempSync(join(tmpdir(),'tw-state-')));
const deadPid=async()=>{const child=Bun.spawn([process.execPath,'-e','0'],{stdout:'ignore',stderr:'ignore'});await child.exited;return child.pid;};

describe('lifecycle decision table',()=>{
 it('no work record and no lifecycle state is stopped',()=>{expect(decide(obs({}))).toEqual({action:'stopped'});});
 it('installing/starting owner with matching identity is waited for, never reclaimed, and times out explicitly',()=>{
  expect(decide(withLock(lockRecord({operation:'install'}),alive))).toEqual({action:'wait',reason:'installing'});
  expect(decide(withLock(lockRecord({operation:'install'}),alive,{budgetExpired:true}))).toEqual({action:'timeout',reason:'installing'});
  expect(decide(withLock(lockRecord({operation:'start'}),alive))).toEqual({action:'wait',reason:'starting'});
  expect(decide(withState(stateRecord({status:'starting'}),alive))).toEqual({action:'wait',reason:'starting'});
  expect(decide(withState(stateRecord({status:'starting'}),alive,{budgetExpired:true}))).toEqual({action:'timeout',reason:'starting'});
  // an identity without a start time (the test-only signal probe for a foreign PID): a live (possibly reused) PID stays live
  expect(decide(withLock(lockRecord({operation:'install'}),{state:'alive'}))).toEqual({action:'wait',reason:'installing'});
 });
 it('installing/starting owner gone or with a different identity is reclaimed',()=>{
  expect(decide(withLock(lockRecord({operation:'install'}),{state:'gone'}))).toEqual({action:'reclaim',target:'lock',reason:'gone'});
  expect(decide(withLock(lockRecord(),{...alive,startedAt:'2026-02-02T00:00:00.000Z'}))).toEqual({action:'reclaim',target:'lock',reason:'mismatch'});
  expect(decide(withLock(lockRecord(),{...alive,exe:'/usr/bin/other'}))).toEqual({action:'reclaim',target:'lock',reason:'mismatch'});
  expect(decide(withState(stateRecord({status:'starting'}),{state:'gone'}))).toEqual({action:'reclaim',target:'state',reason:'gone'});
 });
 it('an existing guard means wait within the budget; nothing under it is judged or reclaimed from outside',()=>{
  expect(decide(withLock(lockRecord(),{state:'gone'},{guard:true}))).toEqual({action:'wait',reason:'guard'});
  expect(decide(obs({guard:true,budgetExpired:true}))).toEqual({action:'timeout',reason:'guard'});
 });
 it('partial metadata inside the grace period is re-read',()=>{
  expect(decide(obs({lock:{kind:'partial',file:'1:1'},lockPartialMs:1_999}))).toEqual({action:'reread',target:'lock'});
  expect(decide(obs({state:{kind:'partial',file:'1:2'},statePartialMs:0}))).toEqual({action:'reread',target:'state'});
 });
 it('undeterminable owner after the grace, denied or failed identity is uncertain and fails closed',()=>{
  for(const decision of [
   decide(obs({lock:{kind:'partial',file:'1:1'},lockPartialMs:2_000})),
   decide(obs({state:{kind:'partial',file:'1:2'},statePartialMs:2_000})),
   decide(withLock(lockRecord(),{state:'denied'})),
   decide(withLock(lockRecord(),{state:'error'})),
   decide(withState(stateRecord(),{state:'denied'})),
   decide(obs({lock:{kind:'unreadable',code:'EACCES'}})),
   decide(obs({unstable:true})),
  ])expect(decision.action).toBe('uncertain');
 });
 it('running with matching identity asks for the bridge probe and allows stop only when the recorded boot_id answers',()=>{
  expect(decide(withState(stateRecord(),alive))).toEqual({action:'probe',port:7317});
  expect(decide(withState(stateRecord(),alive,{probe:{kind:'boot',boot_id:'boot-1'}}))).toEqual({action:'running',port:7317,boot_id:'boot-1'});
 });
 it('matching identity with a silent bridge probe is uncertain (no kill, no reclaim)',()=>{
  const decision=decide(withState(stateRecord(),alive,{probe:{kind:'silent'}}));
  expect(decision.action).toBe('uncertain');expect(JSON.stringify(decision)).toContain('silent');
 });
 it('a different boot_id on the recorded port is a foreign instance: no stop request',()=>{
  expect(decide(withState(stateRecord(),alive,{probe:{kind:'boot',boot_id:'other'}}))).toEqual({action:'foreign',port:7317});
 });
 it('stopping owner with matching identity is waited for without a second cleanup',()=>{
  expect(decide(withState(stateRecord({status:'stopping'}),alive))).toEqual({action:'wait',reason:'stopping'});
  expect(decide(withState(stateRecord({status:'stopping'}),alive,{budgetExpired:true}))).toEqual({action:'timeout',reason:'stopping'});
 });
 it('a running/stopping record whose owner is proven gone is stale state',()=>{
  expect(decide(withState(stateRecord(),{state:'gone'}))).toEqual({action:'reclaim',target:'state',reason:'gone'});
  expect(decide(withState(stateRecord({status:'stopping'}),{...alive,startedAt:'2027-01-01T00:00:00.000Z'}))).toEqual({action:'reclaim',target:'state',reason:'mismatch'});
 });
 it('owner matching compares only fields both sides know and never treats denied/error as gone',()=>{
  expect(matchOwner({pid:1},{state:'alive'})).toBe('match');
  expect(matchOwner({pid:1,startedAt:STARTED},{state:'alive',startedAt:STARTED,exe:EXE})).toBe('match');
  expect(matchOwner({pid:1,exe:EXE},{state:'alive',exe:'/other'})).toBe('mismatch');
  expect(matchOwner({pid:1},{state:'denied'})).toBe('uncertain');
  expect(matchOwner({pid:1},{state:'error'})).toBe('uncertain');
  expect(judgeLock({kind:'record',record:lockRecord(),file:'1:1'},undefined,0).verdict).toBe('uncertain');
 });
});

describe('test-only signal probe',()=>{
 it('distinguishes gone, alive and denied PIDs',async()=>{
  expect(signalIdentity(await deadPid()).state).toBe('gone');
  const self=signalIdentity(process.pid);expect(self.state).toBe('alive');expect(self.startedAt).toBeString();expect(self.exe).toBe(process.execPath);
  if(process.platform==='win32')expect(signalIdentity(4).state).toBe('denied');
  else if(process.getuid?.()!==0)expect(signalIdentity(1).state).toBe('denied');
 });
});

describe('work lock and guard',()=>{
 it('places guard and lock outside the root, shared by every alias, without creating the root',()=>{
  const base=fixture();
  try{
   const root=join(base,'Owned Root');const paths=lockPaths(root);
   expect(dirname(paths.lock)).toBe(base);expect(dirname(paths.guard)).toBe(base);expect(paths.guard).not.toBe(paths.lock);
   expect(lockPaths(join(base,'other')).lock).not.toBe(paths.lock);
   const aliases=[root.replaceAll('\\','/'),root+'/'];
   if(process.platform==='win32')aliases.push(root.toUpperCase(),root.toLowerCase(),root[0]!.toLowerCase()+root.slice(1));
   // a missing root keeps its typed spelling in `target`; the lock files are what every alias must share
   const files=(path:string)=>{const {lock,guard}=lockPaths(path);return {lock,guard};};
   for(const alias of aliases)expect(files(alias)).toEqual(files(root));
   const handle=acquireLock(root.replaceAll('\\','/'),'install');
   try{expect(existsSync(root)).toBe(false);expect(JSON.parse(readFileSync(paths.lock,'utf8'))).toMatchObject({pid:process.pid,operation:'install',nonce:handle.nonce,exe:process.execPath});expect(existsSync(paths.guard)).toBe(false);}
   finally{expect(handle.release()).toBe(true);}
   expect(listing(base)).toEqual([]);
   mkdirSync(root);for(const alias of aliases)expect(files(alias)).toEqual(files(root));
   if(process.platform==='win32'){
    const short=Bun.spawnSync([join(process.env.SystemRoot!,'System32','WindowsPowerShell','v1.0','powershell.exe'),'-NoProfile','-NonInteractive','-Command','(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:TW_ALIAS).ShortPath'],{env:{...process.env,TW_ALIAS:root},stdout:'pipe',stderr:'pipe'}).stdout.toString().trim();
    if(short&&short.toLowerCase()!==root.toLowerCase())expect(lockPaths(short)).toEqual(paths);
    else console.warn('8.3 short names are disabled on this volume; short-name alias not exercised');
   }
  }finally{rmSync(base,{recursive:true,force:true});}
 });
 it('waits for a live owner for the stop budget (10 s by default) and then fails without touching its lock',()=>{
  const base=fixture();const root=join(base,'owned');const c=clock();
  try{
   const held=acquireLock(root,'start');const before=readFileSync(held.paths.lock,'utf8');
   expect(()=>acquireLock(root,'stop',{now:c.now,sleep:c.sleep})).toThrow(/timed out after 10000 ms.*live owner/);
   expect(c.t).toBeGreaterThanOrEqual(10_000);expect(c.t).toBeLessThan(10_100);
   expect(readFileSync(held.paths.lock,'utf8')).toBe(before);expect(existsSync(held.paths.guard)).toBe(false);
   expect(held.release()).toBe(true);
  }finally{rmSync(base,{recursive:true,force:true});}
 });
 it('fails closed at once on a denied or failed owner identity',()=>{
  const base=fixture();const root=join(base,'owned');const paths=lockPaths(root);
  try{
   const before=JSON.stringify(lockRecord({pid:4242,operation:'install'}));writeFileSync(paths.lock,before);
   for(const state of ['denied','error'] as const){
    // the caller's own identity still describes it; only the owner query fails
    const c=clock();
    expect(()=>acquireLock(root,'start',{now:c.now,sleep:c.sleep,identity:pid=>pid===process.pid?signalIdentity(pid):{state}})).toThrow(`uncertain (owner identity ${state}`);
    expect(c.t).toBe(0);expect(readFileSync(paths.lock,'utf8')).toBe(before);expect(existsSync(paths.guard)).toBe(false);
   }
  }finally{rmSync(base,{recursive:true,force:true});}
 });
 it('asks the owner identity outside the guard, and only judges the record it was asked for',()=>{
  const base=fixture();const root=join(base,'owned');const paths=lockPaths(root);
  try{
   writeFileSync(paths.lock,JSON.stringify(lockRecord({pid:4242,nonce:'first'})));
   const asked:{pid:number;guard:boolean}[]=[];
   // While the first owner is asked about, it hands the lock to a second owner: the answer for the first must not judge the second.
   const identity=(pid:number):Identity=>{
    if(pid===process.pid)return signalIdentity(pid);
    asked.push({pid,guard:existsSync(paths.guard)});
    if(pid===4242){writeFileSync(paths.lock,JSON.stringify(lockRecord({pid:4343,nonce:'second'})));return {state:'gone'};}
    return alive;
   };
   const c=clock();
   expect(()=>acquireLock(root,'start',{now:c.now,sleep:c.sleep,identity,budgetMs:200})).toThrow(/timed out after 200 ms.*live owner \(pid 4343/);
   expect(asked[0]).toEqual({pid:4242,guard:false});expect(asked.slice(1).every(entry=>entry.pid===4343&&!entry.guard)).toBe(true);
   expect(JSON.parse(readFileSync(paths.lock,'utf8')).nonce).toBe('second');expect(existsSync(paths.guard)).toBe(false);
  }finally{rmSync(base,{recursive:true,force:true});}
 });
 it('a live uninstall lock is never reclaimed by install or stop: every lock is recorded and judged by the same identity adapter',()=>{
  const base=fixture();const root=join(base,'owned');mkdirSync(root);
  writeFileSync(join(root,'.termweave-owned.json'),JSON.stringify({product:'termweave',root,inventory:{}}));
  const attempts:{operation:string;error?:string}[]=[];let published=false;
  try{
   // While the uninstall CLI path (default lock options) holds its work lock, the install and stop callers try to take it.
   uninstallOwned(root,true,{trace:event=>{
    if(event==='published')published=true;
    else if(event==='guard-released'&&published&&!attempts.length)for(const operation of ['install','stop'] as const){
     const c=clock();
     try{acquireLock(root,operation,{identity:processIdentity,now:c.now,sleep:c.sleep,budgetMs:100}).release();attempts.push({operation});}
     catch(error){attempts.push({operation,error:String(error)});}
    }
   }});
   // a reclaim would record the attempt without an error
   const refused=expect.stringMatching(/timed out after 100 ms: work lock .* is held by a live owner \(pid \d+, .*operation uninstall/);
   expect(attempts).toEqual([{operation:'install',error:refused},{operation:'stop',error:refused}]);
   expect(existsSync(root)).toBe(false);expect(listing(base)).toEqual([]);
  }finally{rmSync(base,{recursive:true,force:true});}
 });
 it('re-reads partial metadata during the 2 s grace and then fails closed instead of reclaiming',()=>{
  const base=fixture();const root=join(base,'owned');const c=clock();const paths=lockPaths(root);let rechecks=0;
  try{
   writeFileSync(paths.lock,'{"pid":');
   expect(()=>acquireLock(root,'install',{now:c.now,sleep:c.sleep,trace:event=>{if(event==='recheck')rechecks++;}})).toThrow('uninterpretable after 2000 ms');
   expect(c.t).toBeGreaterThanOrEqual(2_000);expect(c.t).toBeLessThan(2_100);expect(rechecks).toBeGreaterThan(50);
   expect(readFileSync(paths.lock,'utf8')).toBe('{"pid":');expect(listing(base)).toEqual([`${paths.lock.slice(base.length+1)}`]);
  }finally{rmSync(base,{recursive:true,force:true});}
 });
 it('a record completed within the grace is judged on its content (stale owner reclaimed into a tombstone)',async()=>{
  const base=fixture();const root=join(base,'owned');const c=clock();const paths=lockPaths(root);const dead=await deadPid();let sleeps=0;
  try{
   writeFileSync(paths.lock,'');
   const handle=acquireLock(root,'start',{now:c.now,sleep:ms=>{c.sleep(ms);if(++sleeps===3)writeFileSync(paths.lock,JSON.stringify(lockRecord({pid:dead,nonce:'stale-1'})));}});
   expect(c.t).toBeLessThan(2_000);
   const tombs=listing(base).filter(name=>name.includes('.tomb-'));expect(tombs).toHaveLength(1);
   expect(JSON.parse(readFileSync(join(base,tombs[0]!),'utf8')).nonce).toBe('stale-1');
   expect(JSON.parse(readFileSync(paths.lock,'utf8')).nonce).toBe(handle.nonce);
   expect(handle.release()).toBe(true);expect(listing(base)).toEqual([]);
  }finally{rmSync(base,{recursive:true,force:true});}
 });
 it('a late release by a reclaimed owner never removes the new owner lock',()=>{
  const base=fixture();const root=join(base,'owned');
  try{
   const old=acquireLock(root,'start');
   // the next caller observes a different start time for the recorded PID: identity mismatch is a stale proof
   const next=acquireLock(root,'start',{identity:pid=>pid===process.pid?{state:'alive',startedAt:'reused-pid',exe:process.execPath}:signalIdentity(pid)});
   expect(next.nonce).not.toBe(old.nonce);
   expect(old.release()).toBe(false);
   expect(JSON.parse(readFileSync(next.paths.lock,'utf8')).nonce).toBe(next.nonce);
   expect(next.release()).toBe(true);expect(existsSync(next.paths.lock)).toBe(false);expect(listing(base)).toEqual([]);
  }finally{rmSync(base,{recursive:true,force:true});}
 });
 it('never reclaims an existing guard: fails within the budget with target, path, owner and offline recovery guidance',()=>{
  const base=fixture();const root=join(base,'owned');const c=clock();const paths=lockPaths(root);
  try{
   const guard=JSON.stringify(lockRecord({pid:999999,nonce:'guard-1',operation:'stop'}));writeFileSync(paths.guard,guard);
   let message='';
   try{acquireLock(root,'start',{now:c.now,sleep:c.sleep,budgetMs:500});}catch(error){message=String(error);}
   for(const part of [paths.target,paths.guard,'pid 999999','operation stop','never removed automatically','Offline manual recovery','do not delete the guard'])expect(message).toContain(part);
   expect(c.t).toBeGreaterThanOrEqual(500);expect(readFileSync(paths.guard,'utf8')).toBe(guard);expect(existsSync(paths.lock)).toBe(false);
   expect(()=>withGuard(root,'stop',()=>true,{now:c.now,sleep:c.sleep,budgetMs:100})).toThrow('gave up after 100 ms');
  }finally{rmSync(base,{recursive:true,force:true});}
 });
});

describe('lifecycle state files',()=>{
 it('replaces and removes lifecycle.json only under matching expectations',()=>{
  const base=fixture();const root=join(base,'owned');mkdirSync(root);
  try{
   const lock=acquireLock(root,'start');
   expect(replaceState(root,stateRecord({status:'starting',boot_id:'b1'}),{lock:lock.nonce,state:null},'start')).toBe(true);
   expect(replaceState(root,stateRecord({boot_id:'b2'}),{lock:lock.nonce,state:null},'start')).toBe(false);
   expect(replaceState(root,stateRecord({boot_id:'b1'}),{lock:'someone-else',state:'b1'},'start')).toBe(false);
   expect(replaceState(root,stateRecord({boot_id:'b1'}),{lock:lock.nonce,state:'b1'},'start')).toBe(true);
   expect(JSON.parse(readFileSync(stateFile(root),'utf8'))).toMatchObject({status:'running',boot_id:'b1'});
   expect(lock.release()).toBe(true);
   expect(removeState(root,{state:'old-boot'},'stop')).toBe(false);
   expect(removeState(root,{lock:lock.nonce,state:'b1'},'stop')).toBe(false);
   expect(existsSync(stateFile(root))).toBe(true);
   writeFileSync(stateFile(root),'{"status":"run');
   expect(removeState(root,{state:'b1'},'stop')).toBe(false);expect(readFileSync(stateFile(root),'utf8')).toBe('{"status":"run');
   writeFileSync(stateFile(root),JSON.stringify(stateRecord({boot_id:'b1'})));
   expect(removeState(root,{state:'b1'},'stop')).toBe(true);expect(existsSync(stateFile(root))).toBe(false);
   expect(listing(root)).toEqual([]);expect(listing(base)).toEqual(['owned']);
  }finally{rmSync(base,{recursive:true,force:true});}
 });
 it('--check inspection creates nothing and resolves partial state through the grace period',async()=>{
  const base=fixture();const root=join(base,'owned');
  try{
   expect(decide(inspectLifecycle(root))).toEqual({action:'stopped'});expect(listing(base)).toEqual([]);
   const held=acquireLock(root,'install');
   expect(decide(inspectLifecycle(root))).toEqual({action:'wait',reason:'installing'});
   expect(held.release()).toBe(true);
   mkdirSync(root);writeFileSync(stateFile(root),'');const c=clock();
   const partial=inspectLifecycle(root,{now:c.now,sleep:c.sleep});
   expect(c.t).toBeGreaterThanOrEqual(2_000);expect(decide(partial).action).toBe('uncertain');
   writeFileSync(stateFile(root),JSON.stringify(stateRecord({pid:await deadPid()})));
   expect(decide(inspectLifecycle(root))).toEqual({action:'reclaim',target:'state',reason:'gone'});
   const self=processIdentity(process.pid);
   writeFileSync(stateFile(root),JSON.stringify(stateRecord({pid:process.pid,startedAt:self.startedAt,exe:self.exe})));
   expect(decide({...inspectLifecycle(root),probe:{kind:'boot',boot_id:'boot-1'}})).toEqual({action:'running',port:7317,boot_id:'boot-1'});
   expect(listing(base)).toEqual(['owned']);expect(listing(root)).toEqual(['lifecycle.json']);
  }finally{rmSync(base,{recursive:true,force:true});}
 });
});
