import {execFileSync} from 'node:child_process';
import {readFileSync,lstatSync} from 'node:fs';
import {resolve} from 'node:path';
import {canonicalPath,isWithin} from './lifecycle-path.ts';
/** Only exact committed regular-file bytes are eligible. No ignored/untracked files. Paths compare by canonical identity, so drive case/8.3/junction spellings of the source are aliases while links inside it are refused. */
export function installationSources(source:string):string[]{
 const root=canonicalPath(source);
 if(canonicalPath(execFileSync('git',['rev-parse','--show-toplevel'],{cwd:root,encoding:'utf8'}).trim())!==root)throw new Error('Independent committed source repository required');
 const names=execFileSync('git',['ls-tree','-rz','--name-only','HEAD'],{cwd:root}).toString().split('\0').filter(Boolean);
 for(const name of names){const path=resolve(root,name);if(name.startsWith('/')||!isWithin(root,path)||canonicalPath(path)!==path||!lstatSync(path).isFile())throw new Error('Invalid source boundary');const committed=execFileSync('git',['show',`HEAD:${name}`],{cwd:root,maxBuffer:16*1024*1024});if(!readFileSync(path).equals(committed))throw new Error('Modified committed installation source');}
 if(!names.includes('package.json')||!names.includes('bun.lock'))throw new Error('Missing required installation source');return names;
}
