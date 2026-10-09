import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync, openSync, readSync, closeSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
export type Deployment = 'frontend' | 'backend' | 'native' | 'schema';
export interface ReleaseManifest {
  schema: 1; id: string; deployment: Deployment;
  source: { commit: string; tree: string; lock: string; upstreamLock: string };
  tools: { bun: string; node: string }; native: { version: string; checksum: string };
  compatibility: { backend: string; storage: string; protocol: string };
  tests: { status: 'PASS'; hash: string };
  assets: Record<string, string>; frontend: string; backend: string;
}
export function boundedRead(path:string,limit=1_048_576):Buffer {
 const fd=openSync(path,'r');
 try {const buffer=Buffer.alloc(limit+1);let offset=0;while(offset<buffer.length){const bytes=readSync(fd,buffer,offset,buffer.length-offset,null);if(!bytes)break;offset+=bytes;}if(offset>limit)throw new Error('Release data exceeds byte bound');return buffer.subarray(0,offset);}finally{closeSync(fd);}
}
export const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export function contained(root: string, path: string): string {
  const base = realpathSync(root), candidate = realpathSync(path);
  if (candidate !== base && !candidate.startsWith(base + sep)) throw new Error('Release path escapes root');
  return candidate;
}
export function files(root: string): Record<string,string> {
  const result: Record<string,string> = {};
  let count=0,total=0;
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory,entry), stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error('Release symlinks are forbidden');
      contained(root,path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) { if(++count>4096 || (total+=stat.size)>268_435_456)throw new Error('Artifact count/size exceeds limit');result[relative(root,path).split(sep).join('/')] = hash(boundedRead(path,16_777_216)); }
      else throw new Error('Release contains unsupported file type');
    }
  }; visit(root);return result;
}
export function validateManifest(value: unknown): ReleaseManifest {
  const manifest=value as ReleaseManifest;
  if (!manifest || manifest.schema!==1 || !/^[a-zA-Z0-9_-]{1,80}$/.test(manifest.id) || !['frontend','backend','native','schema'].includes(manifest.deployment)) throw new Error('Invalid release manifest identity');
  if (!/^[a-f0-9]{40}$/.test(manifest.source?.commit) || !/^[a-f0-9]{40}$/.test(manifest.source?.tree)) throw new Error('Release source must be committed');
  for (const value of [manifest.source.lock,manifest.source.upstreamLock,manifest.native?.checksum,manifest.tests?.hash,manifest.frontend,manifest.backend]) if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Missing required provenance hash');
  if (manifest.tests.status!=='PASS' || !manifest.native.version || !manifest.tools?.bun || !manifest.tools.node || !manifest.compatibility?.backend || !manifest.compatibility.storage || !manifest.compatibility.protocol) throw new Error('Unverified release requirements');
  if (!manifest.assets || !Object.keys(manifest.assets).length || !manifest.assets['index.html']) throw new Error('Missing client assets');
  for (const [path,digest] of Object.entries(manifest.assets)) if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(segment=>['.','..',''].includes(segment)) || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid asset path/hash');
  return manifest;
}
export function validateArtifact(directory: string): ReleaseManifest {
  if(lstatSync(directory).isSymbolicLink() || lstatSync(join(directory,'manifest.json')).isSymbolicLink() || lstatSync(join(directory,'dist')).isSymbolicLink())throw new Error('Release symlinks are forbidden');
  const manifest=validateManifest(JSON.parse(boundedRead(join(directory,'manifest.json')).toString('utf8')));
  const actual=files(join(directory,'dist'));
  if (JSON.stringify(Object.entries(actual).sort())!==JSON.stringify(Object.entries(manifest.assets).sort())) throw new Error('Release asset hashes mismatch');
  if (hash(JSON.stringify(Object.entries(actual).sort()))!==manifest.frontend) throw new Error('Release frontend hash mismatch');
  return manifest;
}
