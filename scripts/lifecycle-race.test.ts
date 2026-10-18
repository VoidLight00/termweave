import { it, expect } from 'bun:test';
import { mkdtempSync, realpathSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('barrier-released start/uninstall transition admits one lock owner and preserves competing files', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tw-race-')));
  const ready = join(root, 'go');
  const lock = join(root, '.lifecycle.lock');
  const worker = `
    import { existsSync, writeFileSync } from 'node:fs';
    const { lifecycleLock } = await import(${JSON.stringify(join(import.meta.dir, 'lifecycle-lock.ts'))});
    while (!existsSync(${JSON.stringify(ready)})) await Bun.sleep(2);
    let release;
    try { release = lifecycleLock(${JSON.stringify(root)}); }
    catch {
      writeFileSync(${JSON.stringify(join(root, 'contended'))}, 'rejected');
      process.exit(3);
    }
    writeFileSync(${JSON.stringify(join(root, 'winner'))}, process.argv[1]);
    while (!existsSync(${JSON.stringify(join(root, 'release'))})) await Bun.sleep(2);
    release();
  `;
  const children = ['start', 'uninstall'].map(name =>
    Bun.spawn([process.execPath, '-e', worker, name], { stdout: 'ignore', stderr: 'ignore' }));
  try {
    writeFileSync(ready, 'go');
    // Do not release the winner until the other process actually attempts the held
    // lock. A sleep only lets two late-starting workers acquire it sequentially.
    for (let i = 0; i < 200 && !existsSync(join(root, 'contended')); i++) await Bun.sleep(2);
    expect(existsSync(join(root, 'winner'))).toBe(true);
    expect(existsSync(join(root, 'contended'))).toBe(true);
    expect(existsSync(lock)).toBe(true);
    writeFileSync(join(root, 'release'), 'release');
    const codes = await Promise.all(children.map(child => child.exited));
    expect([...codes].sort()).toEqual([0, 3]);
    expect(existsSync(lock)).toBe(false);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map(child => child.exited));
    rmSync(root, { recursive: true, force: true });
  }
});
