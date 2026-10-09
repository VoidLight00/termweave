import { existsSync,mkdirSync,writeFileSync,renameSync,rmSync,openSync,closeSync,copyFileSync,lstatSync } from 'node:fs';
import { join } from 'node:path';
import { contained,validateArtifact,hash,boundedRead } from './manifest.ts';
export interface ReleasePointer {schema:1;active:string;previous:string|null;generation:number}
export function readPointer(root:string):ReleasePointer|null {
 const path=join(root,'active.json');if(!existsSync(path))return null;
 if(lstatSync(path).isSymbolicLink())throw new Error('Symlink pointer forbidden');
 const value=JSON.parse(boundedRead(path).toString('utf8'));
 if(value.schema!==1||!Number.isInteger(value.generation)||value.generation<1||!/^[a-zA-Z0-9_-]{1,80}$/.test(value.active)||value.previous!==null&&!/^[a-zA-Z0-9_-]{1,80}$/.test(value.previous))throw new Error('Invalid release pointer');return value;
}
export async function activateRelease(root:string,id:string,health:(directory:string)=>Promise<boolean>,rollback=false) {
 if(!rollback && !/^[a-zA-Z0-9_-]{1,80}$/.test(id))throw new Error('Invalid release id');
 const lock=join(root,'.activation.lock');const descriptor=openSync(lock,'wx',0o600);
 try {
  const current=readPointer(root);
  if(rollback){if(!current?.previous)throw new Error('No compatible prior release');id=current.previous;}
  const releases=join(root,'releases');
  if(lstatSync(releases).isSymbolicLink())throw new Error('Release collection symlink forbidden');
  contained(root,releases);
  const candidate=contained(releases,join(releases,id));const manifest=validateArtifact(candidate);
  if(manifest.deployment!=='frontend')throw new Error('Backend/native/schema require distinct coordinated deployment');
  if(current){const active=validateArtifact(contained(releases,join(releases,current.active)));if(JSON.stringify(active.compatibility)!==JSON.stringify(manifest.compatibility)||active.backend!==manifest.backend||active.native.checksum!==manifest.native.checksum)throw new Error('Incompatible release cannot activate or roll back statically');}
  if(!(await health(candidate)))throw new Error('Candidate health check failed');
  if(JSON.stringify(validateArtifact(candidate))!==JSON.stringify(manifest))throw new Error('Candidate changed during health check');
  const assets=join(root,'retained-assets');mkdirSync(assets,{recursive:true});
  // Preserve every prior hashed asset for an already-open client's lazy imports.
  for(const [path,digest] of Object.entries(manifest.assets))if(path.startsWith('assets/')){
   const destination=join(assets,path);
   if(lstatSync(assets).isSymbolicLink())throw new Error('Retained root symlink forbidden');
   const parent=join(destination,'..');
   if(existsSync(parent))contained(assets,parent);
   mkdirSync(parent,{recursive:true});contained(assets,parent);
   if(existsSync(destination)){contained(assets,destination);if(hash(boundedRead(destination,16_777_216))!==digest)throw new Error('Retained asset collision');}
   else copyFileSync(contained(join(candidate,'dist'),join(candidate,'dist',path)),destination);
  }
  const retainedDigests: Record<string,string> = {};
  for(const releaseName of [current?.active,id].filter((value):value is string=>Boolean(value))) {
    const prior=validateArtifact(contained(releases,join(releases,releaseName)));
    for(const [path,digest] of Object.entries(prior.assets))if(path.startsWith('assets/'))retainedDigests[path]=digest;
  }
  const digestPath=join(root,'retained-digests.json');
  const previousDigests=existsSync(digestPath)?JSON.parse(boundedRead(digestPath).toString('utf8')):{};
  const digestTemporary=join(root,`.digests-${process.pid}.json`);
  writeFileSync(digestTemporary,JSON.stringify({...previousDigests,...retainedDigests}),{mode:0o600,flag:'wx'});
  renameSync(digestTemporary,digestPath);
  const next:ReleasePointer={schema:1,active:id,previous:current?.active??null,generation:(current?.generation??0)+1};
  const temporary=join(root,`.pointer-${process.pid}.json`);writeFileSync(temporary,JSON.stringify(next),{mode:0o600,flag:'wx'});renameSync(temporary,join(root,'active.json'));
  return {...next,rollback};
 }finally{closeSync(descriptor);rmSync(lock,{force:true});}
}
if(import.meta.main)throw new Error('Production activation requires separate approval; use activateRelease in an owned deployment root');
