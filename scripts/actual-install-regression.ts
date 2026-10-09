import './test-herdr.ts';import assert from 'node:assert/strict';import {mkdtempSync,existsSync,readFileSync,rmSync,writeFileSync} from 'node:fs';import {join} from 'node:path';import {uninstallOwned} from './uninstall.ts';
const root=mkdtempSync(join(process.env.TERMWEAVE_TEST_ROOT!,'actual-install-')),destination=join(root,'installed');
const portProbe=Bun.serve({port:0,hostname:'127.0.0.1',fetch:()=>new Response('probe')});const port=portProbe.port;portProbe.stop(true);
const env={...process.env,HERDR_STAGING_DIST:join(destination,'dist'),TERMWEAVE_INSTALL_DIR:destination,HOST:'127.0.0.1',PORT:String(port),HERDR_WEB_TOKEN:'synthetic-install',HERDR_WEB_STATE_DIR:join(root,'state')};
const children:ReturnType<typeof Bun.spawn>[]=[];const ownedPids=new Set<number>();
const spawn=(command:string[],options:any)=>{const child=Bun.spawn(command,options);children.push(child);return child;};
const inject=(stage:string)=>{if(process.env.TERMWEAVE_INSTALL_FAILURE===stage)throw new Error('INJECTED_'+stage);};
try {
const installer=Bun.spawnSync(['sh',join(import.meta.dir,'../install.sh'),'--install'],{env,stdout:'pipe',stderr:'pipe'});assert.equal(installer.exitCode,0,installer.stderr.toString());inject('installed');
const waitPid=async()=>{for(let i=0;i<200;i++){try{const pid=JSON.parse(readFileSync(join(destination,'lifecycle.json'),'utf8')).pid;if(Number.isSafeInteger(pid))return pid as number;}catch{}await Bun.sleep(10);}throw new Error('Owned launcher did not publish PID identity');};
const barrier = join(import.meta.dir, 'lifecycle-command-barrier.ts');
const simultaneous = (label:string, commands:string[][]) => {
 const go=join(root,label+'-go');
 const children=commands.map((command,index)=>({ready:join(root,label+'-ready-'+index),child:spawn(['bun','--preload',barrier,...command],{env:{...env,TERMWEAVE_BARRIER_READY:join(root,label+'-ready-'+index),TERMWEAVE_BARRIER_GO:go},stdout:'ignore',stderr:'pipe'})}));
 return {children,async release(){const deadline=Date.now()+15000;while(!children.every(item=>existsSync(item.ready))){assert.ok(Date.now()<deadline,'CLI readiness barrier timeout');await Bun.sleep(2);}writeFileSync(go,'go',{flag:'wx'});}};
};
// Both real start commands compete for the stopped installation under one barrier.
const starts=simultaneous('double-start',[[join(destination,'scripts/owned-server.ts'),'start'],[join(destination,'scripts/owned-server.ts'),'start']]);
await starts.release();
const initialPid=await waitPid();ownedPids.add(initialPid);inject('started');
const initialDeadline=Date.now()+15000;
while(starts.children.every(item=>item.child.exitCode===null)){assert.ok(Date.now()<initialDeadline);await Bun.sleep(5);}
const loser=starts.children.find(item=>item.child.exitCode!==null)!;
assert.notEqual(await loser.child.exited,0);
assert.ok(!(await new Response(loser.child.stderr).text()).includes('UNEXPECTED_SIGNAL'));
const winner=starts.children.find(item=>item!==loser)!;
assert.equal(winner.child.exitCode,null);process.kill(initialPid,0);
winner.child.kill('SIGTERM');await winner.child.exited;
assert.throws(()=>process.kill(initialPid,0));
assert.equal(existsSync(join(destination,'lifecycle.json')),false);
assert.equal(existsSync(join(destination,'.lifecycle.lock')),false);
const launcher=spawn(['bun',join(destination,'scripts/owned-server.ts'),'start'],{env,stdout:'ignore',stderr:'ignore'});let pid=0;
try{pid=await waitPid();ownedPids.add(pid);process.kill(pid,0);let ready=false;for(let i=0;i<100;i++){try{ready=(await fetch(`http://127.0.0.1:${port}/api/health`)).status===200;if(ready)break;}catch{}await Bun.sleep(30);}assert.equal(ready,true);assert.equal((await fetch(`http://127.0.0.1:${port}/api/session`)).status,401);assert.equal((await fetch(`http://127.0.0.1:${port}/api/session`,{headers:{authorization:'Bearer synthetic-install'}})).status,200);assert.throws(()=>uninstallOwned(destination,true));
const contenders=simultaneous('active-start-uninstall',[[join(destination,'scripts/owned-server.ts'),'start'],[join(destination,'scripts/uninstall.ts'),'--confirm',destination]]);
await contenders.release();
for(const {child} of contenders.children){assert.notEqual(await child.exited,0);assert.ok(!(await new Response(child.stderr).text()).includes('UNEXPECTED_SIGNAL'));}
assert.ok(existsSync(join(destination,'.termweave-owned.json')));assert.equal(JSON.parse(readFileSync(join(destination,'lifecycle.json'),'utf8')).pid,pid);process.kill(pid,0);assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status,200);
const second=spawn(['bun',join(destination,'scripts/owned-server.ts'),'start'],{env,stdout:'ignore',stderr:'ignore'});assert.notEqual(await second.exited,0);const direct=spawn(['bun',join(destination,'server/index.ts')],{env,stdout:'ignore',stderr:'ignore'});assert.notEqual(await direct.exited,0);}
finally{launcher.kill('SIGTERM');await launcher.exited;}
assert.equal(existsSync(join(destination,'lifecycle.json')),false);assert.throws(()=>process.kill(pid,0));const crash=spawn(['bun',join(destination,'scripts/owned-server.ts'),'start'],{env,stdout:'ignore',stderr:'ignore'});for(let i=0;i<100&&!existsSync(join(destination,'lifecycle.json'));i++)await Bun.sleep(20);let crashPid:number|undefined;for(let i=0;i<100;i++){try{crashPid=JSON.parse(readFileSync(join(destination,'lifecycle.json'),'utf8')).pid;if(crashPid)break;}catch{}await Bun.sleep(20);}assert.ok(crashPid);ownedPids.add(crashPid);process.kill(crashPid,'SIGKILL');await crash.exited;assert.equal(existsSync(join(destination,'lifecycle.json')),false);
const lockFile=join(destination,'.lifecycle.lock');(await import('node:fs')).writeFileSync(lockFile,'synthetic-stale');assert.throws(()=>uninstallOwned(destination,true));const blocked=spawn(['bun',join(destination,'scripts/owned-server.ts'),'start'],{env,stdout:'ignore',stderr:'ignore'});assert.notEqual(await blocked.exited,0);rmSync(lockFile);
uninstallOwned(destination,true);assert.equal(existsSync(destination),false);rmSync(root,{recursive:true,force:true});console.log('PASS actual clean-HOME installer/start/live refusal/stop/PID removal/uninstall');

} finally {
 const failures:string[]=[];
 for(const child of [...children].reverse()) {
  try { if(child.exitCode===null)child.kill('SIGTERM'); await child.exited; } catch { failures.push('owned subprocess cleanup failed'); }
 }
 for(const pid of ownedPids){try{process.kill(pid,0);failures.push('owned server remains alive');}catch{}}
 // No deletion until all owned processes are confirmed stopped. Never signal a PID from stale files.
 if(!failures.length)rmSync(root,{recursive:true,force:true});
 if(process.env.DOCK_EVIDENCE)writeFileSync(join(process.env.DOCK_EVIDENCE,'actual-install-cleanup'+(process.env.TERMWEAVE_INSTALL_FAILURE?'-'+process.env.TERMWEAVE_INSTALL_FAILURE:'')+'.json'),JSON.stringify({injected:process.env.TERMWEAVE_INSTALL_FAILURE??null,owned_process_count:children.length,owned_pid_count:ownedPids.size,root_removed:!existsSync(root),failures},null,2));
 assert.deepEqual(failures,[],'Owned install cleanup failed');
}
