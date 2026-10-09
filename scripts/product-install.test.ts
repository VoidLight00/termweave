import {expect,it} from 'bun:test';import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {uninstallOwned} from './uninstall.ts';
it('clean HOME preflight performs no installation, remote exposure or upstream state changes',()=>{
 const root=mkdtempSync(join(tmpdir(),'tw-install-'));const home=join(root,'home');mkdirSync(home);
 try{const child=Bun.spawnSync(['sh',join(import.meta.dir,'../install.sh'),'--check'],{env:{...process.env,HOME:home},stdout:'pipe',stderr:'pipe'});expect(child.exitCode).toBe(0);expect(existsSync(join(home,'.config','herdr-web-ui'))).toBe(false);expect(existsSync(join(home,'.config','termweave'))).toBe(false);
 const owned=join(root,'owned');mkdirSync(owned);writeFileSync(join(owned,'.termweave-owned.json'),JSON.stringify({product:'termweave',root:owned,inventory:{}}));expect(()=>uninstallOwned(home,true)).toThrow('Unowned');uninstallOwned(owned,true);expect(existsSync(owned)).toBe(false);expect(existsSync(home)).toBe(true);
 }finally{rmSync(root,{recursive:true,force:true});}
});
