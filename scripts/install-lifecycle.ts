import {lstatSync,mkdirSync,statSync} from 'node:fs';import {dirname,join,posix,resolve,win32} from 'node:path';
import {judgeDestination} from './lifecycle-path.ts';import {installOwned} from './owned-install.ts';
import {MIN_BUN,MIN_HERDR,envValue,findExecutable,toolVersion,versionGe,type Env} from './lifecycle-env.ts';
import {BUDGET_MS,acquireLock,matchOwner,observeFile,parseLockRecord,readLock,type FileObservation,type LockHandle,type OwnerRecord} from './lifecycle-lock.ts';
import {decide,inspectLifecycle,parseLifecycleRecord,removeState,replaceState,stateFile,type Decision,type LifecycleRecord,type Observation,type Probe} from './lifecycle-state.ts';
import {processIdentity,type ProcessIdentity} from './process-identity.ts';import {bridgeProbe,launchOwned,requestOwnedStop,type StopAnswer} from './lifecycle-launch.ts';
/**
 * Shared lifecycle entry point behind install.ps1 (Windows) and install.sh semantics:
 *   bun scripts/install-lifecycle.ts <check|install|start|stop> [--dir PATH] [--port N] [--no-start] [--yes]
 * Exit codes: 0 ok, 2 missing prerequisite, 1 any other failure. --no-start and --yes belong to the front end (it starts the
 * server and runs official installers); they are accepted here and ignored. Tokens are never printed.
 */
export const DEFAULT_PORT=7317;
const MIN_NODE=18;
export const COMMANDS=['check','install','start','stop'] as const;
export type Command=typeof COMMANDS[number];
export type Options={command:Command;dir:string;port:number;start:boolean;yes:boolean};
export class UsageError extends Error{}
export type Context={
 env:Env;platform:NodeJS.Platform;cwd:string;
 out:(line:string)=>void;err:(line:string)=>void;
 /** `<exe> --version` as a bare version string (lifecycle-env toolVersion). */
 version:(executable:string,env:Env)=>string|undefined;
 /** The full, herdr-inclusive `/api/health` on the loopback port answered `"ok":true`. Only check's exit 0 and the start report use it. */
 healthy:(port:number)=>Promise<boolean>;
 /** source checkout installed from */
 source:string;
};
export const USAGE=`Usage: bun scripts/install-lifecycle.ts <check|install|start|stop> [--dir PATH] [--port N] [--no-start] [--yes]
  check       verify prerequisites, install and health; change nothing
  install     install and build into --dir (an existing install is reused)
  start       start the installed server in the background and wait until it answers
  stop        stop the installed server gracefully (port: the recorded one; --port must match it)
  --dir PATH  install directory (default: $TERMWEAVE_INSTALL_DIR, else %LOCALAPPDATA%\\termweave-owned on Windows, ~/.local/share/termweave-owned elsewhere)
  --port N    local port (default: $PORT, else ${DEFAULT_PORT})`;
/** Environment values set but empty count as unset, like the shell's `\${VAR:-default}`. */
const setting=(env:Env,name:string,platform:NodeJS.Platform)=>envValue(env,name,platform)||undefined;
/** Option precedence: CLI, then TERMWEAVE_INSTALL_DIR / PORT, then the platform default. Returns undefined for --help. */
export function parseArgs(argv:string[],{env,platform,cwd}:Pick<Context,'env'|'platform'|'cwd'>):Options|undefined{
 let command:Command|undefined,dir:string|undefined,port:string|undefined,start=true,yes=false;
 for(let i=0;i<argv.length;i++){
  const arg=argv[i]!;
  if(arg==='--dir'||arg==='--port'){const value=argv[++i];if(!value)throw new UsageError(`${arg} needs a value`);if(arg==='--dir')dir=value;else port=value;}
  else if(arg==='--no-start')start=false;
  else if(arg==='--yes')yes=true;
  else if(arg==='-h'||arg==='--help')return undefined;
  else if(command===undefined&&(COMMANDS as readonly string[]).includes(arg))command=arg as Command;
  else throw new UsageError(`Unknown argument: ${arg}`);
 }
 if(!command)throw new UsageError('A command is required');
 const win=platform==='win32';const path=win?win32:posix;
 dir??=setting(env,'TERMWEAVE_INSTALL_DIR',platform);
 if(dir===undefined){
  const base=setting(env,win?'LOCALAPPDATA':'HOME',platform);
  if(!base||!path.isAbsolute(base))throw new UsageError(`${win?'LOCALAPPDATA':'HOME'} must be an absolute path to choose the default --dir`);
  dir=win?path.join(base,'termweave-owned'):path.join(base,'.local','share','termweave-owned');
 }
 port??=setting(env,'PORT',platform)??String(DEFAULT_PORT);
 if(!/^\d+$/.test(port)||Number(port)<1||Number(port)>65535)throw new UsageError(`Invalid port: ${port}`);
 return {command,dir:path.resolve(cwd,dir),port:Number(port),start,yes};
}
const installed=(dir:string)=>!!statSync(join(dir,'.termweave-owned.json'),{throwIfNoEntry:false})?.isFile();
/** install.sh check_prereqs: git, bun >= MIN_BUN and herdr >= MIN_HERDR everywhere; Node >= 18 only off Windows (terminal sidecar). */
export function prerequisites({env,platform,out,err,version}:Context):boolean{
 const win=platform==='win32';let complete=true;
 const miss=(line:string)=>{err(`MISS  ${line}`);complete=false;};
 const git=findExecutable('git',{env,platform});
 if(git)out(`ok    git ${version(git,env)??''}`.trimEnd());
 else miss(`git not found. Fix: ${win?'winget install --id Git.Git -e':"macOS 'xcode-select --install', Debian/Ubuntu 'sudo apt install git'"}`);
 const tool=(name:string,minimum:string,fix:string,upgrade:string)=>{
  const executable=findExecutable(name,{env,platform});
  if(!executable)return miss(`${name} not found. Fix: ${fix}`);
  const found=version(executable,env);
  if(found&&versionGe(found,minimum))out(`ok    ${name} ${found}`);else miss(`${name} ${found??'unknown'} is older than ${minimum}. Fix: ${upgrade}`);
 };
 tool('bun',MIN_BUN,win?'powershell -c "irm bun.sh/install.ps1 | iex"   (or rerun with --yes)':'curl -fsSL https://bun.sh/install | bash   (or rerun with --yes)','bun upgrade');
 if(!win)tool('node',String(MIN_NODE),`install Node ${MIN_NODE}+ from https://nodejs.org, nvm or Homebrew ('brew install node')`,`install Node ${MIN_NODE}+ from https://nodejs.org`);
 tool('herdr',MIN_HERDR,win?'irm https://herdr.dev/install.ps1 | iex   (or rerun with --yes)':'curl -fsSL https://herdr.dev/install.sh | sh   (or rerun with --yes; docs: https://herdr.dev/docs/install/)','herdr update');
 if(!complete)err('Missing prerequisites. Run the Fix commands above, then rerun the installer.');
 return complete;
}
/** Completes a decision that asks for the bridge probe: the probe goes to the recorded port only. */
async function judge(observation:Observation):Promise<{decision:Decision;probe?:Probe}>{
 const decision=decide(observation);if(decision.action!=='probe')return {decision};
 const probe=await bridgeProbe(decision.port);return {decision:decide({...observation,probe}),probe};
}
const waitLabel:Record<string,string>={guard:'a lifecycle guard is held',installing:'an install is in progress',starting:'a start is in progress',stopping:'a stop is in progress',uninstalling:'an uninstall is in progress'};
/** One line for a decision that is not `running`/`stopped`. */
function notRunning(decision:Decision):string{
 switch(decision.action){
  case 'wait':case 'timeout':return `${waitLabel[decision.reason]}; not judged as running`;
  case 'reread':return 'lifecycle files are being written; not judged as running';
  case 'reclaim':return `lifecycle state is stale (owner ${decision.reason}); not running`;
  case 'uncertain':return `lifecycle state is uncertain: ${decision.reason}`;
  case 'foreign':return `port ${decision.port} answers with another boot id: another server, not this install's instance`;
  default:return decision.action;
 }
}
/**
 * Read-only: 0 only for an owned running instance (process identity and bridge boot_id match) whose full `/api/health` (herdr
 * included) is ok; 1 otherwise; 2 missing prerequisite. Never creates the guard, a lock or the root.
 */
export async function check(options:Options,context:Context):Promise<number>{
 if(!prerequisites(context))return 2;
 const {dir}=options;let port=options.port,code=0,decision:Decision={action:'stopped'};
 if(installed(dir)){context.out(`ok    installed at ${dir}`);decision=(await judge(inspectLifecycle(dir,{identity:processIdentity}))).decision;}
 else{context.err(`MISS  not installed at ${dir} (run the installer)`);code=1;}
 if(decision.action==='running'){
  port=decision.port;context.out(`ok    own instance running on port ${port} (boot ${decision.boot_id})`);
  if(await context.healthy(port))context.out(`ok    server answers http://127.0.0.1:${port}/api/health`);
  else{context.err(`MISS  herdr is not ready: http://127.0.0.1:${port}/api/health is not ok (the web server runs; start herdr, then rerun check)`);code=1;}
  return code;
 }
 if(decision.action!=='stopped'){context.err(`MISS  ${notRunning(decision)}`);return 1;}
 const url=`http://127.0.0.1:${port}`;
 if(await context.healthy(port))context.out(`note  ${url} answers, but not from this install (another server owns port ${port})`);
 else context.err(`MISS  no server answers ${url}/api/health`);
 return 1;
}
/** lifecycle.json as written by the owned launcher: the decision record plus its extra fields, the stop token among them. */
type OwnedState={record:LifecycleRecord;raw:Record<string,unknown>;token?:string};
const parseOwnedState=(value:unknown):OwnedState|undefined=>{
 const record=parseLifecycleRecord(value);if(!record)return undefined;
 const raw=value as Record<string,unknown>;return {record,raw,token:typeof raw.stop_token==='string'&&raw.stop_token?raw.stop_token:undefined};
};
const asStateObservation=(observed:FileObservation<OwnedState>):FileObservation<LifecycleRecord>=>observed.kind==='record'?{kind:'record',record:observed.record.record,file:observed.file}:observed;
/** `--port` exactly as given on the command line (PORT and the default do not count); stop uses the recorded port otherwise. */
export function cliPort(argv:string[]):number|undefined{
 for(let i=0;i<argv.length;i++){if(argv[i]==='--dir')i++;else if(argv[i]==='--port')return Number(argv[i+1]);}
 return undefined;
}
/** install.sh step 4 / --start: launch the owned server in the background (lifecycle-launch.ts), then report herdr readiness. */
export async function start(options:Options,context:Context,explicitPort?:number):Promise<number>{
 const {dir}=options;const fail=(line:string)=>{context.err(`FAIL  ${line}`);return 1;};
 if(!installed(dir))return fail(`not installed at ${dir} (run the installer)`);
 const {decision}=await judge(inspectLifecycle(dir,{identity:processIdentity}));
 let port=options.port;
 if(decision.action==='running'){
  if(explicitPort!==undefined&&explicitPort!==decision.port)return fail(`already running on port ${decision.port}; stop it first (bun scripts/install-lifecycle.ts stop --dir "${dir}"), then start with --port ${explicitPort}`);
  port=decision.port;context.out(`ok    already running on http://127.0.0.1:${port}`);
 }else if(decision.action==='uncertain'||decision.action==='foreign')return fail(`${notRunning(decision)}; not started`);
 else{
  try{const launched=await launchOwned(dir,{port,env:context.env});context.out(`ok    started on http://127.0.0.1:${port} (server pid ${launched.pid}, launcher pid ${launched.launcher}, log ${launched.log})`);}
  catch(error){return fail(error instanceof Error?error.message:String(error));}
 }
 // herdr readiness never makes the running bridge stale: the server stays up and this reports what is missing.
 if(await context.healthy(port)){context.out(`ok    server answers http://127.0.0.1:${port}/api/health`);return 0;}
 context.err(`MISS  herdr is not ready: http://127.0.0.1:${port}/api/health is not ok. The web server keeps running; start herdr, then run check.`);
 return 1;
}
const psQuote=(value:string)=>`'${value.replaceAll("'","''")}'`;
const describeIdentity=(identity:ProcessIdentity|undefined)=>identity?`${identity.state}${identity.startedAt?`, started ${identity.startedAt}`:''}${identity.exe?`, exe ${identity.exe}`:''}${identity.detail?` (${identity.detail})`:''}`:'not checked';
const describeProbe=(probe:Probe|undefined,recorded:string)=>!probe?'not sent':probe.kind==='silent'?'silent (no answer)':probe.boot_id===recorded?`boot ${probe.boot_id} (matches the record)`:`boot ${probe.boot_id||'(none)'} (record has ${recorded})`;
export type StopCause='timeout'|'silent'|'refused'|'uncertain'|'foreign'|'busy';
const STOP_GUIDANCE:Record<StopCause,string>={
 timeout:`The server accepted the stop request but has not exited within ${BUDGET_MS.stop} ms. It may still be finishing: wait a moment and run stop again (a repeated stop is safe).`,
 silent:'The server process is alive but does not answer on its port (hung or overloaded). Wait and run stop again (a repeated stop is safe).',
 refused:'The server refused the stop request. Run stop again; if it keeps refusing, the process on that port is not the instance lifecycle.json describes.',
 uncertain:'The owner of lifecycle.json could not be judged, so nothing was sent or removed. Run stop again once the cause above is gone.',
 foreign:'Another server (another install, or a launch this install did not record) answers on the recorded port, so no stop request was sent. Find it with: Get-NetTCPConnection -LocalPort <port> | Select-Object OwningProcess',
 busy:'Another lifecycle transition did not finish within the stop budget. Wait for it to end, then run stop again.',
};
/** Stop failure report: what was checked, when, and what to do. It never contains the stop token. Nothing is killed automatically. */
function stopDiagnostics(context:Context,dir:string,cause:StopCause,headline:string,owned:OwnedState|undefined,server:ProcessIdentity|undefined,probe:Probe|undefined){
 const line=(text:string)=>context.err(`      ${text}`);
 context.err(`FAIL  stop: ${headline}`);
 line(`checked at    ${new Date().toISOString()}`);
 if(owned){
  const {record,raw}=owned,launcher=raw.launcher_identity as {pid?:unknown;startedAt?:unknown;exe?:unknown}|undefined;
  line(`server        pid ${record.pid}, started ${record.startedAt??'unknown'}, exe ${record.exe??'unknown'} (recorded, status ${record.status})`);
  line(`server now    ${describeIdentity(server)}`);
  if(launcher&&typeof launcher.pid==='number')line(`launcher      pid ${launcher.pid}, started ${String(launcher.startedAt??'unknown')}, exe ${String(launcher.exe??'unknown')} (recorded)`);
  line(`port          ${record.port} (recorded in lifecycle.json)`);
  line(`bridge probe  ${describeProbe(probe,record.boot_id)}`);
 }
 line(STOP_GUIDANCE[cause].replace('<port>',owned?String(owned.record.port):'<port>'));
 const windows=process.platform==='win32';
 if(owned&&cause!=='foreign'&&owned.record.startedAt&&(windows||owned.record.exe)){
  const {pid,startedAt}=owned.record;
  line('Nothing was killed. Only if you decide this server must end now, end it by hand with a command that re-checks the same');
  // Windows compares PID and creation time only: CIM's ExecutablePath may spell a junction install differently from the kernel's recorded exe.
  if(windows){
   line('process (PID and start time) right before stopping it and stops nothing if either changed:');
   line(`  $p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if($p -and $p.CreationDate -and $p.CreationDate.ToUniversalTime().ToString('o') -eq ${psQuote(startedAt)}){Stop-Process -Id ${pid}}else{'Process ${pid} changed or is gone: not stopped'}`);
  }else{
   line('process (PID, start time and executable) right before stopping it and stops nothing if any of them changed:');
   line(`  ps -o lstart=,comm= -p ${pid}   then, only if its start time and executable still match the lines above: kill ${pid}`);
  }
  line('Do not reuse the PID number alone later: Windows reuses PIDs. The launcher then removes lifecycle.json and exits on its own.');
 }
 line(`Afterwards confirm the state with: bun scripts/install-lifecycle.ts check --dir "${dir}"`);
}
/** Leftover C-6 guard, reported apart from a stop timeout. The guard is never removed automatically. */
function guardDiagnostics(context:Context,dir:string,detail:string){
 const {paths}=readLock(dir);const owner=observeFile(paths.guard,parseLockRecord);
 const line=(text:string)=>context.err(`      ${text}`);
 context.err(`FAIL  stop: the lifecycle guard is still held (this is not a server stop timeout; no stop request was sent)`);
 line(`checked at    ${new Date().toISOString()}`);
 line(`guard         ${paths.guard}`);
 if(owner.kind==='record'){const now=processIdentity(owner.record.pid);line(`guard owner   pid ${owner.record.pid}, started ${owner.record.startedAt??'unknown'}, exe ${owner.record.exe??'unknown'}, operation ${owner.record.operation} (recorded)`);line(`owner now     ${describeIdentity(now)}`);}
 else line(`guard owner   ${owner.kind==='absent'?'released just now: run stop again':'unknown (empty or unreadable record)'}`);
 line('The guard is never removed automatically, even when its owner is gone. Offline manual recovery: end every TermWeave lifecycle');
 line('command, waiter and launcher for this install, make sure none can start, and only then delete the guard file above. Leave the');
 line(`work lock ${paths.lock} and lifecycle.json alone; the next normal call re-judges them. If you cannot confirm nothing runs, do not delete it.`);
 line(detail);
 line(`Afterwards confirm the state with: bun scripts/install-lifecycle.ts check --dir "${dir}"`);
}
/**
 * Graceful stop of this install's instance. Port: the recorded one; an explicit --port that differs fails before any request.
 * The stop request goes out only for `running` with identity and bridge boot_id matching; a silent probe or another boot never gets
 * one. The guard is held only for the short state transitions, never while the request or the exit is awaited.
 */
export async function stop(options:Options,context:Context,explicitPort?:number):Promise<number>{
 const {dir}=options;const fail=(line:string)=>{context.err(`FAIL  ${line}`);return 1;};
 if(!installed(dir))return fail(`not installed at ${dir} (run the installer)`);
 const lockOptions={identity:processIdentity};let lock:LockHandle;
 try{lock=acquireLock(dir,'stop',lockOptions);}
 catch(error){
  const message=error instanceof Error?error.message:String(error);
  if(readLock(dir).guard){guardDiagnostics(context,dir,message);return 1;}
  stopDiagnostics(context,dir,'busy',`waited ${BUDGET_MS.stop} ms for another lifecycle transition`,undefined,undefined,undefined);context.err(`      ${message}`);return 1;
 }
 try{return await stopOwned(dir,context,lock,explicitPort);}
 finally{if(!lock.release())context.err('note  the stop work lock was no longer ours at release');}
}
async function stopOwned(dir:string,context:Context,lock:LockHandle,explicitPort:number|undefined):Promise<number>{
 const lockOptions={identity:processIdentity};const deadline=Date.now()+BUDGET_MS.stop;
 let partial:{file:string;at:number}|undefined,waited=false;
 for(;;){
  const observed=observeFile(stateFile(dir),parseOwnedState);const owned=observed.kind==='record'?observed.record:undefined;
  if(owned&&explicitPort!==undefined&&explicitPort!==owned.record.port){context.err(`FAIL  stop: --port ${explicitPort} does not match the recorded port ${owned.record.port}; no request was sent to either port. Run stop without --port (the recorded port is used).`);return 1;}
  if(observed.kind==='partial'){if(partial?.file!==observed.file)partial={file:observed.file,at:Date.now()};}else partial=undefined;
  const server=owned?processIdentity(owned.record.pid):undefined;
  // The stop work lock is ours, so only the lifecycle.json rows of the decision table apply here.
  const {decision,probe}=await judge({guard:false,lock:{kind:'absent'},state:asStateObservation(observed),stateOwner:server,statePartialMs:partial?Date.now()-partial.at:undefined});
  const expired=Date.now()>=deadline;
  switch(decision.action){
   case 'stopped':context.out(waited?'ok    stopped':'ok    not running (nothing to stop)');return 0;
   case 'reclaim':
    if(removeState(dir,{lock:lock.nonce,state:owned!.record.boot_id},'stop',lockOptions)){context.out(`ok    not running (removed stale lifecycle.json of pid ${owned!.record.pid}: owner ${decision.reason})`);return 0;}
    break;
   case 'uncertain':stopDiagnostics(context,dir,probe?.kind==='silent'?'silent':'uncertain',decision.reason,owned,server,probe);return 1;
   case 'foreign':stopDiagnostics(context,dir,'foreign',`port ${decision.port} answers with another boot id; no stop request was sent`,owned,server,probe);return 1;
   case 'running':{
    const {record,raw,token}=owned!;
    if(!token){stopDiagnostics(context,dir,'uncertain','lifecycle.json carries no stop token; no stop request was sent',owned,server,probe);return 1;}
    if(!replaceState(dir,{...raw,status:'stopping'} as LifecycleRecord,{lock:lock.nonce,state:record.boot_id},'stop',lockOptions))break;
    const answer=await requestOwnedStop(record.port,token);
    if(answer.kind==='refused'){
     replaceState(dir,{...raw,status:'running'} as LifecycleRecord,{lock:lock.nonce,state:record.boot_id},'stop',lockOptions);
     stopDiagnostics(context,dir,'refused',`the server refused the stop request (HTTP ${answer.status}${answer.code?` ${answer.code}`:''})`,owned,server,probe);return 1;
    }
    return awaitExit(dir,context,lock,owned!,answer,probe);
   }
   default:
    // wait (stopping/starting), reread: the state is still moving; wait within the budget.
    waited||=decision.action==='wait'&&decision.reason==='stopping';
    if(expired){stopDiagnostics(context,dir,decision.action==='wait'&&decision.reason==='stopping'?'timeout':'busy',`${notRunning(decision)} after ${BUDGET_MS.stop} ms`,owned,server,probe);return 1;}
  }
  if(Date.now()>=deadline&&decision.action!=='wait'){stopDiagnostics(context,dir,'uncertain',`lifecycle.json kept changing for ${BUDGET_MS.stop} ms`,owned,server,probe);return 1;}
  await Bun.sleep(200);
 }
}
/** After the stop request: wait, without the guard, for this boot's state to go and the server and launcher processes to end. */
async function awaitExit(dir:string,context:Context,lock:LockHandle,owned:OwnedState,answer:StopAnswer,probe:Probe|undefined):Promise<number>{
 const {record,raw}=owned,deadline=Date.now()+BUDGET_MS.stop;
 const launcherRecord=raw.launcher_identity as OwnerRecord|undefined;
 const ended=(owner:OwnerRecord)=>{const verdict=matchOwner(owner,processIdentity(owner.pid));return verdict==='gone'||verdict==='mismatch';};
 for(;;){
  const state=observeFile(stateFile(dir),parseLifecycleRecord);
  const ours=state.kind!=='absent'&&!(state.kind==='record'&&state.record.boot_id!==record.boot_id);
  if(!ours&&ended(record)&&(!launcherRecord||typeof launcherRecord.pid!=='number'||ended(launcherRecord))){context.out(`ok    stopped (server pid ${record.pid} on port ${record.port})`);return 0;}
  if(Date.now()>=deadline)break;
  await Bun.sleep(200);
 }
 // A request that got no answer may never have arrived: the state goes back to running so the next stop sends it again.
 if(answer.kind==='silent')replaceState(dir,{...raw,status:'running'} as LifecycleRecord,{lock:lock.nonce,state:record.boot_id},'stop',{identity:processIdentity});
 const server=processIdentity(record.pid);
 const now=server.state==='alive'?await bridgeProbe(record.port):probe;
 const headline=server.state==='gone'?`the server exited, but its launcher did not withdraw lifecycle.json and exit within ${BUDGET_MS.stop} ms`
  :answer.kind==='silent'?`the stop request got no answer (${answer.detail}) and the server did not exit within ${BUDGET_MS.stop} ms`
  :`the server did not exit within ${BUDGET_MS.stop} ms after accepting the stop request`;
 stopDiagnostics(context,dir,answer.kind==='silent'?'silent':'timeout',headline,owned,server,now);
 return 1;
}
/** install.sh step 3: reuse an existing install, refuse an existing non-install path, otherwise installOwned into a new root. */
export function install(options:Options,context:Context):number{
 if(!prerequisites(context))return 2;
 const {dir}=options;const fail=(line:string)=>{context.err(`FAIL  ${line}`);return 1;};
 if(installed(dir)){context.out(`ok    already installed at ${dir} (reused)`);return 0;}
 if(lstatSync(dir,{throwIfNoEntry:false}))return fail(`${dir} exists but is not a TermWeave install. Remove it or pass --dir NEW_PATH`);
 const judged=judgeDestination(dir,context.source,{platform:context.platform,env:context.env});
 if('refused' in judged){
  if(judged.refused!=='missing parent')return fail(`cannot install into ${dir} (${judged.refused}). Pass --dir NEW_PATH`);
  try{mkdirSync(dirname(dir),{recursive:true});}catch{return fail(`cannot create ${dirname(dir)}`);}
 }
 context.out(`Installing dependencies and building into ${dir} (takes a few minutes)...`);
 try{installOwned(context.source,dir);}
 catch(error){return fail(`install failed (${error instanceof Error?error.message:String(error)}). The source checkout must be a clean git clone (no local edits): git status`);}
 if(!installed(dir))return fail('install did not finish');
 context.out(`ok    installed and built at ${dir}`);return 0;
}
export async function main(argv:string[],context:Context):Promise<number>{
 let options:Options|undefined;
 try{options=parseArgs(argv,context);}
 catch(error){if(!(error instanceof UsageError))throw error;context.err(error.message);context.err(USAGE);return 1;}
 if(!options){context.out(USAGE);return 0;}
 if(options.command==='check')return check(options,context);
 if(options.command==='install')return install(options,context);
 if(options.command==='start')return start(options,context,cliPort(argv));
 return stop(options,context,cliPort(argv));
}
/** Context.healthy of the CLI: the full, herdr-inclusive `/api/health` answers `"ok":true`. */
export async function fullHealthOk(port:number):Promise<boolean>{
 try{const response=await fetch(`http://127.0.0.1:${port}/api/health`,{signal:AbortSignal.timeout(3000)});return response.ok&&(await response.json() as {ok?:unknown})?.ok===true;}
 catch{return false;}
}
if(import.meta.main)process.exitCode=await main(process.argv.slice(2),{
 env:process.env,platform:process.platform,cwd:process.cwd(),out:line=>console.log(line),err:line=>console.error(line),
 version:toolVersion,healthy:fullHealthOk,source:resolve(import.meta.dir,'..'),
});
