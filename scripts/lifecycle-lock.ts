import {closeSync,openSync,readdirSync,readFileSync,renameSync,rmSync,statSync,unlinkSync,writeFileSync,writeSync} from 'node:fs';import {basename,dirname,join} from 'node:path';import {createHash,randomUUID} from 'node:crypto';
import {canonicalIdentity} from './lifecycle-path.ts';import {processIdentity} from './process-identity.ts';
/**
 * Per-target lifecycle work lock serialized by one shared `wx` guard (C-6). Both files are siblings of the install root (never
 * inside it, so the root is not created for the lock), named from a digest of the canonical target key so every alias of the
 * target (drive/letter case, 8.3 names, slash style) meets the same files. Exclusion comes only from the guard's exclusive create.
 * Every work-lock acquire, stale reclaim and release happens while holding the guard; the guard itself is never reclaimed
 * automatically: a guard left by a crashed owner fails closed until the documented offline manual recovery.
 * No raw work-lock mutation is exported: callers get `acquireLock` (whose handle releases by nonce) and `withGuard` for state files.
 */
export type Operation='install'|'start'|'stop'|'uninstall';
export const OPERATIONS:readonly Operation[]=['install','start','stop','uninstall'];
/** Default waiting budgets, guard wait included. Uninstall uses the stop budget. A timeout fails explicitly and never makes a live owner stale. */
export const BUDGET_MS:Record<Operation,number>={install:15*60_000,start:40_000,stop:10_000,uninstall:10_000};
/** Empty or partial metadata is treated as still being written for this long; expiry is not evidence of staleness. */
export const GRACE_MS=2_000;
const POLL_MS=20;
export type Identity={state:'alive'|'gone'|'denied'|'error';startedAt?:string;exe?:string};
export type IdentityProbe=(pid:number)=>Identity;
export type OwnerRecord={pid:number;startedAt?:string;exe?:string};
/** Lock and guard metadata. No secrets: process identity, owned command path, operation and a random nonce. */
export type LockRecord=OwnerRecord&{command:string;operation:Operation;nonce:string};
export type LockPaths={target:string;dir:string;lock:string;guard:string};
export type FileObservation<T>={kind:'absent'}|{kind:'record';record:T;file:string}|{kind:'partial';file:string}|{kind:'unreadable';code:string};
/** Observer for diagnostics and test barriers; it can delay but not change any decision. */
export type Trace=(event:string,detail?:Record<string,unknown>)=>void;
export type LockOptions={budgetMs?:number;now?:()=>number;sleep?:(ms:number)=>void;identity?:IdentityProbe;command?:string;trace?:Trace};
export type LockHandle={readonly nonce:string;readonly operation:Operation;readonly paths:LockPaths;
 /** Under the guard, removes the work lock only while it still carries this nonce. False when another owner has replaced it. */
 release():boolean};
type Resolved=Required<LockOptions>;
const errorCode=(error:unknown)=>String((error as {code?:unknown})?.code??'unknown');
const SELF_STARTED=new Date(Math.round(performance.timeOrigin)).toISOString();
/**
 * Test-only signal probe, injected as a fake or a negative control; never a production default. `process.kill(pid,0)` only (ESRCH
 * gone, EPERM denied, success alive): a foreign live PID carries no start time or exe, so it cannot see PID reuse. Its own record
 * uses another start-time spelling than processIdentity, so the two must never judge each other's records.
 */
export function signalIdentity(pid:number):Identity{
 if(pid===process.pid)return {state:'alive',startedAt:SELF_STARTED,exe:process.execPath};
 try{process.kill(pid,0);return {state:'alive'};}
 catch(error){const code=errorCode(error);return {state:code==='ESRCH'?'gone':code==='EPERM'?'denied':'error'};}
}
/** gone/mismatch are the only stale proofs; denied/error are uncertain. A field is compared only when both sides know it. */
export function matchOwner(record:OwnerRecord,identity:Identity):'match'|'mismatch'|'gone'|'uncertain'{
 if(identity.state==='gone')return 'gone';
 if(identity.state!=='alive')return 'uncertain';
 const differs=(a?:string,b?:string)=>a!==undefined&&b!==undefined&&a!==b;
 return differs(record.startedAt,identity.startedAt)||differs(record.exe,identity.exe)?'mismatch':'match';
}
const optionalString=(value:unknown)=>value===undefined||typeof value==='string';
export function parseLockRecord(value:unknown):LockRecord|undefined{
 const v=value as Partial<LockRecord>|null;
 if(!v||typeof v!=='object'||!Number.isSafeInteger(v.pid)||v.pid!<=0||typeof v.nonce!=='string'||!v.nonce||typeof v.command!=='string'||!OPERATIONS.includes(v.operation as Operation)||!optionalString(v.startedAt)||!optionalString(v.exe))return undefined;
 return {pid:v.pid!,startedAt:v.startedAt,exe:v.exe,command:v.command,operation:v.operation!,nonce:v.nonce};
}
/** Read-only observation of one JSON record file. Empty, truncated or invalid content is `partial`; a read that races a replace is re-read. */
export function observeFile<T>(path:string,parse:(value:unknown)=>T|undefined):FileObservation<T>{
 for(let attempt=0;;attempt++){
  let before,text,after;
  try{before=statSync(path,{bigint:true});text=readFileSync(path,'utf8');after=statSync(path,{bigint:true});}
  catch(error){const code=errorCode(error);if(code==='ENOENT')return {kind:'absent'};return {kind:'unreadable',code};}
  const file=`${after.dev}:${after.ino}`;
  if(`${before.dev}:${before.ino}`!==file||before.size!==after.size){if(attempt<3)continue;return {kind:'partial',file};}
  let value:unknown;try{value=JSON.parse(text);}catch{return {kind:'partial',file};}
  const record=parse(value);return record?{kind:'record',record,file}:{kind:'partial',file};
 }
}
/** Guard and work-lock paths for a possibly missing install root. Case-insensitive platforms fold the digest input so a missing root spelled in another case meets the same files. */
export function lockPaths(root:string):LockPaths{
 const target=canonicalIdentity(root);const dir=dirname(target);
 if(dir===target)throw new Error(`No lifecycle lock for filesystem root ${target}`);
 const fold=process.platform==='win32'||process.platform==='darwin';
 const base=join(dir,`.termweave-${createHash('sha256').update(fold?target.toLowerCase():target).digest('hex').slice(0,16)}`);
 return {target,dir,lock:`${base}.lock`,guard:`${base}.guard`};
}
export type LockVerdict={verdict:'free'}|{verdict:'live';record:LockRecord}|{verdict:'stale';record:LockRecord;reason:'gone'|'mismatch'}|{verdict:'creating'}|{verdict:'uncertain';reason:string;record?:LockRecord};
/** Pure work-lock judgment from a fresh observation, the owner's identity and how long the current partial file has been seen. */
export function judgeLock(observation:FileObservation<LockRecord>,owner:Identity|undefined,partialMs:number):LockVerdict{
 if(observation.kind==='absent')return {verdict:'free'};
 if(observation.kind==='unreadable')return {verdict:'uncertain',reason:`work lock unreadable (${observation.code})`};
 if(observation.kind==='partial')return partialMs<GRACE_MS?{verdict:'creating'}:{verdict:'uncertain',reason:`work lock metadata still uninterpretable after ${GRACE_MS} ms`};
 const record=observation.record;if(!owner)return {verdict:'uncertain',reason:'owner identity not checked',record};
 const match=matchOwner(record,owner);
 if(match==='match')return {verdict:'live',record};
 if(match==='uncertain')return {verdict:'uncertain',reason:`owner identity ${owner.state}`,record};
 return {verdict:'stale',record,reason:match};
}
const resolveOptions=(operation:Operation,options:LockOptions):Resolved=>({budgetMs:options.budgetMs??BUDGET_MS[operation],now:options.now??Date.now,sleep:options.sleep??Bun.sleepSync,identity:options.identity??processIdentity,command:options.command??process.argv[1]??process.execPath,trace:options.trace??(()=>{})});
const describe=(record:LockRecord)=>`pid ${record.pid}, started ${record.startedAt??'unknown'}, exe ${record.exe??'unknown'}, command ${record.command}, operation ${record.operation}`;
function selfRecord(operation:Operation,o:Resolved):LockRecord{
 const self=o.identity(process.pid);if(self.state!=='alive')throw new Error(`Own process identity unavailable (${self.state})`);
 return {pid:process.pid,startedAt:self.startedAt,exe:self.exe??process.execPath,command:o.command,operation,nonce:randomUUID()};
}
/** Windows refuses to replace a file another process has open for a moment; retry those sharing errors within the deadline. */
function replaceFile(from:string,to:string,o:Resolved,deadline:number){
 for(;;){try{renameSync(from,to);return;}catch(error){if(!['EPERM','EACCES','EBUSY'].includes(errorCode(error))||o.now()>=deadline)throw error;o.sleep(POLL_MS);}}
}
/**
 * Frees the name at once by renaming to a unique sibling, then deletes it. On Windows a deleted file that another process (a
 * reader, an antivirus scan) still has open keeps its name reserved as "delete pending", which would make the next exclusive
 * create fail with EPERM and the next read look unreadable.
 */
function discard(path:string,o:Resolved){const gone=`${path}.${randomUUID()}.gone`;replaceFile(path,gone,o,o.now()+o.budgetMs);unlinkSync(gone);}
/** For lifecycle state files inside `withGuard`; the work lock itself is only ever removed by its handle's release. */
export function discardFile(path:string,options:LockOptions={}){discard(path,resolveOptions('stop',options));}
/** Temp file in the same directory plus atomic replace; readers see the old or the complete new content, never a partial write. */
export function writeAtomic(path:string,content:string,options:LockOptions={}){
 const o=resolveOptions('stop',options);const temp=`${path}.${randomUUID()}.tmp`;
 try{writeFileSync(temp,content,{flag:'wx',mode:0o600});replaceFile(temp,path,o,o.now()+o.budgetMs);}
 catch(error){rmSync(temp,{force:true});throw error;}
}
function guardBusy(paths:LockPaths,operation:Operation,o:Resolved):Error{
 const owner=observeFile(paths.guard,parseLockRecord);
 const known=owner.kind==='record'?describe(owner.record):owner.kind==='absent'?'released just now':'unknown (empty or unreadable record)';
 return new Error(`Lifecycle ${operation} for ${paths.target} gave up after ${o.budgetMs} ms: lifecycle guard ${paths.guard} is held (owner: ${known}). `
  +'The guard is never removed automatically. Offline manual recovery: stop every TermWeave lifecycle command, waiter and launcher for this target, '
  +`make sure no new one can start, and only then delete ${paths.guard}. Leave the work lock ${paths.lock} and lifecycle.json in place; the next normal call re-judges them. `
  +'If you cannot confirm that nothing runs for this target, do not delete the guard.');
}
/** Error for a guard still busy at the deadline; a waiter that already saw a live owner reports that owner instead. */
type Timeout=()=>Error;
/** The only mutual exclusion: exclusive create of the guard file. EEXIST waits within the deadline, never reclaims. */
function enterGuard(paths:LockPaths,operation:Operation,deadline:number,o:Resolved,timeout?:Timeout):()=>void{
 const record=JSON.stringify(selfRecord(operation,o));
 for(;;){
  let fd:number;
  try{fd=openSync(paths.guard,'wx',0o600);}
  catch(error){
   const code=errorCode(error);
   if(code==='ENOENT')throw new Error(`Lifecycle guard for ${paths.target} needs the existing parent directory ${paths.dir}`);
   if(code!=='EEXIST')throw error;
   o.trace('guard-busy');if(o.now()>=deadline)throw timeout?timeout():guardBusy(paths,operation,o);o.sleep(POLL_MS);continue;
  }
  try{writeSync(fd,record);}catch(error){closeSync(fd);discard(paths.guard,o);throw error;}
  closeSync(fd);o.trace('guard-acquired');
  return ()=>{discard(paths.guard,o);o.trace('guard-released');};
 }
}
/** Runs `fn` inside the guard and always leaves it; a failure to remove the guard is reported, never hidden. */
function guarded<T>(paths:LockPaths,operation:Operation,deadline:number,o:Resolved,fn:()=>T,timeout?:Timeout):T{
 const leave=enterGuard(paths,operation,deadline,o,timeout);let result:T;
 try{result=fn();}
 catch(error){try{leave();}catch(leaveError){throw new AggregateError([error,leaveError],`Lifecycle guard ${paths.guard} could not be removed after a failure`);}throw error;}
 leave();return result;
}
/** Short guarded critical section for lifecycle state files (expected nonce/boot_id checks). Never wait on other processes inside it. */
export function withGuard<T>(root:string,operation:Operation,fn:()=>T,options:LockOptions={}):T{
 const o=resolveOptions(operation,options);return guarded(lockPaths(root),operation,o.now()+o.budgetMs,o,fn);
}
/** Read-only view for `--check`: no guard, lock or root is created. A guard that cannot be checked counts as present (fail closed). */
export function readLock(root:string):{paths:LockPaths;guard:boolean;lock:FileObservation<LockRecord>}{
 const paths=lockPaths(root);let guard:boolean;
 try{guard=statSync(paths.guard,{throwIfNoEntry:false})!==undefined;}catch{guard=true;}
 return {paths,guard,lock:observeFile(paths.lock,parseLockRecord)};
}
/** Claim with exclusive create, then replace the empty claim with complete metadata. Runs under the guard. */
function publish(paths:LockPaths,operation:Operation,deadline:number,o:Resolved):LockHandle{
 const record=selfRecord(operation,o);const temp=`${paths.lock}.${record.nonce}.tmp`;
 closeSync(openSync(paths.lock,'wx',0o600));
 try{writeFileSync(temp,JSON.stringify(record),{flag:'wx',mode:0o600});replaceFile(temp,paths.lock,o,deadline);}
 catch(error){rmSync(temp,{force:true});rmSync(paths.lock,{force:true});throw error;}
 o.trace('published',{nonce:record.nonce});
 let held=true;
 return {nonce:record.nonce,operation,paths,release(){
  if(!held)return false;
  const released=guarded(paths,operation,o.now()+o.budgetMs,o,()=>{
   const current=observeFile(paths.lock,parseLockRecord);
   if(current.kind!=='record'||current.record.nonce!==record.nonce){o.trace('release-refused');return false;}
   discard(paths.lock,o);
   // Tombstones and abandoned temp files are diagnostics of earlier transitions; nobody else can be publishing while we hold the guard.
   const prefix=basename(paths.lock)+'.';
   for(const name of readdirSync(paths.dir))if(name.startsWith(prefix)&&(name.includes('.tomb-')||name.endsWith('.tmp')))rmSync(join(paths.dir,name),{force:true});
   o.trace('released');return true;
  });
  held=false;return released;
 }};
}
/**
 * Guard → fresh read → free: publish; stale (owner gone or identity mismatch): rename to a unique tombstone and publish, all
 * before leaving the guard. Live or still-being-written owners are waited for outside the guard; uncertain owners fail closed.
 */
export function acquireLock(root:string,operation:Operation,options:LockOptions={}):LockHandle{
 const o=resolveOptions(operation,options);const paths=lockPaths(root);const deadline=o.now()+o.budgetMs;
 let partial:{file:string;since:number}|undefined,waited:LockVerdict|undefined;
 const expired=(verdict:LockVerdict)=>new Error(`Lifecycle ${operation} for ${paths.target} timed out after ${o.budgetMs} ms: work lock ${paths.lock} ${verdict.verdict==='live'?`is held by a live owner (${describe(verdict.record)})`:'metadata is still being written'}. A live owner is never reclaimed.`);
 for(;;){
  // The owner's identity is an OS query (a `ps` spawn on macOS, whatever probe the caller injects): asked before the guard, so a waiter
  // never holds the guard through it and starves the owner's own guarded steps; inside, it counts only for the record it was asked for.
  // Safe out of the guard: the nonce is re-checked under the guard, and for a fixed owner gone/mismatch never revert to match, so a
  // stale answer can only make a waiter wait longer or refuse, never reclaim a live owner.
  const seen=observeFile(paths.lock,parseLockRecord);
  const asked=seen.kind==='record'?{nonce:seen.record.nonce,identity:o.identity(seen.record.pid)}:undefined;
  const outcome=guarded(paths,operation,deadline,o,():{handle:LockHandle}|{verdict:LockVerdict}|{changed:true}=>{
   const observation=observeFile(paths.lock,parseLockRecord);
   if(observation.kind==='record'&&observation.record.nonce!==asked?.nonce)return {changed:true};
   if(observation.kind==='partial'){if(partial?.file!==observation.file)partial={file:observation.file,since:o.now()};}else partial=undefined;
   const verdict=judgeLock(observation,asked?.identity,partial?o.now()-partial.since:0);
   o.trace('recheck',{verdict:verdict.verdict,nonce:observation.kind==='record'?observation.record.nonce:undefined});
   if(verdict.verdict==='free')return {handle:publish(paths,operation,deadline,o)};
   if(verdict.verdict!=='stale')return {verdict};
   const tomb=`${paths.lock}.tomb-${randomUUID()}`;replaceFile(paths.lock,tomb,o,deadline);
   o.trace('reclaimed',{tomb,nonce:verdict.record.nonce});
   return {handle:publish(paths,operation,deadline,o)};
  },waited&&(()=>expired(waited!)));
  if('handle' in outcome)return outcome.handle;
  // another record since the identity was asked: ask again for that owner, within the same deadline
  if('changed' in outcome){if(o.now()>=deadline)throw waited?expired(waited):new Error(`Lifecycle ${operation} for ${paths.target} timed out after ${o.budgetMs} ms: work lock ${paths.lock} kept changing owner`);continue;}
  const verdict=outcome.verdict;waited=verdict;
  if(verdict.verdict==='uncertain')throw new Error(`Lifecycle ${operation} for ${paths.target} refused: work lock ${paths.lock} owner is uncertain (${verdict.reason}${verdict.record?`; ${describe(verdict.record)}`:''}). It is not reclaimed; check that owner, then retry.`);
  if(o.now()>=deadline)throw expired(verdict);
  o.sleep(POLL_MS);
 }
}
