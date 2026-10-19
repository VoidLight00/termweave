/** Real native moves from the sidebar: the "Move to…" dialog and a drag onto another folder.
 * Isolated HOME/herdr session, loopback server, synthetic workspaces. Run: bun scripts/pane-move-regression.ts
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser.ts';
import { isolateTestEnvironment } from './test-isolation.ts';

const executablePath = chromiumExecutable();
const root = isolateTestEnvironment();
process.env.SHELL = '/bin/sh';
await import('./test-herdr.ts');
const { workspaceCreate, workspaceClose, sessionSnapshot, herdrRpc } = await import('../server/herdr/client.ts');
const { createServer } = await import('../server/index.ts');
const { UsageService } = await import('../server/usage.ts');
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let owned: string[] = [];
const until = async (check: () => Promise<boolean>, what: string) => {
  for (let i = 0; i < 100; i++) { if (await check()) return; await Bun.sleep(100); }
  throw new Error(`timed out: ${what}`);
};
const where = async (terminalId: string) => (await sessionSnapshot()).panes.find(pane => pane.terminal_id === terminalId);
try {
  for (const workspace of (await sessionSnapshot()).workspaces) await workspaceClose(workspace.workspace_id);
  const made = [];
  for (const label of ['Alpha', 'Beta']) {
    const cwd = join(root, label.toLowerCase()); mkdirSync(cwd, { recursive: true });
    const created = await workspaceCreate({ cwd, label }); owned = [...owned, created.workspace.workspace_id]; made.push(created);
  }
  const [alpha, beta] = made as [typeof made[0], typeof made[0]];
  // Alpha keeps a second pane, so it still exists after one pane leaves
  await herdrRpc('pane.split', { target_pane_id: alpha.root_pane.pane_id, direction: 'right', cwd: join(root, 'alpha'), focus: false });
  const moving = (await sessionSnapshot()).panes.find(pane => pane.pane_id === alpha.root_pane.pane_id)!;
  server = createServer({ port: 0, hostname: '127.0.0.1', token: '', stateDir: join(root, 'state'), tailscaleOwner: null, codexHome: join(root, 'codex'), usage: new UsageService(undefined, []) });
  const origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, serviceWorkers: 'block' });
  await context.addInitScript(() => localStorage.setItem('termweave:settings', JSON.stringify({ language: 'en' })));
  const page = await context.newPage();
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(15000);
  await page.goto(`${origin}/?pane=${beta.root_pane.pane_id}`);
  await page.locator('.conn-live').waitFor();

  // 1. menu: Alpha's pane goes below Beta's pane
  const row = () => page.locator(`.workspace-terminal-row:has([data-terminal-pane="${moving.pane_id}"])`);
  await row().locator('.terminal-menu-toggle').click();
  await page.getByRole('menuitem', { name: 'Move to…', exact: true }).click();
  const dialog = page.locator('.move-pane-dialog');
  await dialog.waitFor();
  assert.equal(await dialog.locator('select').first().inputValue(), beta.workspace.workspace_id, 'another folder is preselected');
  await dialog.getByLabel('Below').check();
  await dialog.getByRole('button', { name: 'Move terminal', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await until(async () => (await where(moving.terminal_id))?.workspace_id === beta.workspace.workspace_id, 'menu move reaches Beta');
  const landed = (await where(moving.terminal_id))!;
  const tabPanes = (await sessionSnapshot()).panes.filter(pane => pane.tab_id === landed.tab_id);
  assert.equal(tabPanes.length, 2, 'the moved pane shares the Beta tab');
  console.log('PASS menu moves a pane to another folder, beside the chosen pane');

  // 2. drag: the same terminal back onto the Alpha folder
  const moved = (await where(moving.terminal_id))!;
  await page.locator(`.workspace-terminal-row:has([data-terminal-pane="${moved.pane_id}"])`)
    .dragTo(page.locator(`section.workspace[data-reorder-workspace="${alpha.workspace.workspace_id}"] .pane-select`));
  await until(async () => (await where(moving.terminal_id))?.workspace_id === alpha.workspace.workspace_id, 'drag move reaches Alpha');
  console.log('PASS dragging a pane onto another folder moves it there');

  // 3. phone width: the dialog fits
  await page.setViewportSize({ width: 320, height: 700 });
  await page.locator('.drawer-toggle').click();
  const back = (await where(moving.terminal_id))!;
  await page.locator(`.workspace-terminal-row:has([data-terminal-pane="${back.pane_id}"]) .terminal-menu-toggle`).click();
  // a phone shows the row menu as a bottom sheet
  await page.getByText('Move to…', { exact: true }).click();
  await dialog.waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal overflow at 320px');
  const box = (await dialog.boundingBox())!;
  assert.ok(box.x >= 0 && box.x + box.width <= 320 + 1, `dialog inside the screen: ${box.x}+${box.width}`);
  console.log('PASS the move dialog fits a 320px screen');
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  server?.stop();
  for (const id of owned) await workspaceClose(id).catch(() => undefined);
}
