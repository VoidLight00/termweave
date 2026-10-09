import {cpSync,existsSync,mkdirSync,readdirSync,readFileSync,writeFileSync,lstatSync,readlinkSync,realpathSync} from 'node:fs';import {resolve,join} from 'node:path';import {createHash} from 'node:crypto';
import {installationSources} from './install-source.ts';
export function installOwned(source:string,destination:string){
 const sources=installationSources(source);
 const root=resolve(destination);if(root===resolve(source)||root==='/'||root===process.env.HOME||existsSync(root))throw new Error('Install requires a new independent destination');
 if(realpathSync(resolve(root,'..'))!==resolve(root,'..'))throw new Error('Symlink ancestor refused');
 mkdirSync(root,{recursive:false});
 for(const name of sources){mkdirSync(resolve(root,name,'..'),{recursive:true});cpSync(join(source,name),join(root,name));}
 const child=Bun.spawnSync(['bun','install','--frozen-lockfile','--ignore-scripts'],{cwd:root,stdout:'pipe',stderr:'pipe'});if(child.exitCode!==0)throw new Error('Locked install failed');
 if(Bun.spawnSync(['bun','run','build'],{cwd:root,stdout:'pipe',stderr:'pipe'}).exitCode!==0)throw new Error('Build failed');
 const inventory:Record<string,string>={};const visit=(dir:string)=>{for(const name of readdirSync(dir)){const p=join(dir,name);const stat=lstatSync(p);if(stat.isSymbolicLink()){inventory[p.slice(root.length+1)]='symlink:'+readlinkSync(p);continue;}if(stat.isDirectory()){inventory[p.slice(root.length+1)]='directory';visit(p);}else inventory[p.slice(root.length+1)]=createHash('sha256').update(readFileSync(p)).digest('hex');}};visit(root);
 writeFileSync(join(root,'.termweave-owned.json'),JSON.stringify({product:'termweave',root,inventory}),{mode:0o600,flag:'wx'});
 return root;
}
if(import.meta.main)installOwned(resolve(import.meta.dir,'..'),process.argv[2]??'');
