import {createHash,randomBytes} from 'node:crypto';
import {appendFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,renameSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,resolve,win32} from 'node:path';
import {matchOwner,type OwnerRecord} from './lifecycle-lock.ts';import {findExecutable,toolVersion} from './lifecycle-env.ts';
import {QUERY_TIMEOUT_MS,queryIdentity,windowsPowerShell} from './process-identity.ts';import {bridgeProbe} from './lifecycle-launch.ts';
import {fullHealthOk} from './install-lifecycle.ts';import {parseProcessTable,windowsArgv} from '../server/windows-processes.ts';
import {HerdrError,herdrRpc,paneSendKeys,paneSendText,sessionSnapshot,workspaceClose,workspaceCreate} from '../server/herdr/client.ts';
/**
 * Real-machine (M10) evidence for the native Windows port: evidence/windows-native/<run-id>/ with environment.txt, edge.before/after,
 * ime.before/after (+ ime.pane-read.json, the raw pane.read answer), stop.before/after, commands.txt and result.json.
 *
 * Collectors are read-only: environment, edge-before, edge-after, ime-after, stop-before, stop-after, status. Only these change
 * anything, and only when run explicitly: `exec` (runs the command it is given and logs it), `pane` (creates one test-owned herdr
 * workspace), `ime-before` (starts the capture program in that test-owned pane) and `pane-close` (closes that workspace only).
 * Existing user panes are never written to. Tokens, API keys and pane contents outside the test-owned pane are never collected;
 * lifecycle.json is read for pid/startedAt/exe/port/boot_id only, never its stop token.
 *
 * Every run binds one candidate: `init` refuses an existing --dir (a new install dir per run), records `git rev-parse HEAD`, and
 * `environment` asserts marker.source_sha == that HEAD == the current HEAD, marker.root == the run's dir and a marker newer than init.
 * Evidence text files are created once (wx): a failed run is never overwritten; start a new run id instead.
 *
 * `--self-test` checks this tool's interface only (text comparison, process filter, binding, evidence links, result schema). Its
 * result.json says `kind: "self-test"` and `not_real_machine_evidence: true`; it is never real-machine pass evidence.
 *
 * The canonical upstream 9 Korean sentences are not in any VoidLight00/termweave commit (see INSTALL.md); `ime-before` therefore
 * takes the original as a UTF-8 file plus its expected SHA-256 and a provenance note, and never ships a copy.
 */
const SOURCE=resolve(import.meta.dir,'..'),EVIDENCE_ROOT=join(SOURCE,'evidence','windows-native');
export const SCHEMA='termweave.windows-native-acceptance/1';
export const FILES=['environment.txt','edge.before.txt','edge.after.txt','ime.before.txt','ime.after.txt','ime.pane-read.json','stop.before.txt','stop.after.txt','commands.txt'] as const;
export type EvidenceFile=typeof FILES[number];
export const ACS=['AC-I1','AC-I2','AC-I3','AC-I4','AC-I5','AC-I6','AC-I7','AC-B1','AC-B2','AC-B3','AC-B4','AC-B5','AC-B6','AC-B7','AC-U1','AC-U2','AC-U3','AC-U4','AC-U5'] as const;
export type Ac=typeof ACS[number];
/** ACs that only a real Windows machine can pass; real_machine_pass needs every one of them. */
export const REAL_MACHINE_ACS:readonly Ac[]=['AC-I1','AC-I3','AC-I5','AC-B1','AC-B2','AC-B3','AC-B4','AC-B5','AC-U1','AC-U2'];
/** Set only by the measuring subcommand, never by a verdict. */
const MEASURED:Partial<Record<Ac,string>>={'AC-I5':'stop-after','AC-U2':'ime-after'};
const EDGE_ACS:readonly Ac[]=['AC-B1','AC-B2','AC-B3','AC-B4','AC-B5','AC-U1'];
export const STATUSES=['pass','fail','blocked','not-run'] as const;
export type Status=typeof STATUSES[number];
export const SENTENCE_COUNT=9;
const LABEL_PREFIX='termweave-acceptance-';
const nowIso=()=>new Date().toISOString();
const sha256=(data:string|Uint8Array)=>createHash('sha256').update(data).digest('hex');
class Refused extends Error{}

// ---- text comparison (AC-U2) ----------------------------------------------------------------------------------------------------
const codePoint=(c:string|undefined)=>c===undefined?null:`U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4,'0')}`;
export type SentenceResult={sentence:number;expected_length:number;actual_length:number|null;match:boolean;first_mismatch:null|{index:number;expected:string|null;actual:string|null}};
/** Code point by code point exactly as given: no trim, no Unicode normalization, no whitespace folding. Lengths are code points. */
export function compareSentence(sentence:number,expected:string,actual:string|undefined):SentenceResult{
 const e=Array.from(expected);
 if(actual===undefined)return {sentence,expected_length:e.length,actual_length:null,match:false,first_mismatch:{index:0,expected:codePoint(e[0]),actual:null}};
 const a=Array.from(actual);let i=0;while(i<e.length&&i<a.length&&e[i]===a[i])i++;
 const match=i===e.length&&i===a.length;
 return {sentence,expected_length:e.length,actual_length:a.length,match,first_mismatch:match?null:{index:i,expected:codePoint(e[i]),actual:codePoint(a[i])}};
}
export function compareAll(expected:readonly string[],actual:readonly string[]){
 const sentences=expected.map((text,i)=>compareSentence(i+1,text,actual[i]));
 const matched=sentences.filter(s=>s.match).length;
 return {sentences,matched,captured:actual.length,pass:matched===expected.length&&actual.length===expected.length};
}
const markerPrefix=(nonce:string)=>`TWIME ${nonce} <<`;
export const extractionRule=(nonce:string)=>`The pane.read text is split at "\\n"; one "\\r" right before it is dropped. A captured sentence is everything between "${markerPrefix(nonce)}" at the start of a line and the last ">>" of that line (only spaces may follow it). The sentence text is kept exactly: nothing is trimmed, normalized or unescaped. Captures are taken in pane order and must number exactly ${SENTENCE_COUNT}; extra or missing captures fail the run.`;
/** Captured lines of the test-owned pane's capture program, per extractionRule. */
export function extractSentences(text:string,nonce:string):string[]{
 const prefix=markerPrefix(nonce),out:string[]=[];
 for(const raw of text.split('\n')){
  const line=raw.endsWith('\r')?raw.slice(0,-1):raw;if(!line.startsWith(prefix))continue;
  const end=line.lastIndexOf('>>');if(end<prefix.length||!/^ *$/.test(line.slice(end+2)))continue;
  out.push(line.slice(prefix.length,end));
 }
 return out;
}
/** The original sentences: UTF-8 without BOM, LF line ends, exactly 9 non-empty lines (one final newline allowed). Nothing is trimmed. */
export function parseSentenceFile(bytes:Uint8Array):string[]{
 let text:string;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw new Refused('sentence file is not valid UTF-8');}
 if(text.startsWith('\uFEFF'))throw new Refused('sentence file starts with a BOM; save it as UTF-8 without BOM');
 if(text.includes('\r'))throw new Refused('sentence file contains CR; use LF line ends so no line ending is part of a sentence');
 const lines=text.split('\n');if(lines.at(-1)==='')lines.pop();
 if(lines.length!==SENTENCE_COUNT||lines.some(line=>line.length===0))throw new Refused(`sentence file must hold exactly ${SENTENCE_COUNT} non-empty lines (found ${lines.length})`);
 return lines;
}
/** PowerShell run in the test-owned pane: echoes each typed line between markers. ConsoleHost reads and writes UTF-16 directly. */
export function captureScript(nonce:string):string{
 return [
  `$Host.UI.WriteLine('TWIME READY ${nonce}: type each sentence with the Microsoft Korean IME at normal speed, then Enter. Ctrl+C ends.')`,
  `while($true){$line=$Host.UI.ReadLine();if($null -eq $line){break};$Host.UI.WriteLine('${markerPrefix(nonce)}'+$line+'>>')}`,
 ].join('\n');
}

// ---- process filter (AC-I5 / M10 stop evidence) ----------------------------------------------------------------------------------
export type ProcRow={pid:number;parent:number;exe:string|null;commandLine:string|null;created:string|null};
export type OwnedRow=ProcRow&{role:'launcher'|'server';recorded:boolean;parent_check:string};
const pathKey=(path:string)=>win32.normalize(path).replace(/\\+$/,'').toLowerCase();
/** Exact path identity on Windows (case-insensitive, separators normalized). Never a prefix test: C:\a\tw-1 is not C:\a\tw-10. */
export const samePath=(a:string,b:string)=>pathKey(a)===pathKey(b);
const exeName=(row:ProcRow)=>row.exe?win32.basename(row.exe).toLowerCase():undefined;
/**
 * The owned launcher/server boundary: argv exactly `<bun> <root>\scripts\owned-server.ts start` (lifecycle-launch.ts) or
 * `<bun> <root>\server\index.ts` (owned-server.ts), with argv[1] equal to the owned script path for one of `roots`. bun.exe may live
 * outside the install dir, so the executable path is not the boundary. A server is checked against its parent: an owned launcher
 * that started no later than it. Every boundary match counts, orphan or not. A bun.exe whose command line is unreadable makes the
 * observation blocked: it may be an owned process that the query could not show.
 */
export function ownedProcesses(rows:readonly ProcRow[],roots:readonly string[],recorded:readonly OwnerRecord[]=[]):{owned:OwnedRow[];unreadable:ProcRow[]}{
 const launchers=roots.map(root=>win32.join(root,'scripts','owned-server.ts')),servers=roots.map(root=>win32.join(root,'server','index.ts'));
 const owned:OwnedRow[]=[],unreadable:ProcRow[]=[];
 for(const row of rows){
  if(!row.commandLine){if(exeName(row)==='bun.exe')unreadable.push(row);continue;}
  const argv=windowsArgv(row.commandLine);
  const role=argv.length===3&&argv[2]==='start'&&launchers.some(path=>samePath(argv[1]!,path))?'launcher':argv.length===2&&servers.some(path=>samePath(argv[1]!,path))?'server':undefined;
  if(!role)continue;
  owned.push({...row,role,recorded:recorded.some(r=>r.pid===row.pid&&r.startedAt!==undefined&&r.startedAt===row.created),parent_check:''});
 }
 for(const row of owned){
  if(row.role==='launcher'){row.parent_check='launcher (its parent, the start command, exits after launch)';continue;}
  const parent=owned.find(o=>o.role==='launcher'&&o.pid===row.parent);
  row.parent_check=!parent?`parent ${row.parent} is not an owned launcher (orphan or foreign start)`:!row.created||!parent.created?'creation time unreadable'
   :parent.created<=row.created?`child of owned launcher ${parent.pid}`:`parent pid ${parent.pid} reused: that launcher started after this server`;
 }
 return {owned,unreadable};
}
/** Full Win32_Process table with CreationDate exact: the 'o' spelling process-identity.ts records as startedAt (createdIso). */
export const cimTableScript=[
 "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.Encoding]::UTF8",
 "try{$rows=@(Get-CimInstance -ClassName Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,@{n='Created';e={if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}else{$null}}})",
 " [Console]::Out.Write((ConvertTo-Json -Compress -Depth 3 -InputObject @{rows=$rows}))}",
 "catch{[Console]::Out.Write((ConvertTo-Json -Compress -InputObject @{error=[string]$_.CategoryInfo.Category;message=[string]$_.Exception.Message}));exit 2}",
].join('\n');
export type Table={ok:true;rows:ProcRow[]}|{ok:false;blocked:string};
/** A failed, denied or unparseable query is `blocked`, never an empty table: zero processes is only ever a successful answer. */
export function parseCimTable(exitCode:number|null,stdout:string):Table{
 let value:unknown;try{value=JSON.parse(stdout);}catch{return {ok:false,blocked:`CIM query exit ${exitCode} without JSON`};}
 const v=value as {rows?:unknown;error?:unknown;message?:unknown}|null;
 if(v&&typeof v==='object'&&typeof v.error==='string')return {ok:false,blocked:`CIM ${v.error}: ${String(v.message??'')}`.trim()};
 if(exitCode!==0||!v||typeof v!=='object'||!Array.isArray(v.rows))return {ok:false,blocked:`CIM query exit ${exitCode} with unexpected output`};
 const raw=v.rows as {ProcessId?:unknown;Created?:unknown}[],base=parseProcessTable(JSON.stringify(raw));
 if(base.length!==raw.length||base.length===0)return {ok:false,blocked:'CIM returned malformed or no rows'};
 const created=new Map(raw.map(r=>[r.ProcessId,typeof r.Created==='string'&&r.Created?r.Created:null]));
 return {ok:true,rows:base.map(row=>({pid:row.pid,parent:row.parent,exe:row.path,commandLine:row.commandLine,created:created.get(row.pid)??null}))};
}
function processTable():Table{
 let exe:string;try{exe=windowsPowerShell();}catch(error){return {ok:false,blocked:(error as Error).message};}
 try{
  const result=Bun.spawnSync([exe,'-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(cimTableScript,'utf16le').toString('base64')],{stdin:'ignore',stdout:'pipe',stderr:'pipe',windowsHide:true,timeout:QUERY_TIMEOUT_MS,killSignal:'SIGKILL'});
  return parseCimTable(result.exitCode,new TextDecoder('utf-8').decode(result.stdout));
 }catch(error){return {ok:false,blocked:(error as Error).message};}
}
/** Stored text never carries a credential: known token shapes, key=value secrets and long mixed-case base64url runs are masked. */
export function redact(text:string):string{
 return text
  .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,})/g,'[REDACTED]')
  .replace(/((?:token|secret|password|passwd|api[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^\s"'&]+/gi,'$1[REDACTED]')
  .replace(/(--(?:token|secret|password|api-key)[= ])\S+/gi,'$1[REDACTED]')
  .replace(/[A-Za-z0-9_-]{32,}/g,run=>/[A-Z]/.test(run)&&/[a-z]/.test(run)&&/[0-9]/.test(run)?'[REDACTED]':run);
}
const describeRow=(row:ProcRow)=>`pid ${row.pid}  parent ${row.parent}  created ${row.created??'(unreadable)'}  exe ${row.exe??'(unreadable)'}`;
const describeOwned=(row:OwnedRow)=>`${describeRow(row)}\n    role ${row.role}; ${row.recorded?'recorded in lifecycle.json (pid+CreationDate)':'not the recorded pid+CreationDate'}; ${row.parent_check}\n    command line (secrets removed): ${redact(row.commandLine??'')}`;
const named=(rows:readonly ProcRow[],name:string)=>rows.filter(row=>exeName(row)===name).map(({pid,parent,exe,created})=>({pid,parent,exe,created,commandLine:null}));

// ---- binding (candidate HEAD == marker.source_sha, new install dir) --------------------------------------------------------------
export type Marker={product?:unknown;root?:unknown;source_sha?:unknown};
export type BindingInput={initHead:string;currentHead:string;initDir:string;canonicalDir?:string;initAtMs:number;marker:Marker|undefined;markerMtimeMs?:number};
/** Every reason the installed copy may not be the candidate. Empty means bound. */
export function bindingProblems(b:BindingInput):string[]{
 const problems:string[]=[];
 if(!b.marker)return [`no .termweave-owned.json marker in ${b.initDir}`];
 if(b.marker.product!=='termweave')problems.push('marker product is not termweave');
 if(b.marker.source_sha!==b.initHead)problems.push(`marker.source_sha ${String(b.marker.source_sha)} differs from the candidate HEAD ${b.initHead} recorded at init`);
 if(b.currentHead!==b.initHead)problems.push(`HEAD moved from ${b.initHead} to ${b.currentHead} after init`);
 const root=typeof b.marker.root==='string'?b.marker.root:undefined;
 if(!root||!(samePath(root,b.initDir)||(b.canonicalDir!==undefined&&samePath(root,b.canonicalDir))))problems.push(`marker.root ${String(b.marker.root)} is not the run's install dir ${b.initDir}`);
 // Coarse file systems (FAT) keep 2 s timestamps; anything older than init is an install that existed before this run.
 if(b.markerMtimeMs===undefined||b.markerMtimeMs<b.initAtMs-2_000)problems.push('the marker is older than init: an existing install was reused');
 return problems;
}

// ---- result.json --------------------------------------------------------------------------------------------------------------
export type AcEntry={status:Status;by:'agent'|'user'|null;at:string|null;note:string;evidence:EvidenceFile[]};
export type Result={
 schema:string;kind:'real-machine'|'self-test';not_real_machine_evidence:boolean;real_machine_pass:boolean;run_id:string;created_at:string;
 binding:{candidate_head:string;install_dir:string;port:number|null;init_at:string;tracked_changes:number;source_sha:string|null;marker_root:string|null;bound_at:string|null;problems:string[]};
 test_owned:{workspace_id:string;pane_id:string;label:string;created_at:string;closed_at:string|null}|null;
 ime:{nonce:string;sentences:string[];sentences_sha256:string;source:string;matched:number|null;captured:number|null}|null;
 stop:{port:number;boot_id:string;at:string;n:number;server:OwnerRecord;launcher:OwnerRecord|null;herdr:ProcRow[];edge:ProcRow[]}|null;
 commands:{n:number;argv:string[];started_at:string;ended_at:string;exit:number|null}[];
 ac:Record<Ac,AcEntry>;confirmations:{ac:Ac;status:Status;by:'agent'|'user';at:string;note:string}[];
 files:Partial<Record<EvidenceFile,string>>;ci:{run_url:string;push_sha:string;matches_candidate:boolean}|null;g3c:string|null;
};
export function newResult(kind:Result['kind'],runId:string,binding:Result['binding']):Result{
 const ac=Object.fromEntries(ACS.map(id=>[id,{status:'not-run',by:null,at:null,note:'',evidence:[]} satisfies AcEntry])) as Record<Ac,AcEntry>;
 return {schema:SCHEMA,kind,not_real_machine_evidence:kind!=='real-machine',real_machine_pass:false,run_id:runId,created_at:nowIso(),binding,test_owned:null,ime:null,stop:null,commands:[],ac,confirmations:[],files:{},ci:null,g3c:null};
}
/** One AC verdict. A recorded fail is never replaced within the run; a measured AC is set only by its measuring subcommand. */
export function setAc(result:Result,ac:Ac,entry:Omit<AcEntry,'at'>,measuredBy?:string):void{
 if(MEASURED[ac]&&MEASURED[ac]!==measuredBy)throw new Refused(`${ac} is measured by \`${MEASURED[ac]}\`, not set by hand`);
 if(result.ac[ac].status==='fail'&&entry.status!=='fail')throw new Refused(`${ac} already failed in this run; a failure is not overwritten (start a new run id)`);
 const at=nowIso();result.ac[ac]={...entry,at};
 if(entry.by)result.confirmations.push({ac,status:entry.status,by:entry.by,at,note:entry.note});
}
export function realMachinePass(result:Result):boolean{
 return result.kind==='real-machine'&&result.binding.bound_at!==null&&result.binding.problems.length===0&&!!result.ci?.matches_candidate
  &&REAL_MACHINE_ACS.every(ac=>result.ac[ac].status==='pass');
}
/** Hashes of the evidence files present in `dir`. */
export function hashFiles(dir:string):Partial<Record<EvidenceFile,string>>{
 const files:Partial<Record<EvidenceFile,string>>={};
 for(const name of FILES){const path=join(dir,name);if(existsSync(path))files[name]=sha256(readFileSync(path));}
 return files;
}
/** Evidence links: every listed file exists with its recorded SHA-256, and every AC evidence reference is a listed file. */
export function linkProblems(dir:string,result:Result):string[]{
 const problems:string[]=[];
 for(const [name,hash] of Object.entries(result.files)){
  const path=join(dir,name);if(!existsSync(path)){problems.push(`${name} is listed but missing`);continue;}
  if(sha256(readFileSync(path))!==hash)problems.push(`${name} changed after it was recorded`);
 }
 for(const ac of ACS)for(const name of result.ac[ac].evidence)if(!(name in result.files))problems.push(`${ac} cites ${name}, which is not a recorded evidence file`);
 return problems;
}
/** Structural check of result.json, including the self-test / real-machine separation. */
export function schemaProblems(value:unknown):string[]{
 const r=value as Partial<Result>|null;if(!r||typeof r!=='object')return ['result is not an object'];
 const problems:string[]=[];
 if(r.schema!==SCHEMA)problems.push(`schema is not ${SCHEMA}`);
 if(r.kind!=='real-machine'&&r.kind!=='self-test')problems.push('kind must be real-machine or self-test');
 if(r.not_real_machine_evidence!==(r.kind!=='real-machine'))problems.push('not_real_machine_evidence must be true exactly when kind is not real-machine');
 if(r.kind!=='real-machine'&&r.real_machine_pass!==false)problems.push('a self-test result can never be a real-machine pass');
 if(typeof r.run_id!=='string'||!r.run_id)problems.push('run_id missing');
 if(!r.binding||typeof r.binding.candidate_head!=='string'||!Array.isArray(r.binding.problems))problems.push('binding missing');
 if(!r.ac||typeof r.ac!=='object')problems.push('ac missing');
 else{
  const keys=Object.keys(r.ac);if(keys.length!==ACS.length||ACS.some(ac=>!keys.includes(ac)))problems.push('ac must list exactly the bundle ACs');
  for(const ac of ACS){const e=r.ac[ac];if(e&&!(STATUSES as readonly string[]).includes(e.status))problems.push(`${ac} status ${String(e.status)} is not pass/fail/blocked/not-run`);}
 }
 if(!r.files||typeof r.files!=='object'||Object.entries(r.files).some(([name,hash])=>!(FILES as readonly string[]).includes(name)||!/^[0-9a-f]{64}$/.test(String(hash))))problems.push('files must map evidence file names to SHA-256');
 if(r.kind==='real-machine'&&r.real_machine_pass===true&&!realMachinePass(r as Result))problems.push('real_machine_pass is true without its conditions');
 return problems;
}

// ---- run directory ------------------------------------------------------------------------------------------------------------
const RUN_ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function runDir(id:string|undefined):string{
 if(!id||!RUN_ID.test(id)||id.toLowerCase().startsWith('self-test'))throw new Refused(`--run needs a run id (letters, digits, . _ -; not "self-test"): ${JSON.stringify(id??null)}`);
 return join(EVIDENCE_ROOT,id);
}
function loadResult(dir:string):Result{
 const path=join(dir,'result.json');if(!existsSync(path))throw new Refused(`no run at ${dir}; run init first`);
 const result=JSON.parse(readFileSync(path,'utf8')) as Result;const problems=schemaProblems(result);
 if(problems.length)throw new Refused(`result.json is invalid: ${problems.join('; ')}`);
 if(result.kind!=='real-machine')throw new Refused('this run is not a real-machine run');
 return result;
}
/** New evidence files get their hash once; a recorded file that changed is refused (commands.txt only grows, so it is re-hashed). */
function saveResult(dir:string,result:Result):void{
 const current=hashFiles(dir);
 for(const [name,hash] of Object.entries(result.files))if(name!=='commands.txt'&&current[name as EvidenceFile]!==hash)throw new Refused(`${name} changed or vanished after it was recorded; this run is no longer trustworthy`);
 result.files=current;result.real_machine_pass=realMachinePass(result);
 const problems=schemaProblems(result);if(problems.length)throw new Error(`refusing to write an invalid result.json: ${problems.join('; ')}`);
 const tmp=join(dir,`.result.${process.pid}.tmp`);writeFileSync(tmp,JSON.stringify(result,null,1)+'\n');renameSync(tmp,join(dir,'result.json'));
}
/** Evidence text is written once. */
function writeEvidence(dir:string,name:EvidenceFile,lines:string[]):void{
 try{writeFileSync(join(dir,name),lines.join('\n')+'\n',{flag:'wx'});}
 catch(error){if((error as {code?:string}).code==='EEXIST')throw new Refused(`${name} already exists in this run and is never overwritten; start a new run id`);throw error;}
 console.log(`wrote ${join(dir,name)}`);
}
function git(...args:string[]):string{
 const result=Bun.spawnSync(['git',...args],{cwd:SOURCE,stdin:'ignore',stdout:'pipe',stderr:'pipe',windowsHide:true});
 if(result.exitCode!==0)throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`);
 return result.stdout.toString().trim();
}
const readJson=(path:string):unknown=>{try{return JSON.parse(readFileSync(path,'utf8'));}catch{return undefined;}};
type Lifecycle={status:string;pid:number;startedAt?:string;exe?:string;port:number;boot_id:string;launcher:OwnerRecord|null};
/** lifecycle.json fields needed for evidence; the stop token is never read out of the parsed object. */
function readLifecycle(dir:string):Lifecycle|undefined{
 const v=readJson(join(dir,'lifecycle.json')) as Record<string,unknown>|undefined;if(!v||typeof v!=='object')return undefined;
 const owner=(x:unknown):OwnerRecord|null=>{const o=x as Record<string,unknown>|null;return o&&typeof o==='object'&&typeof o.pid==='number'?{pid:o.pid,startedAt:typeof o.startedAt==='string'?o.startedAt:undefined,exe:typeof o.exe==='string'?o.exe:undefined}:null;};
 if(typeof v.pid!=='number'||typeof v.port!=='number'||typeof v.boot_id!=='string'||typeof v.status!=='string')return undefined;
 return {status:v.status,pid:v.pid,startedAt:typeof v.startedAt==='string'?v.startedAt:undefined,exe:typeof v.exe==='string'?v.exe:undefined,port:v.port,boot_id:v.boot_id,launcher:owner(v.launcher_identity)};
}
const roots=(result:Result)=>{const {install_dir,marker_root}=result.binding;return marker_root&&!samePath(marker_root,install_dir)?[install_dir,marker_root]:[install_dir];};
function requireBound(result:Result){if(!result.binding.bound_at)throw new Refused('run `environment` first: it binds the installed copy to the candidate');}
function requireWindows(){if(process.platform!=='win32')throw new Refused('real-machine collection runs on native Windows only');}

// ---- subcommands --------------------------------------------------------------------------------------------------------------
type Args={positional:string[];flags:Map<string,string[]>;rest:string[]};
function parse(argv:string[]):Args{
 const flags=new Map<string,string[]>(),positional:string[]=[];let rest:string[]=[];
 for(let i=0;i<argv.length;i++){
  const arg=argv[i]!;
  if(arg==='--'){rest=argv.slice(i+1);break;}
  if(arg==='--self-test'||arg==='--help'||arg==='-h'){flags.set(arg,['']);continue;}
  if(arg.startsWith('--')){const value=argv[++i];if(value===undefined)throw new Refused(`${arg} needs a value`);flags.set(arg,[...(flags.get(arg)??[]),value]);continue;}
  positional.push(arg);
 }
 return {positional,flags,rest};
}
const flag=(a:Args,name:string)=>a.flags.get(name)?.at(-1);
const need=(a:Args,name:string)=>{const v=flag(a,name);if(!v)throw new Refused(`${name} is required`);return v;};

function init(a:Args):number{
 requireWindows();const runId=flag(a,'--run'),dir=runDir(runId);
 const install=win32.resolve(need(a,'--dir'));const port=flag(a,'--port');
 if(port!==undefined&&!/^\d+$/.test(port))throw new Refused(`invalid --port ${port}`);
 if(existsSync(install))throw new Refused(`${install} already exists. Every real-machine run installs into a new --dir so an older install is never taken for the candidate.`);
 if(existsSync(dir))throw new Refused(`${dir} already exists; choose a new run id`);
 const head=git('rev-parse','HEAD'),changes=git('status','--porcelain','--untracked-files=no').split('\n').filter(Boolean).length;
 mkdirSync(dir,{recursive:true});
 saveResult(dir,newResult('real-machine',runId!,{candidate_head:head,install_dir:install,port:port?Number(port):null,init_at:nowIso(),tracked_changes:changes,source_sha:null,marker_root:null,bound_at:null,problems:[]}));
 const portArg=port?` --port ${port}`:'';
 console.log(`run ${dir}\ncandidate HEAD ${head}${changes?` (WARNING: ${changes} tracked file(s) modified; the installer copies committed files only)`:''}\nnext: bun scripts/windows-native-acceptance.ts exec --run ${win32.basename(dir)} -- powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 --dir "${install}"${portArg}`);
 return 0;
}
async function exec(a:Args):Promise<number>{
 const dir=runDir(flag(a,'--run')),result=loadResult(dir);if(!a.rest.length)throw new Refused('exec needs a command after --');
 const started=nowIso(),child=Bun.spawn(a.rest,{cwd:SOURCE,stdin:'inherit',stdout:'pipe',stderr:'pipe'});
 // A detached server may inherit the pipe, so output is read until the command exits plus a short grace, never until EOF.
 const pump=(stream:ReadableStream<Uint8Array>,sink:NodeJS.WriteStream)=>{const reader=stream.getReader(),decoder=new TextDecoder();let text='';const done=(async()=>{try{for(;;){const {done,value}=await reader.read();if(done)break;sink.write(value);text+=decoder.decode(value,{stream:true});}}catch{}})();return {done,stop:()=>{void reader.cancel().catch(()=>{});return text+decoder.decode();}};};
 const out=pump(child.stdout,process.stdout),err=pump(child.stderr,process.stderr);
 const code=await child.exited;await Promise.race([Promise.all([out.done,err.done]),Bun.sleep(1_500)]);
 const n=result.commands.length+1,ended=nowIso(),text=out.stop()+err.stop();
 appendFileSync(join(dir,'commands.txt'),[`=== #${n} ${started} -> ${ended} exit ${code}`,`argv: ${redact(JSON.stringify(a.rest))}`,`cwd: ${SOURCE}`,'--- stdout then stderr (secrets removed) ---',redact(text).replace(/\s+$/,''),''].join('\n')+'\n');
 result.commands.push({n,argv:a.rest.map(redact),started_at:started,ended_at:ended,exit:code});saveResult(dir,result);
 console.log(`recorded command #${n} (exit ${code}) in ${join(dir,'commands.txt')}`);return code;
}
function psJson(script:string):Record<string,unknown>|undefined{
 try{const r=Bun.spawnSync([windowsPowerShell(),'-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{stdin:'ignore',stdout:'pipe',stderr:'pipe',windowsHide:true,timeout:QUERY_TIMEOUT_MS});
  return r.exitCode===0?JSON.parse(new TextDecoder().decode(r.stdout)):undefined;}catch{return undefined;}
}
const ENV_SCRIPT=[
 "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.Encoding]::UTF8",
 "$os=Get-CimInstance Win32_OperatingSystem;$ubr=$null;try{$ubr=(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion').UBR}catch{}",
 "$edge=$null;foreach($b in @(${env:ProgramFiles(x86)},$env:ProgramFiles,$env:LOCALAPPDATA)){if($b){$p=Join-Path $b 'Microsoft\\Edge\\Application\\msedge.exe';if(Test-Path -LiteralPath $p){$edge=$p;break}}}",
 "$ev=$null;if($edge){$ev=(Get-Item -LiteralPath $edge).VersionInfo.ProductVersion}",
 "[Console]::Out.Write((ConvertTo-Json -Compress -InputObject @{caption=$os.Caption;version=$os.Version;build=$os.BuildNumber;ubr=$ubr;os_arch=$os.OSArchitecture;processor=$env:PROCESSOR_ARCHITECTURE;processor_w6432=$env:PROCESSOR_ARCHITEW6432;powershell=$PSVersionTable.PSVersion.ToString();edge=$edge;edge_version=$ev}))",
].join('\n');
function environment(a:Args):number{
 requireWindows();const dir=runDir(flag(a,'--run')),result=loadResult(dir),b=result.binding,install=b.install_dir;
 const markerPath=join(install,'.termweave-owned.json');
 if(!existsSync(markerPath))throw new Refused(`no install at ${install} yet (no .termweave-owned.json); run install.ps1 --dir "${install}" through exec first`);
 const marker=readJson(markerPath) as Marker|undefined;
 let canonical:string|undefined;try{canonical=realpathSync.native(install);}catch{}
 const problems=bindingProblems({initHead:b.candidate_head,currentHead:git('rev-parse','HEAD'),initDir:install,canonicalDir:canonical,initAtMs:Date.parse(b.init_at),marker,markerMtimeMs:existsSync(markerPath)?statSync(markerPath).mtimeMs:undefined});
 const state=readLifecycle(install),os=psJson(ENV_SCRIPT)??{};
 const bunPath=findExecutable('bun'),herdrPath=findExecutable('herdr');
 b.source_sha=typeof marker?.source_sha==='string'?marker.source_sha:null;b.marker_root=typeof marker?.root==='string'?marker.root:null;b.bound_at=nowIso();b.problems=problems;
 if(state)b.port=state.port;
 writeEvidence(dir,'environment.txt',[
  `recorded at ${b.bound_at}`,`candidate HEAD (init ${b.init_at}): ${b.candidate_head}`,`marker.source_sha: ${b.source_sha??'(none)'}`,`install dir: ${install}`,`marker.root: ${b.marker_root??'(none)'}`,
  `binding: ${problems.length?`FAILED\n  - ${problems.join('\n  - ')}`:'ok (source_sha == candidate HEAD == current HEAD, marker.root == install dir, marker newer than init)'}`,
  `tracked changes in the source checkout at init: ${b.tracked_changes}`,
  `OS: ${os.caption??'(unknown)'} ${os.version??''} build ${os.build??'?'}.${os.ubr??'?'}  OS architecture ${os.os_arch??'?'}  PROCESSOR_ARCHITECTURE ${os.processor??'?'}${os.processor_w6432?` (W6432 ${os.processor_w6432})`:''}  node arch ${process.arch}`,
  `Windows PowerShell: ${os.powershell??'(unknown)'}`,
  `Bun running this tool: ${Bun.version} at ${process.execPath}; bun found for install.ps1: ${bunPath?`${bunPath} ${toolVersion(bunPath)??'(version unknown)'}`:'(not found)'}`,
  `herdr: ${herdrPath?`${herdrPath} ${toolVersion(herdrPath)??'(version unknown)'}`:'(not found)'}`,
  `Edge: ${os.edge?`${os.edge} ${os.edge_version??''}`:'(not found)'}`,
  `recorded instance: ${state?`status ${state.status}, port ${state.port}, boot_id ${state.boot_id}, server pid ${state.pid}`:'lifecycle.json absent or unreadable (not running)'}`,
  `commands so far: ${result.commands.map(c=>`#${c.n} exit ${c.exit}: ${c.argv.join(' ')}`).join(' | ')||'(none recorded)'}`,
 ]);
 saveResult(dir,result);console.log(problems.length?`binding FAILED: ${problems.join('; ')}`:'binding ok');return problems.length?1:0;
}
async function pane(a:Args):Promise<number>{
 const dir=runDir(flag(a,'--run')),result=loadResult(dir);requireBound(result);
 if(result.test_owned)throw new Refused(`this run already owns workspace ${result.test_owned.workspace_id}`);
 const label=LABEL_PREFIX+result.run_id,cwd=mkdtempSync(join(tmpdir(),label+'-'));
 const created=await workspaceCreate({cwd,label});
 result.test_owned={workspace_id:created.workspace.workspace_id,pane_id:created.root_pane.pane_id,label,created_at:nowIso(),closed_at:null};saveResult(dir,result);
 console.log(`test-owned workspace ${created.workspace.workspace_id} (label ${label}), pane ${created.root_pane.pane_id}`);return 0;
}
/** The recorded test-owned pane, re-checked against herdr before anything is sent to it. */
async function ownedPane(result:Result){
 const owned=result.test_owned;if(!owned||owned.closed_at)throw new Refused('no open test-owned pane in this run; run `pane` first');
 const snapshot=await sessionSnapshot();const p=snapshot.panes.find(x=>x.pane_id===owned.pane_id);
 const w=snapshot.workspaces.find(x=>x.workspace_id===owned.workspace_id);
 if(!p||p.workspace_id!==owned.workspace_id||!w||w.label!==owned.label)throw new Refused(`pane ${owned.pane_id} is no longer the test-owned pane of workspace ${owned.workspace_id} (${owned.label}); nothing sent`);
 return owned;
}
async function paneClose(a:Args):Promise<number>{
 const dir=runDir(flag(a,'--run')),result=loadResult(dir),owned=await ownedPane(result);
 await workspaceClose(owned.workspace_id);result.test_owned={...owned,closed_at:nowIso()};saveResult(dir,result);
 console.log(`closed test-owned workspace ${owned.workspace_id}`);return 0;
}
async function edgeBefore(a:Args):Promise<number>{
 requireWindows();const dir=runDir(flag(a,'--run')),result=loadResult(dir);requireBound(result);
 const mode=flag(a,'--mode')??'app';if(mode!=='app'&&mode!=='pwa')throw new Refused('--mode is app or pwa');
 const port=result.binding.port;if(!port)throw new Refused('no recorded port; the instance was not running at `environment`');
 const url=`http://127.0.0.1:${port}`,state=readLifecycle(result.binding.install_dir),probe=await bridgeProbe(port),full=await fullHealthOk(port),os=psJson(ENV_SCRIPT)??{};
 let panes='herdr snapshot unavailable';
 try{const s=await sessionSnapshot();panes=`${s.workspaces.length} workspace(s), ${s.panes.length} pane(s); test-owned pane ${result.test_owned?.pane_id??'(none)'} ${result.test_owned&&s.panes.some(p=>p.pane_id===result.test_owned!.pane_id)?'present':'absent'}`;}catch(error){panes+=`: ${(error as Error).message}`;}
 writeEvidence(dir,'edge.before.txt',[
  `recorded at ${nowIso()}`,`mode: ${mode==='app'?'Edge app window':'installed PWA'}`,`URL: ${url}`,
  `launch: ${mode==='app'?`"${os.edge??'msedge.exe'}" --app=${url}`:`open ${url} in Edge, then Apps > Install this site as an app (no shortcut is created by TermWeave)`}`,
  `Edge: ${os.edge??'(not found)'} ${os.edge_version??''}`,
  `bridge probe: ${probe.kind==='boot'?`boot ${probe.boot_id} (${probe.boot_id===state?.boot_id?'matches lifecycle.json':'does NOT match lifecycle.json'})`:'silent'}`,
  `full /api/health (herdr included): ${full?'ok':'not ok'}`,`herdr: ${panes}`,
  `to check by hand (then record with edge-after): workspace/pane list (AC-B1), split in the test-owned workspace (AC-B2), input round trip (AC-B3), agent icon (AC-B4), Needs-you seen by the user (AC-B5), app/PWA core use (AC-U1)`,
 ]);
 saveResult(dir,result);return 0;
}
function verdicts(a:Args,allowed:readonly Ac[]):{ac:Ac;status:Status}[]{
 const list=(a.flags.get('--verdict')??[]).map(v=>{const [ac,status]=v.split('=');if(!(allowed as readonly string[]).includes(ac!)||!(STATUSES as readonly string[]).includes(status!))throw new Refused(`--verdict ${v}: expected one of ${allowed.join(', ')} = ${STATUSES.join('|')}`);return {ac:ac as Ac,status:status as Status};});
 if(!list.length)throw new Refused('at least one --verdict AC=status is required');return list;
}
const who=(a:Args)=>{const by=need(a,'--by');if(by!=='user'&&by!=='agent')throw new Refused('--by is user or agent');return by;};
function edgeAfter(a:Args):number{
 const dir=runDir(flag(a,'--run')),result=loadResult(dir);if(!existsSync(join(dir,'edge.before.txt')))throw new Refused('run edge-before first');
 const by=who(a),note=flag(a,'--note')??'',list=verdicts(a,EDGE_ACS);
 if(list.some(v=>v.ac==='AC-B5')&&by!=='user')throw new Refused('AC-B5 (Needs-you) is confirmed by the user');
 // Verdicts are applied in memory first, so a refused one leaves no edge.after.txt behind.
 for(const v of list)setAc(result,v.ac,{status:v.status,by,note,evidence:['edge.before.txt','edge.after.txt']});
 writeEvidence(dir,'edge.after.txt',[`recorded at ${nowIso()}`,`confirmed by: ${by}`,...list.map(v=>`${v.ac}: ${v.status}`),`note: ${note||'(none)'}`]);
 saveResult(dir,result);return 0;
}
function verdict(a:Args):number{
 const dir=runDir(flag(a,'--run')),result=loadResult(dir),ac=need(a,'--ac') as Ac,status=need(a,'--status') as Status;
 if(!(ACS as readonly string[]).includes(ac)||!(STATUSES as readonly string[]).includes(status))throw new Refused(`--ac ${ac} --status ${status} is not a bundle AC and status`);
 const evidence=(a.flags.get('--evidence')??[]).map(name=>{if(!(FILES as readonly string[]).includes(name)||!existsSync(join(dir,name)))throw new Refused(`--evidence ${name} is not an evidence file of this run`);return name as EvidenceFile;});
 setAc(result,ac,{status,by:who(a),note:need(a,'--note'),evidence});saveResult(dir,result);return 0;
}
async function imeBefore(a:Args):Promise<number>{
 const dir=runDir(flag(a,'--run')),result=loadResult(dir);requireBound(result);
 const file=need(a,'--sentences'),expected=need(a,'--sha256').toLowerCase(),source=need(a,'--source'),ime=need(a,'--ime');
 const bytes=readFileSync(file),hash=sha256(bytes);if(hash!==expected)throw new Refused(`${file} has SHA-256 ${hash}, not the given ${expected}`);
 const sentences=parseSentenceFile(bytes),owned=await ownedPane(result),nonce=randomBytes(6).toString('hex'),script=captureScript(nonce);
 if(result.ime||existsSync(join(dir,'ime.before.txt')))throw new Refused('ime-before already ran in this run; start a new run id');
 await paneSendText(owned.pane_id,`powershell.exe -NoProfile -EncodedCommand ${Buffer.from(script,'utf16le').toString('base64')}`);await paneSendKeys(owned.pane_id,['Enter']);
 writeEvidence(dir,'ime.before.txt',[
  `recorded at ${nowIso()}`,`original: ${resolve(file)}  SHA-256 ${hash}`,`provenance: ${source}`,`IME condition: ${ime}`,
  `test-owned pane ${owned.pane_id} in workspace ${owned.workspace_id} (${owned.label})`,`capture nonce: ${nonce}`,
  `sentences (exact text between the brackets; JSON form shows every code point; length in code points):`,
  ...sentences.map((s,i)=>`${i+1}. [${s}]  json ${JSON.stringify(s)}  length ${Array.from(s).length}`),
  `capture program started in the test-owned pane (powershell.exe -NoProfile -EncodedCommand):`,...script.split('\n').map(line=>`  ${line}`),
  `extraction rule: ${extractionRule(nonce)}`,
 ]);
 result.ime={nonce,sentences,sentences_sha256:hash,source,matched:null,captured:null};saveResult(dir,result);
 console.log(`capture started in pane ${owned.pane_id}. The user now types the ${SENTENCE_COUNT} sentences in Edge (one per line, Enter after each); then run ime-after.`);
 return 0;
}
async function imeAfter(a:Args):Promise<number>{
 const dir=runDir(flag(a,'--run')),result=loadResult(dir);if(!result.ime)throw new Refused('run ime-before first');
 const owned=await ownedPane(result),{sentences,sentences_sha256}=result.ime;
 // The original file may or may not end with one newline; either way its SHA-256 must still describe these sentences.
 const joined=sentences.join('\n');
 if(sentences.length!==SENTENCE_COUNT||(sha256(joined)!==sentences_sha256&&sha256(joined+'\n')!==sentences_sha256))throw new Refused('the recorded sentences no longer match their SHA-256');
 const links=linkProblems(dir,result);if(links.length)throw new Refused(`evidence changed: ${links.join('; ')}`);
 if(existsSync(join(dir,'ime.after.txt'))||existsSync(join(dir,'ime.pane-read.json')))throw new Refused('ime-after already ran in this run; a result is never overwritten (start a new run id)');
 const params={pane_id:owned.pane_id,source:'recent_unwrapped',format:'text',strip_ansi:true,lines:1000};
 const at=nowIso(),response=await herdrRpc<{read?:{text?:unknown;truncated?:unknown}}>('pane.read',params);
 writeFileSync(join(dir,'ime.pane-read.json'),JSON.stringify({at,request:{method:'pane.read',params},response},null,1)+'\n',{flag:'wx'});
 const text=typeof response.read?.text==='string'?response.read.text:'';const captured=extractSentences(text,result.ime.nonce),cmp=compareAll(sentences,captured);
 const rawHash=sha256(readFileSync(join(dir,'ime.pane-read.json')));
 writeEvidence(dir,'ime.after.txt',[
  `recorded at ${at}`,`raw pane.read answer: ime.pane-read.json  SHA-256 ${rawHash}  (herdr result as server/herdr/client.ts herdrRpc decoded it; truncated=${String(response.read?.truncated)})`,
  `extraction rule: ${extractionRule(result.ime.nonce)}`,`captured lines: ${captured.length} (expected ${SENTENCE_COUNT})`,
  ...cmp.sentences.map(s=>`${s.sentence}. ${s.match?'MATCH':'MISMATCH'}  expected length ${s.expected_length}  actual length ${s.actual_length??'(not captured)'}${s.first_mismatch?`  first mismatch at index ${s.first_mismatch.index}: expected ${s.first_mismatch.expected??'(end)'} actual ${s.first_mismatch.actual??'(end)'}`:''}  actual json ${JSON.stringify(captured[s.sentence-1]??null)}`),
  ...captured.slice(SENTENCE_COUNT).map((s,i)=>`extra capture ${SENTENCE_COUNT+i+1}: json ${JSON.stringify(s)}`),
  `result: ${cmp.matched}/${SENTENCE_COUNT}${cmp.pass?' PASS':' FAIL'}`,
 ]);
 result.ime={...result.ime,matched:cmp.matched,captured:captured.length};
 setAc(result,'AC-U2',{status:cmp.pass?'pass':'fail',by:'agent',note:`${cmp.matched}/${SENTENCE_COUNT} sentences exact (spaces included), ${captured.length} captured`,evidence:['ime.before.txt','ime.after.txt','ime.pane-read.json']},'ime-after');
 saveResult(dir,result);console.log(`AC-U2 ${cmp.matched}/${SENTENCE_COUNT} ${cmp.pass?'PASS':'FAIL'}`);return cmp.pass?0:1;
}
function stopBefore(a:Args):number{
 requireWindows();const dir=runDir(flag(a,'--run')),result=loadResult(dir);requireBound(result);
 if(result.stop)throw new Refused('stop-before already ran in this run');
 const state=readLifecycle(result.binding.install_dir),table=processTable(),at=nowIso();
 const filterRule=`argv[1] equals (case-insensitive, normalized; no prefix match) ${roots(result).map(r=>`${win32.join(r,'scripts','owned-server.ts')} with argv[2]=start and 3 args, or ${win32.join(r,'server','index.ts')} with 2 args`).join('; or ')}; servers checked against an owned launcher parent that started no later; a bun.exe with unreadable command line blocks`;
 const head=[`recorded at ${at}`,`install dir ${result.binding.install_dir}`,`filter: ${filterRule}`];
 if(!state){writeEvidence(dir,'stop.before.txt',[...head,'lifecycle.json absent or unreadable: no running instance to stop (N>0 not shown)']);setAc(result,'AC-I5',{status:'fail',by:'agent',note:'nothing running before stop',evidence:['stop.before.txt']},'stop-after');saveResult(dir,result);return 1;}
 const recorded:OwnerRecord[]=[{pid:state.pid,startedAt:state.startedAt,exe:state.exe},...(state.launcher?[state.launcher]:[])];
 if(!table.ok){writeEvidence(dir,'stop.before.txt',[...head,`BLOCKED: process query failed (${table.blocked}); N is unknown, not 0`]);setAc(result,'AC-I5',{status:'blocked',by:'agent',note:`process query blocked: ${table.blocked}`,evidence:['stop.before.txt']},'stop-after');saveResult(dir,result);return 1;}
 const {owned,unreadable}=ownedProcesses(table.rows,roots(result),recorded),herdr=named(table.rows,'herdr.exe'),edge=named(table.rows,'msedge.exe');
 const server=owned.find(o=>o.role==='server'&&o.recorded),launcher=state.launcher?owned.find(o=>o.role==='launcher'&&o.recorded):undefined;
 const problems=[...(unreadable.length?[`BLOCKED: ${unreadable.length} bun.exe process(es) with an unreadable command line`]:[]),...(owned.length===0?['N=0 before stop']:[]),...(!server?['the recorded server pid+CreationDate is not among the owned processes']:[]),...(state.launcher&&!launcher?['the recorded launcher pid+CreationDate is not among the owned processes']:[])];
 writeEvidence(dir,'stop.before.txt',[...head,`recorded instance: port ${state.port}, boot_id ${state.boot_id}, server pid ${state.pid} started ${state.startedAt??'?'}, launcher ${state.launcher?`pid ${state.launcher.pid} started ${state.launcher.startedAt??'?'}`:'(not recorded)'}`,
  `N (owned launcher/server processes) = ${owned.length}`,...owned.map(describeOwned),...unreadable.map(row=>`unreadable: ${describeRow(row)}`),
  `lifecycle.json: present (status ${state.status})`,`herdr processes: ${herdr.length}`,...herdr.map(describeRow),`Edge processes: ${edge.length}${edge.length?` (first: ${describeRow(edge[0]!)})`:''}`,
  `verdict: ${problems.length?problems.join('; '):'N>0 with the recorded server (and launcher) present'}`]);
 if(problems.length){setAc(result,'AC-I5',{status:unreadable.length?'blocked':'fail',by:'agent',note:problems.join('; '),evidence:['stop.before.txt']},'stop-after');saveResult(dir,result);return 1;}
 result.stop={port:state.port,boot_id:state.boot_id,at,n:owned.length,server:recorded[0]!,launcher:state.launcher,herdr,edge};saveResult(dir,result);
 console.log(`N=${owned.length} before stop. Now: bun scripts/windows-native-acceptance.ts exec --run ${result.run_id} -- powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 --stop --dir "${result.binding.install_dir}"`);return 0;
}
async function stopAfter(a:Args):Promise<number>{
 requireWindows();const dir=runDir(flag(a,'--run')),result=loadResult(dir),before=result.stop;if(!before)throw new Refused('run stop-before first');
 const command=[...result.commands].reverse().find(c=>c.started_at>=before.at&&(c.argv.includes('--stop')||c.argv.includes('stop')));
 if(!command)throw new Refused('no stop command was recorded with `exec` after stop-before');
 const lines=[`recorded at ${nowIso()}`,`stop command #${command.n} exit ${command.exit}: ${command.argv.join(' ')}`],problems:string[]=[];let blocked=false;
 for(let i=1;i<=3;i++){
  if(i>1)await Bun.sleep(1_000);
  const table=processTable();if(!table.ok){blocked=true;lines.push(`observation ${i}: BLOCKED (${table.blocked}); N unknown, not 0`);continue;}
  const {owned,unreadable}=ownedProcesses(table.rows,roots(result));
  lines.push(`observation ${i} at ${nowIso()}: N = ${owned.length}`,...owned.map(describeOwned),...unreadable.map(row=>`unreadable: ${describeRow(row)}`));
  if(unreadable.length){blocked=true;lines.push(`observation ${i}: BLOCKED by ${unreadable.length} unreadable bun.exe command line(s)`);}
  if(owned.length)problems.push(`observation ${i}: N=${owned.length}`);
  if(i===3){
   const alive=(rows:readonly ProcRow[])=>rows.filter(r=>table.rows.some(x=>x.pid===r.pid&&x.created===r.created));
   const herdr=alive(before.herdr),edge=alive(before.edge);
   lines.push(`herdr preserved: ${herdr.length}/${before.herdr.length} process(es) from before still alive with the same CreationDate`,`Edge preserved: ${edge.length}/${before.edge.length}`);
   if(herdr.length!==before.herdr.length)problems.push('a herdr process from before is gone');
   if(edge.length!==before.edge.length)problems.push('an Edge process from before is gone');
  }
 }
 for(const [what,owner] of [['server',before.server],['launcher',before.launcher]] as const){
  if(!owner)continue;const identity=queryIdentity(owner.pid),verdict=matchOwner(owner,identity);
  lines.push(`recorded ${what} pid ${owner.pid} (${owner.startedAt??'?'}): ${identity.state}${identity.startedAt?` started ${identity.startedAt}`:''} -> ${verdict}`);
  if(verdict==='match')problems.push(`recorded ${what} still alive`);if(verdict==='uncertain'){blocked=true;lines.push(`BLOCKED: ${what} identity ${identity.state}${identity.detail?` (${identity.detail})`:''}`);}
 }
 const stateGone=!existsSync(join(result.binding.install_dir,'lifecycle.json')),probe=await bridgeProbe(before.port);
 const listenerClosed=!(probe.kind==='boot'&&probe.boot_id===before.boot_id);
 lines.push(`lifecycle.json: ${stateGone?'deleted':'STILL PRESENT'}`,`port ${before.port}: ${probe.kind==='silent'?'no answer (listener closed)':probe.boot_id===before.boot_id?'STILL ANSWERS with the stopped boot':`answers with another boot ${probe.boot_id}`}`);
 if(command.exit!==0)problems.push(`stop command exit ${command.exit}`);if(!stateGone)problems.push('lifecycle.json still present');if(!listenerClosed)problems.push('the stopped boot still answers');
 const status:Status=blocked?'blocked':problems.length?'fail':'pass';
 lines.push(`N before ${before.n} -> after ${problems.some(p=>p.includes('N='))?'>0':blocked?'unknown':'0'}`,`verdict: ${status}${problems.length?` (${problems.join('; ')})`:''}`);
 writeEvidence(dir,'stop.after.txt',lines);
 setAc(result,'AC-I5',{status,by:'agent',note:status==='pass'?`N ${before.n} -> 0 in 3 observations; state deleted, listener closed, herdr/Edge kept`:problems.join('; ')||'blocked',evidence:['stop.before.txt','stop.after.txt','commands.txt']},'stop-after');
 saveResult(dir,result);console.log(`AC-I5 ${status}`);return status==='pass'?0:1;
}
function finish(a:Args):number{
 const dir=runDir(flag(a,'--run')),result=loadResult(dir),url=flag(a,'--ci-run'),push=flag(a,'--push-sha');
 if((url===undefined)!==(push===undefined))throw new Refused('--ci-run and --push-sha go together');
 if(url&&push)result.ci={run_url:url,push_sha:push,matches_candidate:push===result.binding.candidate_head};
 const g3c=flag(a,'--g3c');if(g3c)result.g3c=g3c;
 saveResult(dir,result);return status(dir,result);
}
function status(dir:string,result:Result):number{
 const links=linkProblems(dir,result);
 console.log(`run ${result.run_id}  candidate ${result.binding.candidate_head}  dir ${result.binding.install_dir}  binding ${result.binding.bound_at?result.binding.problems.length?'FAILED':'ok':'not checked'}`);
 for(const ac of ACS)console.log(`  ${ac.padEnd(6)} ${result.ac[ac].status.padEnd(8)} ${result.ac[ac].by??''} ${result.ac[ac].note}`);
 console.log(`CI: ${result.ci?`${result.ci.run_url} (${result.ci.matches_candidate?'push SHA = candidate':'push SHA differs from candidate'})`:'not recorded'}  3G-C: ${result.g3c??'not recorded'}`);
 console.log(`evidence links: ${links.length?links.join('; '):'ok'}\nreal-machine pass: ${result.real_machine_pass}`);
 return links.length?1:0;
}

// ---- self-test ---------------------------------------------------------------------------------------------------------------
function expect(condition:boolean,message:string){if(!condition)throw new Error(message);}
function selfTest():number{
 const checks:{name:string;run:()=>void}[]=[
  {name:'text comparison keeps spaces and code points exactly (no trim, no normalization)',run:()=>{
   const ok=compareSentence(1,'안녕 하세요','안녕 하세요');expect(ok.match&&ok.first_mismatch===null,'identical text must match');
   const trailing=compareSentence(2,'가나 다','가나 다 ');expect(!trailing.match&&trailing.first_mismatch?.index===4&&trailing.first_mismatch.actual==='U+0020'&&trailing.actual_length===5,'a trailing space must be a mismatch at index 4 (U+0020)');
   const leading=compareSentence(3,'가나',' 가나');expect(!leading.match&&leading.first_mismatch?.index===0,'a leading space must be a mismatch at index 0');
   expect(compareSentence(7,' 앞뒤 공백 ',' 앞뒤 공백 ').match,'an original with edge spaces matches the same text exactly');
   const lost=compareSentence(8,'가나 ','가나');expect(!lost.match&&lost.first_mismatch?.index===2&&lost.first_mismatch.expected==='U+0020'&&lost.first_mismatch.actual===null,'a trailing space of the original that did not arrive is a mismatch at index 2');
   const nfd=compareSentence(4,'한글','한글'.normalize('NFD'));expect(!nfd.match&&nfd.first_mismatch?.index===0&&nfd.first_mismatch.expected==='U+D55C'&&nfd.first_mismatch.actual==='U+1112','NFD jamo must not equal the NFC syllable');
   const nbsp=compareSentence(5,'가 나','가\u00A0나');expect(!nbsp.match&&nbsp.first_mismatch?.actual==='U+00A0','NBSP must not equal a space');
   const missing=compareSentence(6,'가',undefined);expect(!missing.match&&missing.actual_length===null,'a missing capture must fail');
   const nine=Array.from({length:SENTENCE_COUNT},(_,i)=>`문장 ${i+1} 입니다`);
   expect(compareAll(nine,nine).pass&&compareAll(nine,nine).matched===9,'nine exact captures are 9/9');
   expect(!compareAll(nine,[...nine,'추가']).pass,'a tenth capture fails the run');
   const nonce='a1b2c3',pane=['PS> x',`TWIME ${nonce} << 앞 공백>>`,`TWIME ${nonce} <<뒤 공백 >>   `,`TWIME ${nonce} <<a>>b>>\r`,'TWIME ffffff <<other run>>',`TWIME ${nonce} <<no end`].join('\n');
   const got=extractSentences(pane,nonce);expect(JSON.stringify(got)===JSON.stringify([' 앞 공백','뒤 공백 ','a>>b']),`extraction must keep inner spaces exactly, got ${JSON.stringify(got)}`);
   expect(JSON.stringify(parseSentenceFile(new TextEncoder().encode(nine.map(s=>` ${s} `).join('\n')+'\n')))===JSON.stringify(nine.map(s=>` ${s} `)),'sentence file lines are kept untrimmed');
   for(const bad of [nine.join('\r\n'),'\uFEFF'+nine.join('\n'),nine.slice(0,8).join('\n'),[...nine.slice(0,8),''].join('\n')+'\n'])expect((()=>{try{parseSentenceFile(new TextEncoder().encode(bad));return false;}catch(e){return e instanceof Refused;}})(),'CRLF, BOM, 8 lines and empty lines are refused');
  }},
  {name:'process filter: exact owned launcher/server boundary, parent/start time, blocked queries',run:()=>{
   const root='C:\\Users\\u\\AppData\\Local\\tw-run1',bun='C:\\Users\\u\\.bun\\bin\\bun.exe';
   const row=(pid:number,parent:number,commandLine:string|null,created:string|null,exe:string|null=bun):ProcRow=>({pid,parent,exe,commandLine,created});
   const rows=[
    row(10,5,`${bun} c:\\users\\U\\appdata\\local\\TW-RUN1\\scripts\\owned-server.ts start`,'2026-10-23T01:00:00.0000000Z'),
    row(11,10,`"${bun}" ${root}\\server\\index.ts`,'2026-10-23T01:00:01.0000000Z'),
    row(20,5,`${bun} ${root}0\\scripts\\owned-server.ts start`,'2026-10-23T01:00:00.0000000Z'),
    row(21,20,`${bun} ${root}-old\\server\\index.ts`,'2026-10-23T01:00:01.0000000Z'),
    row(22,5,`${bun} ${root}\\scripts\\owned-server.ts.bak start`,'2026-10-23T01:00:00.0000000Z'),
    row(23,5,`${bun} ${root}\\server\\index.ts.old`,'2026-10-23T01:00:00.0000000Z'),
    row(24,5,`${bun} ${root}\\scripts\\owned-server.ts start --extra`,'2026-10-23T01:00:00.0000000Z'),
    row(25,5,`${bun} ${root}\\scripts\\owned-server.ts`,'2026-10-23T01:00:00.0000000Z'),
    row(30,4,'"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --app=http://127.0.0.1:7317','2026-10-23T00:00:00.0000000Z','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'),
    row(31,4,'herdr.exe server','2026-10-23T00:00:00.0000000Z','C:\\h\\herdr.exe'),
   ];
   const {owned,unreadable}=ownedProcesses(rows,[root],[{pid:11,startedAt:'2026-10-23T01:00:01.0000000Z'}]);
   expect(JSON.stringify(owned.map(o=>o.pid))==='[10,11]',`only the exact owned launcher and server match (no prefix, suffix or extra-argument match), got ${JSON.stringify(owned.map(o=>o.pid))}`);
   expect(unreadable.length===0,'no unreadable rows here');
   expect(owned[1]!.recorded&&!owned[0]!.recorded&&owned[1]!.parent_check==='child of owned launcher 10','the server is recorded and a child of the owned launcher');
   const reused=ownedProcesses([rows[0]!,row(12,10,`${bun} ${root}\\server\\index.ts`,'2026-10-23T00:59:59.0000000Z')],[root]).owned[1]!;
   expect(reused.parent_check.includes('reused'),'a server older than its parent launcher is flagged as pid reuse');
   const orphan=ownedProcesses([row(13,999,`${bun} ${root}\\server\\index.ts`,'2026-10-23T01:00:00.0000000Z')],[root]).owned;
   expect(orphan.length===1&&orphan[0]!.parent_check.includes('not an owned launcher'),'an orphan owned server still counts');
   expect(ownedProcesses([row(14,5,null,null)],[root]).unreadable.length===1,'a bun.exe with an unreadable command line is reported');
   const denied=parseCimTable(2,JSON.stringify({error:'PermissionDenied',message:'Access denied'}));expect(!denied.ok&&denied.blocked.includes('PermissionDenied'),'a denied query is blocked, not zero processes');
   expect(!parseCimTable(0,'not json').ok&&!parseCimTable(0,JSON.stringify({rows:[]})).ok,'unparseable or empty answers are blocked');
   const parsed=parseCimTable(0,JSON.stringify({rows:[{ProcessId:10,ParentProcessId:5,ExecutablePath:bun,CommandLine:'x',Created:'2026-10-23T01:00:00.1234567Z'}]}));
   expect(parsed.ok&&parsed.rows[0]!.created==='2026-10-23T01:00:00.1234567Z','CreationDate is kept exact');
   const secret='abcDEF123ghiJKL456mnoPQR789stuVWX0yz';
   expect(!redact(`bun x --token ${secret} HERDR_WEB_TOKEN=${secret} sk-0123456789abcdefXYZ`).includes(secret)&&redact(`sha 0123456789abcdef0123456789abcdef01234567`).includes('0123456789abcdef0123456789abcdef01234567'),'secrets are removed and a git SHA is kept');
  }},
  {name:'binding: candidate HEAD, marker.source_sha and install dir must agree',run:()=>{
   const head='a'.repeat(40),dir='C:\\Users\\u\\AppData\\Local\\tw-run1',init=Date.parse('2026-10-23T01:00:00Z');
   const good={initHead:head,currentHead:head,initDir:dir,initAtMs:init,marker:{product:'termweave',root:dir,source_sha:head},markerMtimeMs:init+60_000};
   expect(bindingProblems(good).length===0,`a fresh install of the candidate is bound: ${bindingProblems(good).join('; ')}`);
   expect(bindingProblems({...good,marker:{...good.marker,source_sha:'b'.repeat(40)}}).some(p=>p.includes('source_sha')),'a marker.source_sha that differs from the candidate HEAD is rejected');
   expect(bindingProblems({...good,currentHead:'c'.repeat(40)}).some(p=>p.includes('HEAD moved')),'a HEAD that moved after init is rejected');
   expect(bindingProblems({...good,marker:{...good.marker,root:dir+'0'}}).some(p=>p.includes('marker.root')),'a marker for another dir is rejected');
   expect(bindingProblems({...good,markerMtimeMs:init-3_600_000}).some(p=>p.includes('reused')),'a marker older than init (reused install) is rejected');
   expect(bindingProblems({...good,marker:undefined}).length===1,'a missing marker is rejected');
  }},
  {name:'evidence links and result schema (self-test is never a real-machine pass)',run:()=>{
   const dir=mkdtempSync(join(tmpdir(),'tw-acceptance-selftest-'));
   try{
    const binding={candidate_head:'a'.repeat(40),install_dir:'C:\\x',port:7317,init_at:nowIso(),tracked_changes:0,source_sha:'a'.repeat(40),marker_root:'C:\\x',bound_at:nowIso(),problems:[]};
    const r=newResult('real-machine','link-check',binding);writeFileSync(join(dir,'stop.before.txt'),'N = 2\n');writeFileSync(join(dir,'stop.after.txt'),'N = 0\n');
    r.files=hashFiles(dir);r.ac['AC-I5']={status:'pass',by:'agent',at:nowIso(),note:'',evidence:['stop.before.txt','stop.after.txt']};
    expect(linkProblems(dir,r).length===0&&schemaProblems(r).length===0,`a consistent run links cleanly: ${[...linkProblems(dir,r),...schemaProblems(r)].join('; ')}`);
    writeFileSync(join(dir,'stop.after.txt'),'N = 1\n');expect(linkProblems(dir,r).some(p=>p.includes('changed')),'an edited evidence file is detected');
    r.ac['AC-U2'].evidence=['ime.after.txt'];expect(linkProblems(dir,r).some(p=>p.includes('ime.after.txt')),'a citation of an unrecorded file is detected');
    expect(!realMachinePass(r),'a run without every real-machine AC and CI is not a pass');
    const self=newResult('self-test','self-test',binding);expect(schemaProblems(self).length===0&&self.not_real_machine_evidence&&!self.real_machine_pass,'a self-test result is marked as not real-machine evidence');
    expect(schemaProblems({...self,real_machine_pass:true}).length>0&&schemaProblems({...self,not_real_machine_evidence:false}).length>0,'a self-test claiming a real-machine pass is invalid');
    expect(schemaProblems({...r,ac:{...r.ac,'AC-I1':{...r.ac['AC-I1'],status:'ok'}}}).length>0,'an unknown AC status is invalid');
    expect((()=>{try{setAc(r,'AC-U2',{status:'pass',by:'user',note:'',evidence:[]});return false;}catch(e){return e instanceof Refused;}})(),'a measured AC cannot be set by hand');
    setAc(r,'AC-B1',{status:'fail',by:'user',note:'',evidence:[]});expect((()=>{try{setAc(r,'AC-B1',{status:'pass',by:'user',note:'',evidence:[]});return false;}catch(e){return e instanceof Refused;}})(),'a recorded failure is not overwritten');
   }finally{rmSync(dir,{recursive:true,force:true});}
  }},
 ];
 const outcomes=checks.map(check=>{try{check.run();console.log(`PASS  ${check.name}`);return {name:check.name,pass:true,error:null as string|null};}catch(error){console.log(`FAIL  ${check.name}\n      ${(error as Error).message}`);return {name:check.name,pass:false,error:(error as Error).message};}});
 const failed=outcomes.filter(o=>!o.pass).length,dir=join(EVIDENCE_ROOT,'self-test');mkdirSync(dir,{recursive:true});
 let head='(not a git checkout)';try{head=git('rev-parse','HEAD');}catch{}
 const result=newResult('self-test','self-test',{candidate_head:head,install_dir:'',port:null,init_at:nowIso(),tracked_changes:0,source_sha:null,marker_root:null,bound_at:null,problems:['self-test: no install is bound']});
 const problems=schemaProblems(result);
 writeFileSync(join(dir,'result.json'),JSON.stringify({...result,self_test:{checks:outcomes,note:'Interface self-test of scripts/windows-native-acceptance.ts. It is not real-machine evidence and never a real-machine pass.'}},null,1)+'\n');
 if(problems.length)console.log(`FAIL  self-test result.json schema: ${problems.join('; ')}`);
 console.log(`${failed||problems.length?'FAIL':'PASS'}  ${checks.length-failed}/${checks.length} self-test checks; ${join(dir,'result.json')} (kind self-test, not_real_machine_evidence true)`);
 return failed||problems.length?1:0;
}

export const USAGE=`Usage: bun scripts/windows-native-acceptance.ts <command> [options]
  --self-test                          interface self-test only (never real-machine evidence)
  init --run ID --dir NEW_DIR [--port N]  bind the candidate HEAD to a new install dir (refuses an existing dir)
  exec --run ID -- COMMAND...          run COMMAND and log argv, exit code and output (secrets removed) to commands.txt
  environment --run ID                 read only: assert source_sha/HEAD/dir binding; OS/arch/PowerShell/Bun/herdr/Edge versions
  pane --run ID                        create one test-owned herdr workspace (label ${LABEL_PREFIX}ID)
  edge-before --run ID [--mode app|pwa]  read only: URL, launch command, bridge/full health, herdr counts
  edge-after --run ID --by user|agent --verdict AC-B1=pass ... [--note TEXT]   AC-B1..B5, AC-U1 (AC-B5 by the user)
  ime-before --run ID --sentences FILE --sha256 HEX --source TEXT --ime TEXT   record the original and start the capture in the test-owned pane
  ime-after --run ID                   read only: raw pane.read, extraction, per-sentence comparison, n/9 (AC-U2)
  stop-before --run ID                 read only: owned launcher/server processes (N>0), recorded pids, herdr/Edge
  stop-after --run ID                  read only: N=0 in three observations, recorded pids gone, state/listener, herdr/Edge kept (AC-I5)
  verdict --run ID --ac AC --status pass|fail|blocked|not-run --by user|agent --note TEXT [--evidence FILE]
  pane-close --run ID                  close the test-owned workspace of this run only
  finish --run ID [--ci-run URL --push-sha SHA] [--g3c not-triggered|TEXT]
  status --run ID                      read only: AC table, evidence links, real-machine pass
Evidence: evidence/windows-native/<run-id>/. Each evidence file is written once; a failed run is kept, start a new run id.`;
export async function main(argv:string[]):Promise<number>{
 const a=parse(argv);
 if(a.flags.has('--self-test'))return selfTest();
 const command=a.positional[0];
 if(!command||a.flags.has('--help')||a.flags.has('-h')){console.log(USAGE);return command?0:1;}
 switch(command){
  case 'init':return init(a);
  case 'exec':return exec(a);
  case 'environment':return environment(a);
  case 'pane':return pane(a);
  case 'pane-close':return paneClose(a);
  case 'edge-before':return edgeBefore(a);
  case 'edge-after':return edgeAfter(a);
  case 'ime-before':return imeBefore(a);
  case 'ime-after':return imeAfter(a);
  case 'stop-before':return stopBefore(a);
  case 'stop-after':return stopAfter(a);
  case 'verdict':return verdict(a);
  case 'finish':return finish(a);
  case 'status':{const dir=runDir(flag(a,'--run'));return status(dir,loadResult(dir));}
  default:console.error(`Unknown command: ${command}\n${USAGE}`);return 1;
 }
}
if(import.meta.main){
 try{process.exitCode=await main(process.argv.slice(2));}
 catch(error){
  if(error instanceof Refused){console.error(`refused: ${error.message}`);process.exitCode=1;}
  else if(error instanceof HerdrError){console.error(`herdr ${error.code}: ${error.message} (start herdr yourself, then rerun)`);process.exitCode=1;}
  else throw error;
 }
}
