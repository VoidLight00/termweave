import {activateRelease} from './activate.ts';
export async function rollbackRelease(root:string,health:(directory:string)=>Promise<boolean>) {
 return activateRelease(root,'rollback',health,true);
}
if(import.meta.main)throw new Error('Rollback activation requires separate approval');
