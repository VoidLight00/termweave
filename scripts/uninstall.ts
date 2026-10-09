import {lifecycleLock} from './lifecycle-lock.ts';
import {existsSync,lstatSync,readFileSync,readdirSync,rmSync,readlinkSync,openSync,closeSync,realpathSync,rmdirSync} from 'node:fs';import {resolve,join,relative} from 'node:path';import {createHash} from 'node:crypto';
/** Fail closed on unowned data or active/uncertain lifecycle state. */
export function uninstallOwned(directory:string,confirm:boolean){
 const root=resolve(directory);if(!confirm||root==='/'||root===process.env.HOME||existsSync(join(root,'.git')))throw new Error('Unsafe or unconfirmed uninstall');
 if(realpathSync(root)!==root)throw new Error('Symlink root or ancestor refused');
 if(lstatSync(root).isSymbolicLink())throw new Error('Symlink installation refused');
 const marker=join(root,'.termweave-owned.json');if(!existsSync(marker))throw new Error('Unowned directory refused');
 const metadata=JSON.parse(readFileSync(marker,'utf8'));if(metadata.product!=='termweave'||metadata.root!==root||!metadata.inventory)throw new Error('Unowned inventory refused');
 if(existsSync(join(root,'server.pid'))||existsSync(join(root,'lifecycle.json')))throw new Error('Active or uncertain process state refused');
 const lock=join(root,'.lifecycle.lock');const release=lifecycleLock(root);
 try{
 const paths:string[]=[];const visit=(directory:string)=>{for(const name of readdirSync(directory)){const path=join(directory,name);if(path===marker||path===lock)continue;const stat=lstatSync(path);if(stat.isSymbolicLink()){if(metadata.inventory[relative(root,path)]!=='symlink:'+readlinkSync(path))throw new Error('Unexpected symlink refused');continue;}if(stat.isDirectory()){if(metadata.inventory[relative(root,path)]!=='directory')throw new Error('Unowned directory refused');visit(path);}else paths.push(path);}};visit(root);
 for(const path of paths){const name=relative(root,path);if(!metadata.inventory[name]||createHash('sha256').update(readFileSync(path)).digest('hex')!==metadata.inventory[name])throw new Error('Unowned or modified file refused');}
 for(const path of paths)rmSync(path);
 const removeDirs=(dir:string)=>{for(const name of readdirSync(dir)){const path=join(dir,name);if(path===marker||path===lock)continue;const stat=lstatSync(path);if(stat.isSymbolicLink())rmSync(path);else if(stat.isDirectory()){removeDirs(path);rmdirSync(path);}}};removeDirs(root);rmSync(marker);rmSync(lock);rmdirSync(root);
 }finally{release();}
}
if(import.meta.main){if(process.argv[2]!=='--confirm'||!process.argv[3])throw new Error('Usage: uninstall --confirm <owned-directory>');uninstallOwned(process.argv[3],true);}
