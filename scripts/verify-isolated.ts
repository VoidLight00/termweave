import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, openSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { chromiumExecutable } from './browser.ts';
import { canonicalPath } from './lifecycle-path.ts';
import { assertIsolatedSocket, isolatedLocations, validateIsolatedEnvironment } from './test-isolation.ts';

const repo = resolve(import.meta.dir, '..');
if (process.env.HERDR_TEST_LIVE === '1' || process.env.HERDR_SOCKET) throw new Error('Live or inherited runtime socket overrides are forbidden');
const root = canonicalPath(mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'tw-')));
const evidence = resolve(repo, 'evidence/p3', basename(root)); mkdirSync(evidence, { recursive: true });
// HOME/XDG and the Windows profile (USERPROFILE/APPDATA/LOCALAPPDATA) live in the root; required OS variables (SystemRoot, PATH, ...) pass through.
// Windows names are case-insensitive: drop every inherited spelling of an isolated name so no duplicate can win in the child.
const isolated: Record<string, string> = { TERMWEAVE_TEST_ROOT: root, HERDR_TEST_SESSION: 'qa', TMPDIR: root, TMP: root, TEMP: root, ...isolatedLocations(root) };
const nameKey = (name: string) => process.platform === 'win32' ? name.toUpperCase() : name;
const replaced = new Set(Object.keys(isolated).map(nameKey));
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !nameKey(name).startsWith('HERDR_') && !replaced.has(nameKey(name)))), ...isolated } as Record<string, string>;
env.HERDR_STAGING_DIST = join(root, 'dist'); env.DOCK_EVIDENCE = evidence;
validateIsolatedEnvironment(env);
// only browser lanes need Chromium: type, build and unit run on a machine without it, and a browser
// lane without it fails with the same install hint from chromiumExecutable()
try { env.CHROME_PATH = chromiumExecutable(); } catch { delete env.CHROME_PATH; }
const lanes: [string, string[], Record<string, string>?][] = [
  ['test-cleanup', ['bun', 'scripts/test-herdr-cleanup-regression.ts']],
  ['ledger', ['node', 'scripts/validate-ledgers.mjs']],
  ['ledger-tests', ['node', '--test', 'scripts/ledger.test.mjs']],
  ['type', ['bun', 'run', 'typecheck']],
  ['build', ['bun', 'run', 'build', '--outDir', env.HERDR_STAGING_DIST]],
  ['unit', ['bun', '--preload', './scripts/staging-static.ts', 'scripts/ci-tests.ts', 'unit'], { HERDR_TEST_MODE: 'unit' }],
  ['integration', ['bun', 'run', 'test:integration']],
  ['pane-mesh', ['bash', 'gates/pane_mesh_gate.sh', '--components'], { HERDR_TEST_MODE: 'unit' }],
  ['sidebar-lifecycle', ['bun', '--preload', './scripts/staging-static.ts', 'scripts/sidebar-lifecycle-regression.ts']],
  ['tmux', ['bash', 'gates/tmux_runtime_gate.sh']],
  ['workspace-status', ['bun', 'scripts/workspace-status-regression.ts']],
  ['workspace-reorder', ['bun', 'scripts/workspace-reorder-regression.ts']],
  ['release-native', ['bun', 'scripts/release/native-regression.ts']],
  ['release-browser', ['bun', 'scripts/release/browser-regression.ts']],
  ['install-cleanup', ['bun', 'scripts/install-cleanup-regression.ts']],
  ['actual-install', ['bun', 'scripts/actual-install-regression.ts']],
  ['product-start', ['bun', 'scripts/product-start-regression.ts']],
  ['product-browser', ['bun', '--preload', './scripts/staging-static.ts', 'scripts/product-browser-regression.ts']],
  ['render', ['bun', 'scripts/terminal-render-regression.ts'], { RENDER_LABEL: 'p3' }],
  // the production PaneTerminal assertions of the mirror input/IME guard (3F) and the composition hold (3G-1) belong to the render lane;
  // their --negative-control runs prove the harness's detection power and stay separate direct checks
  ['render.input-policy', ['bun', 'scripts/terminal-render-regression.ts', '--input-policy']],
  ['render.mirror-flow', ['bun', 'scripts/terminal-render-regression.ts', '--input-policy', '--mirror-flow']],
  ['color-picker', ['bun', 'scripts/color-picker-regression.ts']],
  ['pane-move', ['bun', 'scripts/pane-move-regression.ts']],
  ['dock', ['bun', '--preload', './scripts/staging-static.ts', 'scripts/dock-regression.ts']],
  ['title-drag', ['bun', '--preload', './scripts/staging-static.ts', 'scripts/dock-title-drag-regression.ts']],
  ['dock-header', ['bun', '--preload', './scripts/staging-static.ts', 'scripts/dock-header-regression.ts']],
  ['send-composing', ['bun', '--preload', './scripts/staging-static.ts', 'scripts/terminal-send-composing-regression.ts']],
  ['workspace', ['bun', '--preload', './scripts/staging-static.ts', 'scripts/session-isolation-regression.ts']],
  ['move', ['bun', '--preload', './scripts/staging-static.ts', 'scripts/pane-move-browser.ts']],
  ['preview', ['bun', '--preload', './scripts/staging-static.ts', 'scripts/preview-app-regression.ts']],
  ['spatial', ['bun', '--preload', './scripts/staging-static.ts', 'scripts/spatial-focus-regression.ts']],
  ['ui', ['bun', '--preload', './scripts/staging-static.ts', 'scripts/ui-regression.ts']],
  ['file-uri', ['bun', 'scripts/file-links-browser.ts']],
  ['file-links', ['bun', '--preload', './scripts/staging-static.ts', 'scripts/terminal-file-links-regression.ts']],
  ['source-style', ['bun', 'scripts/source-style-gate.mjs']],
];
const selected = process.argv.slice(2);
for (const name of selected) if (!lanes.some(lane => lane[0] === name)) throw new Error(`Unknown required lane: ${name}`);
// a lane `name` also runs its `name.part` lanes
const runs = (lane: string) => !selected.length || selected.some(name => lane === name || lane.startsWith(name + '.'));
const { trackedHashes } = await import('./tracked-source-hashes.ts');
const trackedSourceHashes = trackedHashes(repo);
const sourceHashes = Object.fromEntries([...new Bun.Glob('{src,shared,server,scripts,gates}/**/*.{ts,tsx,css,sh,mjs,py}').scanSync({ cwd: repo }),
  'package.json', 'bun.lock', 'bunfig.toml', 'tsconfig.json', 'vite.config.ts', 'install.sh']
  .sort().map(path => [path, createHash('sha256').update(readFileSync(join(repo, path))).digest('hex')]));
const results: { name: string; command: string[]; exit_code: number; log: string; counts: Record<string, number> }[] = [];
function countsFor(log: string): Record<string, number> {
  const text = readFileSync(log, 'utf8');
  return Object.fromEntries(['pass', 'skip', 'fail'].flatMap(kind => {
    const matches = [...text.matchAll(new RegExp(`^\\s*(\\d+) ${kind}$`, 'gm')),
      ...text.matchAll(new RegExp(`^(?:#|ℹ) ${kind === 'skip' ? '(?:skip|skipped)' : kind} (\\d+)$`, 'gm'))];
    return matches.length ? [[kind, matches.reduce((sum, match) => sum + Number(match[1]), 0)]] : [];
  }));
}
let cleanupFailed = false;
try {
  for (const [name, command, extra] of lanes) {
    if (!runs(name)) continue;
    const log = join(evidence, name + '.txt');
    // One descriptor for both streams: separately opening the same log loses evidence
    // when stdout/stderr seek and overwrite each other (including the suite banner).
    const fd = openSync(log, 'w', 0o600);
    let code: number;
    try {
      const child = Bun.spawn(command, { cwd: repo, env: { ...env, ...extra }, stdout: fd, stderr: fd, stdin: 'ignore' });
      code = await child.exited;
    } finally { closeSync(fd); }
    results.push({ name, command, exit_code: code, log, counts: countsFor(log) }); console.log(`${code === 0 ? 'PASS' : 'FAIL'}[${name}] exit=${code}`);
    // CI keeps no evidence folder: print the failing lines so a red run can be diagnosed from its log
    if (code !== 0) {
      const lines = readFileSync(log, 'utf8').split('\n');
      const hits = lines.flatMap((line, i) => /^\(fail\)|^error|Error:/.test(line) ? lines.slice(Math.max(0, i - 6), i + 3) : []);
      console.log((hits.length ? hits : lines).slice(-60).join('\n'));
    }
  }
} finally {
  // the session marker (Unix socket file; on Windows the marker of herdr's named pipe) this run owns, and nothing else
  const socket = join(env.XDG_CONFIG_HOME!, 'herdr', 'sessions', 'qa', 'herdr.sock');
  let cleanup = 0;
  const pidFile = join(env.XDG_CONFIG_HOME!, 'herdr', 'sessions', 'qa', 'test-owned.pid');
  const ownedPid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : null;
  let owned = true;
  try { assertIsolatedSocket(socket, env); } catch (error) { owned = false; console.log(`FAIL[cleanup] ${(error as Error).message}`); }
  if (owned && existsSync(socket)) {
    const child = Bun.spawn(['herdr', '--session', 'qa', 'server', 'stop'], { cwd: repo, env, stdout: Bun.file(join(evidence, 'cleanup.txt')), stderr: Bun.file(join(evidence, 'cleanup.txt')) });
    cleanup = await child.exited;
  }
  for (let attempt = 0; attempt < 100 && existsSync(socket); attempt++) await Bun.sleep(20);
  const socketRemoved = !existsSync(socket);
  let ownedPidGone = true;
  if (ownedPid && Number.isSafeInteger(ownedPid)) { try { process.kill(ownedPid, 0); ownedPidGone = false; } catch {} }
  const trackedSourcesUnchanged = JSON.stringify(trackedSourceHashes) === JSON.stringify(trackedHashes(repo));
  cleanupFailed = !owned || cleanup !== 0 || !socketRemoved || !ownedPidGone || !trackedSourcesUnchanged;
  writeFileSync(join(evidence, 'result.json'), JSON.stringify({ root, evidence, tracked_hashes: trackedSourceHashes, tracked_sources_unchanged: trackedSourcesUnchanged, source_hashes: sourceHashes, results, failures: results.filter(result => result.exit_code !== 0), cleanup_exit: cleanup, socket_removed: socketRemoved, owned_pid: ownedPid, owned_pid_gone: ownedPidGone, production_access: false,
      limits: ['Native agent receiver tests prove transport ACK only, not real Claude/Codex semantic processing.', 'Workflow status frames use the production reducer but synthetic events.', 'Task ownership is advisory, not enforcement of arbitrary shell writes.', 'Native metadata check-to-send is not atomic; uncertain sends must not be retried.', 'Production deployment readiness is a separate blocked gate; no deployment was attempted.'] }, null, 2));
  console.log(`EVIDENCE ${evidence}`);
}
if (cleanupFailed || results.some((result: any) => result.exit_code)) process.exitCode = 1;
