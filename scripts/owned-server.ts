import {acquireLock,BUDGET_MS,matchOwner,observeFile,type LockOptions} from './lifecycle-lock.ts';import {parseLifecycleRecord,removeState,replaceState,stateFile,type LifecycleRecord} from './lifecycle-state.ts';
import {buildChildEnv,envValue} from './lifecycle-env.ts';import {processIdentity,type ProcessIdentity} from './process-identity.ts';import {DEFAULT_PORT} from './install-lifecycle.ts';
import {bridgeProbe,requestOwnedStop} from './lifecycle-launch.ts';
import {existsSync,readFileSync} from 'node:fs';import {join,resolve} from 'node:path';import {randomBytes,randomUUID} from 'node:crypto';
const root=resolve(import.meta.dir,'..'),marker=join(root,'.termweave-owned.json');
if(!existsSync(marker))throw new Error('Owned installation required');
const metadata=JSON.parse(readFileSync(marker,'utf8'));if(metadata.product!=='termweave'||metadata.root!==root||!metadata.inventory)throw new Error('Invalid owned marker');
/** Launcher diagnostics go to stderr, which the background launch (lifecycle-launch.ts) and install.sh point at server.log. */
const say=(message:string)=>console.error(`[owned-server ${new Date().toISOString()}] ${message}`);
const brief=(identity:ProcessIdentity)=>({pid:identity.pid,state:identity.state,startedAt:identity.startedAt,exe:identity.exe});
if(process.argv[2]==='start'){
 const options:LockOptions={identity:processIdentity};
 // The owned path never leaves the port to the server's own fallback (shared/protocol.ts 7327): it binds and records this one.
 const rawPort=envValue(process.env,'PORT')||String(DEFAULT_PORT);
 if(!/^\d+$/.test(rawPort)||Number(rawPort)<1||Number(rawPort)>65535)throw new Error(`Invalid port: ${rawPort}`);
 const port=Number(rawPort),bootId=envValue(process.env,'HERDR_WEB_BOOT_ID')||randomUUID();
 const deadline=Date.now()+BUDGET_MS.start;
 // The work lock covers only the starting transition; the running server is represented by lifecycle.json alone.
 const lock=acquireLock(root,'start',options);
 // Per-launch stop token: kept in this local, in lifecycle.json (inside the owned root) and in the server's spawn env only. It is
 // never put in this process's env, a later spawn's env, argv, a URL or a log line.
 const stopToken=randomBytes(32).toString('base64url');
 let child:ReturnType<typeof Bun.spawn>|undefined,record:(LifecycleRecord&Record<string,unknown>)|undefined,published=false,stopRequested=false,running=false;
 /**
 * SIGINT/SIGTERM to this launcher: before the server runs, the start aborts (below); once it runs, the server gets the same
 * graceful HTTP stop the CLI sends. Windows never relies on child.kill('SIGTERM'); POSIX falls back to it only when the stop
 * request is not accepted within the stop budget.
 */
 const forward=async()=>{
  if(stopRequested)return;stopRequested=true;
  if(!running||!child||!record)return;
  if(!replaceState(root,{...record,status:'stopping'},{state:bootId},'stop',options))say('lifecycle.json no longer carried this boot id; stopping anyway');
  const until=Date.now()+BUDGET_MS.stop;
  while(child.exitCode===null&&Date.now()<until){
   const answer=await requestOwnedStop(port,stopToken);
   if(answer.kind==='accepted'){say(`stop requested for server pid ${child.pid}`);return;}
   say(`stop request for server pid ${child.pid} not accepted (${answer.kind==='refused'?`HTTP ${answer.status}`:answer.detail}); retrying`);
   await Bun.sleep(500);
  }
  if(child.exitCode!==null)return;
  if(process.platform!=='win32'){say(`stop request not accepted within ${BUDGET_MS.stop} ms; sending SIGTERM to server pid ${child.pid}`);try{child.kill('SIGTERM');}catch{}}
  else say(`stop request not accepted within ${BUDGET_MS.stop} ms; server pid ${child.pid} left running (see INSTALL.md, stopping)`);
 };
 const onSignal=()=>{void forward();};process.on('SIGTERM',onSignal);process.on('SIGINT',onSignal);
 try{
  // Under the start lock: a state whose owner is gone or is another process on a reused PID is reclaimed; anything else refuses.
  const current=observeFile(stateFile(root),parseLifecycleRecord);
  if(current.kind==='record'){
   const owner=processIdentity(current.record.pid),verdict=matchOwner(current.record,owner);
   if(verdict!=='gone'&&verdict!=='mismatch')throw new Error(`Active or uncertain process state: ${current.record.status} pid ${current.record.pid} (${verdict==='match'?'owner alive':`owner identity ${owner.state}`})`);
   if(!removeState(root,{lock:lock.nonce,state:current.record.boot_id},'start',options))throw new Error('lifecycle.json changed while reclaiming stale state');
   say(`reclaimed stale lifecycle.json of pid ${current.record.pid} (${verdict})`);
  }else if(current.kind!=='absent')throw new Error(`Active or uncertain process state: lifecycle.json ${current.kind==='partial'?'is not a lifecycle record':`unreadable (${current.code})`}`);
  // The server runs on this Bun (process.execPath, no PATH lookup) with the denylist-filtered env, loopback HOST, this launch's PORT and boot id.
  child=Bun.spawn([process.execPath,join(root,'server/index.ts')],{cwd:root,env:buildChildEnv(process.env,{PORT:String(port),HOST:'127.0.0.1',TERMWEAVE_OWNED_LAUNCH:'1',HERDR_WEB_BOOT_ID:bootId,TERMWEAVE_STOP_TOKEN:stopToken}),stdout:'inherit',stderr:'inherit',stdin:'ignore',windowsHide:true});
  const server=processIdentity(child.pid);
  if(server.state==='gone')throw new Error(`Server exited (code ${await child.exited}) before it answered on port ${port}`);
  if(server.state!=='alive')throw new Error(`Server process identity unavailable (${server.state}${server.detail?`: ${server.detail}`:''})`);
  // `launcher` stays a bare number: install.sh reads it with sed.
  record={status:'starting',pid:child.pid,startedAt:server.startedAt,exe:server.exe,port,boot_id:bootId,
   launcher:process.pid,launcher_identity:brief(processIdentity(process.pid)),parent:brief(processIdentity(process.ppid)),stop_token:stopToken};
  if(!replaceState(root,record,{lock:lock.nonce,state:null},'start',options))throw new Error('lifecycle.json changed under the start lock');
  published=true;say(`starting server pid ${child.pid} on 127.0.0.1:${port} (boot ${bootId})`);
  // Ready means the bridge probe on this port names this boot, whatever herdr's state; another boot is a foreign server, never ready.
  for(;;){
   if(stopRequested)throw new Error(`Start interrupted by a stop signal before the server answered on port ${port}`);
   if(child.exitCode!==null||child.signalCode!==null)throw new Error(`Server exited (code ${child.exitCode??child.signalCode}) before it answered on port ${port}`);
   if(Date.now()>=deadline)throw new Error(`Server did not answer on port ${port} within ${BUDGET_MS.start} ms`);
   const probe=await bridgeProbe(port,1_000);
   if(probe.kind==='boot'&&probe.boot_id===bootId&&child.exitCode===null)break;
   await Bun.sleep(100);
  }
  record={...record,status:'running'};
  if(!replaceState(root,record,{lock:lock.nonce,state:bootId},'start',options))throw new Error('lifecycle.json changed before running');
  running=true;say(`running server pid ${child.pid} on 127.0.0.1:${port}`);
 }catch(error){
  // Abort path only: the child never became the running instance, so it is ended here and its own state is withdrawn.
  if(child&&child.exitCode===null){try{child.kill();}catch{}await child.exited;}
  if(published&&!removeState(root,{lock:lock.nonce,state:bootId},'start',options))say('lifecycle.json no longer carried this boot id; left unchanged');
  lock.release();throw error;
 }
 if(!lock.release())say('start work lock was no longer ours at release');
 // A signal that arrived between the readiness check and `running` is served now.
 if(stopRequested){stopRequested=false;void forward();}
 const code=await child.exited;
 // Exit cleanup removes only this boot's state (and with it the stop token), under the guard, without retaking a work lock.
 if(!removeState(root,{state:bootId},'stop',options))say('lifecycle.json no longer carried this boot id at exit; left unchanged');
 say(`server pid ${child.pid} exited with ${code}`);process.exit(code);
}else throw new Error('Run foreground owned-server start; stop it with bun scripts/install-lifecycle.ts stop (or Ctrl+C here) and wait for exit');
