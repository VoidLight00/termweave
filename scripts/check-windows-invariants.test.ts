import {afterAll,beforeAll,describe,expect,it} from 'bun:test';
import {cpSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {dirname,join,resolve} from 'node:path';
// @ts-expect-error -- plain .mjs guard without declarations
import {BIND_FILE,INPUT_FILES,INSTALL_PS1,LAUNCH_FILE,LIFECYCLE_FILE,SPAWN_FILES,STATE_FILE,checkInvariants,powershellHost} from './check-windows-invariants.mjs';
/**
 * Detection power of scripts/check-windows-invariants.mjs: each guard runs on a temp copy of the files it reads with exactly one
 * deliberate violation and must fail with its own message; the unmutated copy and the repository itself pass every guard.
 */
const repo=resolve(import.meta.dir,'..'),GUARD=join(import.meta.dir,'check-windows-invariants.mjs'),T=60_000;
const FILES=[...new Set([...SPAWN_FILES,...Object.values(INPUT_FILES) as string[],INSTALL_PS1,BIND_FILE,STATE_FILE,LIFECYCLE_FILE,LAUNCH_FILE])];
// The PowerShell AST checks need powershell/pwsh. Windows always has it (the guard fails there without it); a POSIX host without
// pwsh cannot parse install.ps1 at all, so those cases are skipped only there (GitHub ubuntu/macOS images ship pwsh).
const noPowerShell=!powershellHost()&&process.platform!=='win32';
let base:string;let copies=0;
beforeAll(()=>{base=mkdtempSync(join(tmpdir(),'tw-invariants-'));});
afterAll(()=>{rmSync(base,{recursive:true,force:true});});
/** A copy of the guarded files (plus the whole server tree the reusePort scan walks, when `server`) with `from` replaced by `to` in `file`. */
function fixture(file?:string,from?:string,to?:string,server=true,also:[string,string]=['','']):string{
 const root=join(base,String(copies++));
 if(server)cpSync(join(repo,'server'),join(root,'server'),{recursive:true,filter:path=>!/[\\/]node_modules(?:[\\/]|$)/.test(path)});
 for(const rel of FILES){mkdirSync(dirname(join(root,rel)),{recursive:true});cpSync(join(repo,rel),join(root,rel));}
 if(file){
  const text=readFileSync(join(root,file),'utf8');
  // the mutation must hit exactly one place, else the fixture no longer says what it tests
  let mutated=text;
  for(const [a,b] of [[from!,to!],also].filter(([a])=>a)){expect(mutated.split(a).length-1).toBe(1);mutated=mutated.replace(a,()=>b);}
  writeFileSync(join(root,file),mutated);
 }
 return root;
}
const failures=(root:string,guard:string)=>{const result=checkInvariants(root,{only:[guard]});expect(result.skips).toEqual([]);return result.failures as string[];};
/** The mutated copy (`also`: a second edit of the same file) fails `guard`, and only with lines matching `message`. */
function violates(guard:string,file:string,from:string,to:string,message:RegExp,also?:[string,string]){
 const lines=failures(fixture(file,from,to,guard==='reuse-port',also),guard);
 expect(lines.length).toBeGreaterThan(0);
 for(const line of lines)expect(line).toMatch(message);
}

describe('the repository and its unmutated copy pass',()=>{
 it.skipIf(noPowerShell)('every guard passes on the repository and on the fixture copy',()=>{
  for(const root of [repo,fixture()]){const result=checkInvariants(root);expect(result.failures).toEqual([]);expect(result.skips).toEqual([]);expect(result.passed).toEqual(['lifecycle-env','input-path','install-ps1','reuse-port','liveness']);}
 },T);
 it.skipIf(noPowerShell)('the CLI exits 0 on the repository and 1 with the violation on a mutated copy',()=>{
  const ok=Bun.spawnSync([process.execPath,GUARD],{cwd:repo,stdout:'pipe',stderr:'pipe'});
  expect(ok.exitCode).toBe(0);expect(ok.stdout.toString()).toContain('PASS[windows-invariants] 5 of 5 guards passed');
  const root=fixture(BIND_FILE,'  const server = Bun.serve<SocketData>({\n','  const server = Bun.serve<SocketData>({\n    reusePort: true,\n');
  const bad=Bun.spawnSync([process.execPath,GUARD,'--root',root],{cwd:repo,stdout:'pipe',stderr:'pipe'});
  expect(bad.exitCode).toBe(1);expect(bad.stderr.toString()).toMatch(/FAIL\[reuse-port\] server\/index\.ts:\d+ sets reusePort/);
 },T);
});

describe('lifecycle-env: spawns get their env from buildChildEnv only',()=>{
 it('an env built by spreading process.env fails',()=>violates('lifecycle-env','scripts/owned-server.ts','env:buildChildEnv(process.env,{PORT:String(port),','env:({...process.env,PORT:String(port),',
  /^\[lifecycle-env\] scripts\/owned-server\.ts:\d+ Bun\.spawn env is `\(\{\.\.\.process\.env.*`, not a direct buildChildEnv\(\.\.\.\) call from scripts\/lifecycle-env\.ts$/));
 it('a spawn without env (inheriting the raw parent) fails',()=>violates('lifecycle-env','scripts/owned-install.ts','{cwd:sourceRoot,env:buildChildEnv(process.env),encoding','{cwd:sourceRoot,encoding',
  /^\[lifecycle-env\] scripts\/owned-install\.ts:\d+ execFileSync sets no env: the child inherits the raw parent environment/));
 it('options spread from another object fail',()=>violates('lifecycle-env','scripts/lifecycle-launch.ts','{cwd:root,detached:true,','{...{},cwd:root,detached:true,',
  /^\[lifecycle-env\] scripts\/lifecycle-launch\.ts:\d+ spawn options spread another object/));
 it('a Bun shell command fails',()=>violates('lifecycle-env','scripts/install-lifecycle.ts','export const DEFAULT_PORT=7317;','export const DEFAULT_PORT=7317;await Bun.$`git status`;',
  /^\[lifecycle-env\] scripts\/install-lifecycle\.ts:\d+ runs a Bun shell command, whose env bypasses buildChildEnv$/));
});

describe('input-path: composition -> sendInput -> send_text',()=>{
 it('sendData no longer sending through socket.sendInput fails',()=>violates('input-path',INPUT_FILES.pane,'if (socket.sendInput(current, input)) {','if (socket.submit(current, input, input)) {',
  /^\[input-path\] src\/components\/PaneTerminal\.tsx sendData does not call socket\.sendInput\(pane, input\)$/));
 it('the onData handler not calling sendData fails',()=>violates('input-path',INPUT_FILES.pane,'      sendData(data);\n    });\n    const sendData','      void data;\n    });\n    const sendData',
  /^\[input-path\] src\/components\/PaneTerminal\.tsx term\.onData handler does not call sendData\(data\)/));
 it('dropped compositionend listeners fail',()=>violates('input-path',INPUT_FILES.pane,'host.addEventListener("compositionend", imeCompositionEnd, true);','host.addEventListener("blur", imeCompositionEnd, true);',
  /^\[input-path\] src\/components\/PaneTerminal\.tsx listens for no compositionend/,['host.addEventListener("compositionend", compositionEnd);','host.addEventListener("blur", compositionEnd);']));
 it('a ws input frame of another type fails',()=>violates('input-path',INPUT_FILES.ws,'try { this.rawSend({ type: "input", pane_id: paneId, text }); return true; }','try { this.rawSend({ type: "submit", pane_id: paneId, text } as never); return true; }',
  /^\[input-path\] src\/lib\/ws\.ts HerdrSocket\.sendInput\(paneId, text\) does not rawSend \{type: "input", pane_id: paneId, text\}$/));
 it('the server sending unshaped text on the mirror path fails',()=>violates('input-path',INPUT_FILES.server,'await paneSendText(message.pane_id, shaped);','await paneSendText(message.pane_id, text);',
  /^\[input-path\] server\/index\.ts case "input" never calls paneSendText\(message\.pane_id, shaped\) with shaped = await mirrorInput\(message\.text, \.\.\.\)$/));
 it('paneSendText calling another herdr method fails',()=>violates('input-path',INPUT_FILES.client,'await herdrRpc("pane.send_text", { pane_id: paneId, text }, socketPath);','await herdrRpc("pane.send_keys", { pane_id: paneId, text }, socketPath);',
  /^\[input-path\] server\/herdr\/client\.ts paneSendText\(paneId, text\) does not call herdrRpc\("pane\.send_text", \{pane_id: paneId, text\}\)$/));
});

describe('install-ps1: ASCII only, exit 0/1/2, no Invoke-Expression outside the child installer',()=>{
 it('a non-ASCII byte fails (byte scan, no PowerShell needed)',()=>{
  const lines=checkInvariants(fixture(INSTALL_PS1,'# Exit codes: 0 ok,','# Exit codes \u2014 0 ok,'),{only:['install-ps1']}).failures as string[];
  expect(lines).toContainEqual(expect.stringMatching(/^\[install-ps1\] install\.ps1:11 has a non-ASCII byte 0xe2 at offset \d+/));
 },T);
 it.skipIf(noPowerShell)('Invoke-Expression in the script itself fails',()=>violates('install-ps1',INSTALL_PS1,"  $common = @()\n","  $common = @()\n  iex 'Write-Line hi'\n",
  /^\[install-ps1\] install\.ps1:\d+ runs Invoke-Expression outside the child installer here-string \(\$ChildInstaller\): iex 'Write-Line hi'$/),T);
 it.skipIf(noPowerShell)('a second assignment to the child installer fails',()=>violates('install-ps1',INSTALL_PS1,"'@\nfunction Get-InstallerUrl","'@\n$ChildInstaller += \"`n\"\nfunction Get-InstallerUrl",
  /^\[install-ps1\] install\.ps1: \$ChildInstaller must be assigned exactly once, at script scope, from a single-quoted here-string$/),T);
 it.skipIf(noPowerShell)('the child installer read outside its encoded runner fails',()=>violates('install-ps1',INSTALL_PS1,"  $common = @()\n","  $common = @()\n  $null = $ChildInstaller.Length\n",
  /^\[install-ps1\] install\.ps1:\d+ reads \$ChildInstaller outside Invoke-OfficialInstaller's -EncodedCommand encoding: \$ChildInstaller\.Length$/),T);
 it.skipIf(noPowerShell)('a return code outside 0/1/2 on the exit path fails',()=>violates('install-ps1',INSTALL_PS1,'if ($null -eq $mutex) { return 1 }','if ($null -eq $mutex) { return 3 }',
  /^\[install-ps1\] install\.ps1:\d+ exit code outside 0\/1\/2: Invoke-Install line \d+: 3 is not 0, 1 or 2$/),T);
 it.skipIf(noPowerShell)('a computed exit code fails',()=>violates('install-ps1',INSTALL_PS1,'exit ([int]$exitCode)','exit ([int]$exitCode + 1)',
  /^\[install-ps1\] install\.ps1:\d+ exit code outside 0\/1\/2: .*\$exitCode \+ 1 is not a literal code, a variable or a call of this script's functions$/),T);
 it.skipIf(noPowerShell)('an official installer exit code passed through fails',()=>violates('install-ps1',INSTALL_PS1,'  $code = Wait-Child $process "the $Name installer"\n  if ($code -eq 0)','  $code = Wait-Child $process "the $Name installer"\n  if ($code -ne 0) { return $code }\n  if ($code -eq 0)',
  /^\[install-ps1\] install\.ps1:\d+ exit code outside 0\/1\/2: Invoke-Install line \d+: Invoke-Changing line \d+: Invoke-OfficialInstaller line \d+: Wait-Child line \d+: \$Process\.ExitCode is not a literal code/),T);
});

describe('reuse-port: the bind path never sets reusePort',()=>{
 it('reusePort on the server Bun.serve fails',()=>violates('reuse-port',BIND_FILE,'  const server = Bun.serve<SocketData>({\n','  const server = Bun.serve<SocketData>({\n    reusePort: process.platform !== "win32",\n',
  /^\[reuse-port\] server\/index\.ts:\d+ sets reusePort: on Windows a second server could share the bridge port$/),T);
 it('spread Bun.serve options fail',()=>violates('reuse-port',BIND_FILE,'  const server = Bun.serve<SocketData>({\n','  const server = Bun.serve<SocketData>({\n    ...{},\n',
  /^\[reuse-port\] server\/index\.ts:\d+ Bun\.serve options spread another object, which can carry reusePort$/),T);
 it('reusePort in another server module fails',()=>violates('reuse-port','server/mobile-relay/serve.ts','hostname: "127.0.0.1", port: options.port ?? 7341,','hostname: "127.0.0.1", reusePort: true, port: options.port ?? 7341,',
  /^\[reuse-port\] server\/mobile-relay\/serve\.ts:\d+ sets reusePort/),T);
});

describe('liveness: decide judges from the bridge probe alone',()=>{
 it('decide mixing in full health fails',()=>violates('liveness',STATE_FILE,"if(o.probe.kind==='silent')return","if(o.probe.kind==='silent'&&!(o as {health?:{ok:boolean}}).health?.ok)return",
  /^\[liveness\] scripts\/lifecycle-state\.ts:\d+ decide reads full health \(.*\); liveness must come from the bridge probe alone$/));
 it('an Observation carrying health fails',()=>violates('liveness',STATE_FILE,' probe?:Probe;budgetExpired?:boolean;',' probe?:Probe;healthOk?:boolean;budgetExpired?:boolean;',
  /^\[liveness\] scripts\/lifecycle-state\.ts:\d+ Observation carries full health: healthOk\?:boolean;$/));
 it('a caller handing decide a probe that is not the bridge probe fails',()=>violates('liveness',LIFECYCLE_FILE,'const probe=await bridgeProbe(decision.port);','const probe:Probe=await fullHealthOk(decision.port)?{kind:\'boot\',boot_id:\'\'}:{kind:\'silent\'};',
  /^\[liveness\] scripts\/install-lifecycle\.ts:\d+ (?:the function that calls decide reads full health \(fullHealthOk\)|decide gets a probe that is not `await bridgeProbe\(\.\.\.\)`: probe)$/));
 it('a bridge probe on the full health endpoint fails',()=>violates('liveness',LAUNCH_FILE,'${port}/api/health?scope=bridge`','${port}/api/health`',
  /^\[liveness\] scripts\/lifecycle-launch\.ts bridgeProbe does not fetch the bridge-only \/api\/health\?scope=bridge$/));
});
