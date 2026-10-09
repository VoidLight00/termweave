import { mkdtempSync, mkdirSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Never import a runtime client before validating and replacing inherited caller state. */
export function isolateTestEnvironment(): string {
  if (process.env.HERDR_TEST_LIVE === '1') throw new Error('Production/live tests are forbidden');
  if (process.env.TERMWEAVE_TEST_ROOT) {
    const root = realpathSync(process.env.TERMWEAVE_TEST_ROOT);
    for (const name of ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME']) {
      const path = process.env[name];
      if (!path || !realpathSync(path).startsWith(root + '/')) throw new Error(`${name} escapes the isolated test root`);
    }
    const session = process.env.HERDR_TEST_SESSION;
    if (!session || !/^[a-zA-Z0-9_-]{1,32}$/.test(session)) throw new Error('Invalid isolated session segment');
    const expected = join(process.env.XDG_CONFIG_HOME!, 'herdr', 'sessions', session, 'herdr.sock');
    let ancestor = dirname(expected);
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    if (!realpathSync(ancestor).startsWith(root + '/')) throw new Error('Socket parent escapes isolation');
    mkdirSync(dirname(expected), { recursive: true });
    if (!realpathSync(dirname(expected)).startsWith(root + '/')) throw new Error('Socket parent escapes isolation');
    if (process.env.HERDR_SOCKET && resolve(process.env.HERDR_SOCKET) !== resolve(expected)) throw new Error('Unexpected or production HERDR_SOCKET refused');
    if (Buffer.byteLength(expected) >= 104) throw new Error('Isolated Unix socket path is too long');
    return root;
  }
  if (process.env.HERDR_SOCKET) throw new Error('Inherited HERDR_SOCKET refused. Use the isolated verifier');
  const root = realpathSync(mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'tw-')));
  for (const key of Object.keys(process.env)) if (key.startsWith('HERDR_')) delete process.env[key];
  process.env.TERMWEAVE_TEST_ROOT = root;
  process.env.HERDR_TEST_SESSION = 'qa';
  for (const [name, dir] of [['HOME', 'h'], ['XDG_CONFIG_HOME', 'c'], ['XDG_STATE_HOME', 's'], ['XDG_DATA_HOME', 'd'], ['XDG_CACHE_HOME', 'k']]) {
    const path = join(root, dir!); mkdirSync(path, { recursive: true }); process.env[name!] = path;
  }
  return root;
}

export function assertIsolatedSocket(socket: string): void {
  const root = process.env.TERMWEAVE_TEST_ROOT;
  if (!root || !realpathSync(dirname(socket)).startsWith(realpathSync(root) + '/')) throw new Error('Runtime socket is not owned by this test');
}
