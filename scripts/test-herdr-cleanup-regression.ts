import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const repo = resolve(import.meta.dir, '..');
const herdr = Bun.which('herdr');
assert.ok(herdr, 'real herdr binary required');
const roots: string[] = [];
const ownedEnvs = new Map<string, Record<string,string>>();
function environment() {
  const root = realpathSync(mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'tw-')));
  roots.push(root);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HERDR_') && key !== 'TERMWEAVE_TEST_ROOT')) as Record<string,string>;
  env.TERMWEAVE_TEST_ROOT = root; env.HERDR_TEST_SESSION = 'qa'; env.HERDR_WEB_HERDR_BIN = herdr!;
  for (const [key, dir] of [['HOME','h'],['XDG_CONFIG_HOME','c'],['XDG_STATE_HOME','s'],['XDG_DATA_HOME','d'],['XDG_CACHE_HOME','k']]) {
    env[key!] = join(root, dir!); mkdirSync(env[key!]!);
  }
  ownedEnvs.set(root, env);
  return { root, env, socket: join(env.XDG_CONFIG_HOME!, 'herdr/sessions/qa/herdr.sock') };
}
const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
async function until(check: () => boolean, message: string) {
  const deadline = Date.now()+15_000;
  while (!check()) { assert.ok(Date.now()<deadline, message); await Bun.sleep(30); }
}
async function direct(mode: 'normal'|'exit'|'signal') {
  const setup = environment();
  const fixture = join(setup.root, 'owned.test.ts');
  writeFileSync(fixture, `import {test,expect} from 'bun:test';\nimport {existsSync,writeFileSync} from 'node:fs';\ntest('owned fixture',async()=>{expect(existsSync(process.env.HERDR_SOCKET!)).toBe(true);writeFileSync(${JSON.stringify(join(setup.root,'ready'))},'ready');process.env.XDG_CONFIG_HOME=${JSON.stringify(join(setup.root,'wrong'))};delete process.env.HERDR_SOCKET;${mode === 'exit' ? 'process.exit(7);' : mode === 'signal' ? 'await Bun.sleep(60000);' : ''}});`);
  const second = join(setup.root, 'second.test.ts');
  writeFileSync(second, `import {test,expect} from 'bun:test';import {existsSync} from 'node:fs';test('second file retains shared server',()=>expect(existsSync(${JSON.stringify(setup.socket)})).toBe(true));`);
  const child = Bun.spawn(['bun','test',fixture,...(mode==='normal'?[second]:[])], {cwd:repo,env:setup.env,stdout:'ignore',stderr:'ignore'});
  await until(()=>existsSync(join(setup.root,'ready')), 'standalone test did not start');
  const pid = Number(readFileSync(join(setup.root,'c/herdr/sessions/qa/test-owned.pid'),'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid>0);
  if (mode==='signal') child.kill('SIGTERM');
  const code=await child.exited;
  console.log(`standalone-${mode} test_exit=${code}`);
  assert.equal(code, mode==='normal'?0:mode==='exit'?7:143);
  await until(()=>gone(pid) && !existsSync(setup.socket), 'owned server or socket survived child exit');
  console.log(`PASS standalone-${mode}: owned PID gone, private socket removed`);
}
async function reused() {
  const setup=environment();
  const server=Bun.spawn([herdr!,'--session','qa','server'],{env:setup.env,stdout:'ignore',stderr:'ignore'});
  try {
    await until(()=>existsSync(setup.socket), 'parent server did not start');
    const fixture=join(setup.root,'reuse.test.ts');
    writeFileSync(fixture, `import {test,expect} from 'bun:test';test('reuse',()=>expect(process.env.HERDR_SOCKET).toBe(${JSON.stringify(setup.socket)}));`);
    const child=Bun.spawn(['bun','test',fixture],{cwd:repo,env:setup.env,stdout:'ignore',stderr:'ignore'});
    assert.equal(await child.exited,0);
    assert.equal(gone(server.pid),false);assert.ok(existsSync(setup.socket));
    assert.equal(existsSync(join(setup.root,'c/herdr/sessions/qa/test-owned.pid')),false);
    console.log('PASS reused-parent: original PID and private socket survive');
  } finally {
    const stop=Bun.spawn([herdr!,'--session','qa','server','stop'],{env:setup.env,stdout:'ignore',stderr:'ignore'});
    await stop.exited;
    if(server.exitCode===null)server.kill('SIGTERM');
    await server.exited;
  }
}
try { await direct('normal');await direct('exit');await direct('signal');await reused(); }
finally {
  for (const root of roots) {
    const socket = join(root, 'c/herdr/sessions/qa/herdr.sock');
    if (existsSync(socket)) {
      const stop = Bun.spawn([herdr!, '--session', 'qa', 'server', 'stop'], {
        env: ownedEnvs.get(root)!, stdout: 'ignore', stderr: 'ignore',
      });
      await stop.exited;
      await until(() => !existsSync(socket), 'owned regression cleanup failed');
    }
    rmSync(root, { recursive: true, force: true });
  }
}
