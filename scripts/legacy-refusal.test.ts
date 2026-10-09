import {it,expect} from 'bun:test';import {join} from 'node:path';
it('legacy phone/start/stop refuse before subprocess or signals',()=>{
 for(const command of ['phone','start','stop']){
  const code=`Bun.spawn=()=>{throw new Error('UNEXPECTED_SPAWN')}; Bun.spawnSync=()=>{throw new Error('UNEXPECTED_SPAWN')};process.kill=()=>{throw new Error('UNEXPECTED_SIGNAL')};process.argv=['bun',${JSON.stringify(join(import.meta.dir,'plugin.ts'))},${JSON.stringify(command)}];await import(${JSON.stringify(join(import.meta.dir,'plugin.ts'))});`;
  // Import is not main; execute the genuine command with a preload that traps spawns.
  const preload=join(import.meta.dir,'legacy-spawn-trap.ts');const env={...process.env};delete env.TERMWEAVE_TEST_ROOT;
  const child=Bun.spawnSync(['bun','--preload',preload,join(import.meta.dir,'plugin.ts'),command],{env,stdout:'pipe',stderr:'pipe'});expect(child.exitCode).not.toBe(0);expect(child.stderr.toString()).toContain('unsupported');expect(child.stderr.toString()).not.toContain('UNEXPECTED_');
 }
});
