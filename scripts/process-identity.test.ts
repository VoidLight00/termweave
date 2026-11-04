import {describe,expect,it} from 'bun:test';
import {matchOwner} from './lifecycle-lock.ts';
import {parseProcStat,parsePsStart,processIdentity,queryIdentity,windowsPowerShell} from './process-identity.ts';
import {createdIso,kernelVerdict,STATUS_ACCESS_DENIED,STATUS_INVALID_CID} from '../server/windows-process-info.ts';
const CREATED='2026-10-23T10:17:43.0622910Z',EXE='C:\\Users\\u\\.bun\\bin\\bun.exe';
/** A Bun child that has exited and been reaped: its PID is free right after. */
async function exitedPid(){const child=Bun.spawn([process.execPath,'-e','0'],{stdin:'ignore',stdout:'ignore',stderr:'ignore',windowsHide:true});await child.exited;return child.pid;}
describe('pure identity decisions (every platform)',()=>{
 it('spells a kernel creation time as CIM CreationDate does: UTC, microseconds, a seventh digit of 0',()=>{
  // 2026-10-23T10:17:43.0622910Z in 100 ns FILETIME ticks, plus 7 ticks CIM does not carry
  const ticks=BigInt(Date.parse('2026-10-23T10:17:43.062Z'))*10_000n+116_444_736_000_000_000n+2_910n+7n;
  expect(createdIso(ticks)).toBe(CREATED);
  expect(createdIso(116_444_736_000_000_000n)).toBe('1970-01-01T00:00:00.0000000Z');
 });
 it('a reused PID differs in start time and is a mismatch; the same record matches only its exact identity',()=>{
  const record={pid:4242,startedAt:CREATED,exe:EXE},alive=(over={})=>({state:'alive' as const,pid:4242,startedAt:CREATED,exe:EXE,...over});
  expect(matchOwner(record,alive())).toBe('match');
  expect(matchOwner(record,alive({startedAt:'2026-10-23T10:17:43.0622900Z'}))).toBe('mismatch');
  expect(matchOwner(record,alive({exe:'C:\\Windows\\System32\\notepad.exe'}))).toBe('mismatch');
  expect(matchOwner(record,{state:'gone'})).toBe('gone');
  expect(matchOwner(record,{state:'denied'})).toBe('uncertain');
  expect(matchOwner(record,{state:'error'})).toBe('uncertain');
 });
 it('parses /proc stat with a hostile comm and ps lstart output',()=>{
  const stat='4242 (a) b (c) S 17 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 100';
  expect(parseProcStat(stat,'1700000000')).toEqual({startedAt:'1700000000:987654',parentPid:17});
  expect(parseProcStat('garbage','1')).toBeUndefined();
  expect(parsePsStart('   17 Thu Oct 23 19:13:00 2026\n')).toEqual({parentPid:17,startedAt:'Thu Oct 23 19:13:00 2026'});
  expect(parsePsStart('   17 Thu Oct  3 19:13:00 2026\n')).toEqual({parentPid:17,startedAt:'Thu Oct 3 19:13:00 2026'});
  expect(parsePsStart('')).toBeUndefined();
 });
 it('uses only a validated absolute SystemRoot for powershell.exe',()=>{
  for(const root of [undefined,'','Windows','\\\\server\\share\\Windows','C:\\Windows\\..\\Temp','C:/Windows','C:\\Windows\\','C:\\Win"dows','C:\\Windows\\.'])
   expect(()=>windowsPowerShell({SystemRoot:root})).toThrow('Invalid SystemRoot');
  expect(()=>windowsPowerShell({SystemRoot:'C:\\definitely-not-windows-root'})).toThrow('Windows PowerShell not found');
 });
 it('maps every kernel answer to the state it proves: only no such id, an exit or another opened PID is gone',()=>{
  const opened=(status:number)=>kernelVerdict({pid:8,opened:status});
  expect(opened(STATUS_INVALID_CID)).toEqual({state:'gone',detail:'no such process'});
  expect(opened(STATUS_ACCESS_DENIED)).toEqual({state:'denied',detail:'NtOpenProcess 0xc0000022'});
  // STATUS_INVALID_PARAMETER, STATUS_ACCESS_VIOLATION, STATUS_UNSUCCESSFUL: a failed query, never a free PID
  for(const status of [0xc000000d,0xc0000005,0xc0000001])expect(opened(status)).toMatchObject({state:'error'});
  const queried=(over:object)=>kernelVerdict({pid:8,opened:0,timed:0,exitTime:0n,based:0,uniqueProcessId:8n,...over});
  expect(queried({})).toBeUndefined();
  expect(queried({exitTime:134_000_000_000_000_000n})).toEqual({state:'gone',detail:'exited'});
  expect(queried({timed:STATUS_ACCESS_DENIED})).toEqual({state:'denied',detail:'process times 0xc0000022'});
  expect(queried({timed:0xc0000001})).toEqual({state:'error',detail:'process times 0xc0000001'});
  // a failed times query leaves ExitTime unread: the failure decides, not the zeroed buffer
  expect(queried({timed:STATUS_INVALID_CID,exitTime:1n})).toEqual({state:'error',detail:'process times 0xc000000b'});
  expect(queried({based:STATUS_ACCESS_DENIED})).toEqual({state:'denied',detail:'basic information 0xc0000022'});
  expect(queried({based:0xc0000001,uniqueProcessId:0n})).toEqual({state:'error',detail:'basic information 0xc0000001'});
  expect(kernelVerdict({pid:9,opened:0,timed:0,exitTime:0n,based:0,uniqueProcessId:8n})).toEqual({state:'gone',detail:'no such process (the kernel opened pid 8)'});
 });
 it('rejects invalid PIDs without querying',()=>{
  for(const pid of [0,-1,1.5,Number.NaN])expect(queryIdentity(pid).state).toBe('error');
 });
});
describe.if(process.platform==='win32')('Windows kernel adapter',()=>{
 it('self lookup returns the exact creation time twice, with path, parent and command line',()=>{
  const first=queryIdentity(process.pid),second=queryIdentity(process.pid);
  expect(first.state).toBe('alive');expect(first.startedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}0Z$/);
  expect(second.startedAt).toBe(first.startedAt!);expect(first.exe?.toLowerCase()).toBe(process.execPath.toLowerCase());
  expect(first.parentPid).toBe(process.ppid);expect(first.commandLine).toContain('bun');
  expect(Math.abs(Date.parse(first.startedAt!)-(Date.now()-process.uptime()*1000))).toBeLessThan(2000);
  expect(processIdentity(process.pid)).toEqual(first);
 });
 it('names the start time, path and parent CIM reports for the same process',()=>{
  const own=queryIdentity(process.pid);
  const script=`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${process.pid}';[Console]::Out.Write(($p.CreationDate.ToUniversalTime().ToString('o'),$p.ExecutablePath,$p.ParentProcessId) -join '|')`;
  const cim=Bun.spawnSync([windowsPowerShell(),'-NoProfile','-NonInteractive','-Command',script],{stdout:'pipe',stderr:'pipe',windowsHide:true}).stdout.toString().split('|');
  expect([own.startedAt,own.exe,String(own.parentPid)]).toEqual(cim);
 },30_000);
 it('a child is alive with its own exact identity, then gone after it exits',async()=>{
  const child=Bun.spawn([process.execPath,'-e','setTimeout(()=>{},60000)'],{stdin:'ignore',stdout:'ignore',stderr:'ignore',windowsHide:true});
  try{
   const a=queryIdentity(child.pid),b=queryIdentity(child.pid);
   expect(a).toMatchObject({state:'alive',parentPid:process.pid});expect(b.startedAt).toBe(a.startedAt!);
   expect(matchOwner({pid:child.pid,startedAt:a.startedAt,exe:a.exe},b)).toBe('match');
  }finally{child.kill();await child.exited;}
  // gone at once, even while this process may still hold the exited child's handle
  expect(queryIdentity(child.pid).state).toBe('gone');
 });
 it('only a PID the kernel does not know, or an exited process, is gone; a refused open is denied and never gone',async()=>{
  expect(queryIdentity(await exitedPid()).state).toBe('gone');
  // the kernel ignores the low 2 bits of a PID, so this opens 4_294_967_288, which no process has
  expect(queryIdentity(4_294_967_291)).toMatchObject({state:'gone',detail:'no such process'});
  // the System process (PID 4): refused unless elevated, where the limited query may succeed; never gone, never this record's owner
  const system=queryIdentity(4);
  expect(system.state).not.toBe('gone');
  expect(['gone','match']).not.toContain(matchOwner({pid:4,startedAt:CREATED},system));
 });
 it('a PID with its low 2 bits set never reports the live process the kernel opens instead',async()=>{
  const child=Bun.spawn([process.execPath,'-e','setTimeout(()=>{},60000)'],{stdin:'ignore',stdout:'ignore',stderr:'ignore',windowsHide:true});
  try{
   expect(child.pid%4).toBe(0);expect(queryIdentity(child.pid).state).toBe('alive');
   for(const k of [1,2,3])expect(queryIdentity(child.pid+k)).toMatchObject({state:'gone',detail:`no such process (the kernel opened pid ${child.pid})`});
  }finally{child.kill();await child.exited;}
 });
 it('spells the creation time of several fresh processes byte for byte as one CIM query does',async()=>{
  // WMI rounding instead of truncating would pass one sample about half the time; eight pass together about once in 256 runs
  const children=Array.from({length:8},()=>Bun.spawn([process.execPath,'-e','setTimeout(()=>{},60000)'],{stdin:'ignore',stdout:'ignore',stderr:'ignore',windowsHide:true}));
  try{
   const kernel=Object.fromEntries(children.map(child=>[String(child.pid),queryIdentity(child.pid).startedAt]));
   const filter=children.map(child=>`ProcessId=${child.pid}`).join(' OR ');
   const script=`[Console]::Out.Write((Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { [string]$_.ProcessId+'|'+$_.CreationDate.ToUniversalTime().ToString('o') }) -join ',')`;
   const result=Bun.spawnSync([windowsPowerShell(),'-NoProfile','-NonInteractive','-Command',script],{stdout:'pipe',stderr:'pipe',windowsHide:true,timeout:30_000});
   expect(result.stderr.toString()).toBe('');
   const cim=Object.fromEntries(result.stdout.toString().split(',').filter(Boolean).map(line=>line.split('|')));
   expect(Object.keys(cim)).toHaveLength(8);expect(cim).toEqual(kernel);
  }finally{for(const child of children)child.kill();await Promise.all(children.map(child=>child.exited));}
 },30_000);
});
describe.if(process.platform!=='win32')('POSIX adapter',()=>{
 it('self lookup is exact and repeatable; an exited child is gone',async()=>{
  const first=queryIdentity(process.pid),second=queryIdentity(process.pid);
  expect(first.state).toBe('alive');expect(second.startedAt).toBe(first.startedAt!);expect(first.parentPid).toBe(process.ppid);
  expect(queryIdentity(await exitedPid()).state).toBe('gone');
 },30_000);
});
