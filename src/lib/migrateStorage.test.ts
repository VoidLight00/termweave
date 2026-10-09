import {expect,it} from 'bun:test';import {migrateUpstreamPreferences} from './migrateStorage.ts';
it('migration requires opt-in, preserves upstream and target values and excludes credentials',()=>{
 const values=new Map([['herdr-web-ui:settings','old'],['herdr-web-ui:dock:v1','layout'],['herdr-web-ui:token','private'],['termweave:settings','new']]);const storage={get length(){return values.size;},key:(i:number)=>[...values.keys()][i]??null,getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value)} as unknown as Storage;
 expect(()=>migrateUpstreamPreferences(storage,false)).toThrow();expect(migrateUpstreamPreferences(storage,true)).toBe(1);expect(values.get('termweave:settings')).toBe('new');expect(values.get('termweave:dock:v1')).toBe('layout');expect(values.has('termweave:token')).toBe(false);expect(values.get('herdr-web-ui:dock:v1')).toBe('layout');
});
