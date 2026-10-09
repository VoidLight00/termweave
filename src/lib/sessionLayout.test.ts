import { afterEach, beforeEach, expect, test } from 'bun:test';
import { group, dock, groups } from './dockLayout.ts';
import { initialSessionLayout, readSessionLayout, saveSessionLayout, initialWorkspaceLayout, readWorkspaceLayout, saveWorkspaceLayout } from './sessionLayout.ts';
const values = new Map<string,string>();
beforeEach(()=>{values.clear();Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{get length(){return values.size;},key:(i:number)=>[...values.keys()][i]??null,getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value)}});});
afterEach(()=>{delete (globalThis as Record<string,unknown>).localStorage;});
test('session owners and machines have independent trees/primary/ratios',()=>{
 const tree=dock(group('main',['A','shell']), 'shell','main','right','split');
 saveSessionLayout('local','A',{tree,primary:'shell',workspace:'w'});
 expect(initialSessionLayout('local','B','w').tree).toEqual(group('main',['B']));
 expect(initialSessionLayout('other','A','w').tree).toEqual(group('main',['A']));
 expect(readSessionLayout('local','A')?.primary).toBe('shell');
 expect(readSessionLayout('local','A')?.tree).toEqual(tree);
});
test('legacy tree is claimed once, left intact, and unrelated row starts single',()=>{
 const tree=dock(group('main',['A','B']), 'B','main','right','split');
 const key='termweave:dock:v1:local:w'; const original=JSON.stringify(tree);values.set(key,original);
 expect(initialSessionLayout('local','unrelated','w').tree).toEqual(group('main',['unrelated']));
 expect(initialSessionLayout('local','A','w').tree).toEqual(tree);
 expect(initialSessionLayout('local','B','w').tree).toEqual(group('main',['B']));
 expect(values.get(key)).toBe(original);
});
test('workspace upgrade prefers deployed v2 to stale v1 and merges without deleting keys',()=>{
 const tree=dock(group('main',['A','A2']), 'A2','main','right','split');
 values.set('termweave:dock:v1:local:w',JSON.stringify(group('old',['old'])));
 saveSessionLayout('local','B',{tree:group('b',['B','A2']),primary:'B',workspace:'w'});
 saveSessionLayout('local','A',{tree,primary:'A2',workspace:'w'});
 const old=new Map(values);
 const upgraded=initialWorkspaceLayout('local','w',['B','A2','A'],'B');
 expect(upgraded.primary).toBe('A2');
 expect(upgraded.tree.kind).toBe('split');
 expect(groups(upgraded.tree).flatMap(g=>g.tabs)).toEqual(['A','B','A2']);
 for(const [key,value] of old) expect(values.get(key)).toBe(value);
 expect(readWorkspaceLayout('local','w')).toEqual(upgraded);
 expect(initialWorkspaceLayout('local','w',['B','A2','A'],'A')).toEqual(upgraded);
 expect(initialWorkspaceLayout('remote','w',['remote-pane'],'remote-pane').primary).toBe('remote-pane');
 saveWorkspaceLayout('local','other',{tree:group('other',['C']),primary:'C',workspace:'other'});
 expect(readWorkspaceLayout('local','w')).toEqual(upgraded);
});
test('workspace migration supports v1-only geometry and rejects unrelated v2',()=>{
 const tree=dock(group('main',['A','B']),'B','main','bottom','s');
 values.set('termweave:dock:v1:local:w',JSON.stringify(tree));
 saveSessionLayout('local','A',{tree:group('foreign',['foreign']),primary:'foreign',workspace:'foreign'});
 expect(initialWorkspaceLayout('local','w',['A','B'],'A').tree).toEqual(tree);
});
test('malformed storage is harmless',()=>{
 values.set('termweave:dock:session:v2:local:A','{"tree":null}');
 expect(initialSessionLayout('local','A','w').tree).toEqual(group('main',['A']));
});
