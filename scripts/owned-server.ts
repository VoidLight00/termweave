import {lifecycleLock} from './lifecycle-lock.ts';
import {existsSync,readFileSync,writeFileSync,rmSync,openSync,closeSync} from 'node:fs';import {join,resolve} from 'node:path';
const root=resolve(import.meta.dir,'..'),marker=join(root,'.termweave-owned.json'),state=join(root,'lifecycle.json');
if(!existsSync(marker))throw new Error('Owned installation required');
const metadata=JSON.parse(readFileSync(marker,'utf8'));if(metadata.product!=='termweave'||metadata.root!==root||!metadata.inventory)throw new Error('Invalid owned marker');
if(process.argv[2]==='start'){
 const release=lifecycleLock(root);
 if(existsSync(state)){release();throw new Error('Active or uncertain process state');}
 writeFileSync(state,JSON.stringify({status:'starting',root}),{flag:'wx',mode:0o600});
 const child=Bun.spawn(['bun',join(root,'server/index.ts')],{cwd:root,env:{...process.env,TERMWEAVE_OWNED_LAUNCH:'1'},stdout:'ignore',stderr:'ignore',stdin:'ignore'});
 writeFileSync(state,JSON.stringify({pid:child.pid,root,launcher:process.pid}),{mode:0o600});
 const cleanup=()=>{try{child.kill('SIGTERM');}catch{}};process.on('SIGTERM',cleanup);process.on('SIGINT',cleanup);
 const code=await child.exited;rmSync(state);release();process.exitCode=code;
}else throw new Error('Run foreground owned-server start; stop its owned launcher with SIGTERM and wait for exit');
