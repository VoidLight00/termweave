import { test,expect } from 'bun:test';
import { mkdtempSync, writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { apkDownloadHandler } from './apk';
test('APK route serves exact verified snapshot and refuses arbitrary routes, methods and changed hashes',async()=>{
 const root=mkdtempSync(join(tmpdir(),'tw-apk-'));try{
 const path=join(root,'test.apk'),manifest=join(root,'apk.json'),bytes=Buffer.from('synthetic signed bytes');
 writeFileSync(path,bytes);const record={path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};writeFileSync(manifest,JSON.stringify(record),{mode:0o600});
 expect(()=>apkDownloadHandler(manifest,()=>false)).toThrow('apk_verification_failed');
 const handler=apkDownloadHandler(manifest,()=>true);
 const held=Array.from({length:4},()=>handler(new Request('http://localhost/download/termweave-companion.apk')));
 expect(handler(new Request('http://localhost/download/termweave-companion.apk')).status).toBe(429);
 await Promise.all(held.map(response=>response.body!.cancel()));
 expect(handler(new Request('http://localhost/download/termweave-companion.apk',{headers:{range:'bytes=0-1'}})).status).toBe(416);
 for(const url of ['http://localhost/download/other.apk','http://localhost/download/termweave-companion.apk?path=/etc/passwd'])expect(handler(new Request(url)).status).toBe(404);
 expect(handler(new Request('http://localhost/download/termweave-companion.apk',{method:'POST'})).status).toBe(405);
 writeFileSync(path,Buffer.from('changed on disk'));
 const res=handler(new Request('http://localhost/download/termweave-companion.apk'));expect(res.headers.get('x-content-type-options')).toBe('nosniff');expect(await res.text()).toBe(bytes.toString());
 expect(()=>apkDownloadHandler(manifest,()=>true)).toThrow();
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('version metadata is served only when the manifest records a versionCode',async()=>{
 const root=mkdtempSync(join(tmpdir(),'tw-apk-'));try{
 const path=join(root,'test.apk'),manifest=join(root,'apk.json'),bytes=Buffer.from('synthetic');writeFileSync(path,bytes);
 const sha256=createHash('sha256').update(bytes).digest('hex');
 writeFileSync(manifest,JSON.stringify({path,bytes:bytes.length,sha256}),{mode:0o600});
 expect(apkDownloadHandler(manifest,()=>true)(new Request('http://localhost/download/termweave-companion.json')).status).toBe(404);
 writeFileSync(manifest,JSON.stringify({path,bytes:bytes.length,sha256,versionCode:307,versionName:'0.3.7'}),{mode:0o600});
 const handler=apkDownloadHandler(manifest,()=>true);
 expect(await handler(new Request('http://localhost/download/termweave-companion.json')).json()).toEqual({versionCode:307,versionName:'0.3.7',sha256,bytes:bytes.length});
 expect(handler(new Request('http://localhost/download/termweave-companion.json?x=1')).status).toBe(404);
 }finally{rmSync(root,{recursive:true,force:true});}
});
