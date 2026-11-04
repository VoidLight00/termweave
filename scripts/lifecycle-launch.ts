import {spawn} from 'node:child_process';import {closeSync,openSync} from 'node:fs';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
import {buildChildEnv,type Env} from './lifecycle-env.ts';import {BUDGET_MS,observeFile} from './lifecycle-lock.ts';import {parseLifecycleRecord,stateFile,type Probe} from './lifecycle-state.ts';
import {OWNED_STOP_HEADER,OWNED_STOP_PATH} from '../shared/machines.ts';
export type Launched={launcher:number;pid:number;port:number;boot_id:string;log:string};
export type LaunchOptions={port:number;env?:Env;budgetMs?:number};
/**
 * Bridge-only `/api/health?scope=bridge` on loopback: liveness plus the answering launch's boot id, whatever herdr's state. No answer
 * (refused, timed out, not an ok JSON answer) is `silent`; an ok answer naming no boot id carries `''`, which matches no recorded boot.
 * Ownership, locks and stop decide on this alone, never on the herdr-inclusive full `/api/health`.
 */
export async function bridgeProbe(port:number,timeoutMs=2_000):Promise<Probe>{
 try{
  const response=await fetch(`http://127.0.0.1:${port}/api/health?scope=bridge`,{signal:AbortSignal.timeout(timeoutMs)});if(!response.ok)return {kind:'silent'};
  const body=await response.json() as {ok?:unknown;boot_id?:unknown};
  return body?.ok===true?{kind:'boot',boot_id:typeof body.boot_id==='string'?body.boot_id:''}:{kind:'silent'};
 }catch{return {kind:'silent'};}
}
export type StopAnswer={kind:'accepted'}|{kind:'refused';status:number;code?:string}|{kind:'silent';detail:string};
/** The owned stop request to the loopback server; the token travels in a header only, never in the URL, argv or a log line. */
export async function requestOwnedStop(port:number,token:string,timeoutMs=3_000):Promise<StopAnswer>{
 try{
  const response=await fetch(`http://127.0.0.1:${port}${OWNED_STOP_PATH}`,{method:'POST',headers:{[OWNED_STOP_HEADER]:token},signal:AbortSignal.timeout(timeoutMs)});
  if(response.status===202)return {kind:'accepted'};
  let code:string|undefined;try{code=String(((await response.json()) as {error?:{code?:unknown}}).error?.code??'')||undefined;}catch{}
  return {kind:'refused',status:response.status,code};
 }catch(error){return {kind:'silent',detail:error instanceof Error?error.name:String(error)};}
}
/**
 * Starts `<root>/scripts/owned-server.ts start` in the background so it outlives this process and its console: detached, hidden,
 * stdin ignored, stdout and stderr on one append descriptor of `<root>/server.log`, unref'd. The port is always explicit and the
 * launch gets a fresh HERDR_WEB_BOOT_ID. Resolves only once lifecycle.json records this boot as running and the server answers;
 * a launcher exit or the start budget running out rejects with the server.log path. Nothing is killed on failure.
 */
export async function launchOwned(root:string,{port,env=process.env,budgetMs=BUDGET_MS.start}:LaunchOptions):Promise<Launched>{
 if(!Number.isSafeInteger(port)||port<1||port>65535)throw new Error(`Invalid port: ${port}`);
 const bootId=randomUUID(),log=join(root,'server.log');
 const fd=openSync(log,'a',0o600);let child;
 try{child=spawn(process.execPath,[join(root,'scripts','owned-server.ts'),'start'],{cwd:root,detached:true,windowsHide:true,stdio:['ignore',fd,fd],env:buildChildEnv(env,{PORT:String(port),HOST:'127.0.0.1',HERDR_WEB_BOOT_ID:bootId})});}
 finally{closeSync(fd);}
 let exited:string|undefined;
 child.once('exit',(code,signal)=>{exited=signal?`signal ${signal}`:`code ${code}`;});child.once('error',error=>{exited=`spawn failed: ${error.message}`;});
 child.unref();
 const deadline=Date.now()+budgetMs;
 while(Date.now()<deadline){
  const state=observeFile(stateFile(root),parseLifecycleRecord);
  if(state.kind==='record'&&state.record.boot_id===bootId&&state.record.status==='running'){
   // Ready means this boot answers the bridge probe; herdr being down does not make it unready.
   const probe=await bridgeProbe(port);
   if(probe.kind==='boot'&&probe.boot_id===bootId)return {launcher:child.pid!,pid:state.record.pid,port,boot_id:bootId,log};
  }
  if(exited!==undefined)throw new Error(`Owned server launcher exited (${exited}) before it was ready on port ${port}; see ${log}`);
  await Bun.sleep(100);
 }
 throw new Error(`Owned server did not become ready on port ${port} within ${budgetMs} ms (launcher pid ${child.pid??'unknown'}); see ${log}`);
}
