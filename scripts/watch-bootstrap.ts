import { writeFileSync,existsSync,mkdirSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { emptyDurableState,parseDurableState } from './watch-store.ts';
/** Generates reviewed bootstrap content locally only. Never creates a branch remotely. */
export function bootstrapState(path:string) {
 const destination=resolve(path);if(existsSync(destination))throw new Error('Bootstrap refuses overwrite');
 mkdirSync(dirname(destination),{recursive:true});const state=parseDurableState(emptyDurableState());
 writeFileSync(destination,JSON.stringify(state,null,2)+'\n',{mode:0o600});return state;
}
if(import.meta.main){if(!process.argv[2])throw new Error('Provide a local bootstrap output path');bootstrapState(process.argv[2]);}
