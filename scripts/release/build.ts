import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { files,hash,validateArtifact,type ReleaseManifest,type Deployment } from './manifest.ts';
export function requireCleanSource(root:string) {
  const git=(...args:string[])=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
  if (realpathSync(git('rev-parse','--show-toplevel'))!==realpathSync(root)) throw new Error('Source must own its repository');
  if (git('status','--porcelain')) throw new Error('Release requires clean committed source');
  return {commit:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}')};
}
export function backendCompatibilityHash(source:string):string {
  return hash(JSON.stringify({server:files(join(source,'server')),shared:files(join(source,'shared')),releaseRuntime:files(join(source,'scripts','release')),package:hash(readFileSync(join(source,'package.json'))),lock:hash(readFileSync(join(source,'bun.lock')))}));
}
export const REQUIRED_RELEASE_LANES = ['ledger','type','build','unit','integration','release-native','release-browser','render','dock','title-drag','workspace','move','preview','spatial','ui','source-style'] as const;
export function validateTestEvidence(tests:any,identity:{commit:string;tree:string}) {
 if(tests.status!=='PASS'||tests.source_commit!==identity.commit||tests.source_tree!==identity.tree||!Array.isArray(tests.lanes))throw new Error('Incorrect source test binding');
 const names=tests.lanes.map((lane:any)=>lane.name);
 if(names.length!==REQUIRED_RELEASE_LANES.length||new Set(names).size!==names.length||REQUIRED_RELEASE_LANES.some(name=>!names.includes(name))||tests.lanes.some((lane:any)=>lane.exit_code!==0))throw new Error('Missing duplicate unknown or failed required lane');
}
export async function buildRelease(options:{source:string;output:string;id:string;deployment:Deployment;tests:string;nativeVersion:string;nativeChecksum:string;backendSchema:string;storageSchema:string;protocol:string}) {
  const source=resolve(options.source),output=resolve(options.output);const identity=requireCleanSource(source);
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(options.id))throw new Error('Invalid release id');
  const target=join(output,options.id);if(existsSync(target))throw new Error('Immutable release already exists');
  const tests=JSON.parse(readFileSync(options.tests,'utf8'));validateTestEvidence(tests,identity);
  mkdirSync(output,{recursive:true});const temporary=join(output,`.candidate-${options.id}-${process.pid}`);mkdirSync(temporary);
  try {
    execFileSync('bun',['run','build','--outDir',join(temporary,'dist')],{cwd:source,stdio:'pipe'});
    if(JSON.stringify(requireCleanSource(source))!==JSON.stringify(identity))throw new Error('Source changed during build');
    const assets=files(join(temporary,'dist'));
    const backend=backendCompatibilityHash(source);
    const manifest:ReleaseManifest={schema:1,id:options.id,deployment:options.deployment,source:{...identity,lock:hash(readFileSync(join(source,'bun.lock'))),upstreamLock:hash(readFileSync(join(source,'upstreams.lock.json')))},tools:{bun:execFileSync('bun',['--version'],{encoding:'utf8'}).trim(),node:process.version},native:{version:options.nativeVersion,checksum:options.nativeChecksum},compatibility:{backend:options.backendSchema,storage:options.storageSchema,protocol:options.protocol},tests:{status:'PASS',hash:hash(readFileSync(options.tests))},assets,frontend:hash(JSON.stringify(Object.entries(assets).sort())),backend};
    writeFileSync(join(temporary,'manifest.json'),JSON.stringify(manifest,null,2));validateArtifact(temporary);renameSync(temporary,target);return target;
  } catch(error){rmSync(temporary,{recursive:true,force:true});throw error;}
}
if(import.meta.main)throw new Error('Use reviewed buildRelease configuration with matching committed-source test evidence');
