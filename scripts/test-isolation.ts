import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalIdentity, canonicalPath, isNetworkPath } from './lifecycle-path.ts';

type Env = Record<string, string | undefined>;
/** Where a runtime finds its home, config, data and cache: HOME/XDG on Unix; on Windows os.homedir() reads USERPROFILE and herdr %APPDATA%\herdr. */
const LOCATIONS = [['HOME', 'h'], ['XDG_CONFIG_HOME', 'c'], ['XDG_STATE_HOME', 's'], ['XDG_DATA_HOME', 'd'], ['XDG_CACHE_HOME', 'k'],
  ['USERPROFILE', 'h'], ['APPDATA', join('h', 'AppData', 'Roaming')], ['LOCALAPPDATA', join('h', 'AppData', 'Local')]] as const;
/** Windows-only profile variables: required inside the root on Windows, checked only when set elsewhere. */
const WINDOWS_PROFILE: ReadonlySet<string> = new Set(['USERPROFILE', 'APPDATA', 'LOCALAPPDATA']);
const PIPE = '\\\\.\\pipe\\';

/** Creates the isolated home/XDG/Windows profile directories under `root`; returns the variables naming them. */
export function isolatedLocations(root: string): Record<string, string> {
  return Object.fromEntries(LOCATIONS.map(([name, directory]) => { const path = join(root, directory); mkdirSync(path, { recursive: true }); return [name, path]; }));
}

/**
 * `path` must lie strictly under the canonical `root`: the canonical identity (symlinks/junctions, 8.3 and drive spelling resolved;
 * nearest existing ancestor plus the missing tail) relative to it may not be empty (the root itself is no isolated location),
 * `..`-led or absolute (another drive). A `..` segment in the spelling itself is refused before any resolution.
 */
export function assertWithinRoot(root: string, path: string, what: string): string {
  if (path.split(/[\\/]/).includes('..')) throw new Error(`${what} escapes the isolated test root`);
  const real = canonicalIdentity(path), rel = relative(root, real);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error(`${what} escapes the isolated test root`);
  return real;
}

/** The address a session's herdr listens on: the socket file itself on Unix (sun_path < 104 bytes); on Windows a named pipe of the marker's own name, as server/herdr/client.ts socketAddress() derives it (whole name <= 256 characters). */
export function isolatedEndpoint(marker: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const pipe = PIPE + marker;
    if (pipe.length > 256) throw new Error('Isolated named pipe name is too long');
    return pipe;
  }
  if (Buffer.byteLength(marker) >= 104) throw new Error('Isolated Unix socket path is too long');
  return marker;
}

/** Validates an isolated environment (the verifier's child env or this process) and returns its root plus the one owned socket marker/endpoint. */
export function validateIsolatedEnvironment(env: Env = process.env): { root: string; marker: string; endpoint: string } {
  if (env.HERDR_TEST_LIVE === '1') throw new Error('Production/live tests are forbidden');
  if (!env.TERMWEAVE_TEST_ROOT) throw new Error('No isolated test root');
  const root = canonicalPath(env.TERMWEAVE_TEST_ROOT);
  for (const [name] of LOCATIONS) {
    const path = env[name];
    if (!path && WINDOWS_PROFILE.has(name) && process.platform !== 'win32') continue;
    // strict: each location is a child of the root, never the root itself
    if (!path) throw new Error(`${name} escapes the isolated test root`);
    assertWithinRoot(root, path, name);
  }
  const session = env.HERDR_TEST_SESSION;
  if (!session || !/^[a-zA-Z0-9_-]{1,32}$/.test(session)) throw new Error('Invalid isolated session segment');
  const marker = resolve(env.XDG_CONFIG_HOME!, 'herdr', 'sessions', session, 'herdr.sock');
  // strict, before creating anything: the nearest existing ancestor may not lead out through a link
  assertWithinRoot(root, dirname(marker), 'Socket parent');
  mkdirSync(dirname(marker), { recursive: true });
  // strict, after creation: the session directory itself
  assertWithinRoot(root, dirname(marker), 'Socket parent');
  const endpoint = isolatedEndpoint(marker);
  const inherited = env.HERDR_SOCKET;
  // only this session's marker or its own derived endpoint; any other pipe/UNC/device name (prefix or case variants included) is foreign
  if (inherited && inherited !== endpoint && (isNetworkPath(inherited) || resolve(inherited) !== marker)) throw new Error('Unexpected or production HERDR_SOCKET refused');
  return { root, marker, endpoint };
}

/** Never import a runtime client before validating and replacing inherited caller state. */
export function isolateTestEnvironment(): string {
  if (process.env.HERDR_TEST_LIVE === '1') throw new Error('Production/live tests are forbidden');
  if (process.env.TERMWEAVE_TEST_ROOT) return validateIsolatedEnvironment().root;
  if (process.env.HERDR_SOCKET) throw new Error('Inherited HERDR_SOCKET refused. Use the isolated verifier');
  const root = canonicalPath(mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'tw-')));
  for (const key of Object.keys(process.env)) if (key.toUpperCase().startsWith('HERDR_')) delete process.env[key];
  process.env.TERMWEAVE_TEST_ROOT = root;
  process.env.HERDR_TEST_SESSION = 'qa';
  Object.assign(process.env, isolatedLocations(root));
  return validateIsolatedEnvironment().root;
}

/** The socket (marker path, or on Windows its named pipe) a test may start or stop: exactly the one derived from a valid isolated root/session. */
export function assertIsolatedSocket(socket: string, env: Env = process.env): void {
  let owned: { marker: string; endpoint: string };
  try { owned = validateIsolatedEnvironment(env); } catch (error) { throw new Error(`Runtime socket is not owned by this test: ${(error as Error).message}`); }
  if (socket !== owned.endpoint && (isNetworkPath(socket) || resolve(socket) !== owned.marker)) throw new Error('Runtime socket is not owned by this test');
}
