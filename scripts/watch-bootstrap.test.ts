import {expect,it} from 'bun:test';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {bootstrapState} from './watch-bootstrap.ts';
it('bootstrap only writes explicit local state and refuses overwrite',()=>{
 const root=mkdtempSync(join(tmpdir(),'tw-bootstrap-'));
 try{const path=join(root,'bootstrap.json');expect(bootstrapState(path).pending).toEqual([]);expect(JSON.parse(readFileSync(path,'utf8')).schema).toBe(1);expect(()=>bootstrapState(path)).toThrow('overwrite');}
 finally{rmSync(root,{recursive:true,force:true});}
});
