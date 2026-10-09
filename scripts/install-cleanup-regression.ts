import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
for(const stage of ['installed','started']){
 const child=Bun.spawn(['bun',join(import.meta.dir,'actual-install-regression.ts')],{env:{...process.env,TERMWEAVE_INSTALL_FAILURE:stage},stdout:'ignore',stderr:'pipe'});
 assert.notEqual(await child.exited,0);
 const stderr=await new Response(child.stderr).text();assert.ok(stderr.includes('INJECTED_'+stage));
 const result=JSON.parse(readFileSync(join(process.env.DOCK_EVIDENCE!,'actual-install-cleanup-'+stage+'.json'),'utf8'));
 assert.deepEqual(result.failures,[]);assert.equal(result.root_removed,true);
 if(stage==='started'){assert.equal(result.owned_process_count,2);assert.equal(result.owned_pid_count,1);}
 console.log('PASS owned installation failure cleanup: '+stage);
}
