/** Explicit non-destructive browser layout/preferences migration only.
 * Authentication/device/session material is never copied.
 */
export function migrateUpstreamPreferences(storage: Storage, consent: boolean): number {
 if(!consent)throw new Error('Migration requires explicit consent');
 const allowed=/^herdr-web-ui:(?:dock:|view:|settings$)/;
 let copied=0;
 for(let i=0;i<storage.length;i++){
  const key=storage.key(i);if(!key||!allowed.test(key))continue;
  const destination=key.replace(/^herdr-web-ui:/,'termweave:');
  if(storage.getItem(destination)!==null)continue;
  const value=storage.getItem(key);if(value!==null){storage.setItem(destination,value);copied++;}
 }
 return copied;
}
