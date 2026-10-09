import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';

// Test preload only: synchronize genuine CLI entrypoints without changing product code.
const owned = realpathSync(process.env.TERMWEAVE_TEST_ROOT ?? '');
function contained(value: string | undefined): string {
  if (!value) throw new Error('Missing owned barrier path');
  const path = resolve(value);
  const rel = relative(owned, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Unowned barrier path');
  return path;
}
const ready = contained(process.env.TERMWEAVE_BARRIER_READY);
const go = contained(process.env.TERMWEAVE_BARRIER_GO);
process.kill = (() => { throw new Error('UNEXPECTED_SIGNAL'); }) as typeof process.kill;
writeFileSync(ready, 'ready', { flag: 'wx' });
const deadline = Date.now() + 15_000;
while (!existsSync(go)) {
  if (Date.now() > deadline) throw new Error('Owned command barrier timed out');
  await Bun.sleep(2);
}
