import {openSync,closeSync,rmSync} from 'node:fs';import {join} from 'node:path';
/** Stale or competing locks fail closed. Never inspect or signal an unowned PID. */
export function lifecycleLock(root:string){const path=join(root,'.lifecycle.lock');const fd=openSync(path,'wx',0o600);return ()=>{closeSync(fd);rmSync(path,{force:true});};}
