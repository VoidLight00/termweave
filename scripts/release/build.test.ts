import {files} from './manifest.ts';
import { expect,it } from 'bun:test';
import { mkdtempSync,writeFileSync,rmSync,mkdirSync,openSync,ftruncateSync,closeSync } from 'node:fs';import { join } from 'node:path';import { tmpdir } from 'node:os';import { execFileSync } from 'node:child_process';
import { requireCleanSource,backendCompatibilityHash,validateTestEvidence,REQUIRED_RELEASE_LANES } from './build.ts';
it('release source must be its own clean committed repository, not dirty or untracked source',()=>{
 const root=mkdtempSync(join(tmpdir(),'tw-clean-'));const git=(...args:string[])=>execFileSync('git',['-C',root,...args],{stdio:'pipe'});
 try{
 git('init');writeFileSync(join(root,'synthetic.txt'),'synthetic');git('add','synthetic.txt');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','Synthetic release fixture');
 expect(requireCleanSource(root).commit).toMatch(/^[a-f0-9]{40}$/);
 writeFileSync(join(root,'untracked.txt'),'x');expect(()=>requireCleanSource(root)).toThrow('clean');rmSync(join(root,'untracked.txt'));
 writeFileSync(join(root,'synthetic.txt'),'dirty');expect(()=>requireCleanSource(root)).toThrow('clean');
 }finally{rmSync(root,{recursive:true,force:true});}
});

it('shared-only runtime changes invalidate backend compatibility',()=>{
 const root=mkdtempSync(join(tmpdir(),'tw-backend-'));
 try{mkdirSync(join(root,'server'));mkdirSync(join(root,'shared'));mkdirSync(join(root,'scripts','release'),{recursive:true});writeFileSync(join(root,'server','a.ts'),'server');writeFileSync(join(root,'shared','protocol.ts'),'v1');writeFileSync(join(root,'package.json'),'{}');writeFileSync(join(root,'bun.lock'),'lock');const before=backendCompatibilityHash(root);writeFileSync(join(root,'shared','protocol.ts'),'v2');expect(backendCompatibilityHash(root)).not.toBe(before);}
 finally{rmSync(root,{recursive:true,force:true});}
});

it('release evidence rejects empty missing duplicate unknown and wrong-source lanes',()=>{
 const identity={commit:'a'.repeat(40),tree:'b'.repeat(40)};const good={status:'PASS',source_commit:identity.commit,source_tree:identity.tree,lanes:REQUIRED_RELEASE_LANES.map(name=>({name,exit_code:0}))};
 expect(()=>validateTestEvidence(good,identity)).not.toThrow();
 for(const lanes of [[],good.lanes.slice(1),[...good.lanes.slice(1),good.lanes[1]],good.lanes.map((lane,i)=>i===0?{name:'unknown',exit_code:0}:lane)])expect(()=>validateTestEvidence({...good,lanes},identity)).toThrow();
 expect(()=>validateTestEvidence({...good,source_tree:'c'.repeat(40)},identity)).toThrow();
});

it('artifact validation enforces per-file resource bound',()=>{
 const root=mkdtempSync(join(tmpdir(),'tw-bound-'));
 try{const fd=openSync(join(root,'large.js'),'w');ftruncateSync(fd,16_777_217);closeSync(fd);expect(()=>files(root)).toThrow('byte bound');}
 finally{rmSync(root,{recursive:true,force:true});}
});
