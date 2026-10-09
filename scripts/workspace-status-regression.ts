import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createServer, transformWithEsbuild } from 'vite';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser.ts';

// Synthetic snapshots only: no managed server, native PTY, production API, or saved settings.
const root = resolve(import.meta.dir, '..');
const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MachineSidebar } from '/src/components/MachineSidebar.tsx';
import { SettingsProvider } from '/src/lib/settings.ts';
import { applyPaneStatus } from '/src/lib/snapshot.ts';
import '/src/styles.css';
const pane = (id, status, tasks = 0) => ({pane_id:id, workspace_id:'ws', tab_id:id === 'ready' ? 'active' : 'hidden', terminal_id:id, focused:false, revision:0, agent_status:status, background_tasks:tasks});
const initial = [pane('ready','idle'), pane('waiting','blocked',2), pane('worker','working',3), pane('answer','done',1), pane('idle','idle'), pane('unknown','future')];
function Fixture() {
  const [selection, setSelection] = useState({machine:'local', pane:'ready'});
  const [snapshot, setSnapshot] = useState({protocol:1, version:'fixture', agents:[], layouts:[], tabs:[], panes:initial,
    workspaces:[{workspace_id:'ws',label:'Mixed workspace',active_tab_id:'active',agent_status:'idle',focused:false,number:1,pane_count:6,tab_count:2}]});
  const resumeWaiting = () => setSnapshot(current => applyPaneStatus(current, 'waiting', 'idle', 0));
  const clearStates = () => setSnapshot(current => current.panes.reduce((next, pane) => applyPaneStatus(next, pane.pane_id, 'idle', 0), current));
  const machines = ['local','remote'].map(id => ({id,name:id,kind:id === 'local' ? 'local' : 'ssh',state:'connected',enabled:true,snapshot}));
  const noop = () => {};
  const actions = {selectPane:noop, selectAdjacentPane:noop,setView:noop,toggleView:noop,openNewSession:noop,openPalette:noop,openSettings:noop,openAddPc:noop,toggleSidebar:noop,toggleTheme:noop,lock:null,enableNotifications:null,refresh:noop,openFiles:null};
  return <><div style={{width:360}}><MachineSidebar machines={machines} selectedMachineId={selection.machine} selectedPaneId={selection.pane} selectedWorkspaceId="ws" actions={actions} version={null}
    onSelect={(machine,pane) => setSelection({machine,pane})} onSelectWorkspace={(machine) => setSelection({machine,pane:'workspace'})} onNew={noop} onSetup={noop}/></div>
    <output data-testid="selection">{selection.machine+':'+selection.pane}</output>
    <output data-testid="snapshot-state">{snapshot.workspaces[0].agent_status+':'+snapshot.panes.length+':'+snapshot.panes.find(pane => pane.pane_id === 'waiting').agent_status}</output>
    <button onClick={resumeWaiting}>Resume waiting pane</button><button onClick={clearStates}>Clear pane states</button></>;
}
createRoot(document.getElementById('root')).render(<SettingsProvider><Fixture/></SettingsProvider>);
`;
const vite = await createServer({ root, configFile: false, esbuild: { jsx: 'automatic' },
  define: { __APP_VERSION__: JSON.stringify('fixture') }, server: { host: '127.0.0.1', port: 0 },
  plugins: [{ name: 'workspace-status-fixture',
    resolveId(id) { if (id === 'virtual:workspace-status-fixture') return '\0workspace-status-fixture.tsx'; },
    async load(id) { if (id === '\0workspace-status-fixture.tsx') return (await transformWithEsbuild(fixture, 'workspace-status-fixture.tsx', { loader: 'tsx', jsx: 'automatic' })).code; },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url !== '/status-test') return next();
        void server.transformIndexHtml('/status-test', '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@id/virtual:workspace-status-fixture"></script></body></html>')
          .then(html => { response.setHeader('Content-Type', 'text/html'); response.end(html); });
      });
    },
  }] });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await vite.listen();
  const port = (vite.httpServer!.address() as { port: number }).port;
  browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(() => { localStorage.setItem('termweave:settings', JSON.stringify({ language: 'en' })); });
  await page.route('**/api/**', route => route.fulfill({ json: { providers: [], machines: [], reports: [] } }));
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/status-test`);
  const remote = page.getByRole('region', { name: 'PC remote', exact: true }).locator('.workspace');
  await remote.locator('[data-workspace-id="ws"]').waitFor();
  assert.equal(await remote.locator('[data-workspace-status]').count(), 3, 'all three states must coexist despite stale idle workspace status');
  for (const [status, count, target] of [['needsInput', 1, 'waiting'], ['running', 3, 'waiting'], ['done', 1, 'answer']] as const) {
    const button = remote.locator(`button[data-workspace-status="${status}"]`);
    assert.match(await button.innerText(), new RegExp(String(count)));
    assert.ok(await button.getAttribute('aria-label'), 'indicator must have an accessible name');
    assert.equal(await button.locator('xpath=ancestor::*[@role="button"]').count(), 0, 'indicator cannot nest in workspace role button');
    await button.click();
    assert.equal(await page.getByTestId('selection').innerText(), `remote:${target}`, 'exact hidden pane on correct machine, not workspace/default pane');
  }
  assert.equal(await remote.getByTestId('background-tasks').innerText(), '6');
  const done = remote.locator('button[data-workspace-status="done"]');
  await done.focus(); await page.keyboard.press('Enter');
  assert.equal(await page.getByTestId('selection').innerText(), 'remote:answer');
  await remote.locator('[data-workspace-id="ws"]').click();
  assert.equal(await page.getByTestId('selection').innerText(), 'remote:workspace');
  await page.getByRole('button', { name: 'Resume waiting pane', exact: true }).click();
  await remote.locator('[data-workspace-status="needsInput"]').waitFor({ state: 'detached' });
  assert.equal(await page.getByTestId('snapshot-state').innerText(), 'idle:6:idle', 'pushed pane status preserves roster and stale workspace status');
  const running = remote.locator('button[data-workspace-status="running"]');
  assert.match(await running.innerText(), /2/);
  await running.focus(); await page.keyboard.press('Space');
  assert.equal(await page.getByTestId('selection').innerText(), 'remote:worker', 'fresh target replaces resumed waiting pane');
  assert.equal(await remote.getByTestId('background-tasks').innerText(), '4');
  await page.setViewportSize({ width: 390, height: 844 });
  await remote.locator('button[data-workspace-status="done"]').click();
  assert.equal(await page.getByTestId('selection').innerText(), 'remote:answer');
  await page.getByRole('button', { name: 'Clear pane states', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-workspace-status]').length === 0);
  assert.equal(await remote.getByTestId('background-tasks').count(), 0);
  assert.equal(await remote.locator('[data-status="blocked"]').count(), 0, 'stale workspace status must not leak through');
  assert.deepEqual(errors, []);
  console.log('PASS workspace status: simultaneous counts, hidden tabs, exact machine/pane routing, keyboard, background badges, stale status');
} finally {
  await browser?.close();
  await vite.close();
}
