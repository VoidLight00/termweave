import { expect,it } from 'bun:test';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,renameSync } from 'node:fs';
import { tmpdir } from 'node:os';import { join } from 'node:path';
import { hash,files,validateArtifact,type ReleaseManifest } from './manifest.ts';
import { activateRelease,readPointer } from './activate.ts';import { rollbackRelease } from './rollback.ts';
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
});
it('exclusive metadata temporaries cannot follow attacker-planted symlinks',async()=>{
 const root=mkdtempSync(join(tmpdir(),'tw-temp-'));const target=join(root,'untouched');
 try{artifact(root,'A');writeFileSync(target,'sentinel');symlinkSync(target,join(root,`.digests-${process.pid}.json`));await expect(activateRelease(root,'A',async()=>true)).rejects.toThrow();expect(readFileSync(target,'utf8')).toBe('sentinel');expect(readPointer(root)).toBeNull();}
 finally{rmSync(root,{recursive:true,force:true});}
});
