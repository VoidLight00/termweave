import {it,expect} from 'bun:test';import {mkdtempSync,mkdirSync,realpathSync,writeFileSync,readFileSync,rmSync,renameSync,symlinkSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {execFileSync} from 'node:child_process';import {installationSources} from './install-source.ts';
it('committed inventory excludes synthetic env/state/log/backups and untracked personal files',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'tw-source-')));const git=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'pipe'});
 try{git('init');writeFileSync(join(root,'package.json'),'{}');writeFileSync(join(root,'bun.lock'),'synthetic');git('add','package.json','bun.lock');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','Synthetic source');for(const name of ['.env','state.json','session.log','backup.txt','personal.txt'])writeFileSync(join(root,name),'synthetic private fixture');expect(installationSources(root).sort()).toEqual(['bun.lock','package.json']);writeFileSync(join(root,'bun.lock'),'modified');expect(()=>installationSources(root)).toThrow('Modified');}
 finally{rmSync(root,{recursive:true,force:true});}
});
it('repository .gitattributes keeps committed LF bytes under core.autocrlf=true checkouts',()=>{
 const attributes=readFileSync(join(import.meta.dir,'..','.gitattributes'));
 const root=realpathSync(mkdtempSync(join(tmpdir(),'tw-source-eol-')));const git=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'pipe'});
 const commit=(message:string)=>git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m',message);
 const recheckout=()=>{rmSync(join(root,'package.json'));rmSync(join(root,'bun.lock'));git('checkout','--','package.json','bun.lock');};
 try{
  git('init');git('config','core.autocrlf','true');
  writeFileSync(join(root,'package.json'),'{\n  "name": "fixture"\n}\n');writeFileSync(join(root,'bun.lock'),'line one\nline two\n');
  git('add','package.json','bun.lock');commit('LF source');
  recheckout();
  expect(readFileSync(join(root,'package.json'),'utf8')).toContain('\r\n');
  expect(()=>installationSources(root)).toThrow('Modified committed installation source');
  writeFileSync(join(root,'.gitattributes'),attributes);git('add','.gitattributes');commit('Pin LF');
  recheckout();
  expect(readFileSync(join(root,'package.json'),'utf8')).not.toContain('\r\n');
  expect(installationSources(root).sort()).toEqual(['.gitattributes','bun.lock','package.json']);
 }finally{rmSync(root,{recursive:true,force:true});}
});
it('source spellings (slashes, drive case, 8.3, junction) are aliases; a link inside the source is an escape',()=>{
 const win=process.platform==='win32',link=win?'junction':'dir';
 const base=realpathSync.native(mkdtempSync(join(tmpdir(),'tw-source-alias-')));const root=join(base,'source repo 한글');mkdirSync(join(root,'sub'),{recursive:true});
 const git=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'pipe'});const expected=['bun.lock','package.json','sub/file.txt'];
 try{
  git('init');git('config','core.autocrlf','false');writeFileSync(join(root,'package.json'),'{}');writeFileSync(join(root,'bun.lock'),'synthetic');writeFileSync(join(root,'sub','file.txt'),'committed');
  git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','Synthetic source');
  symlinkSync(root,join(base,'alias'),link);const aliases=[root,root.replaceAll('\\','/'),join(base,'alias')];
  if(win){aliases.push(root[0]!.toLowerCase()+root.slice(1));const short=Bun.spawnSync(['powershell.exe','-NoProfile','-NonInteractive','-Command','(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:TW_SHORT_TARGET).ShortPath'],{env:{...process.env,TW_SHORT_TARGET:root},stdout:'pipe'}).stdout.toString().trim();if(short&&short!==root)aliases.push(short);}
  for(const alias of aliases)expect([alias,installationSources(alias).sort()]).toEqual([alias,expected]);
  const outside=join(base,'outside');mkdirSync(outside);writeFileSync(join(outside,'file.txt'),'committed');renameSync(join(root,'sub'),join(base,'moved-sub'));symlinkSync(outside,join(root,'sub'),link);
  expect(readFileSync(join(root,'sub','file.txt'),'utf8')).toBe('committed');expect(()=>installationSources(root)).toThrow('Invalid source boundary');
 }finally{rmSync(base,{recursive:true,force:true});}
},30_000);
