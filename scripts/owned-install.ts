import {dlopen,FFIType} from 'bun:ffi';import {cpSync,mkdirSync,mkdtempSync,readdirSync,readFileSync,writeFileSync,lstatSync,readlinkSync,rmdirSync,rmSync} from 'node:fs';import {resolve,join,isAbsolute} from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';
import {installationSources} from './install-source.ts';import {canonicalPath,judgeDestination} from './lifecycle-path.ts';import {buildChildEnv} from './lifecycle-env.ts';import {trusteeSid} from './windows-sid.ts';
const SYSTEM_SID='S-1-5-18';
const SE_FILE_OBJECT=1,DACL_SECURITY_INFORMATION=0x4,PROTECTED_DACL_SECURITY_INFORMATION=0x8000_0000,SDDL_REVISION_1=1;
let win32:ReturnType<typeof openWin32>|undefined;
/** 64-bit Windows (x64 and ARM64 share these LLP64 signatures), as in server/private-file.ts; out-parameters are TypedArrays. */
function openWin32(){
 const kernel32=dlopen('kernel32.dll',{LocalFree:{args:[FFIType.ptr],returns:FFIType.ptr}}).symbols;
 const advapi32=dlopen('advapi32.dll',{ConvertStringSecurityDescriptorToSecurityDescriptorW:{args:[FFIType.ptr,FFIType.u32,FFIType.ptr,FFIType.ptr],returns:FFIType.i32},GetSecurityDescriptorDacl:{args:[FFIType.ptr,FFIType.ptr,FFIType.ptr,FFIType.ptr],returns:FFIType.i32},SetNamedSecurityInfoW:{args:[FFIType.ptr,FFIType.u32,FFIType.u32,FFIType.ptr,FFIType.ptr,FFIType.ptr,FFIType.ptr],returns:FFIType.u32}}).symbols;
 return {...kernel32,...advapi32};
}
const wide=(text:string)=>Buffer.from(`${text}\0`,'utf16le');
/**
 * Sets the whole DACL of `root` to a protected one granting only `sid` and SYSTEM (OI)(CI) full control. SetNamedSecurityInfoW replaces
 * the DACL, where icacls only edits it: an explicit ACE for another trustee (an elevated runner leaves BUILTIN\Administrators) survived
 * `icacls /inheritance:r /grant:r`. The owner is left as created; the owner-only rule is the DACL. Without bun:ffi it refuses.
 */
function applyOwnedDacl(root:string,sid:string){
 const fail=(why:string)=>new Error(`Owned root ACL apply failed: ${why}`);
 let w:ReturnType<typeof openWin32>;try{w=win32??=openWin32();}catch(error){throw fail(`Windows security APIs are unavailable (${(error as Error).message})`);}
 const descriptor=new BigUint64Array(1);
 if(!w.ConvertStringSecurityDescriptorToSecurityDescriptorW(wide(`D:P(A;OICI;FA;;;${sid})(A;OICI;FA;;;${SYSTEM_SID})`),SDDL_REVISION_1,descriptor,null))throw fail('the security descriptor could not be built');
 try{
  const present=new Int32Array(1),dacl=new BigUint64Array(1),defaulted=new Int32Array(1);
  if(!w.GetSecurityDescriptorDacl(descriptor[0]!,present,dacl,defaulted)||!present[0]||!dacl[0])throw fail('the security descriptor has no DACL');
  const status=w.SetNamedSecurityInfoW(wide(root),SE_FILE_OBJECT,(DACL_SECURITY_INFORMATION|PROTECTED_DACL_SECURITY_INFORMATION)>>>0,null,null,dacl[0]!,null);
  if(status!==0)throw fail(`Win32 error ${status}`);
 }finally{w.LocalFree(descriptor[0]!);}
}
const system32=(exe:string)=>{const root=process.env.SystemRoot;if(!root||!isAbsolute(root))throw new Error('SystemRoot is required for the owned root ACL');return join(root,'System32',exe);};
/** Every child inherits the denylist-filtered environment (lifecycle-env.ts), never the raw parent with its API keys. */
const run=(argv:string[],cwd?:string,timeout?:number)=>Bun.spawnSync(argv,{cwd,env:buildChildEnv(process.env),stdout:'pipe',stderr:'pipe',windowsHide:true,timeout});
/** SID of the installing account from the locale-independent SID column of `whoami /user`; a whoami that hangs is killed after 15 s and fails it. */
export function currentUserSid():string{const result=run([system32('whoami.exe'),'/user','/fo','csv','/nh'],undefined,15_000);const sid=result.exitCode===0?/"(S-1-\d+(?:-\d+)+)"\s*$/.exec(result.stdout.toString())?.[1]:undefined;if(!sid)throw new Error('Current user SID unavailable');return sid;}
/** SDDL DACL that is protected (no inherited ACEs) and grants exactly the user and SYSTEM (OI)(CI) full control. A trailing SACL of mandatory-label ACEs only (an elevated creator leaves e.g. S:(ML;OICI;NW;;;HI)) is accepted: a label only restricts writes from lower integrity. Every trustee is compared as its SID (`icacls /save` writes aliases such as SY, and LA when the user is the built-in Administrator); one Windows cannot resolve fails the check. */
export function isOwnedRootDacl(sddl:string,userSid:string):boolean{
 const [,control='',aces='']=/^D:([A-Z]*)((?:\([^()]*\))+)(?:S:[A-Z]*(?:\(ML;[^()]*\))+)?$/.exec(sddl.trim())??[];if(!control.includes('P'))return false;
 const expected=new Set([userSid,SYSTEM_SID]);const seen=new Set<string>();
 for(const ace of aces.slice(1,-1).split(')(')){const [type,flags,rights,object,inherited,trustee,...rest]=ace.split(';');const sid=trustee?trusteeSid(trustee):undefined;if(rest.length||type!=='A'||flags!=='OICI'||rights!=='FA'||object||inherited||!sid||!expected.has(sid))return false;seen.add(sid);}
 return seen.size===expected.size;
}
/** Windows, right after root creation and before any file is written: sets the protected DACL of the user `sid` (default: the installing user) and SYSTEM only, then reads it back independently of how it was set, with `icacls /save`. Any failure fails the install. */
export function restrictOwnedRoot(root:string,sid=currentUserSid()){
 const icacls=system32('icacls.exe');applyOwnedDacl(root,sid);
 const scratch=mkdtempSync(join(tmpdir(),'tw-acl-'));
 try{const saved=join(scratch,'acl');const sddl=run([icacls,root,'/save',saved]).exitCode===0?readFileSync(saved).toString('utf16le').split(/\r?\n/)[1]??'':'';if(!isOwnedRootDacl(sddl,sid))throw new Error(`Owned root ACL verification failed: expected only ${sid} and SYSTEM, read back ${JSON.stringify(sddl)}`);}
 finally{rmSync(scratch,{recursive:true,force:true});}
}
export function installOwned(source:string,destination:string){
 const sources=installationSources(source);const sourceRoot=canonicalPath(source);
 const source_sha=execFileSync('git',['rev-parse','HEAD'],{cwd:sourceRoot,env:buildChildEnv(process.env),encoding:'utf8',windowsHide:true}).trim();if(!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(source_sha))throw new Error('Source commit unavailable');
 const judged=judgeDestination(destination,sourceRoot);if('refused' in judged)throw new Error(judged.refused==='symlink ancestor'?'Symlink ancestor refused':`Install requires a new independent destination (${judged.refused})`);
 const root=judged.root;mkdirSync(root,{recursive:false});
 if(process.platform==='win32'){try{restrictOwnedRoot(root);}catch(error){try{rmdirSync(root);}catch{}throw error;}}
 for(const name of sources){mkdirSync(resolve(root,name,'..'),{recursive:true});cpSync(join(sourceRoot,name),join(root,name));}
 if(run([process.execPath,'install','--frozen-lockfile','--ignore-scripts'],root).exitCode!==0)throw new Error('Locked install failed');
 if(run([process.execPath,'run','build'],root).exitCode!==0)throw new Error('Build failed');
 const inventory:Record<string,string>={};const visit=(dir:string)=>{for(const name of readdirSync(dir)){const p=join(dir,name);const stat=lstatSync(p);if(stat.isSymbolicLink()){inventory[p.slice(root.length+1)]='symlink:'+readlinkSync(p);continue;}if(stat.isDirectory()){inventory[p.slice(root.length+1)]='directory';visit(p);}else inventory[p.slice(root.length+1)]=createHash('sha256').update(readFileSync(p)).digest('hex');}};visit(root);
 writeFileSync(join(root,'.termweave-owned.json'),JSON.stringify({product:'termweave',root,source_sha,inventory}),{mode:0o600,flag:'wx'});
 return root;
}
if(import.meta.main)installOwned(resolve(import.meta.dir,'..'),process.argv[2]??'');
