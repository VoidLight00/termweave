import {execFileSync} from 'node:child_process';
import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';
/** Only exact committed regular-file bytes are eligible. No ignored/untracked files. */
export function installationSources(source:string):string[]{
 const root=realpathSync(source);
 if(realpathSync(execFileSync('git',['rev-parse','--show-toplevel'],{cwd:root,encoding:'utf8'}).trim())!==root)throw new Error('Independent committed source repository required');
 const names=execFileSync('git',['ls-tree','-rz','--name-only','HEAD'],{cwd:root}).toString().split('\0').filter(Boolean);
 for(const name of names){const path=resolve(root,name);if(relative(root,path).startsWith('..')||name.startsWith('/')||realpathSync(path)!==path||!lstatSync(path).isFile())throw new Error('Invalid source boundary');const committed=execFileSync('git',['show',`HEAD:${name}`],{cwd:root,maxBuffer:16*1024*1024});if(!readFileSync(path).equals(committed))throw new Error('Modified committed installation source');}
 if(!names.includes('package.json')||!names.includes('bun.lock'))throw new Error('Missing required installation source');return names;
}
