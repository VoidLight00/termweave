import {it,expect} from 'bun:test';import {mkdtempSync,realpathSync,writeFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {execFileSync} from 'node:child_process';import {installationSources} from './install-source.ts';
it('committed inventory excludes synthetic env/state/log/backups and untracked personal files',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'tw-source-')));const git=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'pipe'});
 try{git('init');writeFileSync(join(root,'package.json'),'{}');writeFileSync(join(root,'bun.lock'),'synthetic');git('add','package.json','bun.lock');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','Synthetic source');for(const name of ['.env','state.json','session.log','backup.txt','personal.txt'])writeFileSync(join(root,name),'synthetic private fixture');expect(installationSources(root).sort()).toEqual(['bun.lock','package.json']);writeFileSync(join(root,'bun.lock'),'modified');expect(()=>installationSources(root)).toThrow('Modified');}
 finally{rmSync(root,{recursive:true,force:true});}
});
