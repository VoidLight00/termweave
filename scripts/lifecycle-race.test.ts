import {afterEach,describe,expect,it} from 'bun:test';
import {existsSync,mkdirSync,mkdtempSync,readdirSync,readFileSync,realpathSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {basename,join} from 'node:path';import type {Subprocess} from 'bun';

/**
 * C-6 barrier scenarios with separate Bun processes. Ordering comes only from test-only barrier files written by the trace
 * observer of the real helper (`at-<event>` reached, `go-<event>` released); there are no ordering sleeps. Budgets only bound
 * how long a correctly refused contender keeps waiting for a live owner.
 */
const LOCK=join(import.meta.dir,'lifecycle-lock.ts'),STATE=join(import.meta.dir,'lifecycle-state.ts'),UNINSTALL=join(import.meta.dir,'uninstall.ts');
const WORKER=`
import {appendFileSync,existsSync,renameSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
const cfg=JSON.parse(process.argv[2]);
// result files appear complete or not at all
const put=(name,value)=>{writeFileSync(file(name)+'.tmp',value);renameSync(file(name)+'.tmp',file(name));};
const lock=await import(cfg.module);
const file=name=>join(cfg.ctl,cfg.name+'.'+name);
const log=(event,detail={})=>appendFileSync(file('events'),JSON.stringify({event,...detail})+'\\n');
const barrier=name=>{while(!existsSync(file(name)))Bun.sleepSync(2);};
const paused=new Set();
const trace=(event,detail={})=>{log(event,detail);if(cfg.pause.includes(event)&&!paused.has(event)){paused.add(event);writeFileSync(file('at-'+event),'');barrier('go-'+event);}};
// test-only identity override: the listed PIDs are reported gone (an identity-mismatch proof for a still running old owner)
const identity=pid=>cfg.gone.includes(pid)?{state:'gone'}:lock.signalIdentity(pid);
const options={trace,identity,budgetMs:cfg.budgetMs};
log('loaded',{pid:process.pid,paths:lock.lockPaths(cfg.root)});
try{
 if(cfg.mode==='acquire'){
  const pre=lock.readLock(cfg.root).lock;log('pre',{nonce:pre.kind==='record'?pre.record.nonce:pre.kind});
  const handle=lock.acquireLock(cfg.root,cfg.op,options);put('owner',handle.nonce);
  for(;;){if(existsSync(file('release'))){put('released',String(handle.release()));break;}if(existsSync(file('exit')))break;Bun.sleepSync(2);}
 }else if(cfg.mode==='uninstall'){(await import(cfg.uninstall)).uninstallOwned(cfg.root,true,options);put('done','removed');}
 else if(cfg.mode==='remove-state'){put('done',String((await import(cfg.state)).removeState(cfg.root,{state:cfg.expectState},'stop',options)));}
}catch(error){put('error',String(error?.message??error));process.exit(3);}
`;
type WorkerConfig={name:string;root:string;mode?:'acquire'|'uninstall'|'remove-state';op?:string;pause?:string[];budgetMs?:number;gone?:number[];module?:string;expectState?:string};
type Event={event:string;[key:string]:unknown};
type Worker={name:string;child:Subprocess;pid:number};
let active:Fixture|undefined;
class Fixture{
 readonly base=realpathSync(mkdtempSync(join(tmpdir(),'tw-race-')));readonly ctl=join(this.base,'ctl');readonly area=join(this.base,'area');
 readonly children:Subprocess[]=[];
 constructor(){mkdirSync(this.ctl);mkdirSync(this.area);writeFileSync(join(this.ctl,'worker.ts'),WORKER);}
 file(name:string,suffix:string){return join(this.ctl,`${name}.${suffix}`);}
 spawn(cfg:WorkerConfig):Worker{
  const full={mode:'acquire',op:'start',pause:[],budgetMs:15_000,gone:[],module:LOCK,uninstall:UNINSTALL,state:STATE,ctl:this.ctl,...cfg};
  const child=Bun.spawn([process.execPath,join(this.ctl,'worker.ts'),JSON.stringify(full)],{stdout:'ignore',stderr:'pipe'});
  this.children.push(child);return {name:cfg.name,child,pid:child.pid};
 }
 events(name:string):Event[]{const path=this.file(name,'events');// a line still being appended is skipped until it is complete
  return existsSync(path)?readFileSync(path,'utf8').split('\n').flatMap(line=>{try{return [JSON.parse(line) as Event];}catch{return [];}}):[];}
 /** Barrier wait: returns once the worker created `name.suffix` (or logged `event`); a worker that died first fails the test with its error. */
 async waitFor(worker:Worker,suffix:string,event?:string){
  const reached=()=>event?this.events(worker.name).some(e=>e.event===event):existsSync(this.file(worker.name,suffix));
  for(const deadline=Date.now()+20_000;!reached();){
   if(worker.child.exitCode!==null&&!reached())throw new Error(`${worker.name} exited ${worker.child.exitCode} before ${event??suffix}: ${this.read(worker.name,'error')??await new Response(worker.child.stderr as ReadableStream).text()}`);
   if(Date.now()>deadline)throw new Error(`barrier timeout waiting for ${worker.name} ${event??suffix}`);
   await Bun.sleep(2);
  }
  return this.read(worker.name,suffix);
 }
 signal(worker:Worker,suffix:string){writeFileSync(this.file(worker.name,suffix),'');}
 read(name:string,suffix:string){const path=this.file(name,suffix);return existsSync(path)?readFileSync(path,'utf8'):undefined;}
 async kill(worker:Worker){worker.child.kill();await worker.child.exited;expect(()=>process.kill(worker.pid,0)).toThrow();}
 /** Every lifecycle file next to the targets: name -> content. `.gone` names are already deleted (Windows delete-pending). */
 snapshot(){return Object.fromEntries(readdirSync(this.area).filter(name=>name.startsWith('.termweave-')&&!name.endsWith('.gone')).sort().map(name=>[name,readFileSync(join(this.area,name),'utf8')]));}
 lockNonce(lock:string){return existsSync(lock)?JSON.parse(readFileSync(lock,'utf8')).nonce as string:undefined;}
 tombNonces(){return readdirSync(this.area).filter(name=>name.includes('.lock.tomb-')).map(name=>JSON.parse(readFileSync(join(this.area,name),'utf8')).nonce as string);}
 /** Stale lock S: a real acquire by a process that then exits without releasing. */
 async stale(root:string){
  const s=this.spawn({name:`S${this.children.length}`,root});this.signal(s,'exit');
  expect(await s.child.exited).toBe(0);const nonce=this.read(s.name,'owner')!;expect(nonce).toBeString();
  expect(()=>process.kill(s.pid,0)).toThrow();return nonce;
 }
 async dispose(){
  for(const name of readdirSync(this.ctl))if(name.endsWith('.events')){const worker=name.slice(0,-'.events'.length);writeFileSync(this.file(worker,'exit'),'');for(const event of ['recheck','guard-acquired','reclaimed','guard-busy','published'])writeFileSync(this.file(worker,`go-${event}`),'');}
  for(const child of this.children)if(child.exitCode===null)child.kill();
  await Promise.all(this.children.map(child=>child.exited));
  // cleanup only after every child and waiter has exited
  rmSync(this.base,{recursive:true,force:true});
 }
}
const fixture=()=>(active=new Fixture());
afterEach(async()=>{const current=active;active=undefined;await current?.dispose();});
/** The C-6 property: at most one process believes it owns the work lock, it is the nonce on disk, and no owner was moved into a tombstone. */
function assertOwnership({owners,lockNonce,tombNonces}:{owners:string[];lockNonce:string|undefined;tombNonces:string[]}){
 if(owners.length>1)throw new Error(`ownership violated: ${owners.length} processes believe they own the work lock (${owners.join(', ')})`);
 const moved=owners.filter(nonce=>tombNonces.includes(nonce));if(moved.length)throw new Error(`ownership violated: live owner ${moved.join(', ')} was moved into a tombstone`);
 if(owners.length===1&&owners[0]!==lockNonce)throw new Error(`ownership violated: work lock carries ${lockNonce}, owner holds ${owners[0]}`);
}
/** Negative-control module: a copy of the real helper whose guard entry is replaced by a no-op. Product source stays unchanged. */
function unguardedCopy(f:Fixture){
 const source=readFileSync(LOCK,'utf8');let replaced=0;
 // every relative import (lifecycle-path.ts, process-identity.ts) resolves from scripts/; a new or renamed one fails the count
 const relative=source.match(/from '\.{1,2}\//g)?.length??0;expect(relative).toBe(2);
 const copy=source.replace(/from '(\.{1,2}\/[^']+)'/g,(_,path:string)=>{replaced++;return `from ${JSON.stringify(join(import.meta.dir,path))}`;})
  .replace(/(function enterGuard\([^)]*\):\(\)=>void\{)/,(head)=>{replaced++;return `${head}return ()=>{};`;});
 expect(replaced).toBe(relative+1);expect(copy).not.toBe(source);
 const path=join(f.ctl,'lifecycle-lock.unguarded.ts');writeFileSync(path,copy);return path;
}
const T=60_000;

describe('C-6 shared guard barrier scenarios',()=>{
 it('1. negative control: without the guard two reclaimers both own the lock and the new owner N is moved',async()=>{
  const f=fixture();const root=join(f.area,'target');const lock=(await import(LOCK)).lockPaths(root).lock as string;
  const S=await f.stale(root);const unguarded=unguardedCopy(f);
  const A=f.spawn({name:'A',root,module:unguarded,pause:['recheck']}),B=f.spawn({name:'B',root,module:unguarded,pause:['recheck']});
  await f.waitFor(A,'at-recheck');await f.waitFor(B,'at-recheck');
  // both finished their final re-check of the same stale S before either renamed it
  for(const name of ['A','B'])expect(f.events(name).find(e=>e.event==='recheck')).toMatchObject({verdict:'stale',nonce:S});
  f.signal(A,'go-recheck');const N=(await f.waitFor(A,'owner'))!;expect(f.lockNonce(lock)).toBe(N);
  f.signal(B,'go-recheck');const nB=(await f.waitFor(B,'owner'))!;
  expect(f.read('A','error')).toBeUndefined();expect(f.read('B','error')).toBeUndefined();
  const observed={owners:[N,nB],lockNonce:f.lockNonce(lock),tombNonces:f.tombNonces()};
  // the counterexample on real file nonces: N sits in B's tombstone and both processes hold an owner nonce
  expect(observed.tombNonces.sort()).toEqual([S,N].sort());expect(observed.lockNonce).toBe(nB);
  // red: exactly the ownership assertion fails (module loaded, both workers ran to ownership, no other error)
  let red='';try{assertOwnership(observed);}catch(error){red=String(error);}
  expect(red).toContain('ownership violated: 2 processes believe they own the work lock');
  console.info(`negative control (guard bypassed) red as expected: ${red}; S=${S} N=${N} lock=${observed.lockNonce} tombstones=${observed.tombNonces.join(',')}`);
 },T);

 const guardedReclaim=async(first:string,second:string)=>{
  const f=fixture();const root=join(f.area,'target');const lock=(await import(LOCK)).lockPaths(root).lock as string;
  const S=await f.stale(root);
  const P=f.spawn({name:first,root,pause:['recheck']});await f.waitFor(P,'at-recheck');
  expect(f.events(first).find(e=>e.event==='pre')?.nonce).toBe(S);expect(f.events(first).find(e=>e.event==='recheck')).toMatchObject({verdict:'stale',nonce:S});
  const Q=f.spawn({name:second,root,budgetMs:4_000}),C=f.spawn({name:'C',root,op:'stop',budgetMs:4_000});
  await f.waitFor(Q,'','guard-busy');await f.waitFor(C,'','guard-busy');
  // both contenders tried to enter while the first holds the guard after its final re-check; none got further
  expect(f.events(second).find(e=>e.event==='pre')?.nonce).toBe(S);
  for(const name of [second,'C'])for(const event of ['guard-acquired','recheck','reclaimed','published'])expect(f.events(name).some(e=>e.event===event)).toBe(false);
  f.signal(P,'go-recheck');const N=(await f.waitFor(P,'owner'))!;const identity=statSync(lock,{bigint:true}).ino;
  expect(await Q.child.exited).toBe(3);expect(await C.child.exited).toBe(3);
  for(const name of [second,'C']){
   expect(f.read(name,'error')).toContain('live owner');
   // re-read N under the guard instead of trusting the cached S, and refused to reclaim it
   expect(f.events(name).filter(e=>e.event==='recheck').every(e=>e.verdict==='live'&&e.nonce===N)).toBe(true);
   expect(f.events(name).some(e=>e.event==='reclaimed'||e.event==='published')).toBe(false);
  }
  const observed={owners:[N],lockNonce:f.lockNonce(lock),tombNonces:f.tombNonces()};
  expect(observed.lockNonce).toBe(N);expect(statSync(lock,{bigint:true}).ino).toBe(identity);expect(observed.tombNonces).toEqual([S]);
  assertOwnership(observed);
  f.signal(P,'release');expect(await f.waitFor(P,'released')).toBe('true');expect(f.snapshot()).toEqual({});
 };
 it('2. guard green: the reclaim is serialized, N keeps its nonce and file identity, no tombstone holds N, one owner',()=>guardedReclaim('A','B'),T);
 it('3a. reversed order (B reclaims first) keeps the same guarantees',()=>guardedReclaim('B','A'),T);

 it('3b. an old owner release, uninstall and a stale launcher cleanup interleaved with a reclaim preserve the new nonce and boot_id',async()=>{
  const f=fixture();const root=join(f.area,'owned');mkdirSync(root);const marker=join(root,'.termweave-owned.json');
  writeFileSync(marker,JSON.stringify({product:'termweave',root,inventory:{}}));
  const lock=(await import(LOCK)).lockPaths(root).lock as string;
  const O=f.spawn({name:'O',root});const old=(await f.waitFor(O,'owner'))!;
  // A has proof that O's identity no longer matches (injected), so it reclaims O while O is still running
  const A=f.spawn({name:'A',root,gone:[O.pid],pause:['recheck']});await f.waitFor(A,'at-recheck');
  expect(f.events('A').find(e=>e.event==='recheck')).toMatchObject({verdict:'stale',nonce:old});
  f.signal(O,'release');await f.waitFor(O,'','guard-busy');
  const U=f.spawn({name:'U',root,mode:'uninstall',budgetMs:4_000});await f.waitFor(U,'','guard-busy');
  writeFileSync(join(root,'lifecycle.json'),JSON.stringify({status:'running',pid:process.pid,port:7317,boot_id:'boot-new'}));
  const L=f.spawn({name:'L',root,mode:'remove-state',expectState:'boot-old',budgetMs:4_000});await f.waitFor(L,'','guard-busy');
  f.signal(A,'go-recheck');const N=(await f.waitFor(A,'owner'))!;
  expect(await f.waitFor(O,'released')).toBe('false');
  expect(await f.waitFor(L,'done')).toBe('false');
  expect(await U.child.exited).toBe(3);expect(f.read('U','error')).toContain('live owner');
  const observed={owners:[N],lockNonce:f.lockNonce(lock),tombNonces:f.tombNonces()};
  expect(observed.lockNonce).toBe(N);expect(observed.tombNonces).toEqual([old]);assertOwnership(observed);
  expect(JSON.parse(readFileSync(join(root,'lifecycle.json'),'utf8')).boot_id).toBe('boot-new');expect(existsSync(marker)).toBe(true);
  f.signal(A,'release');expect(await f.waitFor(A,'released')).toBe('true');expect(f.snapshot()).toEqual({});
 },T);

 it('3c. aliases of one target (case, slashes, 8.3) meet the same guard',async()=>{
  const f=fixture();const root=join(f.area,'Alias Target');mkdirSync(root);
  const aliases=[root.replaceAll('\\','/')];
  if(process.platform==='win32'){
   aliases.push(root.toUpperCase());
   const short=Bun.spawnSync([join(process.env.SystemRoot!,'System32','WindowsPowerShell','v1.0','powershell.exe'),'-NoProfile','-NonInteractive','-Command','(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:TW_ALIAS).ShortPath'],{env:{...process.env,TW_ALIAS:root},stdout:'pipe',stderr:'pipe'}).stdout.toString().trim();
   if(short&&short.toLowerCase()!==root.toLowerCase())aliases.push(short);else console.warn('8.3 short names are disabled on this volume; short-name alias not exercised');
  }
  const A=f.spawn({name:'A',root,pause:['guard-acquired']});await f.waitFor(A,'at-guard-acquired');
  const guard=(f.events('A')[0]!.paths as {guard:string}).guard;
  const others=aliases.map((alias,i)=>f.spawn({name:`X${i}`,root:alias,budgetMs:3_000}));
  for(const other of others){await f.waitFor(other,'','guard-busy');expect((f.events(other.name)[0]!.paths as {guard:string}).guard).toBe(guard);}
  f.signal(A,'go-guard-acquired');const N=(await f.waitFor(A,'owner'))!;
  for(const other of others){expect(await other.child.exited).toBe(3);expect(f.read(other.name,'error')).toContain('live owner');expect(f.events(other.name).filter(e=>e.event==='recheck').every(e=>e.verdict==='live'&&e.nonce===N)).toBe(true);}
  f.signal(A,'release');expect(await f.waitFor(A,'released')).toBe('true');
 },T);

 it('4a. a crash right after creating the guard fails closed; the guard and lock files stay untouched',async()=>{
  const f=fixture();const root=join(f.area,'target');const paths=(await import(LOCK)).lockPaths(root);
  const S=await f.stale(root);
  const K=f.spawn({name:'K',root,pause:['guard-acquired']});await f.waitFor(K,'at-guard-acquired');await f.kill(K);
  const before=f.snapshot();expect(Object.keys(before)).toHaveLength(2);expect(JSON.parse(before[basename(paths.guard)]!).pid).toBe(K.pid);
  const next=f.spawn({name:'next',root,budgetMs:1_500});expect(await next.child.exited).toBe(3);
  const error=f.read('next','error')!;
  for(const part of [paths.target,paths.guard,`pid ${K.pid}`,'never removed automatically','Offline manual recovery'])expect(error).toContain(part);
  expect(f.events('next').some(e=>e.event==='recheck')).toBe(false);
  expect(f.snapshot()).toEqual(before);expect(f.lockNonce(paths.lock)).toBe(S);
 },T);

 it('4b. a crash right after the stale rename fails closed; tombstone and missing lock are not repaired automatically',async()=>{
  const f=fixture();const root=join(f.area,'target');const paths=(await import(LOCK)).lockPaths(root);
  const S=await f.stale(root);
  const K=f.spawn({name:'K',root,pause:['reclaimed']});await f.waitFor(K,'at-reclaimed');await f.kill(K);
  const before=f.snapshot();expect(existsSync(paths.lock)).toBe(false);expect(existsSync(paths.guard)).toBe(true);expect(f.tombNonces()).toEqual([S]);
  const next=f.spawn({name:'next',root,budgetMs:1_500});expect(await next.child.exited).toBe(3);
  expect(f.read('next','error')).toContain('Offline manual recovery');
  expect(f.snapshot()).toEqual(before);
 },T);

 it('4c. a worker killed outside the guard leaves a stale work lock that the next call reclaims normally',async()=>{
  const f=fixture();const root=join(f.area,'target');const paths=(await import(LOCK)).lockPaths(root);
  const K=f.spawn({name:'K',root});const old=(await f.waitFor(K,'owner'))!;await f.waitFor(K,'','guard-released');await f.kill(K);
  expect(existsSync(paths.guard)).toBe(false);expect(f.lockNonce(paths.lock)).toBe(old);
  const next=f.spawn({name:'next',root,budgetMs:5_000});const N=(await f.waitFor(next,'owner'))!;
  expect(f.events('next').find(e=>e.event==='pre')?.nonce).toBe(old);expect(f.events('next').find(e=>e.event==='reclaimed')?.nonce).toBe(old);
  expect(f.lockNonce(paths.lock)).toBe(N);expect(f.tombNonces()).toEqual([old]);
  f.signal(next,'release');expect(await f.waitFor(next,'released')).toBe('true');expect(f.snapshot()).toEqual({});
 },T);
});
