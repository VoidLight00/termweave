import {accessSync,constants,statSync} from 'node:fs';import {posix,win32} from 'node:path';
/**
 * Child environments and executable lookup shared by the owned-install lifecycle. Pure apart from `stat`/`access` probes and the
 * `--version` spawn in toolVersion. The registry is never read here: on Windows the PowerShell front end owns the PATH refresh and
 * hands this code the merged environment it should use.
 */
export type Env=Record<string,string|undefined>;
export const MIN_BUN='1.4.0',MIN_HERDR='0.9.0';
/** Windows variables a child needs to run at all, in their canonical spelling. The denylist must never match them (tested). */
export const WINDOWS_PRESERVED=['SystemRoot','windir','ComSpec','PATHEXT','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','USERNAME','Path'] as const;
const PRESERVED=new Map<string,string>(WINDOWS_PRESERVED.map(name=>[name.toUpperCase(),name]));
/** POSIX keeps install.sh's `env -i` allowlist, plus the proxy variables `bun install` needs behind a proxy. */
export const POSIX_ALLOWED=['HOME','PATH','LANG','USER','SHELL','XDG_CONFIG_HOME','HERDR_SOCKET','HERDR_WEB_TOKEN','HTTP_PROXY','HTTPS_PROXY','NO_PROXY','http_proxy','https_proxy','no_proxy'] as const;
/** The user's own web token passes through, as in install.sh; it is never printed. */
const PASSED=new Set(['HERDR_WEB_TOKEN']);
const DENIED=[/^(?:AWS|OPENAI|ANTHROPIC)_/i,/^(?:GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN)$/i,/(?:^|_)(?:API_?KEY|TOKEN|SECRET|SECRET_KEY|ACCESS_KEY|PRIVATE_KEY|PASSWORD|PASSWD|CREDENTIALS?)$/i];
/** True for names the child must not inherit (API keys, tokens, secrets). */
export const isDeniedEnv=(name:string)=>!PASSED.has(name.toUpperCase())&&DENIED.some(pattern=>pattern.test(name));
/** Windows Path entries from several spellings joined into one list, first occurrence kept (compared case-insensitively). */
const mergePath=(...values:string[])=>{const seen=new Set<string>();const entries:string[]=[];for(const value of values)for(const entry of value.split(';')){const id=entry.trim().replace(/[\\/]+$/,'').toUpperCase();if(!id||seen.has(id))continue;seen.add(id);entries.push(entry);}return entries.join(';');};
/** Case-insensitive lookup on Windows (where `Path` and `PATH` name one variable), exact on POSIX. */
export function envValue(env:Env,name:string,platform:NodeJS.Platform=process.platform):string|undefined{
 if(platform!=='win32')return env[name];
 const id=name.toUpperCase();const values=Object.entries(env).filter(([key,value])=>key.toUpperCase()===id&&value!==undefined).map(([,value])=>value!);
 return id==='PATH'&&values.length>1?mergePath(...values):values[0];
}
/**
 * Environment for a lifecycle child. Overrides are applied last and bypass every filter; an `undefined` override removes the variable.
 * - win32: inherit the parent minus the denylist. Names compare case-insensitively and collapse to one key: preserved names take their
 *   canonical spelling, duplicate `Path`/`PATH` values merge into one `Path`, any other duplicate keeps its first value.
 * - POSIX: install.sh's `env -i` allowlist (an allowlist is never used on Windows), LANG defaulting to en_US.UTF-8.
 */
export function buildChildEnv(parentEnv:Env,overrides:Env={},platform:NodeJS.Platform=process.platform):Record<string,string>{
 if(platform==='win32'){
  const merged=new Map<string,{key:string;value:string}>();
  const put=(key:string,value:string)=>{const id=key.toUpperCase();merged.set(id,{key:PRESERVED.get(id)??key,value});};
  for(const [key,value] of Object.entries(parentEnv)){
   if(value===undefined)continue;const id=key.toUpperCase();
   if(isDeniedEnv(key))continue;
   const previous=merged.get(id);
   if(!previous)put(key,value);else if(id==='PATH')put(key,mergePath(previous.value,value));
  }
  // An override replaces every spelling of its name and is emitted under the override's own spelling.
  for(const [key,value] of Object.entries(overrides)){if(value===undefined)merged.delete(key.toUpperCase());else put(key,value);}
  return Object.fromEntries([...merged.values()].map(({key,value})=>[key,value]));
 }
 const env:Record<string,string>={};
 for(const name of POSIX_ALLOWED){const value=parentEnv[name];if(value!==undefined&&value!==''&&!isDeniedEnv(name))env[name]=value;}
 env.LANG??='en_US.UTF-8';
 for(const [key,value] of Object.entries(overrides)){if(value===undefined)delete env[key];else env[key]=value;}
 return env;
}
/** install.sh's version_ge: dotted A >= B comparing the leading digits of each part numerically, missing parts as 0. */
export function versionGe(a:string,b:string):boolean{
 const left=a.split('.'),right=b.split('.');const part=(value:string|undefined)=>Number(/^\d*/.exec(value??'')![0]||'0');
 for(let i=0;i<Math.max(left.length,right.length);i++){const x=part(left[i]),y=part(right[i]);if(x>y)return true;if(x<y)return false;}
 return true;
}
/** `bun`/`herdr` resolved under these directories are Store aliases or system stand-ins, never the real tool. */
const ALIAS_DIRECTORY=/[\\/](?:WindowsApps|System32)[\\/]/i;
const ALIAS_GUARDED=new Set(['bun','herdr']);
export const isAliasCandidate=(path:string)=>ALIAS_DIRECTORY.test(path);
/** Official installers' default directories: bun.sh (`~/.bun/bin`) and herdr.dev (install.ps1: `%LOCALAPPDATA%\Programs\Herdr\bin` and its `%USERPROFILE%\.herdr\packages\standalone\current` junction; install.sh: `~/.local/bin`). */
export function defaultDirectories(name:string,env:Env,platform:NodeJS.Platform=process.platform):string[]{
 const win=platform==='win32';const path=win?win32:posix;const at=(base:string|undefined,...parts:string[])=>base&&path.isAbsolute(base)?[path.join(base,...parts)]:[];
 const home=envValue(env,win?'USERPROFILE':'HOME',platform);
 if(name==='bun')return at(home,'.bun','bin');
 if(name==='herdr')return win?[...at(envValue(env,'LOCALAPPDATA',platform),'Programs','Herdr','bin'),...at(home,'.herdr','packages','standalone','current')]:at(home,'.local','bin');
 return [];
}
const isExecutable=(path:string,platform:NodeJS.Platform)=>{
 if(!statSync(path,{throwIfNoEntry:false})?.isFile())return false;
 if(platform==='win32')return true;
 try{accessSync(path,constants.X_OK);return true;}catch{return false;}
};
export type FindOptions={ownedDir?:string;env?:Env;platform?:NodeJS.Platform};
/**
 * Absolute path of `name`, searched in order: the verified owned directory, the official default install location, then the Path of
 * the given env (relative entries skipped). Windows applies PATHEXT to an extension-less name. Candidates for bun/herdr under
 * `\WindowsApps\` or `\System32\` are skipped; other tools (PowerShell, ComSpec) are not restricted.
 */
export function findExecutable(name:string,{ownedDir,env=process.env,platform=process.platform}:FindOptions={}):string|undefined{
 const win=platform==='win32';const path=win?win32:posix;
 if(ownedDir!==undefined&&!path.isAbsolute(ownedDir))throw new Error('Owned directory must be absolute');
 const extensions=win&&!path.extname(name)?(envValue(env,'PATHEXT',platform)||'.COM;.EXE;.BAT;.CMD').toLowerCase().split(';').filter(Boolean):[''];
 const searched=(envValue(env,'PATH',platform)??'').split(win?';':':').map(entry=>win?entry.trim().replace(/^"(.*)"$/,'$1'):entry);
 const guarded=ALIAS_GUARDED.has(path.basename(name,path.extname(name)).toLowerCase());
 for(const dir of [...(ownedDir?[ownedDir]:[]),...defaultDirectories(name,env,platform),...searched]){
  if(!dir||!path.isAbsolute(dir))continue;
  for(const extension of extensions){const candidate=path.join(dir,name+extension);if(guarded&&isAliasCandidate(candidate))continue;if(isExecutable(candidate,platform))return candidate;}
 }
 return undefined;
}
/** Version reported by `<exe> --version`: bun prints `1.4.0`, herdr `herdr 0.9.1`, git `git version 2.x`. Undefined when it cannot run. */
export function toolVersion(executable:string,env:Env=process.env):string|undefined{
 try{const result=Bun.spawnSync([executable,'--version'],{env:buildChildEnv(env),stdin:'ignore',stdout:'pipe',stderr:'ignore',timeout:10_000,windowsHide:true});if(result.exitCode!==0)return undefined;const words=result.stdout.toString().trim().split(/\s+/);return words.find(word=>/^v?\d+(\.\d+)*/.test(word))?.replace(/^v/,'')||undefined;}
 catch{return undefined;}
}
