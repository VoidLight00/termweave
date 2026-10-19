/** Real application captures with isolated native terminals and synthetic output only.
 * Run: bun scripts/public-feature-capture.ts
 * No live socket, persistent browser profile, device delivery, or external publication.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium, type Page } from 'playwright-core';
import { chromiumExecutable } from './browser.ts';
import { isolateTestEnvironment } from './test-isolation.ts';

const repository = resolve(import.meta.dir, '..');
const executablePath = chromiumExecutable();
const root = isolateTestEnvironment();
// Resolve all runtime modules only after replacing HOME and the herdr environment.
process.env.SHELL = '/bin/sh';
process.env.TERMWEAVE_MACHINE_NAME = 'Demo workstation';
delete process.env.TERMWEAVE_RELEASE_ROOT;
const { testSocketPath } = await import('./test-herdr.ts');
assert.equal(process.env.HERDR_SOCKET, testSocketPath());
const { workspaceCreate, workspaceClose, sessionSnapshot, herdrRpc, paneSendText, paneSendKeys } = await import('../server/herdr/client.ts');
const { createServer } = await import('../server/index.ts');
const { UsageService } = await import('../server/usage.ts');
const { sessionColorKey } = await import('../src/lib/sessionColor.ts');
const output = join(repository, 'assets/screenshots');
mkdirSync(output, { recursive: true });
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let owned: string[] = [];
let captures: object[] = [];
let errors: string[] = [];
const names = ['Atlas website', 'Orion API', 'Nova research'];
try {
  // The helper's resident workspace is also synthetic and belongs to this new isolated root.
  for (const workspace of (await sessionSnapshot()).workspaces) await workspaceClose(workspace.workspace_id);
  const workspaces = [];
  for (const label of names) {
    const cwd = join(root, 'h', 'demo', label.split(' ')[0].toLowerCase());
    mkdirSync(cwd, { recursive: true });
    const created = await workspaceCreate({ cwd, label });
    owned = [...owned, created.workspace.workspace_id];
    workspaces.push(created);
  }
  const first = workspaces[0]!;
  const panes = [first.root_pane.pane_id];
  for (let index = 0; index < 2; index++) {
    const split = await herdrRpc<{ pane: { pane_id: string } }>('pane.split', {
      target_pane_id: panes[0], direction: 'right', cwd: join(root, 'h', 'demo', 'atlas'), focus: false,
    });
    panes.push(split.pane.pane_id);
  }
  const titles = ['Design review', 'Component checks', 'Release notes'];
  const lines = [
    ['ATLAS / DESIGN REVIEW', '', 'Synthetic demonstration session', '', '$ review homepage', 'Typography       ready', 'Navigation       ready', 'Responsive flow  ready', '', 'Next: review the mobile navigation.'],
    ['ATLAS / COMPONENT CHECKS', '', 'Synthetic demonstration output', '', '$ check components', 'Button           example passed', 'Search           example passed', 'Sidebar          example passed', '', 'No production tests or services were run.'],
    ['ATLAS / RELEASE NOTES', '', 'Synthetic demonstration session', '', '1. Organize workspaces by folder color', '2. Split terminal views', '3. Continue from a mobile browser', '', 'Documentation preview only.'],
  ];
  for (let index = 0; index < panes.length; index++) {
    await herdrRpc('pane.rename', { pane_id: panes[index], label: titles[index] });
    // Clear the native terminal and scrollback; output is rendered by the actual PTY/xterm path.
    const text = lines[index]!.join('\\n');
    await paneSendText(panes[index]!, `printf '\\033[2J\\033[3J\\033[H${text}\\n'; PS1='demo $ '`);
    await paneSendKeys(panes[index]!, ['Enter']);
  }
  server = createServer({ port: 0, hostname: '127.0.0.1', token: '', stateDir: join(root, 'state'), tailscaleOwner: null, codexHome: join(root, 'codex'), usage: new UsageService(undefined, []) });
  const origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: 'dark', serviceWorkers: 'block' });
  // Browser requests can only reach this owned app. No production API or remote asset traffic.
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  const colors = ['blue', 'green', 'violet'];
  const colorKeys = owned.map(id => sessionColorKey(origin, 'local', id));
  await context.addInitScript(({ panes, workspace, colorKeys, colors }) => {
    localStorage.setItem('termweave:settings', JSON.stringify({ language: 'en', theme: 'dark', terminalInputMode: 'direct', showUsage: false }));
    colorKeys.forEach((key, index) => localStorage.setItem(key, colors[index]!));
    const group = (index: number) => ({ kind: 'group', id: `demo-${index}`, tabs: [panes[index]], active: panes[index] });
    localStorage.setItem(`termweave:dock:v1:local:${workspace}`, JSON.stringify({ kind: 'split', id: 'demo-main', axis: 'columns', ratio: 0.55, first: group(0), second: { kind: 'split', id: 'demo-right', axis: 'rows', ratio: 0.5, first: group(1), second: group(2) } }));
  }, { panes, workspace: owned[0], colorKeys, colors });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => { errors = [...errors, error.message]; });
  const capture = async (page: Page, name: string, description: string) => {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(350);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), name + ' horizontal overflow');
    const file = join(output, name + '.png');
    await page.screenshot({ path: file, animations: 'disabled' });
    captures = [...captures, { file: 'assets/screenshots/' + name + '.png', description, viewport: page.viewportSize(), sha256: createHash('sha256').update(readFileSync(file)).digest('hex') }];
  };
  await page.goto(`${origin}/?pane=${panes[0]}`);
  await page.locator('.conn-live').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.dock-group').length === 3);
  await page.waitForTimeout(1800);
  const folderColors = await page.locator('.pane-select[data-workspace-id] .agent-mark-holder').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).color));
  assert.equal(new Set(folderColors).size, 3, 'Three distinct workspace folder colors');
  await capture(page, 'desktop-workspaces', 'Real three-pane terminal layout; synthetic native terminal output; three folder-icon colors, not colored rows.');
  await page.locator('.dock-group').first().getByRole('button', { name: 'Terminal tools', exact: true }).click();
  await page.locator('.dock-tools-panel').waitFor();
  await capture(page, 'desktop-pane-tools', 'Actual terminal tools panel over the native terminal layout.');
  await page.locator('.dock-tools-panel').getByRole('button', { name: 'Close', exact: true }).click();
  // A real in-app alert: another workspace's agent goes working -> blocked, as the droplet regression does.
  const report = (pane: string, state: string) => herdrRpc('pane.report_agent', { pane_id: pane, source: 'manual', agent: 'claude', state });
  const alertFrom = async (index: number) => {
    const pane = workspaces[index]!.root_pane.pane_id;
    await report(pane, 'idle'); await report(pane, 'working');
    await page.locator(`.workspace:has(.pane-select[data-workspace-id="${owned[index]}"]) [data-workspace-status="running"]`).waitFor({ state: 'attached' });
    await report(pane, 'blocked');
    await page.locator('.droplet-card').waitFor({ state: 'visible' });
    await page.waitForTimeout(900);
  };
  await alertFrom(1);
  await capture(page, 'desktop-alert', 'Actual in-app alert: an agent in another workspace needs input. The agent status is reported through herdr pane.report_agent; no OS push delivery.');
  await page.locator('.droplet-card').click();
  await page.locator('.droplet').waitFor({ state: 'detached' });
  await page.goto(`${origin}/?pane=${panes[0]}`);
  await page.locator('.conn-live').waitFor();
  await page.getByRole('button', { name: `More for workspace ${names[0]}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Session color', exact: true }).click();
  await page.locator('.session-color-dialog').waitFor();
  await capture(page, 'desktop-session-palette', 'Actual workspace session-color selection dialog.');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.settings-dialog').waitFor();
  await capture(page, 'desktop-settings', 'Actual appearance settings; no configuration has been published.');
  await page.getByRole('button', { name: 'Customize these colors', exact: true }).click();
  await page.locator('.color-picker').scrollIntoViewIfNeeded();
  await capture(page, 'desktop-color-picker', 'Actual custom color picker: saturation and brightness square, hue slider, HEX, RGB and HSB fields.');
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelectorAll('.dock-group').length === 1);
  await capture(page, 'mobile-terminal', '390x844 responsive browser viewport; single native terminal view. Not a physical device capture.');
  await alertFrom(2);
  await capture(page, 'mobile-alert', 'Actual in-app alert at 390x844 in a responsive browser viewport. Not a physical device or OS notification.');
  await page.locator('.droplet-card').click();
  await page.locator('.droplet').waitFor({ state: 'detached' });
  await page.locator('.drawer-toggle').click();
  await page.locator('.sidebar.is-open').waitFor();
  await capture(page, 'mobile-sidebar', 'Actual mobile workspace drawer with colored folder icons.');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.settings-dialog').waitFor();
  await capture(page, 'mobile-appearance', 'Actual mobile appearance settings at 390x844.');
  for (const [heading, file, description] of [
    ['Alerts', 'mobile-notification-settings', 'Actual notification preferences only; no simulated event or device push delivery.'],
    ['My Android devices', 'mobile-companion-settings', 'Actual Android devices settings in a browser; no companion pairing or Android device delivery tested.'],
  ]) {
    const section = page.locator('.settings-section').filter({ has: page.getByRole('heading', { name: heading, exact: true }) });
    await section.evaluate(node => node.scrollIntoView({ block: 'start' }));
    await capture(page, file, description);
  }
  assert.deepEqual(errors, []);
  await Bun.write(join(output, 'provenance.json'), JSON.stringify({
    command: 'bun scripts/public-feature-capture.ts', capturedAt: new Date().toISOString(),
    app: 'Existing repository dist/index.html served by server/index.ts; no replacement HTML/CSS or screenshot compositing.',
    distIndexSha256: createHash('sha256').update(readFileSync(join(repository, 'dist/index.html'))).digest('hex'),
    isolation: 'Fresh test-isolation HOME/XDG/native herdr session, fresh Chromium context, loopback server on ephemeral port, browser network allowlist. Synthetic workspace names and output only.',
    folderColors, captures, browserErrors: errors,
    limits: ['Existing built frontend used; source freshness is not asserted.', 'Mobile screenshots use responsive Chromium viewport, not physical device or Android WebView.', 'Notification delivery, companion pairing and physical-device behavior are not tested.'],
  }, null, 2) + '\n');
  console.log(`PASS public-feature-capture: ${captures.length} real app screenshots, 3 distinct folder colors, no browser errors`);
} finally {
  await browser?.close();
  server?.stop();
  for (const id of owned) await workspaceClose(id).catch(() => undefined);
  // test-herdr's exit handler owns native-server shutdown. Its isolated root is retained for diagnosis.
}
