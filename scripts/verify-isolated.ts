import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, existsSync, readFileSync, openSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromiumExecutable } from './browser.ts';

const repo = resolve(import.meta.dir, '..');
if (process.env.HERDR_TEST_LIVE === '1' || process.env.HERDR_SOCKET) throw new Error('Live or inherited runtime socket overrides are forbidden');
const root = realpathSync(mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'tw-')));
const evidence = resolve(repo, 'evidence/p3', root.split('/').at(-1)!); mkdirSync(evidence, { recursive: true });
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('HERDR_'))) as Record<string, string>;
env.TERMWEAVE_TEST_ROOT = root; env.HERDR_TEST_SESSION = 'qa';
env.TMPDIR = root; env.TMP = root; env.TEMP = root;
for (const [name, directory] of [['HOME', 'h'], ['XDG_CONFIG_HOME', 'c'], ['XDG_STATE_HOME', 's'], ['XDG_DATA_HOME', 'd'], ['XDG_CACHE_HOME', 'k']]) {
  const path = join(root, directory!); mkdirSync(path); env[name!] = path;
}
env.HERDR_STAGING_DIST = join(root, 'dist'); env.DOCK_EVIDENCE = evidence; env.CHROME_PATH = chromiumExecutable();
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
  ['release-native', ['bun', 'scripts/release/native-regression.ts']],
  ['release-browser', ['bun', 'scripts/release/browser-regression.ts']],
  ['install-cleanup', ['bun', 'scripts/install-cleanup-regression.ts']],
  ['actual-install', ['bun', 'scripts/actual-install-regression.ts']],
  ['product-start', ['bun', 'scripts/product-start-regression.ts']],
  ['product-browser', ['bun', '--preload', './scripts/staging-static.ts', 'scripts/product-browser-regression.ts']],
  ['render', ['bun', 'scripts/terminal-render-regression.ts'], { RENDER_LABEL: 'p3' }],
  ['dock', ['bun', '--preload', './scripts/staging-static.ts', 'scripts/dock-regression.ts']],
  ['title-drag', ['bun', '--preload', './scripts/staging-static.ts', 'scripts/dock-title-drag-regression.ts']],
  ['workspace', ['bun', '--preload', './scripts/staging-static.ts', 'scripts/session-isolation-regression.ts']],
  ['move', ['bun', '--preload', './scripts/staging-static.ts', 'scripts/pane-move-browser.ts']],
  ['preview', ['bun', '--preload', './scripts/staging-static.ts', 'scripts/preview-app-regression.ts']],
  ['spatial', ['bun', '--preload', './scripts/staging-static.ts', 'scripts/spatial-focus-regression.ts']],
  ['ui', ['bun', '--preload', './scripts/staging-static.ts', 'scripts/ui-regression.ts']],
  ['file-uri', ['bun', 'scripts/file-links-browser.ts']],
  ['file-links', ['bun', '--preload', './scripts/staging-static.ts', 'scripts/terminal-file-links-regression.ts']],
  ['source-style', ['node', 'scripts/source-style-gate.mjs']],
];
const selected = process.argv.slice(2);
for (const name of selected) if (!lanes.some(lane => lane[0] === name)) throw new Error(`Unknown required lane: ${name}`);
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
    if (selected.length && !selected.includes(name)) continue;
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
  const socket = join(env.XDG_CONFIG_HOME!, 'herdr/sessions/qa/herdr.sock');
  let cleanup = 0;
  const pidFile = join(env.XDG_CONFIG_HOME!, "herdr/sessions/qa/test-owned.pid");
  const ownedPid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : null;
  if (existsSync(socket)) {
    const child = Bun.spawn(['herdr', '--session', 'qa', 'server', 'stop'], { cwd: repo, env, stdout: Bun.file(join(evidence, 'cleanup.txt')), stderr: Bun.file(join(evidence, 'cleanup.txt')) });
    cleanup = await child.exited;
  }
  for (let attempt = 0; attempt < 100 && existsSync(socket); attempt++) await Bun.sleep(20);
  const socketRemoved = !existsSync(socket);
  let ownedPidGone = true;
  if (ownedPid && Number.isSafeInteger(ownedPid)) { try { process.kill(ownedPid, 0); ownedPidGone = false; } catch {} }
  cleanupFailed = cleanup !== 0 || !socketRemoved || !ownedPidGone;
  writeFileSync(join(evidence, 'result.json'), JSON.stringify({ root, evidence, source_hashes: sourceHashes, results, failures: results.filter(result => result.exit_code !== 0), cleanup_exit: cleanup, socket_removed: socketRemoved, owned_pid: ownedPid, owned_pid_gone: ownedPidGone, production_access: false,
      limits: ['Native agent receiver tests prove transport ACK only, not real Claude/Codex semantic processing.', 'Workflow status frames use the production reducer but synthetic events.', 'Task ownership is advisory, not enforcement of arbitrary shell writes.', 'Native metadata check-to-send is not atomic; uncertain sends must not be retried.', 'Production deployment readiness is a separate blocked gate; no deployment was attempted.'] }, null, 2));
  console.log(`EVIDENCE ${evidence}`);
}
if (cleanupFailed || results.some((result: any) => result.exit_code)) process.exitCode = 1;
