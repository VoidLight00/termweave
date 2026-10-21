/** Folder color dialog: pick a custom hex, apply, and the folder keeps it after reload.
 * Run: bun scripts/session-color-regression.ts [screenshotDir]
 * Isolated herdr root and owned server only. No live socket, no external traffic.
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { chromiumExecutable } from './browser.ts';
import { isolateTestEnvironment } from './test-isolation.ts';

const executablePath = chromiumExecutable();
const root = isolateTestEnvironment();
process.env.SHELL = '/bin/sh';
delete process.env.TERMWEAVE_RELEASE_ROOT;
const shots = process.argv[2];
await import('./test-herdr.ts');
const { workspaceCreate, workspaceClose, sessionSnapshot } = await import('../server/herdr/client.ts');
const { createServer } = await import('../server/index.ts');
const { UsageService } = await import('../server/usage.ts');
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let owned: string[] = [];
const label = 'Color folder';
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
try {
  for (const workspace of (await sessionSnapshot()).workspaces) await workspaceClose(workspace.workspace_id);
  const cwd = join(root, 'h', 'color'); mkdirSync(cwd, { recursive: true });
  const created = await workspaceCreate({ cwd, label });
  owned = [created.workspace.workspace_id];
  server = createServer({ port: 0, hostname: '127.0.0.1', token: '', stateDir: join(root, 'state'), tailscaleOwner: null, codexHome: join(root, 'codex'), usage: new UsageService(undefined, []) });
  const origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ executablePath, headless: true });
  const run = async (theme: 'dark' | 'light', width: number, height: number, tag: string) => {
    const context = await browser!.newContext({ viewport: { width, height }, colorScheme: theme, serviceWorkers: 'block', hasTouch: width < 500 });
    await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
    await context.addInitScript(theme => { if (!localStorage.getItem('termweave:settings')) localStorage.setItem('termweave:settings', JSON.stringify({ language: 'en', theme, terminalInputMode: 'direct', showUsage: false })); }, theme);
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin + '/'); await page.locator('.conn-live').waitFor();
    const folder = page.locator(`.pane-select[data-workspace-id="${owned[0]}"] .agent-mark-holder`);
    if (width < 500 && !(await folder.isVisible())) await page.locator('.drawer-toggle').click();
    await page.getByRole('button', { name: `More for workspace ${label}`, exact: true }).click();
    await (width < 500 ? page.getByText('Session color', { exact: true }) : page.getByRole('menuitem', { name: 'Session color', exact: true })).click();
    const dialog = page.locator('.session-color-dialog'); await dialog.waitFor();
    const hex = dialog.getByLabel(/hex/i).first();
    await hex.fill('#FF7A00'); await hex.press('Enter');
    await page.waitForTimeout(150);
    assert.equal(await dialog.locator('.session-color-hex').textContent(), '#ff7a00', 'typed hex shows in preview');
    assert.ok(await noOverflow(page), `${tag} horizontal overflow`);
    const box = await dialog.boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1, `${tag} dialog fits`);
    if (shots) await page.screenshot({ path: join(shots, `color-dialog-${tag}.png`) });
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.reload(); await page.locator('.conn-live').waitFor();
    if (width < 500 && !(await folder.isVisible())) await page.locator('.drawer-toggle').click();
    assert.equal(await folder.evaluate(n => getComputedStyle(n).color), 'rgb(255, 122, 0)', `${tag} folder keeps custom color after reload`);
    if (shots && tag === 'dark') await page.screenshot({ path: join(shots, 'color-sidebar-custom.png') });
    // Escape closes and recent swatch is offered
    await page.getByRole('button', { name: `More for workspace ${label}`, exact: true }).click();
    await (width < 500 ? page.getByText('Session color', { exact: true }) : page.getByRole('menuitem', { name: 'Session color', exact: true })).click();
    await dialog.waitFor();
    assert.equal(await dialog.locator('.session-color-recent button').count() >= 1, true, 'recent swatch shown');
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
    assert.deepEqual(errors, []);
    await context.close();
  };
  await run('dark', 1280, 860, 'dark');
  await run('light', 1280, 860, 'light');
  await run('dark', 375, 760, 'phone');
  await run('dark', 320, 640, 'phone320');
  console.log('session-color-regression: ok');
} finally {
  await browser?.close();
  server?.stop(true);
  for (const id of owned) await workspaceClose(id).catch(() => {});
}
