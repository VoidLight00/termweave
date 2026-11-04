import {afterAll,beforeAll,describe,expect,it} from 'bun:test';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {dirname,join} from 'node:path';
import {cliPort} from './install-lifecycle.ts';
import {findExecutable} from './lifecycle-env.ts';
import {stateFile} from './lifecycle-state.ts';
import {bridgeProbe} from './lifecycle-launch.ts';
import {processIdentity,type ProcessIdentity} from './process-identity.ts';
import {OWNED_STOP_PATH} from '../shared/machines.ts';
import {windowsProcessTable} from '../server/windows-processes.ts';
/**
 * The TS entry as install.ps1 drives it: a child `bun scripts/install-lifecycle.ts <command>` with one merged Path, whose exit code
 * install.ps1 passes through. Covers what lifecycle-env.test.ts (parseArgs, prerequisites, check/install units) and owned-stop.test.ts
 * (real launcher, stop protocol, stop --port mismatch) do not: CLI exit codes 0/1/2 end to end, CLI-level option precedence over the
 * environment, and the recorded-port rule for check and start plus PORT never counting as an explicit stop/start port.
 */
const CLI=join(import.meta.dir,'install-lifecycle.ts'),T=120_000;

describe('cliPort: only a command-line --port is explicit',()=>{
 it('reads --port, skips the value of --dir, and ignores everything else',()=>{
  expect(cliPort(['stop','--port','8123'])).toBe(8123);
  expect(cliPort(['stop','--dir','--port'])).toBeUndefined();
  expect(cliPort(['start','--dir','C:\\x','--port','7400','--no-start'])).toBe(7400);
  expect(cliPort(['start','--yes'])).toBeUndefined();
 });
});

describe.if(process.platform==='win32')('install-lifecycle CLI as install.ps1 runs it (stand-in owned instance)',()=>{
 let base='',root='',port=0,otherPort=0,stand:ReturnType<typeof Bun.spawn>|undefined,identity:ProcessIdentity|undefined;
 const boot='boot-'+crypto.randomUUID();
 const git=findExecutable('git');
 /** The environment install.ps1 hands over: one `Path` key with git, Bun and a herdr stand-in; profile and herdr state isolated. */
 const cliEnv=(extra:Record<string,string>={},{herdr=true}:{herdr?:boolean}={})=>{
  const env:Record<string,string>={};
  for(const [key,value] of Object.entries(process.env))if(value!==undefined&&!['PATH','PORT','TERMWEAVE_INSTALL_DIR'].includes(key.toUpperCase()))env[key]=value;
  return {...env,Path:[dirname(process.execPath),dirname(git!),...(herdr?[join(base,'tools')]:[]),join(process.env.SystemRoot??'C:\\Windows','System32')].join(';'),
   PATHEXT:'.COM;.EXE;.BAT;.CMD',USERPROFILE:join(base,'home'),LOCALAPPDATA:join(base,'home','AppData','Local'),HERDR_SOCKET:join(base,'no-herdr.sock'),HERDR_WEB_STATE_DIR:join(base,'state'),...extra};
 };
 async function cli(args:string[],env:Record<string,string>=cliEnv()){
  const child=Bun.spawn([process.execPath,CLI,...args],{cwd:base,env,stdin:'ignore',stdout:'pipe',stderr:'pipe',windowsHide:true});
  const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  return {code,out,err};
 }
 const freePort=()=>{const probe=Bun.serve({port:0,hostname:'127.0.0.1',fetch:()=>new Response('')});const value=probe.port!;probe.stop(true);return value;};
 const flag=(name:string,on:boolean)=>on?writeFileSync(join(base,`flag-${name}`),''):rmSync(join(base,`flag-${name}`),{force:true});
 const stopLog=()=>join(base,'stop-requests.log');
 beforeAll(async()=>{
  expect(git).toBeDefined();
  base=realpathSync(mkdtempSync(join(tmpdir(),'tw-ilc-')));root=join(base,'owned');
  for(const dir of [root,join(base,'tools'),join(base,'home','AppData','Local')])mkdirSync(dir,{recursive:true});
  writeFileSync(join(base,'tools','herdr.cmd'),'@echo herdr 0.9.1\r\n');
  writeFileSync(join(root,'.termweave-owned.json'),'{}');
  // Stands in for the owned server: bridge probe with this boot id, full health ok unless flag-herdr-off, every stop request refused.
  writeFileSync(join(base,'stand-in.ts'),`import {appendFileSync,existsSync} from 'node:fs';import {join} from 'node:path';
const dir=import.meta.dir,boot=process.env.TW_BOOT;
Bun.serve({port:Number(process.env.TW_PORT),hostname:'127.0.0.1',fetch(request){const url=new URL(request.url);
 if(url.pathname==='/api/health'&&url.searchParams.get('scope')==='bridge')return Response.json({ok:true,boot_id:boot});
 if(url.pathname==='/api/health')return existsSync(join(dir,'flag-herdr-off'))?Response.json({error:{code:'herdr_unavailable'}},{status:503}):Response.json({ok:true});
 if(url.pathname===${JSON.stringify(OWNED_STOP_PATH)}){appendFileSync(join(dir,'stop-requests.log'),request.method+' '+request.headers.get('host')+'\\n');return Response.json({error:{code:'fixture_refuses'}},{status:403});}
 return new Response('stand-in',{status:404});}});
`);
  port=freePort();otherPort=port===65535?port-1:port+1;
  stand=Bun.spawn([process.execPath,join(base,'stand-in.ts')],{cwd:base,env:{...process.env,TW_PORT:String(port),TW_BOOT:boot},stdin:'ignore',stdout:'ignore',stderr:'ignore',windowsHide:true});
  for(const deadline=Date.now()+20_000;(await bridgeProbe(port)).kind!=='boot';await Bun.sleep(100))if(Date.now()>deadline)throw new Error('stand-in did not answer');
  identity=processIdentity(stand.pid);expect(identity.state).toBe('alive');
  writeFileSync(stateFile(root),JSON.stringify({status:'running',pid:stand.pid,startedAt:identity.startedAt,exe:identity.exe,port,boot_id:boot,stop_token:'t'.repeat(48)}));
 },T);
 afterAll(async()=>{
  // Ends only the stand-in this file started, and only while its kernel identity (start time) is still the one recorded.
  if(stand&&identity){const now=processIdentity(stand.pid);if(now.state==='alive'&&now.startedAt===identity.startedAt)stand.kill();await stand.exited;}
  const left=(await windowsProcessTable()).filter(row=>(row.commandLine??'').toLowerCase().includes(base.toLowerCase()));
  expect(left).toEqual([]);
  rmSync(base,{recursive:true,force:true});
 },T);

 it('exit codes end to end: 0 owned and healthy, 1 herdr not ready or not installed, 2 prerequisite missing, 0 help, 1 usage',async()=>{
  const running=await cli(['check','--dir',root]);
  expect([running.code,running.err]).toEqual([0,'']);
  expect(running.out).toContain(`ok    own instance running on port ${port} (boot ${boot})`);
  flag('herdr-off',true);
  const herdrOff=await cli(['check','--dir',root]);flag('herdr-off',false);
  expect(herdrOff.code).toBe(1);expect(herdrOff.err).toContain(`MISS  herdr is not ready: http://127.0.0.1:${port}/api/health is not ok`);
  const absent=await cli(['check','--dir',join(base,'never')]);
  expect(absent.code).toBe(1);expect(absent.err).toContain(`MISS  not installed at ${join(base,'never')}`);
  const noHerdr=await cli(['check','--dir',root],cliEnv({},{herdr:false}));
  expect(noHerdr.code).toBe(2);expect(noHerdr.err).toContain('MISS  herdr not found. Fix: irm https://herdr.dev/install.ps1 | iex');
  for(const command of ['install','start'])expect([command,(await cli([command,'--dir',join(base,'never2')],cliEnv({},{herdr:false}))).code]).toEqual([command,command==='install'?2:1]);
  const help=await cli(['--help']);expect(help.code).toBe(0);expect(help.out).toContain('Usage: bun scripts/install-lifecycle.ts');
  const usage=await cli(['check','--bogus']);expect(usage.code).toBe(1);expect(usage.err).toContain('Unknown argument: --bogus');
  expect(existsSync(join(base,'never'))).toBe(false);expect(existsSync(join(base,'never2'))).toBe(false);
 },T);

 it('options: the command line beats TERMWEAVE_INSTALL_DIR and PORT, whose names match case-insensitively',async()=>{
  const fromEnv=await cli(['check'],cliEnv({TERMWEAVE_INSTALL_DIR:root}));
  expect(fromEnv.code).toBe(0);expect(fromEnv.out).toContain(`ok    installed at ${root}`);
  const lower=await cli(['check'],cliEnv({termweave_install_dir:root}));
  expect(lower.code).toBe(0);expect(lower.out).toContain(`ok    installed at ${root}`);
  const cliDir=await cli(['check','--dir',root],cliEnv({TERMWEAVE_INSTALL_DIR:join(base,'never')}));
  expect(cliDir.code).toBe(0);expect(cliDir.out).toContain(`ok    installed at ${root}`);
  const badEnvPort=await cli(['check','--dir',root],cliEnv({PORT:'abc'}));
  expect([badEnvPort.code,badEnvPort.err.split('\n')[0]]).toEqual([1,'Invalid port: abc']);
  expect((await cli(['check','--dir',root,'--port',String(otherPort)],cliEnv({PORT:'abc'}))).code).toBe(0);
  expect((await cli(['check','--dir',root],cliEnv({PORT:''}))).code).toBe(0);
 },T);

 it('recorded port: check and start use it, an explicit other --port fails start and stop, PORT is never explicit',async()=>{
  const recorded=readFileSync(stateFile(root),'utf8');
  const checked=await cli(['check','--dir',root,'--port',String(otherPort)]);
  expect(checked.code).toBe(0);expect(checked.out).toContain(`ok    own instance running on port ${port} (boot ${boot})`);
  const startOther=await cli(['start','--dir',root,'--port',String(otherPort)]);
  expect(startOther.code).toBe(1);
  expect(startOther.err).toContain(`FAIL  already running on port ${port}; stop it first (bun scripts/install-lifecycle.ts stop --dir "${root}"), then start with --port ${otherPort}`);
  expect(readFileSync(stateFile(root),'utf8')).toBe(recorded);expect(existsSync(join(root,'server.log'))).toBe(false);
  const startEnv=await cli(['start','--dir',root],cliEnv({PORT:String(otherPort)}));
  expect(startEnv.code).toBe(0);expect(startEnv.out).toContain(`ok    already running on http://127.0.0.1:${port}`);
  expect((await cli(['start','--dir',root,'--port',String(port)])).code).toBe(0);
  expect(readFileSync(stateFile(root),'utf8')).toBe(recorded);expect(existsSync(join(root,'server.log'))).toBe(false);
  const stopOther=await cli(['stop','--dir',root,'--port',String(otherPort)]);
  expect(stopOther.code).toBe(1);expect(stopOther.err).toContain(`--port ${otherPort} does not match the recorded port ${port}; no request was sent to either port`);
  expect(existsSync(stopLog())).toBe(false);
  // PORT names another port, yet the one stop request goes to the recorded port (where the stand-in refuses it).
  const stopEnv=await cli(['stop','--dir',root],cliEnv({PORT:String(otherPort)}));
  expect(stopEnv.code).toBe(1);expect(stopEnv.err).toContain('FAIL  stop: the server refused the stop request (HTTP 403 fixture_refuses)');
  expect(stopEnv.err).not.toContain('t'.repeat(48));
  expect(readFileSync(stopLog(),'utf8')).toBe(`POST 127.0.0.1:${port}\n`);
  expect(JSON.parse(readFileSync(stateFile(root),'utf8'))).toMatchObject({status:'running',port,boot_id:boot});
 },T);
});
