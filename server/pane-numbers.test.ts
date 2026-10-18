import {expect,it} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {basename,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {Database} from 'bun:sqlite';
import {PaneNumbers} from './pane-numbers.ts';
const pane=(terminal_id:string,pane_id:string)=>({terminal_id,pane_id});
const snapshot=(panes:any[])=>({panes,layouts:[{panes:panes.map(p=>({pane_id:p.pane_id}))}]});
it('reuses the smallest retired number and preserves surviving numbers across moves and restart',()=>{
 const root=mkdtempSync(join(tmpdir(),'pane-numbers-'));let registry=new PaneNumbers(root);
 const read=(panes:any[])=>registry.annotate(snapshot(panes)).panes;
 try{
  expect(read([pane('A','w1:p1'),pane('B','w2:p1')]).map(p=>p.global_pane_number)).toEqual([1,2]);
  expect(read([pane('B','w3:p7'),pane('A','w4:p1')]).map(p=>p.global_pane_number)).toEqual([2,1]);
  registry.close();registry=new PaneNumbers(root);
  expect(read([pane('B','w3:p7'),pane('C','w5:p1')]).map(p=>p.global_pane_number)).toEqual([2,1]);
  const second=new PaneNumbers(root);try{expect(()=>second.annotate({panes:[{...pane('D','w7:p1'),global_pane_number:99}]})).toThrow('active writer');}finally{second.close();}
  expect(registry.annotate({panes:[{...pane('D','w7:p1'),global_pane_number:99}]}).panes[0]!.global_pane_number).toBe(3);
  expect(read([pane('B','w3:p7'),pane('D','w7:p1'),pane('E','w8:p1')]).map(p=>p.global_pane_number)).toEqual([2,3,1]);
  read([]);expect(read([pane('F','w9:p1')])[0].global_pane_number).toBe(1);
 }finally{registry.close();rmSync(root,{recursive:true,force:true});}
});
it('retains restored identities and does not retire rows from incomplete snapshots',()=>{
 const root=mkdtempSync(join(tmpdir(),'pane-numbers-'));const registry=new PaneNumbers(root);
 try{
  registry.annotate(snapshot([pane('A','a'),pane('B','b')]));
  const partial=registry.annotate({panes:[pane('B','b'),pane('C','c')],layouts:[{panes:[{pane_id:'a'},{pane_id:'b'},{pane_id:'c'}]}]});
  expect(partial.panes.map((p:any)=>p.global_pane_number)).toEqual([2,3]);
  const restored=registry.annotate(snapshot([{...pane('A','a'),restore_error:'pending'},pane('B','b')]));
  expect(restored.panes.map((p:any)=>p.global_pane_number)).toEqual([1,2]);
  expect(()=>registry.annotate(snapshot([pane('A','a'),pane('A','b')]))).toThrow('Invalid pane identities');
  expect(()=>registry.annotate(snapshot([pane('','a')]))).toThrow('Invalid pane identities');
 }finally{registry.close();rmSync(root,{recursive:true,force:true});}
});
it('keeps existing high numbers and binds the registry to one socket and live writer',()=>{
 const root=mkdtempSync(join(tmpdir(),'pane-numbers-'));
 const db=new Database(join(root,'pane-numbers.sqlite'));db.exec("CREATE TABLE pane_numbers(number INTEGER PRIMARY KEY AUTOINCREMENT,terminal_id TEXT NOT NULL UNIQUE); INSERT INTO pane_numbers VALUES(34,'A'),(60,'retired')");db.close();
 const registry=new PaneNumbers(root,'socket-a');
 try{
  expect(registry.annotate(snapshot([pane('A','a'),pane('B','b')])).panes.map((p:any)=>p.global_pane_number)).toEqual([34,1]);
  const other=new PaneNumbers(root,'socket-b');try{expect(()=>other.annotate(snapshot([]))).toThrow('scope changed');}finally{other.close();}
  const store=new Database(join(root,'pane-numbers.sqlite'));store.query('UPDATE pane_number_owner SET pid=?').run(process.ppid);store.close();
  const writer=new PaneNumbers(root,'socket-a');try{expect(()=>writer.annotate(snapshot([]))).toThrow('active writer');}finally{writer.close();}
 }finally{registry.close();rmSync(root,{recursive:true,force:true});}
});
it('serializes native snapshot acquisition and continues after a failed read',async()=>{
 const root=mkdtempSync(join(tmpdir(),'pane-numbers-'));const registry=new PaneNumbers(root);const calls:string[]=[];
 try{
  let release!:()=>void;const wait=new Promise<void>(resolve=>release=resolve);
  const first=registry.read(async()=>{calls.push('first');await wait;return snapshot([pane('A','a')]);});
  const second=registry.read(async()=>{calls.push('second');return snapshot([pane('A','a'),pane('B','b')]);});
  await Promise.resolve();expect(calls).toEqual(['first']);release();await first;
  expect((await second).panes.map((p:any)=>p.global_pane_number)).toEqual([1,2]);
  await expect(registry.read(async()=>{throw new Error('offline');})).rejects.toThrow('offline');
  expect((await registry.read(async()=>snapshot([pane('B','b')]))).panes[0].global_pane_number).toBe(2);
 }finally{registry.close();rmSync(root,{recursive:true,force:true});}
});
it('rejects a second same-process writer through a canonical path alias without releasing the first',()=>{
 const root=mkdtempSync(join(tmpdir(),'pane-numbers-'));const registry=new PaneNumbers(root,'socket-a');
 const alias=new PaneNumbers(root + '/../' + basename(root),'socket-a');
 try{
  registry.annotate(snapshot([pane('A','a'),pane('B','b')]));
  expect(()=>alias.annotate(snapshot([pane('B','b'),pane('C','c')]))).toThrow('active writer');
  alias.close();
  expect(()=>alias.annotate(snapshot([]))).toThrow('closed');
  const duplicate=new PaneNumbers(root,'socket-a');
  try{expect(()=>duplicate.annotate(snapshot([]))).toThrow('active writer');}finally{duplicate.close();}
  expect(registry.annotate(snapshot([pane('B','b'),pane('C','c')])).panes.map(p=>p.global_pane_number)).toEqual([2,1]);
  registry.close();
  const successor=new PaneNumbers(root,'socket-a');
  try{expect(successor.annotate(snapshot([pane('B','b'),pane('C','c')])).panes.map(p=>p.global_pane_number)).toEqual([2,1]);}finally{successor.close();}
 }finally{registry.close();alias.close();rmSync(root,{recursive:true,force:true});}
});
it('allows child-process takeover after close while preserving the durable socket scope',()=>{
 const root=mkdtempSync(join(tmpdir(),'pane-numbers-'));const registry=new PaneNumbers(root,'socket-a');
 try{
  registry.annotate(snapshot([pane('A','a'),pane('B','b')]));registry.close();registry.close();
  const code=`import {PaneNumbers} from ${JSON.stringify(fileURLToPath(new URL('./pane-numbers.ts',import.meta.url)))};
   const registry=new PaneNumbers(${JSON.stringify(root)},'socket-a');
   try {const result=registry.annotate({panes:[{terminal_id:'B',pane_id:'b'},{terminal_id:'C',pane_id:'c'}],layouts:[{panes:[{pane_id:'b'},{pane_id:'c'}]}]});process.stdout.write(JSON.stringify(result.panes.map(p=>p.global_pane_number)));}finally{registry.close();}`;
  const child=Bun.spawnSync([process.execPath,'-e',code]);
  expect(child.exitCode).toBe(0);expect(JSON.parse(new TextDecoder().decode(child.stdout))).toEqual([2,1]);
  const other=new PaneNumbers(root,'socket-b');
  try{expect(()=>other.annotate(snapshot([]))).toThrow('scope changed');}finally{other.close();}
  const successor=new PaneNumbers(root,'socket-a');
  try{expect(successor.annotate(snapshot([pane('B','b'),pane('C','c')])).panes.map(p=>p.global_pane_number)).toEqual([2,1]);}finally{successor.close();}
 }finally{registry.close();rmSync(root,{recursive:true,force:true});}
});
it('rejects in-flight and queued reads after close without reacquiring ownership',async()=>{
 const root=mkdtempSync(join(tmpdir(),'pane-numbers-'));const registry=new PaneNumbers(root,'socket-a');
 const successor=new PaneNumbers(root,'socket-a');let release!:()=>void;
 const wait=new Promise<void>(resolve=>release=resolve);let queuedAcquired=false;
 try{
  registry.annotate(snapshot([pane('A','a'),pane('B','b')]));
  const pending=registry.read(async()=>{await wait;return snapshot([pane('A','a'),pane('B','b')]);});
  const queued=registry.read(async()=>{queuedAcquired=true;return snapshot([]);});
  const pendingResult=pending.then(()=>null,error=>error);
  const queuedResult=queued.then(()=>null,error=>error);
  await Promise.resolve();registry.close();release();
  expect((await pendingResult)?.message).toContain('closed');
  expect((await queuedResult)?.message).toContain('closed');expect(queuedAcquired).toBe(false);
  await expect(registry.read(async()=>{queuedAcquired=true;return snapshot([]);})).rejects.toThrow('closed');
  expect(queuedAcquired).toBe(false);
  expect(()=>registry.annotate(snapshot([]))).toThrow('closed');
  expect(successor.annotate(snapshot([pane('B','b'),pane('C','c')])).panes.map(p=>p.global_pane_number)).toEqual([2,1]);
 }finally{release();registry.close();successor.close();rmSync(root,{recursive:true,force:true});}
});
it('fails closed on a corrupt number store instead of renumbering terminals',()=>{
 const root=mkdtempSync(join(tmpdir(),'pane-numbers-'));writeFileSync(join(root,'pane-numbers.sqlite'),'corrupt');const registry=new PaneNumbers(root);
 try{expect(()=>registry.annotate(snapshot([pane('A','w1:p1')]))).toThrow();}finally{registry.close();rmSync(root,{recursive:true,force:true});}
});
