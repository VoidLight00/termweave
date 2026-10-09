import {expect,it} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PaneNumbers} from './pane-numbers.ts';
const pane=(terminal_id:string,pane_id:string)=>({terminal_id,pane_id});
it('assigns unique persistent numbers across sessions and never reuses a retired number',()=>{
 const root=mkdtempSync(join(tmpdir(),'pane-numbers-'));let registry=new PaneNumbers(root);
 const read=(panes:any[])=>registry.annotate({panes}).panes;
 try{
  const a=read([pane('A','w1:p1'),pane('B','w2:p1')]);expect(a.map(p=>p.global_pane_number)).toEqual([1,2]);
  expect(read([pane('B','w3:p7'),pane('A','w4:p1')]).map(p=>p.global_pane_number)).toEqual([2,1]);
  registry.close();registry=new PaneNumbers(root);
  expect(read([pane('B','w3:p7'),pane('C','w5:p1')]).map(p=>p.global_pane_number)).toEqual([2,3]);
  const second=new PaneNumbers(root);try{expect(second.annotate({panes:[{...pane('D','w7:p1'),global_pane_number:99}]}).panes[0]!.global_pane_number).toBe(4);}finally{second.close();}
  expect(read([pane('A','w1:p1')])[0].global_pane_number).toBe(1);
 }finally{registry.close();rmSync(root,{recursive:true,force:true});}
});
it('fails closed on a corrupt number store instead of renumbering terminals',()=>{
 const root=mkdtempSync(join(tmpdir(),'pane-numbers-'));writeFileSync(join(root,'pane-numbers.sqlite'),'corrupt');const registry=new PaneNumbers(root);
 try{expect(()=>registry.annotate({panes:[pane('A','w1:p1')]})).toThrow();}finally{registry.close();rmSync(root,{recursive:true,force:true});}
});
