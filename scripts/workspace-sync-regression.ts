/** Folder color, rename and order made on one screen reach another open screen without a reload.
 * Isolated HOME/herdr session, loopback server. Run: bun scripts/workspace-sync-regression.ts
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser.ts';
import { isolateTestEnvironment } from './test-isolation.ts';

const root = isolateTestEnvironment();
process.env.SHELL = '/bin/sh';
await import('./test-herdr.ts');
const { workspaceCreate, workspaceClose, sessionSnapshot } = await import('../server/herdr/client.ts');
const { createServer } = await import('../server/index.ts');
const { UsageService } = await import('../server/usage.ts');
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let owned: string[] = [];
try {
  for (const workspace of (await sessionSnapshot()).workspaces) await workspaceClose(workspace.workspace_id);
  for (const label of ['Alpha', 'Beta']) {
    const cwd = join(root, label.toLowerCase()); mkdirSync(cwd, { recursive: true });
    owned = [...owned, (await workspaceCreate({ cwd, label })).workspace.workspace_id];
  }
  const [alpha, beta] = owned as [string, string];
  server = createServer({ port: 0, hostname: '127.0.0.1', token: '', stateDir: join(root, 'state'), tailscaleOwner: null, codexHome: join(root, 'codex'), usage: new UsageService(undefined, []) });
  const origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
  const open = async () => {
    const context = await browser!.newContext({ viewport: { width: 1280, height: 860 }, serviceWorkers: 'block' });
    await context.addInitScript(() => localStorage.setItem('termweave:settings', JSON.stringify({ language: 'en' })));
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(origin); await page.locator('.conn-live').waitFor();
    return page;
  };
  const app = await open();
  const web = await open();
  const post = (path: string, body: unknown) => app.evaluate(async ([p, b]) => (await fetch(p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-herdr-machine': '1' }, body: JSON.stringify(b) })).status, [path, body] as const);
  const mark = (id: string) => web.locator(`section.workspace[data-reorder-workspace="${id}"] .agent-mark-holder.is-shell`);

  assert.equal(await post('/api/workspace/colors', { workspace_id: alpha, color: '#ff0000' }), 200);
  await web.waitForFunction(el => el && getComputedStyle(el).color === 'rgb(255, 0, 0)', await mark(alpha).elementHandle());
  console.log('PASS a color set on one screen shows on another without reload');
  assert.equal(await post('/api/workspace/colors', { workspace_id: alpha, color: 'javascript:x' }), 400);
  console.log('PASS a bad color is refused');

  assert.equal(await post('/api/workspace/rename', { workspace_id: beta, label: 'Renamed' }), 200);
  await web.getByText('Renamed', { exact: true }).first().waitFor();
  console.log('PASS a rename shows on another screen without reload');

  assert.equal(await post('/api/workspace/move', { workspace_id: beta, insert_index: 0 }), 200);
  await web.waitForFunction(id => document.querySelector('section.workspace[data-reorder-workspace]')?.getAttribute('data-reorder-workspace') === id, beta);
  console.log('PASS a folder move shows on another screen without reload');
} finally {
  await browser?.close();
  server?.stop();
  for (const id of owned) await workspaceClose(id).catch(() => undefined);
}
