import { expect,it } from 'bun:test';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,renameSync,openSync,closeSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';import { join } from 'node:path';
import { hash,files,validateArtifact,type ReleaseManifest } from './manifest.ts';
import { activateRelease,readPointer,replaceFile } from './activate.ts';import { rollbackRelease } from './rollback.ts';
import { serveStatic } from '../../server/static.ts';
function artifact(root:string,id:string) {
 const directory=join(root,'releases',id);mkdirSync(join(directory,'dist','assets'),{recursive:true});
 writeFileSync(join(directory,'dist','index.html'),`<script type="module" src="/assets/${id}.js"></script>`);writeFileSync(join(directory,'dist','assets',id+'.js'),`export const version='${id}';`);
 const assets=files(join(directory,'dist'));const manifest:ReleaseManifest={schema:1,id,deployment:'frontend',source:{commit:'a'.repeat(40),tree:'b'.repeat(40),lock:hash('lock'),upstreamLock:hash('upstream')},tools:{bun:'1',node:'1'},native:{version:'test',checksum:hash('native')},compatibility:{backend:'1',storage:'v1-v3',protocol:'22'},tests:{status:'PASS',hash:hash('tests')},assets,frontend:hash(JSON.stringify(Object.entries(assets).sort())),backend:hash('backend')};
 writeFileSync(join(directory,'manifest.json'),JSON.stringify(manifest));return directory;
}
it('A remains active after failed B, atomic B activation retains old lazy assets, compatible rollback restores A',async()=>{
 const root=mkdtempSync(join(tmpdir(),'tw-release-'));
 try{
  artifact(root,'A');artifact(root,'B');await activateRelease(root,'A',async()=>true);
  await expect(activateRelease(root,'B',async()=>false)).rejects.toThrow('health');expect(readPointer(root)?.active).toBe('A');
  await activateRelease(root,'B',async()=>true);expect(readPointer(root)?.active).toBe('B');
  expect(await (await serveStatic('/assets/A.js',root)).text()).toContain("version='A'");
  expect((await serveStatic('/assets/missing.js',root)).status).toBe(404);expect((await serveStatic('/missing.css',root)).status).toBe(404);
  await rollbackRelease(root,async()=>true);expect(readPointer(root)?.active).toBe('A');expect(await(await serveStatic('/',root)).text()).toContain('/assets/A.js');
  expect((await serveStatic('/assets/B.js',root)).status).toBe(200);
 }finally{rmSync(root,{recursive:true,force:true});}
});
it('rejects corrupt artifacts, traversal, symlinks and backend/schema static activation',async()=>{
 const root=mkdtempSync(join(tmpdir(),'tw-release-')),outside=mkdtempSync(join(tmpdir(),'tw-out-'));
 try{
  const a=artifact(root,'A');await expect(activateRelease(root,'../escape',async()=>true)).rejects.toThrow();
  symlinkSync(outside,join(a,'dist','escape'));expect(()=>validateArtifact(a)).toThrow('symlink');rmSync(join(a,'dist','escape'));
  const manifest=JSON.parse(readFileSync(join(a,'manifest.json'),'utf8'));manifest.deployment='schema';writeFileSync(join(a,'manifest.json'),JSON.stringify(manifest));
  await expect(activateRelease(root,'A',async()=>true)).rejects.toThrow('distinct');
 }finally{rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});

it('rollback shares activation lock and cannot use a stale previous pointer during an activation',async()=>{
 const root=mkdtempSync(join(tmpdir(),'tw-release-race-'));
 try{artifact(root,'A');artifact(root,'B');await activateRelease(root,'A',async()=>true);let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);const pending=activateRelease(root,'B',async()=>{await gate;return true;});await Bun.sleep(0);await expect(rollbackRelease(root,async()=>true)).rejects.toThrow();release();await pending;await rollbackRelease(root,async()=>true);expect(readPointer(root)?.active).toBe('A');}
 finally{rmSync(root,{recursive:true,force:true});}
});

it('static cache validates changed pointer generations and rejects malformed escaped pointers',async()=>{
 const root=mkdtempSync(join(tmpdir(),'tw-pointer-'));
 try{artifact(root,'A');const b=artifact(root,'B');await activateRelease(root,'A',async()=>true);expect((await serveStatic('/',root)).status).toBe(200);
 writeFileSync(join(b,'dist','assets','B.js'),'corrupt');writeFileSync(join(root,'active.json'),JSON.stringify({schema:1,active:'B',previous:'A',generation:2}));await expect(serveStatic('/',root)).rejects.toThrow('hash');
 writeFileSync(join(root,'active.json'),JSON.stringify({schema:1,active:'../escape',previous:'A',generation:3}));await expect(serveStatic('/',root)).rejects.toThrow('pointer');
 }finally{rmSync(root,{recursive:true,force:true});}
});

it('static denies escaped collection and same-ID asset replacement after cache validation',async()=>{
 const root=mkdtempSync(join(tmpdir(),'tw-cache-')),outside=mkdtempSync(join(tmpdir(),'tw-external-'));
 try{const a=artifact(root,'A');await activateRelease(root,'A',async()=>true);await serveStatic('/assets/A.js',root);writeFileSync(join(a,'dist','assets','A.js'),'tampered');await expect(serveStatic('/assets/A.js',root)).rejects.toThrow('changed');
 rmSync(join(root,'releases'),{recursive:true});symlinkSync(outside,join(root,'releases'));await expect(serveStatic('/',root)).rejects.toThrow('symlink');}
 finally{rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});

it('verified shell and retained bytes reject same-generation mutation/removal and escaped roots',async()=>{
 const root=mkdtempSync(join(tmpdir(),'tw-shell-')),outside=mkdtempSync(join(tmpdir(),'tw-retained-'));
 try{const a=artifact(root,'A');artifact(root,'B');await activateRelease(root,'A',async()=>true);await serveStatic('/',root);writeFileSync(join(a,'dist','index.html'),'tampered');await expect(serveStatic('/',root)).rejects.toThrow('shell');rmSync(join(a,'dist','index.html'));expect((await serveStatic('/',root)).status).toBe(503);
 rmSync(join(root,'releases'),{recursive:true});artifact(root,'A');artifact(root,'B');await activateRelease(root,'B',async()=>true);writeFileSync(join(root,'retained-assets','assets','A.js'),'tampered');await expect(serveStatic('/assets/A.js',root)).rejects.toThrow('changed');rmSync(join(root,'retained-assets'),{recursive:true});symlinkSync(outside,join(root,'retained-assets'));await expect(serveStatic('/assets/A.js',root)).rejects.toThrow('symlink');}
 finally{rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});

it('recycled deployment root is revalidated and concurrent old asset readers observe complete metadata',async()=>{
 const root=mkdtempSync(join(tmpdir(),'tw-root-'));const moved=root+'-old';
 try{artifact(root,'A');artifact(root,'B');await activateRelease(root,'A',async()=>true);await serveStatic('/',root);await activateRelease(root,'B',async()=>true);const reads=Array.from({length:10},()=>serveStatic('/assets/A.js',root));await activateRelease(root,'A',async()=>true);for(const response of await Promise.all(reads))expect(response.status).toBe(200);
 renameSync(root,moved);mkdirSync(root);const a=artifact(root,'A');await activateRelease(root,'A',async()=>true);writeFileSync(join(a,'dist','index.html'),'recycled-tamper');await expect(serveStatic('/',root)).rejects.toThrow();}
 finally{rmSync(root,{recursive:true,force:true});rmSync(moved,{recursive:true,force:true});}
});

it('separate process reads retained assets while repeated activation renames sidecars',async()=>{
 const root=mkdtempSync(join(tmpdir(),'tw-interleave-'));
 try{artifact(root,'A');artifact(root,'B');await activateRelease(root,'A',async()=>true);await activateRelease(root,'B',async()=>true);
 const script=`import {serveStatic} from ${JSON.stringify(join(import.meta.dir,'../../server/static.ts'))}; let n=0; for(let i=0;i<150;i++){const r=await serveStatic('/assets/A.js',${JSON.stringify(root)});if(r.status!==200||!(await r.text()).includes("version='A'"))throw new Error('Reader mismatch');n++;await Bun.sleep(2);}process.stdout.write(String(n));`;
 const child=Bun.spawn(['bun','-e',script],{env:{...process.env,HERDR_STAGING_DIST:''},stdout:'pipe',stderr:'pipe'});
 for(let i=0;i<15;i++)await activateRelease(root,i%2?'A':'B',async()=>{await Bun.sleep(5);return true;});
 expect(await child.exited).toBe(0);expect(Number(await new Response(child.stdout).text())).toBe(150);
 }finally{rmSync(root,{recursive:true,force:true});}
// a second Bun process plus 150 verified reads and 15 activations: about 1.6 s idle on Windows, past Bun's 5 s default on a loaded runner
},30_000);
it('activation replaces the pointer and digests while a reader holds them open',async()=>{
 const root=mkdtempSync(join(tmpdir(),'tw-open-'));
 try{artifact(root,'A');artifact(root,'B');await activateRelease(root,'A',async()=>true);
  const held=['active.json','retained-digests.json'].map(name=>openSync(join(root,name),'r'));
  try{await activateRelease(root,'B',async()=>true);expect(readPointer(root)?.active).toBe('B');expect(JSON.parse(readFileSync(held[0]!,'utf8')).active).toBe('A');}
  finally{for(const fd of held)closeSync(fd);}
  expect(Object.keys(JSON.parse(readFileSync(join(root,'retained-digests.json'),'utf8')))).toEqual(['assets/A.js','assets/B.js']);
 }finally{rmSync(root,{recursive:true,force:true});}
});
it('a replace whose source cannot be opened fails with the OS reason and leaves the target',()=>{
 const root=mkdtempSync(join(tmpdir(),'tw-replace-'));const to=join(root,'to');
 try{writeFileSync(to,'old');
  // Windows: no fallback rename and no retry, the Win32 error of the failing call (ERROR_FILE_NOT_FOUND); POSIX: rename(2)
  expect(()=>replaceFile(join(root,'missing'),to)).toThrow(process.platform==='win32'?/failed: CreateFileW Win32 error 2$/:/ENOENT/);
  expect(readFileSync(to,'utf8')).toBe('old');
 }finally{rmSync(root,{recursive:true,force:true});}
});
it.if(process.platform==='win32')('Windows replace retries a source held without delete sharing, and reports the Win32 error once the retry budget is spent',async()=>{
 const root=mkdtempSync(join(tmpdir(),'tw-held-'));const from=join(root,'from'),to=join(root,'to'),ready=join(root,'ready');
 // a scanner-like holder in another process: the source opened with share mode 0, so no DELETE open succeeds while it holds
 const hold=(ms:number)=>Bun.spawn([process.execPath,'-e',`import {dlopen,FFIType,ptr} from 'bun:ffi';import {writeFileSync} from 'node:fs';
const k=dlopen('kernel32.dll',{CreateFileW:{args:[FFIType.ptr,FFIType.u32,FFIType.u32,FFIType.ptr,FFIType.u32,FFIType.u32,FFIType.ptr],returns:FFIType.i64},CloseHandle:{args:[FFIType.i64],returns:FFIType.i32}}).symbols;
const h=k.CreateFileW(ptr(Buffer.from(${JSON.stringify(from)}+'\\0','utf16le')),0x80000000,0,null,3,0,null);if(h===-1n)process.exit(2);
writeFileSync(${JSON.stringify(ready)},'');Bun.sleepSync(${ms});k.CloseHandle(h);`],{stdin:'ignore',stdout:'ignore',stderr:'pipe',windowsHide:true});
 const held=async(holder:ReturnType<typeof hold>)=>{for(const deadline=Date.now()+15_000;!existsSync(ready);await Bun.sleep(5))if(holder.exitCode!==null||Date.now()>deadline)throw new Error(`holder not ready (exit ${holder.exitCode}): ${await new Response(holder.stderr).text()}`);};
 writeFileSync(from,'new');writeFileSync(to,'old');let holder=hold(60_000);
 try{await held(holder);
  expect(()=>replaceFile(from,to,200)).toThrow('CreateFileW Win32 error 32 after retrying for 200 ms');
  expect(readFileSync(to,'utf8')).toBe('old');expect(existsSync(from)).toBe(true);
  holder.kill();await holder.exited;rmSync(ready);
  // released 300 ms after it took the file: the sharing violations are retried and the replace completes
  holder=hold(300);await held(holder);
  replaceFile(from,to);expect(readFileSync(to,'utf8')).toBe('new');expect(existsSync(from)).toBe(false);expect(await holder.exited).toBe(0);
 }finally{holder.kill();await holder.exited;rmSync(root,{recursive:true,force:true});}
},30_000);
it('exclusive metadata temporaries cannot follow attacker-planted symlinks',async()=>{
 const root=mkdtempSync(join(tmpdir(),'tw-temp-'));const target=join(root,'untouched');
 try{artifact(root,'A');writeFileSync(target,'sentinel');symlinkSync(target,join(root,`.digests-${process.pid}.json`));await expect(activateRelease(root,'A',async()=>true)).rejects.toThrow();expect(readFileSync(target,'utf8')).toBe('sentinel');expect(readPointer(root)).toBeNull();}
 finally{rmSync(root,{recursive:true,force:true});}
});
