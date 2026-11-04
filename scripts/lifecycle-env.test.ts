import {afterAll,describe,expect,it} from 'bun:test';import {chmodSync,existsSync,mkdirSync,mkdtempSync,readdirSync,rmSync,writeFileSync} from 'node:fs';import {join,posix,resolve,win32} from 'node:path';import {tmpdir} from 'node:os';
import {MIN_BUN,MIN_HERDR,WINDOWS_PRESERVED,buildChildEnv,defaultDirectories,envValue,findExecutable,isAliasCandidate,isDeniedEnv,versionGe} from './lifecycle-env.ts';
import {check,DEFAULT_PORT,install,main,parseArgs,type Context,type Options} from './install-lifecycle.ts';
import {canonicalPath} from './lifecycle-path.ts';import {lockPaths} from './lifecycle-lock.ts';
const win=process.platform==='win32';
const base=canonicalPath(mkdtempSync(join(tmpdir(),'tw-env-')));afterAll(()=>rmSync(base,{recursive:true,force:true}));
let serial=0;
const dir=(...parts:string[])=>{const path=resolve(base,...parts);mkdirSync(path,{recursive:true});return path;};
/** Fake executable (empty, never run): `<name>.exe` on Windows, an executable `<name>` elsewhere. */
const fake=(at:string,name:string,file=win?`${name}.exe`:name)=>{const path=join(dir(at),file);writeFileSync(path,'');chmodSync(path,0o755);return path;};
/** Profile-shaped env rooted at a fresh fixture home with the given PATH directories. */
const fixtureEnv=(pathDirs:string[],home=dir(`home-${++serial}`))=>({home,env:win?{USERPROFILE:home,LOCALAPPDATA:join(home,'AppData','Local'),PATHEXT:'.COM;.EXE;.BAT;.CMD',Path:pathDirs.join(';')}:{HOME:home,PATH:pathDirs.join(':')}});
const secrets={OPENAI_API_KEY:'sk-1',ANTHROPIC_API_KEY:'sk-2',ANTHROPIC_BASE_URL:'https://x',AWS_ACCESS_KEY_ID:'a',AWS_PROFILE:'p',GITHUB_TOKEN:'g',GH_TOKEN:'g',NPM_TOKEN:'n',HF_TOKEN:'h',SLACK_BOT_TOKEN:'s',STRIPE_SECRET:'s',DB_PASSWORD:'d',OPENAI_ORG:'o',GOOGLE_API_KEY:'k',openai_api_key:'lower'};

describe('buildChildEnv',()=>{
 const windowsParent={SYSTEMROOT:'C:\\Windows',WINDIR:'C:\\Windows',comspec:'C:\\Windows\\system32\\cmd.exe',PathExt:'.COM;.EXE',temp:'C:\\T',Tmp:'C:\\T',userprofile:'C:\\Users\\u',AppData:'C:\\Users\\u\\AppData\\Roaming',localappdata:'C:\\Users\\u\\AppData\\Local',UserName:'u',PATH:'C:\\bin'};
 it('keeps every required Windows variable under its canonical name',()=>{
  const env=buildChildEnv({...windowsParent,...secrets},{},'win32');
  expect(Object.fromEntries(WINDOWS_PRESERVED.map(name=>[name,env[name]]))).toEqual({SystemRoot:'C:\\Windows',windir:'C:\\Windows',ComSpec:'C:\\Windows\\system32\\cmd.exe',PATHEXT:'.COM;.EXE',TEMP:'C:\\T',TMP:'C:\\T',USERPROFILE:'C:\\Users\\u',APPDATA:'C:\\Users\\u\\AppData\\Roaming',LOCALAPPDATA:'C:\\Users\\u\\AppData\\Local',USERNAME:'u',Path:'C:\\bin'});
  expect(Object.keys(env).filter(key=>WINDOWS_PRESERVED.some(name=>name.toUpperCase()===key.toUpperCase())).sort()).toEqual([...WINDOWS_PRESERVED].sort());
  expect(WINDOWS_PRESERVED.filter(name=>isDeniedEnv(name)||isDeniedEnv(name.toUpperCase()))).toEqual([]);
 });
 it('inherits on Windows instead of applying the POSIX allowlist',()=>{
  expect(buildChildEnv({...windowsParent,HERDR_SOCKET:'pipe',CUSTOM_SETTING:'1'},{},'win32')).toMatchObject({HERDR_SOCKET:'pipe',CUSTOM_SETTING:'1',SystemRoot:'C:\\Windows'});
  const posixEnv=buildChildEnv({HOME:'/h',PATH:'/bin',CUSTOM_SETTING:'1',SystemRoot:'C:\\Windows',HERDR_SOCKET:'/s',HTTPS_PROXY:'http://proxy'},{PORT:'7317',HOST:'127.0.0.1'},'linux');
  expect(posixEnv).toEqual({HOME:'/h',PATH:'/bin',HERDR_SOCKET:'/s',HTTPS_PROXY:'http://proxy',LANG:'en_US.UTF-8',PORT:'7317',HOST:'127.0.0.1'});
 });
 it('merges Path/PATH spellings into one Path key on Windows',()=>{
  const env=buildChildEnv({PATH:'C:\\git\\bin;C:\\a',SystemRoot:'C:\\Windows',Path:'c:\\A\\;C:\\b;;C:\\git\\bin',path:'C:\\c'},{},'win32');
  expect(Object.keys(env).filter(key=>key.toUpperCase()==='PATH')).toEqual(['Path']);
  expect(env.Path).toBe('C:\\git\\bin;C:\\a;C:\\b;C:\\c');
  expect(envValue({PATH:'C:\\a',Path:'C:\\b'},'path','win32')).toBe('C:\\a;C:\\b');
  const overridden=buildChildEnv({PATH:'C:\\a',Path:'C:\\b',port:'1'},{path:'C:\\only',PORT:'7317'},'win32');
  expect([overridden.Path,overridden.PORT,Object.keys(overridden).length]).toEqual(['C:\\only','7317',2]);
  expect(envValue({PATH:'/a',Path:'/b'},'PATH','linux')).toBe('/a');
 });
 it('drops API keys and tokens on every platform but passes the user HERDR_WEB_TOKEN',()=>{
  for(const platform of ['win32','linux'] as const){
   const env=buildChildEnv({...windowsParent,HOME:'/h',HERDR_WEB_TOKEN:'web',HERDR_SOCKET:'s',TOKENIZERS_PARALLELISM:'false',KEYBOARD:'us',...secrets},{TERMWEAVE_STOP_TOKEN:'override passes'},platform);
   for(const name of Object.keys(secrets))expect([platform,name,env[name]]).toEqual([platform,name,undefined]);
   expect(Object.keys(env).filter(key=>isDeniedEnv(key)&&key!=='TERMWEAVE_STOP_TOKEN')).toEqual([]);
   expect([env.HERDR_WEB_TOKEN,env.HERDR_SOCKET,env.TERMWEAVE_STOP_TOKEN]).toEqual(['web','s','override passes']);
  }
  expect(isDeniedEnv('HERDR_WEB_TOKEN')).toBe(false);expect(isDeniedEnv('herdr_web_token')).toBe(false);
  for(const name of ['TOKENIZERS_PARALLELISM','KEYBOARD','PATHEXT','USERNAME','HERDR_SOCKET','ANTHROPIC'])expect([name,isDeniedEnv(name)]).toEqual([name,false]);
 });
 it('reaches a real child: required variables kept, secrets dropped, HOST/PORT overridden',()=>{
  const parent={...process.env,OPENAI_API_KEY:'sk-test',GH_TOKEN:'gh-test',HERDR_WEB_TOKEN:'web-test',HOST:'0.0.0.0'};
  const probe="const e=process.env;console.log(JSON.stringify({openai:e.OPENAI_API_KEY??null,gh:e.GH_TOKEN??null,web:e.HERDR_WEB_TOKEN??null,host:e.HOST,port:e.PORT,systemRoot:e.SystemRoot??null,path:!!e.PATH}))";
  const result=Bun.spawnSync([process.execPath,'-e',probe],{env:buildChildEnv(parent,{PORT:'7399',HOST:'127.0.0.1'}),stdout:'pipe',stderr:'pipe'});
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual({openai:null,gh:null,web:'web-test',host:'127.0.0.1',port:'7399',systemRoot:win?process.env.SystemRoot!:null,path:true});
 });
});

describe('findExecutable',()=>{
 it('searches the owned directory, then the official default location, then PATH',()=>{
  const owned=dir('order','owned'),onPath=dir('order','path');const {home,env}=fixtureEnv([onPath]);
  const [defaultBun]=defaultDirectories('bun',env);const [defaultHerdr]=defaultDirectories('herdr',env);
  expect(defaultBun).toBe(win?win32.join(home,'.bun','bin'):posix.join(home,'.bun','bin'));
  expect(defaultHerdr).toBe(win?win32.join(home,'AppData','Local','Programs','Herdr','bin'):posix.join(home,'.local','bin'));
  for(const [name,defaultDir] of [['bun',defaultBun!],['herdr',defaultHerdr!]] as const){
   const fromOwned=fake(owned,name),fromDefault=fake(defaultDir,name),fromPath=fake(onPath,name);
   expect(findExecutable(name,{ownedDir:owned,env})).toBe(fromOwned);
   rmSync(fromOwned);expect(findExecutable(name,{ownedDir:owned,env})).toBe(fromDefault);
   rmSync(fromDefault);expect(findExecutable(name,{ownedDir:owned,env})).toBe(fromPath);
   rmSync(fromPath);expect(findExecutable(name,{ownedDir:owned,env})).toBeUndefined();
  }
  expect(()=>findExecutable('bun',{ownedDir:'relative',env})).toThrow('absolute');
 });
 it('reads the herdr install.ps1 junction location and skips relative PATH entries',()=>{
  if(win){const {home,env}=fixtureEnv([]);const current=fake(join(home,'.herdr','packages','standalone','current'),'herdr');expect(findExecutable('herdr',{env})).toBe(current);}
  fake('relative-entry','bun');const {env}=fixtureEnv(['relative-entry']);const cwd=process.cwd();
  try{process.chdir(base);expect(findExecutable('bun',{env})).toBeUndefined();}finally{process.chdir(cwd);}
 });
 it.if(win)('applies PATHEXT on Windows',()=>{
  const at=dir('pathext');const shim=join(at,'herdr.cmd');writeFileSync(shim,'');const {env}=fixtureEnv([at]);
  expect(findExecutable('herdr',{env})).toBe(shim);
  expect(findExecutable('herdr',{env:{...env,PATHEXT:'.EXE'}})).toBeUndefined();
  expect(findExecutable('herdr.cmd',{env:{...env,PATHEXT:'.EXE'}})).toBe(shim);
 });
 it('skips WindowsApps/System32 aliases for bun and herdr only',()=>{
  const store=dir('alias','Microsoft','WindowsApps'),system=dir('alias','Windows','System32'),real=dir('alias','real');
  for(const name of ['bun','herdr']){fake(store,name);fake(system,name);}
  const {env}=fixtureEnv([store,system,real]);
  expect(findExecutable('bun',{env})).toBeUndefined();expect(findExecutable('herdr',{env})).toBeUndefined();
  const bun=fake(real,'bun'),herdr=fake(real,'herdr');
  expect(findExecutable('bun',{env})).toBe(bun);expect(findExecutable('herdr',{env})).toBe(herdr);
  expect(findExecutable('bun',{env,ownedDir:store})).toBe(bun);
  const powershell=fake(system,'powershell');expect(findExecutable('powershell',{env})).toBe(powershell);
  expect(isAliasCandidate('C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\bun.exe')).toBe(true);
  expect(isAliasCandidate('c:\\windows\\system32\\herdr.exe')).toBe(true);
  expect(isAliasCandidate('C:\\Users\\u\\.bun\\bin\\bun.exe')).toBe(false);
 });
});

describe('versionGe',()=>{
 it('matches install.sh version_ge',()=>{
  for(const [a,b,expected] of [['1.4.0',MIN_BUN,true],['1.4',MIN_BUN,true],['1.10.0',MIN_BUN,true],['2.0.0',MIN_BUN,true],['1.4.0-canary.1',MIN_BUN,true],['1.3.99',MIN_BUN,false],['0.9.1',MIN_HERDR,true],['0.8.12',MIN_HERDR,false],['',MIN_BUN,false],['v1.4.0',MIN_BUN,false],['0.9.0',MIN_HERDR,true]] as const)expect([a,b,versionGe(a,b)]).toEqual([a,b,expected]);
 });
});

describe('install-lifecycle',()=>{
 const versions:Record<string,string>={bun:'1.4.0',herdr:'0.9.0',git:'2.47.0',node:'22.0.0'};
 /** Context with fake git/bun/herdr(/node) on PATH, stubbed versions and health. */
 const context=(over:Partial<Record<string,string|undefined>>={},health=false,omit:string[]=[])=>{
  const bin=dir(`tools-${++serial}`);for(const name of ['git','bun','herdr',...(win?[]:['node'])])if(!omit.includes(name))fake(bin,name);
  const {env}=fixtureEnv([bin]);const out:string[]=[],err:string[]=[];
  const ctx:Context={env,platform:process.platform,cwd:base,out:line=>out.push(line),err:line=>err.push(line),healthy:async()=>health,source:resolve(import.meta.dir,'..'),
   version:executable=>{const name=Object.keys(versions).find(tool=>executable.endsWith(win?`${tool}.exe`:tool))!;return name in over?over[name]:versions[name];}};
  return {ctx,out,err,env};
 };
 const options=(dir:string,port=7399):Options=>({command:'check',dir,port,start:true,yes:false});
 it('check exits 2 when Bun is missing or too old, or herdr is too old',async()=>{
  const missing=context({},true,['bun']);expect(await check(options(dir('check-none')),missing.ctx)).toBe(2);
  expect(missing.err.some(line=>line.startsWith('MISS  bun not found'))).toBe(true);
  const old=context({bun:'1.3.9'},true);expect(await check(options(dir('check-none')),old.ctx)).toBe(2);
  expect(old.err).toContain(`MISS  bun 1.3.9 is older than ${MIN_BUN}. Fix: bun upgrade`);
  const oldHerdr=context({herdr:'0.8.9'},true);expect(await check(options(dir('check-none')),oldHerdr.ctx)).toBe(2);
  expect(oldHerdr.err).toContain(`MISS  herdr 0.8.9 is older than ${MIN_HERDR}. Fix: herdr update`);
  const unknown=context({bun:undefined},true);expect(await check(options(dir('check-none')),unknown.ctx)).toBe(2);
 });
 it('check exits 2 from the CLI when Bun is not on PATH or in its default location',()=>{
  const {env}=fixtureEnv([dir('empty-path')]);const keep=Object.fromEntries(['SystemRoot','windir','ComSpec','TEMP','TMP'].map(name=>[name,process.env[name]]));
  const result=Bun.spawnSync([process.execPath,join(import.meta.dir,'install-lifecycle.ts'),'check','--dir',dir('cli-none')],{env:{...keep,...env},stdout:'pipe',stderr:'pipe'});
  expect(result.exitCode).toBe(2);expect(result.stderr.toString()).toContain('MISS  bun not found');
 });
 it('check is 0 only for an installed and running own instance, and writes nothing',async()=>{
  const root=dir('check-installed');writeFileSync(join(root,'.termweave-owned.json'),'{}');
  const before=readdirSync(root).sort();
  const notRunning=context({},false);expect(await check(options(root),notRunning.ctx)).toBe(1);expect(notRunning.err).toContain('MISS  no server answers http://127.0.0.1:7399/api/health');
  const foreign=context({},true);expect(await check(options(root),foreign.ctx)).toBe(1);expect(foreign.out.some(line=>line.startsWith('note  http://127.0.0.1:7399 answers, but not from this install'))).toBe(true);
  // A lifecycle.json that is no lifecycle record is uncertain, never an owned running instance, whatever the full health says.
  writeFileSync(join(root,'lifecycle.json'),'{}');
  const uncertain=context({},true);expect(await check(options(root),uncertain.ctx)).toBe(1);
  expect(uncertain.err.some(line=>line.startsWith('MISS  lifecycle state is uncertain: lifecycle.json still uninterpretable'))).toBe(true);
  expect(readdirSync(root).sort()).toEqual([...before,'lifecycle.json'].sort());
  expect(existsSync(lockPaths(root).guard)).toBe(false);expect(existsSync(lockPaths(root).lock)).toBe(false);
  const missing=dir('check-missing-parent');const absent=join(missing,'never');
  expect(await check(options(absent),context({},true).ctx)).toBe(1);expect(readdirSync(missing)).toEqual([]);
 });
 it('install reuses an existing install and refuses other existing or forbidden paths',()=>{
  const root=dir('install-existing');writeFileSync(join(root,'.termweave-owned.json'),'{}');
  const reuse=context();expect(install({...options(root),command:'install'},reuse.ctx)).toBe(0);expect(reuse.out).toContain(`ok    already installed at ${root} (reused)`);
  const other=dir('install-other');const occupied=context();expect(install({...options(other),command:'install'},occupied.ctx)).toBe(1);
  expect(occupied.err).toContain(`FAIL  ${other} exists but is not a TermWeave install. Remove it or pass --dir NEW_PATH`);
  const inside=join(resolve(import.meta.dir,'..'),'tw-never-created');const refused=context();expect(install({...options(inside),command:'install'},refused.ctx)).toBe(1);
  expect(refused.err.some(line=>line.includes('(source repository)'))).toBe(true);
  expect(install({...options(dir('install-none-new')),command:'install'},context({},false,['bun']).ctx)).toBe(2);
 });
 it('resolves --dir and --port from CLI, then TERMWEAVE_INSTALL_DIR/PORT, then the platform default',()=>{
  const at=(argv:string[],env:Record<string,string>,platform:NodeJS.Platform=process.platform)=>parseArgs(argv,{env,platform,cwd:base})!;
  expect(at(['check','--dir','cli','--port','8000'],{TERMWEAVE_INSTALL_DIR:join(base,'env'),PORT:'9000'})).toEqual({command:'check',dir:join(base,'cli'),port:8000,start:true,yes:false});
  expect(at(['install','--no-start','--yes'],{TERMWEAVE_INSTALL_DIR:join(base,'env'),PORT:'9000',HOME:'/h',LOCALAPPDATA:'C:\\L'})).toEqual({command:'install',dir:join(base,'env'),port:9000,start:false,yes:true});
  expect(at(['check'],{LOCALAPPDATA:'C:\\Users\\u\\AppData\\Local',HOME:'/home/u',PORT:''},'win32')).toMatchObject({dir:'C:\\Users\\u\\AppData\\Local\\termweave-owned',port:DEFAULT_PORT});
  expect(at(['check'],{LOCALAPPDATA:'C:\\L',HOME:'/home/u'},'linux')).toMatchObject({dir:'/home/u/.local/share/termweave-owned',port:7317});
  expect(at(['check'],{localappdata:'C:\\L',termweave_install_dir:'D:\\tw',port:'7400'},'win32')).toMatchObject({dir:'D:\\tw',port:7400});
  expect(parseArgs(['--help'],{env:{},platform:'linux',cwd:base})).toBeUndefined();
  for(const argv of [[],['check','--port','0'],['check','--port','70000'],['check','--port','12a'],['check','--dir'],['check','--bogus'],['check','install'],['uninstall']])expect(()=>at(argv,{HOME:'/h',LOCALAPPDATA:'C:\\L'})).toThrow();
  expect(()=>at(['check'],{HOME:'/h',LOCALAPPDATA:'C:\\L',PORT:'abc'})).toThrow('Invalid port: abc');
  expect(()=>at(['check'],{},'win32')).toThrow('LOCALAPPDATA');
 });
 it('exits 1 for invalid arguments and for start/stop of a directory that is not an install',async()=>{
  const {ctx,err}=context();
  expect(await main(['check','--port','nope'],ctx)).toBe(1);expect(err[0]).toBe('Invalid port: nope');
  for(const command of ['start','stop']){const never=dir(`never-${command}`);const run=context();expect(await main([command,'--dir',never],run.ctx)).toBe(1);expect(run.err).toEqual([`FAIL  not installed at ${never} (run the installer)`]);}
  const never=dir('never-cli');
  const result=Bun.spawnSync([process.execPath,join(import.meta.dir,'install-lifecycle.ts'),'stop','--dir',never,'--port','7399'],{stdout:'pipe',stderr:'pipe'});
  expect([result.exitCode,result.stderr.toString().trim()]).toEqual([1,`FAIL  not installed at ${never} (run the installer)`]);
 });
});
