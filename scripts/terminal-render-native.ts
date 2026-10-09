import { OwnedCleanup } from './cleanup.ts';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { existsSync, realpathSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { createServer as createVite } from 'vite';
import { chromium } from 'playwright-core';

const root = resolve(import.meta.dir, '..');
const owned = resolve(root, 'evidence/p2b/n');
for (const name of ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME']) assert.ok(process.env[name] && realpathSync(process.env[name]!).startsWith(realpathSync(owned) + '/'), `${name} must be isolated`);
assert.equal(process.env.HERDR_TEST_SESSION, 'tw');
assert.notEqual(process.env.HERDR_TEST_LIVE, '1');
const cleanup = new OwnedCleanup();
try {
const test = await import('./test-herdr.ts');
const nativeSocket = test.testSocketPath();
const serverPidPath = join(dirname(nativeSocket), 'test-owned.pid');
const nativePid = existsSync(serverPidPath) ? Number(readFileSync(serverPidPath, 'utf8').trim()) : null;
cleanup.add('native-owned-session', async () => {
  const child = Bun.spawn(['herdr', '--session', 'tw', 'server', 'stop'], { env: process.env, stdout: 'ignore', stderr: 'ignore' });
  const exit = await child.exited;
  for (let attempt = 0; attempt < 100 && existsSync(nativeSocket); attempt++) await Bun.sleep(20);
  let pidGone = nativePid === null;
  if (nativePid) { try { process.kill(nativePid, 0); } catch { pidGone = true; } }
  const postconditions = { exit, socketRemoved: !existsSync(nativeSocket), ownedPid: nativePid, ownedPidGone: pidGone };
  writeFileSync(join(owned, 'native-shutdown.json'), JSON.stringify(postconditions, null, 2));
  assert.equal(exit, 0); assert.equal(postconditions.socketRemoved, true); assert.equal(postconditions.ownedPidGone, true);
});
assert.equal(process.env.HERDR_SOCKET, test.testSocketPath());
assert.ok(realpathSync(dirname(process.env.HERDR_SOCKET!)).startsWith(realpathSync(owned) + '/'));
const { createServer } = await import('../server/index.ts');
const { workspaceCreate, workspaceClose, paneSendText, sessionSnapshot } = await import('../server/herdr/client.ts');
const { UsageService } = await import('../server/usage.ts');
const workspace = await workspaceCreate({ cwd: owned, label: 'synthetic-render-owned' });
cleanup.add('workspace', () => workspaceClose(workspace.workspace.workspace_id));
const pane = workspace.root_pane;
const pidPath = join(owned, 'shell-pid.txt');
if (existsSync(pidPath)) unlinkSync(pidPath);
await paneSendText(pane.pane_id, `printf '%s' $$ > '${pidPath}'\n`);
for (let i = 0; i < 100 && !existsSync(pidPath); i++) await Bun.sleep(50);
assert.ok(existsSync(pidPath));
const pid = readFileSync(pidPath, 'utf8').trim();
const server = createServer({ port: 0, hostname: '127.0.0.1', stateDir: join(owned, 'web-state'), token: '', usage: new UsageService(undefined, []) });
cleanup.add('web-server', () => server.stop());
const vite = await createVite({ root, configFile: false, esbuild: { jsx: 'automatic' }, server: { host: '127.0.0.1', port: 0,
  proxy: { '/ws': { target: `http://127.0.0.1:${server.port}`, ws: true }, '/api': { target: `http://127.0.0.1:${server.port}` } } },
  plugins: [{ name: 'owned-native-render-fixture', configureServer(vite) { vite.middlewares.use((request, response, next) => {
    if (request.url !== '/render-native') return next();
    void vite.transformIndexHtml('/render-native', '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><div id="root"></div><script type="module" src="/scripts/terminal-render-fixture.tsx"></script></body></html>').then(html => response.end(html));
  }); } }] });
cleanup.add('vite', () => vite.close());
await vite.listen();
const executablePath = process.env.CHROME_PATH; assert.ok(executablePath);
const browser = await chromium.launch({ executablePath, headless: true });
cleanup.add('browser', () => browser.close());
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
await page.addInitScript(id => { (window as any).nativeRenderPane = id; localStorage.setItem('termweave:direct-typing', '1'); }, pane.pane_id);
const frames: any[] = [], errors: string[] = [], evidence: any[] = [];
page.on('pageerror', error => errors.push(error.message));
page.on('websocket', socket => socket.on('framesent', frame => { try { const data = JSON.parse(String(frame.payload)); if (['resize', 'attach'].includes(data.type)) frames.push(data); } catch {} }));
const measure = async (label: string) => {
  await page.waitForTimeout(500);
  const value = await page.evaluate(() => {
    const body = document.querySelector('.dock-drop-body')!.getBoundingClientRect();
    const stack = document.querySelector('.terminal-stack')!.getBoundingClientRect();
    const mount = document.querySelector('.pane-terminal')!.getBoundingClientRect();
    const screen = document.querySelector('.xterm-screen')!.getBoundingClientRect();
    const term = (window as any).renderTerms.find((term: any) => term.element?.isConnected);
    return { bodyWidth: body.width, bodyRight: body.right, bodyBottom: body.bottom, stackRight: stack.right, stackBottom: stack.bottom, mountWidth: mount.width, screenWidth: screen.width, right: screen.right, mountRight: mount.right,
      bottom: screen.bottom, mountBottom: mount.bottom, cols: term.cols, rows: term.rows };
  });
  assert.ok(value.stackRight <= value.bodyRight + 1 && value.stackBottom <= value.bodyBottom + 1 && value.mountRight <= value.bodyRight + 1 && value.mountBottom <= value.bodyBottom + 1);
  assert.ok(value.right <= value.mountRight + 1 && value.bottom <= value.mountBottom + 1);
  const frame = frames.filter(frame => frame.pane_id === pane.pane_id).at(-1); assert.ok(frame);
  assert.equal(value.cols, frame.cols); assert.equal(value.rows, frame.rows);
  if (existsSync(join(owned, label + '-size.txt'))) unlinkSync(join(owned, label + '-size.txt'));
  await paneSendText(pane.pane_id, `stty size > '${join(owned, label + '-size.txt')}'\n`);
  for (let i = 0; i < 100 && !existsSync(join(owned, label + '-size.txt')); i++) await Bun.sleep(50);
  const size = readFileSync(join(owned, label + '-size.txt'), 'utf8').trim().split(/\s+/).map(Number);
  assert.deepEqual(size, [value.rows, value.cols]);
  const snapshot = await sessionSnapshot(); assert.equal(snapshot.panes.find(p => p.pane_id === pane.pane_id)?.terminal_id, pane.terminal_id);
  assert.equal((await Bun.$`ps -p ${pid} -o pid=`.quiet()).exitCode, 0);
  evidence.push({ label, ...value, ptySize: size, terminalId: pane.terminal_id, shellPid: pid });
  await page.screenshot({ path: join(owned, label + '.png') });
};
  await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/render-native`);
  await page.locator('.xterm-screen').waitFor(); await page.evaluate(() => document.fonts.ready);
  await measure('native-wide'); await page.setViewportSize({ width: 650, height: 800 }); await measure('native-shrink');
  await page.setViewportSize({ width: 390, height: 844 }); await measure('native-mobile');
  await page.setViewportSize({ width: 1440, height: 950 }); await measure('native-expand');
  assert.deepEqual(errors, []);
  writeFileSync(join(owned, 'execution-manifest.json'), JSON.stringify(Object.fromEntries(['scripts/terminal-render-fixture.tsx', 'scripts/terminal-render-native.ts', 'src/components/PaneTerminal.css'].map(path => [path, createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')])), null, 2));
  writeFileSync(join(owned, 'result.json'), JSON.stringify({ status: 'PASS', errors, evidence, socketIsolated: true }, null, 2));
  console.log('PASS isolated native render: rows/cols match stty, terminal identity and shell PID survive');
} finally {
  const results = await cleanup.run();
  writeFileSync(join(owned, 'cleanup.json'), JSON.stringify(results, null, 2));
  if (results.some(result => result.status === 'FAIL')) throw new Error('Owned native cleanup failed');
}
