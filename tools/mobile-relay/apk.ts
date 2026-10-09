import { lstatSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
const MAX_BYTES=32*1024*1024;
export function apkDownloadHandler(manifest:string, verifySignature=(path:string)=>{
 const signer=join(homedir(),'Library/Android/sdk/build-tools/34.0.0/apksigner');
 const result=Bun.spawnSync([signer,'verify','--verbose',path],{env:{...process.env,JAVA_HOME:'/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home'},stdout:'pipe',stderr:'pipe',timeout:15000});
 return result.exitCode===0;
}){
 const stat=lstatSync(manifest);if(!stat.isFile()||stat.isSymbolicLink()||stat.mode&0o077||stat.uid!==process.getuid?.())throw Error('unsafe_apk_manifest');
 const record=JSON.parse(readFileSync(manifest,'utf8'));
 if(typeof record.path!=='string'||resolve(record.path)!==record.path||!Number.isSafeInteger(record.bytes)||record.bytes<1||record.bytes>MAX_BYTES||!/^[a-f0-9]{64}$/.test(record.sha256))throw Error('invalid_apk_manifest');
 const fileStat=lstatSync(record.path);if(!fileStat.isFile()||fileStat.isSymbolicLink()||fileStat.size!==record.bytes||fileStat.uid!==process.getuid?.())throw Error('unsafe_apk');
 const bytes=readFileSync(record.path);
 if(createHash('sha256').update(bytes).digest('hex')!==record.sha256||!verifySignature(record.path))throw Error('apk_verification_failed');
 // The verified immutable bytes are served; subsequent build output changes are irrelevant.
 let active=0;
 return (req:Request):Response=>{
  const url=new URL(req.url);
  if(url.pathname!=='/download/termweave-companion.apk'||url.search)return new Response('Not found',{status:404});
  if(req.method!=='GET')return new Response('Method not allowed',{status:405,headers:{Allow:'GET'}});
  if(req.headers.has('range'))return new Response('Range not supported',{status:416});
  if(active>=4)return new Response('Download busy',{status:429,headers:{'Retry-After':'5'}});
  active++;let offset=0,closed=false;
  const finish=()=>{if(!closed){closed=true;active--;req.signal.removeEventListener('abort',finish);}};
  req.signal.addEventListener('abort',finish,{once:true});
  const stream=new ReadableStream<Uint8Array>({pull(controller){if(req.signal.aborted){finish();controller.close();return;}const end=Math.min(offset+65536,bytes.length);controller.enqueue(bytes.subarray(offset,end));offset=end;if(offset===bytes.length){finish();controller.close();}},cancel(){finish();}});
  return new Response(stream,{headers:{'Content-Type':'application/vnd.android.package-archive','Content-Disposition':'attachment; filename="termweave-companion.apk"','Content-Length':String(bytes.length),'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','X-TermWeave-SHA256':record.sha256}});
 };
}
