import {join} from 'node:path';
import {GRACE_MS,discardFile,judgeLock,matchOwner,observeFile,readLock,withGuard,writeAtomic,type FileObservation,type Identity,type IdentityProbe,type LockOptions,type LockRecord,type Operation} from './lifecycle-lock.ts';
import {processIdentity} from './process-identity.ts';
/**
 * Persistent lifecycle states are exactly four. `installing` is the external work record (the work lock with operation
 * `install`, outside the root, which may not exist yet); `starting`, `running` and `stopping` live in `<root>/lifecycle.json`.
 * Stopped is the absence of lifecycle.json; failures belong to server.log / the install log, never to a state.
 */
export type Status='starting'|'running'|'stopping';
export const STATUSES:readonly Status[]=['starting','running','stopping'];
export type LifecycleRecord={status:Status;pid:number;startedAt?:string;exe?:string;port:number;boot_id:string};
export const stateFile=(root:string)=>join(root,'lifecycle.json');
export function parseLifecycleRecord(value:unknown):LifecycleRecord|undefined{
 const v=value as Partial<LifecycleRecord>|null;
 if(!v||typeof v!=='object'||!STATUSES.includes(v.status as Status)||!Number.isSafeInteger(v.pid)||v.pid!<=0||!Number.isSafeInteger(v.port)||v.port!<1||v.port!>65535||typeof v.boot_id!=='string'||!v.boot_id)return undefined;
 if((v.startedAt!==undefined&&typeof v.startedAt!=='string')||(v.exe!==undefined&&typeof v.exe!=='string'))return undefined;
 return {status:v.status!,pid:v.pid!,startedAt:v.startedAt,exe:v.exe,port:v.port!,boot_id:v.boot_id};
}
/** Bridge-only `/api/health?scope=bridge` result on the recorded port; never the herdr-inclusive full health. */
export type Probe={kind:'boot';boot_id:string}|{kind:'silent'};
export type Observation={
 guard:boolean;lock:FileObservation<LockRecord>;lockOwner?:Identity;
 state:FileObservation<LifecycleRecord>;stateOwner?:Identity;
 /** how long the current partial lock/state file has been observed */
 lockPartialMs?:number;statePartialMs?:number;
 probe?:Probe;budgetExpired?:boolean;
 /** consecutive reads kept disagreeing */
 unstable?:boolean;
};
export type WaitReason='guard'|'installing'|'starting'|'stopping'|'uninstalling';
export type Decision=
 |{action:'stopped'}
 |{action:'wait';reason:WaitReason}
 |{action:'timeout';reason:WaitReason}
 |{action:'reread';target:'lock'|'state'}
 |{action:'reclaim';target:'lock'|'state';reason:'gone'|'mismatch'}
 |{action:'uncertain';reason:string}
 |{action:'probe';port:number}
 |{action:'running';port:number;boot_id:string}
 |{action:'foreign';port:number};
const transition:Record<Operation,WaitReason>={install:'installing',start:'starting',stop:'stopping',uninstall:'uninstalling'};
/**
 * Lifecycle decision table as one pure function. Waits become `timeout` once the budget is spent; nothing here turns a timeout,
 * a grace expiry or a silent probe into a reclaim. `running` is the only verdict that permits a stop request, and it never depends
 * on herdr health.
 */
export function decide(o:Observation):Decision{
 const wait=(reason:WaitReason):Decision=>o.budgetExpired?{action:'timeout',reason}:{action:'wait',reason};
 if(o.unstable)return {action:'uncertain',reason:'lifecycle files kept changing while being read'};
 if(o.guard)return wait('guard');
 const lock=judgeLock(o.lock,o.lockOwner,o.lockPartialMs??0);
 if(lock.verdict==='creating')return {action:'reread',target:'lock'};
 if(lock.verdict==='uncertain')return {action:'uncertain',reason:lock.reason};
 if(lock.verdict==='stale')return {action:'reclaim',target:'lock',reason:lock.reason};
 if(lock.verdict==='live')return wait(transition[lock.record.operation]);
 const state=o.state;
 if(state.kind==='absent')return {action:'stopped'};
 if(state.kind==='unreadable')return {action:'uncertain',reason:`lifecycle.json unreadable (${state.code})`};
 if(state.kind==='partial')return (o.statePartialMs??0)<GRACE_MS?{action:'reread',target:'state'}:{action:'uncertain',reason:`lifecycle.json still uninterpretable after ${GRACE_MS} ms`};
 const record=state.record;
 if(!o.stateOwner)return {action:'uncertain',reason:'owner identity not checked'};
 const owner=matchOwner(record,o.stateOwner);
 if(owner==='uncertain')return {action:'uncertain',reason:`owner identity ${o.stateOwner.state}`};
 if(owner!=='match')return {action:'reclaim',target:'state',reason:owner};
 if(record.status!=='running')return wait(record.status);
 if(!o.probe)return {action:'probe',port:record.port};
 if(o.probe.kind==='silent')return {action:'uncertain',reason:`owner alive but bridge probe on port ${record.port} is silent; not killed or reclaimed`};
 if(o.probe.boot_id!==record.boot_id)return {action:'foreign',port:record.port};
 return {action:'running',port:record.port,boot_id:record.boot_id};
}
export type InspectOptions={identity?:IdentityProbe;now?:()=>number;sleep?:(ms:number)=>void};
/**
 * `--check` read helper: never creates the guard, a lock or the root. Partial files are re-read for up to the grace period;
 * reads that keep disagreeing are reported as unstable (uncertain) after a bounded number of attempts.
 */
export function inspectLifecycle(root:string,{identity=processIdentity,now=Date.now,sleep=Bun.sleepSync}:InspectOptions={}):Observation{
 const read=()=>{const {guard,lock}=readLock(root);return {guard,lock,state:observeFile(stateFile(root),parseLifecycleRecord)};};
 const partialSince:{lock?:{file:string;at:number};state?:{file:string;at:number}}={};
 for(;;){
  let current=read(),unstable=true;
  for(let attempt=0;attempt<3;attempt++){const next=read();if(JSON.stringify(next)===JSON.stringify(current)){unstable=false;break;}current=next;}
  const age=(key:'lock'|'state')=>{const value=current[key];if(value.kind!=='partial'){delete partialSince[key];return undefined;}const seen=partialSince[key];if(seen?.file!==value.file)partialSince[key]={file:value.file,at:now()};return now()-partialSince[key]!.at;};
  const lockPartialMs=age('lock'),statePartialMs=age('state');
  if(!unstable&&((lockPartialMs??GRACE_MS)<GRACE_MS||(statePartialMs??GRACE_MS)<GRACE_MS)){sleep(50);continue;}
  return {...current,unstable,lockPartialMs,statePartialMs,
   lockOwner:current.lock.kind==='record'?identity(current.lock.record.pid):undefined,
   stateOwner:current.state.kind==='record'?identity(current.state.record.pid):undefined};
 }
}
/** `lock`: work-lock nonce the caller must still own. `state`: boot_id currently in lifecycle.json, or null for no state file. */
export type Expectation={lock?:string;state:string|null};
function expected(root:string,expect:Expectation):boolean{
 if(expect.lock!==undefined){const {lock}=readLock(root);if(lock.kind!=='record'||lock.record.nonce!==expect.lock)return false;}
 const state=observeFile(stateFile(root),parseLifecycleRecord);
 return (state.kind==='absent'?null:state.kind==='record'?state.record.boot_id:undefined)===expect.state;
}
/** Under the guard: replace lifecycle.json atomically only while the expectation still holds. Partial/unreadable state never matches. */
export function replaceState(root:string,next:LifecycleRecord,expect:Expectation,operation:Operation,options:LockOptions={}):boolean{
 if(!parseLifecycleRecord(next))throw new Error('Invalid lifecycle record');
 return withGuard(root,operation,()=>{if(!expected(root,expect))return false;writeAtomic(stateFile(root),JSON.stringify(next),options);return true;},options);
}
/** Under the guard: delete lifecycle.json only while it still carries `expect.state` (and the caller still owns `expect.lock`). */
export function removeState(root:string,expect:{lock?:string;state:string},operation:Operation,options:LockOptions={}):boolean{
 return withGuard(root,operation,()=>{if(!expected(root,expect))return false;discardFile(stateFile(root),options);return true;},options);
}
