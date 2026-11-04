import {lstatSync,realpathSync} from 'node:fs';import {basename,dirname,join,parse,resolve,sep} from 'node:path';
/**
 * Path judgments shared by the owned-install lifecycle. Identity is the OS-resolved canonical path (`realpathSync.native`):
 * drive-letter case, 8.3 short names, subst drives and junction spellings all collapse to one target string, compared byte-exact
 * (never case-folded). A link component on the way to a new destination is an escape out of the lexical tree and is refused separately.
 */
export type Refusal='network path'|'filesystem root'|'home directory'|'source repository'|'existing path'|'missing parent'|'symlink ancestor';
export type PathContext={platform?:NodeJS.Platform;env?:Record<string,string|undefined>};
/** `\\server\share`, `//server/share`, `\\?\…` and `\\.\…` are outside the supported local-disk boundary on every OS. */
export const isNetworkPath=(path:string)=>/^[\\/]{2}/.test(path);
/** Windows identifies the profile by USERPROFILE (HOME is a shell convention there); POSIX by HOME. */
export const homeDirectory=({platform=process.platform,env=process.env}:PathContext={})=>(platform==='win32'?env.USERPROFILE:env.HOME)||undefined;
export const isFilesystemRoot=(path:string)=>{const target=resolve(path);return target===parse(target).root;};
/** Canonical identity of an existing path; throws when it does not exist. */
export const canonicalPath=(path:string)=>realpathSync.native(resolve(path));
/** Canonical identity of a possibly missing path: canonical nearest existing ancestor plus the remaining lexical segments. */
export function canonicalIdentity(path:string):string{
 const missing:string[]=[];let current=resolve(path);
 for(;;){try{return join(canonicalPath(current),...missing.reverse());}catch{const parent=dirname(current);if(parent===current)return join(current,...missing.reverse());missing.push(basename(current));current=parent;}}
}
/** Both arguments must already be canonical. Exact containment by separator boundary, no case folding. */
export const isWithin=(parent:string,child:string)=>child===parent||child.startsWith(parent.endsWith(sep)?parent:parent+sep);
/** lstat reading a missing entry as absent: ENOENT, and ENOTDIR (POSIX: a regular file on the way; Windows says ENOENT). Any other error propagates. */
const lstatEntry=(path:string)=>{try{return lstatSync(path,{throwIfNoEntry:false});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOTDIR')return undefined;throw error;}};
/** First existing component (walking down from the filesystem root) that is a symlink or junction. Spelling aliases (case, 8.3) are not links and pass. */
export function linkComponent(path:string):string|undefined{
 const target=resolve(path);let current=parse(target).root;
 for(const part of target.slice(current.length).split(sep).filter(Boolean)){current=join(current,part);const stat=lstatEntry(current);if(!stat)return undefined;if(stat.isSymbolicLink())return current;}
 return undefined;
}
/** A new owned root must be a missing, link-free, local child of an existing directory that is not the filesystem root, the profile home or inside the source. */
export function judgeDestination(destination:string,source:string,context:PathContext={}):{root:string}|{refused:Refusal}{
 if(isNetworkPath(destination))return {refused:'network path'};
 const target=resolve(destination);if(isNetworkPath(target))return {refused:'network path'};
 if(isFilesystemRoot(target))return {refused:'filesystem root'};
 const exists=!!lstatEntry(target);const root=canonicalIdentity(target);
 if(isNetworkPath(root))return {refused:'network path'};
 if(isFilesystemRoot(root))return {refused:'filesystem root'};
 const home=homeDirectory(context);if(home&&root===canonicalIdentity(home))return {refused:'home directory'};
 if(isWithin(canonicalIdentity(source),root))return {refused:'source repository'};
 if(exists)return {refused:'existing path'};
 if(linkComponent(target))return {refused:'symlink ancestor'};
 if(!lstatEntry(dirname(target))?.isDirectory())return {refused:'missing parent'};
 return {root};
}
