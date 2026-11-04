import {expect,it} from 'bun:test';import {mkdtempSync,writeFileSync,mkdirSync,rmSync,symlinkSync,realpathSync,existsSync,readdirSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {uninstallOwned} from './uninstall.ts';import {acquireLock} from './lifecycle-lock.ts';
it('uninstall refuses missing/corrupt markers, stale PID, extra/modified files and unowned symlinks',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'tw-refuse-')));const owned=join(root,'owned');mkdirSync(owned);const marker=join(owned,'.termweave-owned.json');
 try{expect(()=>uninstallOwned(owned,true)).toThrow();writeFileSync(marker,'invalid');expect(()=>uninstallOwned(owned,true)).toThrow();writeFileSync(marker,JSON.stringify({product:'termweave',root:owned,inventory:{}}));writeFileSync(join(owned,'lifecycle.json'),JSON.stringify({pid:process.pid}));expect(()=>uninstallOwned(owned,true)).toThrow('uncertain');rmSync(join(owned,'lifecycle.json'));writeFileSync(join(owned,'extra'),'private');expect(()=>uninstallOwned(owned,true)).toThrow('Unowned');rmSync(join(owned,'extra'));mkdirSync(join(owned,'user-empty'));expect(()=>uninstallOwned(owned,true)).toThrow('directory');rmSync(join(owned,'user-empty'),{recursive:true});symlinkSync(root,join(owned,'outside'));expect(()=>uninstallOwned(owned,true)).toThrow('symlink');}
 finally{rmSync(root,{recursive:true,force:true});}
});
it('uninstall waits on the external work lock, never removes a live owner install, and releases the lock on refusal and success',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'tw-refuse-')));const owned=join(root,'owned');mkdirSync(owned);const marker=join(owned,'.termweave-owned.json');
 // `.gone` names are already deleted but may still be delete-pending on Windows
 const listing=()=>readdirSync(root).filter(name=>!name.endsWith('.gone'));
 try{
  writeFileSync(marker,JSON.stringify({product:'termweave',root:owned,inventory:{}}));
  const held=acquireLock(owned,'start');let t=0;
  expect(()=>uninstallOwned(owned,true,{now:()=>t,sleep:ms=>{t+=ms;}})).toThrow('live owner');expect(t).toBeGreaterThanOrEqual(10_000);
  expect(existsSync(marker)).toBe(true);expect(held.release()).toBe(true);
  writeFileSync(join(owned,'extra'),'private');expect(()=>uninstallOwned(owned,true)).toThrow('Unowned');expect(listing()).toEqual(['owned']);rmSync(join(owned,'extra'));
  uninstallOwned(owned,true);expect(existsSync(owned)).toBe(false);expect(listing()).toEqual([]);
 }finally{rmSync(root,{recursive:true,force:true});}
});
