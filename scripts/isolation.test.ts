import { afterEach, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { canonicalPath } from './lifecycle-path.ts';
import { assertIsolatedSocket, isolatedEndpoint, isolatedLocations, isolateTestEnvironment, validateIsolatedEnvironment } from './test-isolation.ts';
import { socketAddress } from '../server/herdr/client.ts';

const win = process.platform === 'win32';
const PIPE = '\\\\.\\pipe\\';
// the helper rewrites process.env (a fresh isolation drops every HERDR_* name): each test gets the whole environment back
const saved = { ...process.env };
const made: string[] = [];
afterEach(() => {
  for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
  Object.assign(process.env, saved);
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});
const temp = (prefix: string) => { const path = canonicalPath(mkdtempSync(join(win ? tmpdir() : '/tmp', prefix))); made.push(path); return path; };
/** A valid isolated root with every location set the way the verifier sets them, `process.env` pointing at it. */
function isolatedRoot(parent?: string): string {
  const root = parent ? canonicalPath(parent) : temp('twi-');
  delete process.env.HERDR_SOCKET; delete process.env.HERDR_TEST_LIVE;
  process.env.TERMWEAVE_TEST_ROOT = root; process.env.HERDR_TEST_SESSION = 'qa';
  Object.assign(process.env, isolatedLocations(root));
  return root;
}

it('refuses live-mode and inherited runtime socket without contacting either', () => {
  process.env.HERDR_TEST_LIVE = '1'; expect(() => isolateTestEnvironment()).toThrow('forbidden');
  delete process.env.HERDR_TEST_LIVE; delete process.env.TERMWEAVE_TEST_ROOT;
  process.env.HERDR_SOCKET = '/not-owned/herdr.sock'; expect(() => isolateTestEnvironment()).toThrow('refused');
});

it('a fresh isolation moves HOME, XDG and the Windows profile into its own root and keeps required OS variables', () => {
  delete process.env.TERMWEAVE_TEST_ROOT; delete process.env.HERDR_SOCKET;
  const systemRoot = process.env.SystemRoot, path = process.env.PATH;
  const root = isolateTestEnvironment(); made.push(root);
  for (const name of ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    expect(process.env[name]!.startsWith(root + sep)).toBe(true);
    expect(existsSync(process.env[name]!)).toBe(true);
  }
  expect(process.env.SystemRoot).toBe(systemRoot); expect(process.env.PATH).toBe(path);
  expect(existsSync(join(root, 'c', 'herdr', 'sessions', 'qa'))).toBe(true);
});

it('accepts a root spelled with native separators, the way Windows hands it out', () => {
  const root = isolatedRoot();
  const owned = validateIsolatedEnvironment();
  expect(owned.root).toBe(root);
  expect(owned.marker).toBe(join(root, 'c', 'herdr', 'sessions', 'qa', 'herdr.sock'));
  if (win) {
    expect(root).toMatch(/^[A-Za-z]:\\/); expect(owned.marker).not.toContain('/');
    expect(owned.endpoint).toBe(PIPE + owned.marker);
    // the same locations spelled with forward slashes are the same canonical directories
    for (const name of ['HOME', 'XDG_CONFIG_HOME', 'APPDATA']) process.env[name] = process.env[name]!.replaceAll('\\', '/');
    expect(validateIsolatedEnvironment().root).toBe(root);
  } else expect(owned.endpoint).toBe(owned.marker);
  expect(isolateTestEnvironment()).toBe(root);
});

it('refuses traversal: session segments, `..` spellings and the root itself', () => {
  const root = isolatedRoot(), outside = temp('two-');
  process.env.HERDR_TEST_SESSION = '../escape'; expect(() => isolateTestEnvironment()).toThrow('session');
  process.env.HERDR_TEST_SESSION = 'qa';
  process.env.HOME = join(root, 'h', '..', '..', outside.slice(outside.lastIndexOf(sep) + 1)); expect(() => isolateTestEnvironment()).toThrow('HOME escapes');
  // `..` that would stay inside lexically is refused as well: a link on the way could lead out
  process.env.HOME = `${root}${sep}h${sep}..${sep}h`; expect(() => isolateTestEnvironment()).toThrow('HOME escapes');
  // an empty relative path is never an isolated location
  process.env.HOME = root; expect(() => isolateTestEnvironment()).toThrow('HOME escapes');
  process.env.HOME = join(root, 'h'); expect(isolateTestEnvironment()).toBe(root);
});

it('refuses a junction or symlink out of the root, for a location and for the socket parent', () => {
  const root = isolatedRoot(), outside = temp('two-');
  symlinkSync(outside, join(root, 'j'), 'junction');
  process.env.XDG_DATA_HOME = join(root, 'j'); expect(() => isolateTestEnvironment()).toThrow('XDG_DATA_HOME escapes');
  process.env.XDG_DATA_HOME = join(root, 'j', 'missing', 'below'); expect(() => isolateTestEnvironment()).toThrow('XDG_DATA_HOME escapes');
  process.env.XDG_DATA_HOME = join(root, 'd');
  rmSync(join(root, 'c', 'herdr'), { recursive: true, force: true });
  mkdirSync(join(root, 'c', 'herdr')); symlinkSync(outside, join(root, 'c', 'herdr', 'sessions'), 'junction');
  expect(() => isolateTestEnvironment()).toThrow('Socket parent escapes');
  expect(() => assertIsolatedSocket(join(root, 'c', 'herdr', 'sessions', 'qa', 'herdr.sock'))).toThrow('not owned');
  expect(readdirSync(outside)).toEqual([]);
});

it('refuses USERPROFILE, APPDATA and LOCALAPPDATA outside the root', () => {
  const root = isolatedRoot(), outside = temp('two-');
  for (const name of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    process.env[name] = outside; expect(() => isolateTestEnvironment()).toThrow(`${name} escapes`);
    // Windows tools read these unconditionally: an unset profile is no isolation there
    delete process.env[name];
    if (win) expect(() => isolateTestEnvironment()).toThrow(`${name} escapes`); else expect(isolateTestEnvironment()).toBe(root);
    Object.assign(process.env, isolatedLocations(root));
  }
  if (win) {
    // another drive is outside by construction, whether or not that drive exists
    const other = root[0]!.toUpperCase() === 'Z' ? 'Y' : 'Z';
    process.env.APPDATA = `${other}:\\tw\\AppData\\Roaming`; expect(() => isolateTestEnvironment()).toThrow('APPDATA escapes');
  }
});

it('allows only the session endpoint derived from the root, never a prefix match or the personal herdr', () => {
  const root = isolatedRoot();
  const { marker, endpoint } = validateIsolatedEnvironment();
  // the helper derives the pipe exactly as the herdr client does
  expect(endpoint).toBe(socketAddress(marker));
  for (const accepted of [marker, endpoint]) {
    process.env.HERDR_SOCKET = accepted; expect(isolateTestEnvironment()).toBe(root);
    delete process.env.HERDR_SOCKET; expect(() => assertIsolatedSocket(accepted)).not.toThrow();
  }
  // the user's own herdr, from the account database rather than an environment the preload already isolated
  const personal = join(userInfo().homedir, ...(win ? ['AppData', 'Roaming'] : ['.config']), 'herdr', 'herdr.sock');
  const foreign = [personal, PIPE + personal, PIPE + root, `${PIPE}${root}${sep}other.sock`, `${endpoint}-x`, PIPE + marker.toUpperCase(),
    `\\\\?\\pipe\\${marker}`, `${PIPE}tw-${root.slice(root.lastIndexOf(sep) + 1)}`, join(root, 'c', 'herdr', 'sessions', 'other', 'herdr.sock'), join(root, 'herdr.sock')];
  for (const socket of foreign) {
    if (socket === endpoint || socket === marker) continue;
    process.env.HERDR_SOCKET = socket; expect(() => isolateTestEnvironment()).toThrow('refused');
    delete process.env.HERDR_SOCKET; expect(() => assertIsolatedSocket(socket)).toThrow('not owned');
  }
  // without an isolated root nothing is owned
  delete process.env.TERMWEAVE_TEST_ROOT; expect(() => assertIsolatedSocket(marker)).toThrow('not owned');
});

it('checks a Unix socket path against the 104-byte limit and a Windows pipe against its own 256-character limit', () => {
  const long = join(win ? 'C:\\' : '/', 'x'.repeat(120), 'herdr.sock');
  expect(isolatedEndpoint(long, 'win32')).toBe(PIPE + long);
  expect(() => isolatedEndpoint(long, 'linux')).toThrow('Unix socket path is too long');
  expect(() => isolatedEndpoint(join(win ? 'C:\\' : '/', 'x'.repeat(250), 'herdr.sock'), 'win32')).toThrow('named pipe name is too long');
  // a real deep root: past 104 bytes, still a valid pipe on Windows and refused as a Unix socket elsewhere
  const deep = join(temp('twl-'), 'p'.repeat(40), 'q'.repeat(40)); mkdirSync(deep, { recursive: true });
  const root = isolatedRoot(deep);
  expect(Buffer.byteLength(join(root, 'c', 'herdr', 'sessions', 'qa', 'herdr.sock'))).toBeGreaterThanOrEqual(104);
  if (win) expect(validateIsolatedEnvironment().endpoint).toBe(PIPE + join(root, 'c', 'herdr', 'sessions', 'qa', 'herdr.sock'));
  else expect(() => validateIsolatedEnvironment()).toThrow('Unix socket path is too long');
});

it('classifies tests by suite on POSIX spelling, whatever separator the platform globs with', async () => {
  const listing = async (suite: string) => {
    const child = Bun.spawn([process.execPath, 'scripts/ci-tests.ts', suite, '--list'], { cwd: resolve(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code).toBe(0);
    return out.trim().split('\n');
  };
  const unit = await listing('unit'), integration = await listing('integration');
  for (const file of [...unit, ...integration]) expect(file).not.toContain('\\');
  for (const file of ['scripts/herdr-utf8.test.ts', 'src/lib/mirrorInputPolicy.test.ts', 'src/lib/mirrorCompositionBuffer.test.ts', 'scripts/isolation.test.ts']) expect(unit).toContain(file);
  for (const file of ['server/herdr/client.test.ts', 'server/pty/session.test.ts', 'server/updater.test.ts', 'scripts/herdr-pipe.contract.test.ts']) {
    expect(integration).toContain(file); expect(unit).not.toContain(file);
  }
  expect(unit.filter(file => integration.includes(file))).toEqual([]);
});
