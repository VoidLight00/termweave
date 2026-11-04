import {existsSync,readFileSync,readlinkSync} from 'node:fs';import {win32} from 'node:path';
import type {Identity} from './lifecycle-lock.ts';import {envValue,type Env} from './lifecycle-env.ts';
import {createdIso,windowsProcessInfo} from '../server/windows-process-info.ts';
/**
 * One identity adapter for every lifecycle record and comparison (A-5). `startedAt` is an exact, adapter-specific token compared
 * only for equality with a value recorded by the same adapter: Windows the kernel's creation time read in-process (no PowerShell
 * spawn) and spelled as CIM CreationDate in UTC ISO, Linux `<btime>:<starttime ticks>` from /proc, other POSIX the `ps` lstart text. A failed query is `error` (or `denied`), never `gone`:
 * only a successful query that finds no such process proves the PID is free.
 */
export type ProcessIdentity=Identity&{pid:number;commandLine?:string;parentPid?:number;detail?:string};
/** A process query (`ps`, or a PowerShell CIM table read by the acceptance tool) that stalls is killed here and reported as `error`. */
export const QUERY_TIMEOUT_MS=15_000;
const SELF=new Map<number,ProcessIdentity>();
/** Default identity probe for lifecycle-lock/state callers. The own process never changes identity, so its first live answer is reused. */
export function processIdentity(pid:number):ProcessIdentity{
 const cached=pid===process.pid?SELF.get(pid):undefined;if(cached)return cached;
 const identity=queryIdentity(pid);
 if(pid===process.pid&&identity.state==='alive')SELF.set(pid,identity);
 return identity;
}
/** One uncached OS query. */
export function queryIdentity(pid:number):ProcessIdentity{
 if(!Number.isSafeInteger(pid)||pid<=0)return {state:'error',pid,detail:`invalid pid ${pid}`};
 return process.platform==='win32'?windowsIdentity(pid):process.platform==='linux'?linuxIdentity(pid):psIdentity(pid);
}
/** `<SystemRoot>\System32\WindowsPowerShell\v1.0\powershell.exe` only for a plain absolute drive path; no PATH lookup, no relative or `..` root. */
export function windowsPowerShell(env:Env=process.env):string{
 const root=envValue(env,'SystemRoot','win32');
 if(!root||!/^[A-Za-z]:\\[^\\/:*?"<>|]+(?:\\[^\\/:*?"<>|]+)*$/.test(root)||win32.normalize(root)!==root||root.split('\\').some(part=>part==='.'||part==='..'))throw new Error(`Invalid SystemRoot: ${JSON.stringify(root??null)}`);
 const exe=win32.join(root,'System32','WindowsPowerShell','v1.0','powershell.exe');
 if(!existsSync(exe))throw new Error(`Windows PowerShell not found at ${exe}`);
 return exe;
}
/** The kernel's answer for one PID (server/windows-process-info.ts), with the start time spelled as CIM CreationDate. */
function windowsIdentity(pid:number):ProcessIdentity{
 const info=windowsProcessInfo(pid);
 if(info.state!=='alive')return info;
 const {createdTicks,parentPid,exe,commandLine}=info;
 return {state:'alive',pid,startedAt:createdIso(createdTicks),parentPid,exe,commandLine};
}
const fsCode=(error:unknown)=>String((error as {code?:unknown})?.code??'unknown');
/** Pure: `/proc/<pid>/stat` (comm may contain spaces and parentheses) with the boot time, as `<btime>:<starttime>` and the parent PID. */
export function parseProcStat(stat:string,btime:string):{startedAt:string;parentPid:number}|undefined{
 const close=stat.lastIndexOf(')');if(close<0)return undefined;
 const fields=stat.slice(close+2).trim().split(/\s+/);const parentPid=Number(fields[1]),start=fields[19];
 if(!Number.isSafeInteger(parentPid)||!start||!/^\d+$/.test(start))return undefined;
 return {startedAt:`${btime}:${start}`,parentPid};
}
function linuxIdentity(pid:number):ProcessIdentity{
 let stat:string,btime:string|undefined;
 try{stat=readFileSync(`/proc/${pid}/stat`,'utf8');btime=/^btime (\d+)$/m.exec(readFileSync('/proc/stat','utf8'))?.[1];}
 catch(error){const code=fsCode(error);return {state:code==='ENOENT'||code==='ESRCH'?'gone':code==='EACCES'||code==='EPERM'?'denied':'error',pid,detail:code};}
 const parsed=btime?parseProcStat(stat,btime):undefined;if(!parsed)return {state:'error',pid,detail:'unparseable /proc stat'};
 const optional=<T>(read:()=>T)=>{try{return read();}catch{return undefined;}};
 const exe=optional(()=>readlinkSync(`/proc/${pid}/exe`));
 const commandLine=optional(()=>readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0').filter(Boolean).join(' '));
 return {state:'alive',pid,startedAt:parsed.startedAt,parentPid:parsed.parentPid,exe,commandLine};
}
/** Pure: `ps -o ppid=,lstart=` output (parent PID then the fixed five-word start time). Empty output means no such process. */
export function parsePsStart(text:string):{startedAt:string;parentPid:number}|undefined{
 const match=/^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s*$/.exec(text);if(!match)return undefined;
 return {parentPid:Number(match[1]),startedAt:match[2]!.replace(/\s+/g,' ')};
}
function psIdentity(pid:number):ProcessIdentity{
 const ps=(field:string)=>{const result=Bun.spawnSync(['/bin/ps','-o',field,'-p',String(pid)],{stdin:'ignore',stdout:'pipe',stderr:'pipe',timeout:QUERY_TIMEOUT_MS});return {code:result.exitCode,out:result.stdout.toString(),err:result.stderr.toString()};};
 try{
  const start=ps('ppid=,lstart=');
  // ps exits 1 with no rows (and no diagnostic) for a missing PID; anything else is a failed query.
  if(start.code===1&&!start.out.trim()&&!start.err.trim())return {state:'gone',pid};
  const parsed=start.code===0?parsePsStart(start.out):undefined;if(!parsed)return {state:'error',pid,detail:`ps exit ${start.code}: ${start.err.trim()}`};
  const comm=ps('comm='),args=ps('args=');
  return {state:'alive',pid,startedAt:parsed.startedAt,parentPid:parsed.parentPid,exe:comm.code===0&&comm.out.trim()?comm.out.trim():undefined,commandLine:args.code===0&&args.out.trim()?args.out.trim():undefined};
 }catch(error){return {state:'error',pid,detail:String((error as Error).message)};}
}
