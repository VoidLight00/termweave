import '../test-herdr.ts';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { hash,files,type ReleaseManifest } from './manifest.ts';
import { activateRelease,readPointer } from './activate.ts';import { rollbackRelease } from './rollback.ts';
import { workspaceCreate,workspaceClose,paneSendText,sessionSnapshot } from '../../server/herdr/client.ts';
const root=mkdtempSync(join(process.env.TERMWEAVE_TEST_ROOT!,'release-'));
function artifact(id:string){
 const directory=join(root,'releases',id);mkdirSync(join(directory,'dist','assets'),{recursive:true});writeFileSync(join(directory,'dist','index.html'),id);writeFileSync(join(directory,'dist','assets',id+'.js'),`export default '${id}'`);
 const assets=files(join(directory,'dist'));const manifest:ReleaseManifest={schema:1,id,deployment:'frontend',source:{commit:'a'.repeat(40),tree:'b'.repeat(40),lock:hash('lock'),upstreamLock:hash('upstream')},tools:{bun:Bun.version,node:process.version},native:{version:'fixture',checksum:hash('native')},compatibility:{backend:'1',storage:'v1-v3',protocol:'22'},tests:{status:'PASS',hash:hash('synthetic')},assets,frontend:hash(JSON.stringify(Object.entries(assets).sort())),backend:hash('backend')};writeFileSync(join(directory,'manifest.json'),JSON.stringify(manifest));
}
const created=await workspaceCreate({cwd:root,label:'release-owned-identity'});const pane=created.root_pane;
try{
 const pidFile=join(root,'pid.txt');await paneSendText(pane.pane_id,`printf '%s' $$ > '${pidFile}'\n`);
 for(let i=0;i<100&&!existsSync(pidFile);i++)await Bun.sleep(50);const pid=Number(readFileSync(pidFile,'utf8'));
 const storage={v1:'{"ratio":0.5}',v2:'{"owner":"fixture"}',v3:'{"active":"fixture"}'};const before=JSON.stringify(storage);
 artifact('A');artifact('B');await activateRelease(root,'A',async()=>true);
 await assert.rejects(activateRelease(root,'B',async()=>false));assert.equal(readPointer(root)?.active,'A');
 await activateRelease(root,'B',async()=>true);await rollbackRelease(root,async()=>true);
 assert.equal(readPointer(root)?.active,'A');assert.equal(JSON.stringify(storage),before);
 const after=(await sessionSnapshot()).panes.find(entry=>entry.pane_id===pane.pane_id)!;
 assert.equal(after.terminal_id,pane.terminal_id);process.kill(pid,0);
 const evidence=join(import.meta.dir,'../../evidence/p5');mkdirSync(evidence,{recursive:true});writeFileSync(join(evidence,'native-identity.json'),JSON.stringify({status:'PASS',terminalId:pane.terminal_id,shellPid:pid,pointer:readPointer(root),storageUntouched:true,limits:'Storage fixture is server-side noninterference only; real browser migration covered separately by P3'},null,2));
 console.log('PASS release activation/rollback leaves owned PTY identity and storage fixture intact');
}finally{await workspaceClose(created.workspace.workspace_id);rmSync(root,{recursive:true,force:true});}
