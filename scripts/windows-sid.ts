/** SDDL trustees as S-1-… SIDs, resolved by Windows itself (advapi32): the one place the owned-install ACL check and the private-file test fixture turn an alias into a SID. */
import {dlopen,FFIType,toArrayBuffer} from 'bun:ffi';
const SID=/^S-1-\d+(?:-\d+)+$/;
let api:ReturnType<typeof open>|undefined;
function open(){
 const kernel32=dlopen('kernel32.dll',{LocalFree:{args:[FFIType.ptr],returns:FFIType.ptr},lstrlenW:{args:[FFIType.ptr],returns:FFIType.i32}}).symbols;
 const advapi32=dlopen('advapi32.dll',{ConvertStringSidToSidW:{args:[FFIType.ptr,FFIType.ptr],returns:FFIType.i32},ConvertSidToStringSidW:{args:[FFIType.ptr,FFIType.ptr],returns:FFIType.i32}}).symbols;
 return {...kernel32,...advapi32};
}
/**
 * An SDDL trustee as its S-1-… SID: a SID string as it is; a two-letter alias (SY, BA, or a machine-relative one such as LA, which
 * `icacls /save` writes for the built-in Administrator account) as Windows resolves it on this machine. Undefined when Windows
 * cannot resolve it, and for any alias off Windows, so a caller comparing SIDs fails closed. No alias table is kept here.
 */
export function trusteeSid(trustee:string):string|undefined{
 if(SID.test(trustee))return trustee;
 if(process.platform!=='win32'||!/^[A-Z]{2}$/.test(trustee))return undefined;
 const w=api??=open();const sid=new BigUint64Array(1);
 if(!w.ConvertStringSidToSidW(Buffer.from(`${trustee}\0`,'utf16le'),sid))return undefined;
 try{
  const text=new BigUint64Array(1);if(!w.ConvertSidToStringSidW(sid[0]!,text))return undefined;
  try{const resolved=Buffer.from(toArrayBuffer(text[0]!,0,w.lstrlenW(text[0]!)*2)).toString('utf16le');return SID.test(resolved)?resolved:undefined;}finally{w.LocalFree(text[0]!);}
 }finally{w.LocalFree(sid[0]!);}
}
