import {it,expect} from 'bun:test';import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,existsSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
it('barrier-released start/uninstall transition admits one lock owner and preserves competing files',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'tw-race-')));const ready=join(root,'go');const lock=join(root,'.lifecycle.lock');
 try{
  const worker=`import {existsSync,openSync,closeSync,writeFileSync,rmSync} from 'node:fs';while(!existsSync(${JSON.stringify(ready)}))await Bun.sleep(2);let release;try{release=(await import(${JSON.stringify(join(import.meta.dir,'lifecycle-lock.ts'))})).lifecycleLock(${JSON.stringify(root)});}catch{process.exit(3);}writeFileSync(${JSON.stringify(join(root,'winner'))},process.argv[1]);while(!existsSync(${JSON.stringify(join(root,'release'))}))await Bun.sleep(2);release();`;
  const first=Bun.spawn(['bun','-e',worker,'start'],{stdout:'ignore',stderr:'ignore'});const second=Bun.spawn(['bun','-e',worker,'uninstall'],{stdout:'ignore',stderr:'ignore'});writeFileSync(ready,'go');for(let i=0;i<200&&!existsSync(join(root,'winner'));i++)await Bun.sleep(2);expect(existsSync(join(root,'winner'))).toBe(true);await Bun.sleep(50);writeFileSync(join(root,'release'),'release');const codes=await Promise.all([first.exited,second.exited]);expect(codes.sort()).toEqual([0,3]);expect(existsSync(lock)).toBe(false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
