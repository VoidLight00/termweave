import { existsSync,mkdirSync,writeFileSync,renameSync,rmSync,openSync,closeSync,copyFileSync,lstatSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { dlopen,FFIType,ptr } from 'bun:ffi';
import { contained,validateArtifact,hash,boundedRead } from './manifest.ts';
let kernel32:ReturnType<typeof openKernel32>|undefined;
function openKernel32(){return dlopen('kernel32.dll',{
 CreateFileW:{args:[FFIType.ptr,FFIType.u32,FFIType.u32,FFIType.ptr,FFIType.u32,FFIType.u32,FFIType.ptr],returns:FFIType.i64},
 SetFileInformationByHandle:{args:[FFIType.i64,FFIType.i32,FFIType.ptr,FFIType.u32],returns:FFIType.i32},
 GetVolumeInformationByHandleW:{args:[FFIType.i64,FFIType.ptr,FFIType.u32,FFIType.ptr,FFIType.ptr,FFIType.ptr,FFIType.ptr,FFIType.u32],returns:FFIType.i32},
 GetLastError:{args:[],returns:FFIType.u32},
 CloseHandle:{args:[FFIType.i64],returns:FFIType.i32},
}).symbols;}
const ERROR_ACCESS_DENIED=5,ERROR_SHARING_VIOLATION=32,ERROR_NOT_SUPPORTED=50,ERROR_INVALID_PARAMETER=87;
/** Transient refusals (an antivirus or indexer scan holding the file without FILE_SHARE_DELETE) are retried for this long. */
export const REPLACE_RETRY_MS=5_000;
const POLL_MS=20;
/** The volume's file system name (NTFS, ReFS, FAT32, ...), or undefined where the volume does not say. */
function fileSystem(api:NonNullable<typeof kernel32>,handle:bigint):string|undefined{
 const name=Buffer.alloc(2*261);
 if(api.GetVolumeInformationByHandleW(handle,null,0,null,null,null,ptr(name),261)===0)return undefined;
 return name.toString('utf16le').split('\0')[0];
}
/**
 * One Windows FileRenameInfoEx with REPLACE_IF_EXISTS|POSIX_SEMANTICS, which a reader holding the target open (FILE_SHARE_DELETE, as
 * Bun/Node open) does not block. `unsupported` where the volume has no POSIX rename, otherwise the failing call and its Win32 error.
 * GetLastError is its own bun:ffi call made right after the failing call with no other call or await in between; checked on Bun 1.4
 * x64 by alternating CreateFileW failures (not found, path not found, sharing violation) after a SetLastError sentinel, 20,000 calls
 * with a forced GC every 1,000: each returned the failing call's own code, never the sentinel.
 */
function posixRename(from:string,to:string):'renamed'|'unsupported'|{call:string;code:number}{
 const api=kernel32??=openKernel32();const source=Buffer.from(resolve(from)+'\0','utf16le');
 // DELETE access, share read/write/delete, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT (rename a link itself, as rename(2) does)
 const handle=api.CreateFileW(ptr(source),0x10000,7,null,3,0x200000,null);if(handle===-1n)return {call:'CreateFileW',code:api.GetLastError()};
 try{const name=Buffer.from(resolve(to),'utf16le');const info=Buffer.alloc(20+name.length+2);// 64-bit (x64 and ARM64) FILE_RENAME_INFO: Flags@0, RootDirectory@8, FileNameLength@16, FileName@20
  info.writeUInt32LE(0x1|0x2,0);info.writeUInt32LE(name.length,16);name.copy(info,20);
  if(api.SetFileInformationByHandle(handle,22,ptr(info),info.length)!==0)return 'renamed';
  const code=api.GetLastError();
  if(code===ERROR_INVALID_PARAMETER||code===ERROR_NOT_SUPPORTED)return 'unsupported';
  if(code!==ERROR_SHARING_VIOLATION&&code!==ERROR_ACCESS_DENIED){const system=fileSystem(api,handle);if(system!==undefined&&system!=='NTFS')return 'unsupported';}
  return {call:'SetFileInformationByHandle',code};
 }finally{api.CloseHandle(handle);}
}
/**
 * Atomically replaces `to` with `from`. A plain Windows rename refuses a target another process has open (the server reading
 * active.json mid-activation), so Windows uses the POSIX rename, retries sharing/access refusals within `retryMs`, falls back to
 * the ordinary rename only where the volume has no POSIX rename, and otherwise throws with the Win32 error. POSIX: rename(2).
 */
export function replaceFile(from:string,to:string,retryMs=REPLACE_RETRY_MS):void{
 if(process.platform!=='win32'){renameSync(from,to);return;}
 for(const deadline=Date.now()+retryMs;;){
  const result=posixRename(from,to);
  if(result==='renamed')return;
  if(result==='unsupported'){renameSync(from,to);return;}
  const transient=result.code===ERROR_SHARING_VIOLATION||result.code===ERROR_ACCESS_DENIED;
  if(!transient||Date.now()>=deadline)throw new Error(`Replacing ${to} with ${from} failed: ${result.call} Win32 error ${result.code}${transient?` after retrying for ${retryMs} ms`:''}`);
  Bun.sleepSync(POLL_MS);
 }
}
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
  replaceFile(digestTemporary,digestPath);
  const next:ReleasePointer={schema:1,active:id,previous:current?.active??null,generation:(current?.generation??0)+1};
  const temporary=join(root,`.pointer-${process.pid}.json`);writeFileSync(temporary,JSON.stringify(next),{mode:0o600,flag:'wx'});replaceFile(temporary,join(root,'active.json'));
  return {...next,rollback};
 }finally{closeSync(descriptor);rmSync(lock,{force:true});}
}
if(import.meta.main)throw new Error('Production activation requires separate approval; use activateRelease in an owned deployment root');
