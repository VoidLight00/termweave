import {afterAll,expect,it,test} from 'bun:test';import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,existsSync} from 'node:fs';import {join,parse} from 'node:path';import {tmpdir} from 'node:os';import {execFileSync} from 'node:child_process';
import {canonicalPath,canonicalIdentity,homeDirectory,isNetworkPath,isWithin,judgeDestination,linkComponent} from './lifecycle-path.ts';import {currentUserSid,installOwned,isOwnedRootDacl,restrictOwnedRoot} from './owned-install.ts';
const win=process.platform==='win32';
const base=canonicalPath(mkdtempSync(join(tmpdir(),'tw-path-')));afterAll(()=>rmSync(base,{recursive:true,force:true}));
const dir=(...parts:string[])=>{const path=join(base,...parts);mkdirSync(path,{recursive:true});return path;};
const source=dir('source'),home=dir('home');
const refused=(destination:string,from=source,context={})=>{const judged=judgeDestination(destination,from,context);return 'refused' in judged?judged.refused:undefined;};
const rootOf=(destination:string,from=source)=>{const judged=judgeDestination(destination,from,{env:{}});if('refused' in judged)throw new Error(judged.refused);return judged.root;};
const lowerDrive=(path:string)=>path[0]!.toLowerCase()+path.slice(1);
/** Windows 8.3 alias of an existing long path, or undefined when the volume does not generate short names. */
const shortName=(path:string)=>{if(!win)return undefined;const result=Bun.spawnSync(['powershell.exe','-NoProfile','-NonInteractive','-Command','(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:TW_SHORT_TARGET).ShortPath'],{env:{...process.env,TW_SHORT_TARGET:path},stdout:'pipe',stderr:'pipe'});const short=result.stdout.toString().trim();return result.exitCode===0&&short&&short!==path?short:undefined;};
const longParent=dir('long parent directory 한글');const shortParent=shortName(longParent);

it('refuses UNC/network spellings on every OS',()=>{
 for(const path of ['\\\\server\\share','\\\\server\\share\\tw','//server/share/tw','\\\\?\\C:\\tw','\\\\.\\pipe\\tw'])expect([path,isNetworkPath(path),refused(path)]).toEqual([path,true,'network path']);
 for(const path of ['C:\\tw','/tmp/tw','relative/tw',join(base,'tw')])expect(isNetworkPath(path)).toBe(false);
});
it('refuses the filesystem root',()=>{expect(refused(parse(base).root)).toBe('filesystem root');});
it('refuses the profile home: USERPROFILE on Windows, HOME on POSIX',()=>{
 expect(homeDirectory({platform:'win32',env:{USERPROFILE:'A',HOME:'B'}})).toBe('A');expect(homeDirectory({platform:'linux',env:{USERPROFILE:'A',HOME:'B'}})).toBe('B');
 expect(refused(home,source,{platform:'win32',env:{USERPROFILE:home}})).toBe('home directory');
 expect(refused(home,source,{platform:'linux',env:{HOME:home}})).toBe('home directory');
 expect(refused(home,source,{platform:'win32',env:{HOME:home}})).toBe('existing path');
 expect(rootOf(join(home,'termweave'))).toBe(join(home,'termweave'));
});
it('refuses the source and anything inside it, but not a sibling sharing its name prefix',()=>{
 expect(refused(source)).toBe('source repository');expect(refused(join(source,'tw'))).toBe('source repository');expect(refused(join(source,'missing','deep','tw'))).toBe('source repository');
 expect(rootOf(join(base,'source-sibling'))).toBe(join(base,'source-sibling'));expect(isWithin(source,join(base,'source-sibling'))).toBe(false);
});
it('refuses existing directories, files and dangling links, and a missing parent',()=>{
 writeFileSync(join(base,'file'),'x');
 expect(refused(dir('exists'))).toBe('existing path');expect(refused(join(base,'file'))).toBe('existing path');expect(refused(join(base,'nope','tw'))).toBe('missing parent');expect(refused(join(base,'file','tw'))).toBe('missing parent');
 // a regular file on the way: POSIX lstat says ENOTDIR, Windows ENOENT; both are a missing parent, not a raw error
 expect(refused(join(base,'file','deeper','tw'))).toBe('missing parent');expect(linkComponent(join(base,'file','tw'))).toBeUndefined();
 symlinkSync(join(base,'gone'),join(base,'dangling'),win?'junction':'dir');expect(existsSync(join(base,'dangling'))).toBe(false);expect(refused(join(base,'dangling'))).toBe('existing path');
});
it('accepts paths with spaces and Hangul as the same canonical identity',()=>{
 const parent=dir('공백 있는 경로 한글');expect(rootOf(join(parent,'설치 대상 dir'))).toBe(join(parent,'설치 대상 dir'));expect(canonicalIdentity(join(parent,'설치 대상 dir','더 깊이'))).toBe(join(parent,'설치 대상 dir','더 깊이'));
});
test.if(!win)('POSIX: a symlinked ancestor is refused',()=>{
 symlinkSync(dir('posix-target'),join(base,'posix-link'),'dir');expect(linkComponent(join(base,'posix-link','tw'))).toBe(join(base,'posix-link'));expect(refused(join(base,'posix-link','tw'))).toBe('symlink ancestor');
});
// POSIX-only: ELOOP needs a self-referencing symlink, which Windows creates only with the symlink privilege; ENOENT/ENOTDIR above run on every OS
test.if(!win)('POSIX: an lstat error other than a missing entry propagates',()=>{
 symlinkSync('posix-loop',join(base,'posix-loop'));expect(()=>judgeDestination(join(base,'posix-loop','tw'),source)).toThrow('ELOOP');
});
test.if(win)('win32: drive-letter case is an alias, not an escape',()=>{
 expect(base[0]).toBe(base[0]!.toUpperCase());
 expect(rootOf(lowerDrive(join(base,'drive-case')))).toBe(join(base,'drive-case'));
 expect(refused(lowerDrive(join(source,'tw')))).toBe('source repository');expect(refused(join(source,'tw'),lowerDrive(source))).toBe('source repository');
 expect(refused(lowerDrive(home),source,{platform:'win32',env:{USERPROFILE:home}})).toBe('home directory');
});
test.if(!!shortParent)('win32: an 8.3 short name is an alias, not an escape',()=>{
 expect(canonicalPath(shortParent!)).toBe(longParent);expect(linkComponent(join(shortParent!,'tw'))).toBeUndefined();
 expect(rootOf(join(shortParent!,'tw'))).toBe(join(longParent,'tw'));expect(refused(join(longParent,'tw'),shortParent!)).toBe('source repository');
});
test.if(win)('win32: a junction to the source is recognised as the source; a junction elsewhere is an escape',()=>{
 symlinkSync(source,join(base,'junction-to-source'),'junction');
 expect(canonicalPath(join(base,'junction-to-source'))).toBe(source);
 expect(refused(join(base,'junction-to-source','tw'))).toBe('source repository');expect(refused(join(source,'tw'),join(base,'junction-to-source'))).toBe('source repository');
 symlinkSync(dir('outside'),join(dir('inside'),'escape'),'junction');
 expect(linkComponent(join(base,'inside','escape','tw'))).toBe(join(base,'inside','escape'));expect(refused(join(base,'inside','escape','tw'))).toBe('symlink ancestor');
});
it('accepts only a protected user+SYSTEM full-control DACL',()=>{
 const user='S-1-5-21-1-2-3-1001',ok=`D:PAI(A;OICI;FA;;;S-1-5-18)(A;OICI;FA;;;${user})`;
 expect(isOwnedRootDacl(ok,user)).toBe(true);expect(isOwnedRootDacl(`D:P(A;OICI;FA;;;${user})(A;OICI;FA;;;S-1-5-18)`,user)).toBe(true);
 for(const bad of [`D:AI(A;OICI;FA;;;SY)(A;OICI;FA;;;${user})`,`${ok}(A;OICI;FA;;;BA)`,`D:PAI(A;OICIID;FA;;;SY)(A;OICI;FA;;;${user})`,`D:PAI(A;OICI;FA;;;SY)(A;OICI;0x1301bf;;;${user})`,`D:PAI(A;OICI;FA;;;${user})`,`D:PAI(A;OICI;FA;;;SY)(D;OICI;FA;;;${user})`,`D:PAI(A;CI;FA;;;SY)(A;OICI;FA;;;${user})`,'',`O:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${user})`])expect([bad,isOwnedRootDacl(bad,user)]).toEqual([bad,false]);
});
test.if(win)('win32: icacls restricts a new root to the current user and SYSTEM and reads it back',()=>{
 const root=dir('acl root 한글');restrictOwnedRoot(root);
 const saved=join(base,'acl-readback');execFileSync(join(process.env.SystemRoot!,'System32','icacls.exe'),[root,'/save',saved],{stdio:'pipe'});
 const sddl=readFileSync(saved).toString('utf16le').split(/\r?\n/)[1]!;expect(sddl.startsWith('D:P')).toBe(true);expect(isOwnedRootDacl(sddl,currentUserSid())).toBe(true);expect(sddl).not.toContain('ID;');
 writeFileSync(join(root,'secret'),'synthetic');expect(readFileSync(join(root,'secret'),'utf8')).toBe('synthetic');
 expect(()=>restrictOwnedRoot(join(base,'acl-missing'))).toThrow('Owned root ACL apply failed');
});
it('installOwned records the source commit and canonical root, and refuses reuse or in-source destinations',()=>{
 const repo=dir('repo src');const git=(...args:string[])=>execFileSync('git',args,{cwd:repo,stdio:'pipe'}).toString().trim();
 git('init');git('config','core.autocrlf','false');mkdirSync(join(repo,'dep'));writeFileSync(join(repo,'dep','package.json'),'{"name":"dep","version":"1.0.0"}\n');writeFileSync(join(repo,'package.json'),'{"name":"fixture","private":true,"dependencies":{"dep":"file:./dep"},"scripts":{"build":"echo built"}}\n');
 // offline local dependency so the fixture has a real lockfile that `--frozen-lockfile` accepts
 expect(Bun.spawnSync([process.execPath,'install','--ignore-scripts'],{cwd:repo,stdout:'pipe',stderr:'pipe'}).exitCode).toBe(0);
 git('add','package.json','bun.lock','dep/package.json');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','Synthetic source');
 const destination=join(dir('installs 한글'),'owned tw');const root=installOwned(win?lowerDrive(repo):repo,win?lowerDrive(destination):destination);
 expect(root).toBe(destination);const marker=JSON.parse(readFileSync(join(root,'.termweave-owned.json'),'utf8'));
 expect(marker).toMatchObject({product:'termweave',root:destination,source_sha:git('rev-parse','HEAD')});expect(Object.keys(marker.inventory)).toEqual(expect.arrayContaining(['package.json','bun.lock','node_modules']));
 if(win){const saved=join(base,'install-acl');execFileSync(join(process.env.SystemRoot!,'System32','icacls.exe'),[root,'/save',saved],{stdio:'pipe'});expect(isOwnedRootDacl(readFileSync(saved).toString('utf16le').split(/\r?\n/)[1]!,currentUserSid())).toBe(true);}
 expect(()=>installOwned(repo,destination)).toThrow('existing path');expect(()=>installOwned(repo,join(repo,'nested'))).toThrow('source repository');expect(existsSync(join(repo,'nested'))).toBe(false);
},30_000);
