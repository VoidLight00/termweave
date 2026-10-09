import { chromiumExecutable } from './browser.ts';
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { sessionSnapshot, workspaceCreate, workspaceClose } from "../server/herdr/client.ts";

assert.notEqual(process.env.HERDR_TEST_LIVE, "1");
assert.notEqual(process.env.HERDR_TEST_MODE, "unit");
const { testSocketPath } = await import("./test-herdr.ts");
assert.equal(process.env.HERDR_SOCKET, testSocketPath());
const root = mkdtempSync(join(tmpdir(), "herdr-move-browser-"));
const source = await workspaceCreate({ cwd: root, label: "owned-move-browser-source" });
const target = await workspaceCreate({ cwd: root, label: "owned-move-browser-target" });
const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir: join(root, "state"), token: "", tailscaleOwner: null });
const browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable() });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('console',m=>{if(m.text().startsWith('MOVEDEBUG'))console.log(m.text())});
  page.on('pageerror',e=>console.log('PAGE_ERROR',e.message));
  await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(source.root_pane.pane_id)}&machine=local`);
  const summary = page.getByText("실제 작업공간·탭 이동", { exact: true });
  await summary.waitFor();
  // Open the details through the keyboard rather than a drag gesture.
  await summary.focus();
  await page.keyboard.press("Enter");
  const select = page.getByLabel("실제 이동 대상 작업공간과 탭", { exact: true });
  await select.selectOption(target.root_pane.pane_id);
  const response = page.waitForResponse(response => response.url().endsWith("/pane/move") && response.request().method() === "POST");
  const button = page.getByRole("button", { name: "터미널 이동", exact: true });
  await button.focus();
  await page.keyboard.press("Enter");
  const replied = await response;
  assert.equal(replied.status(), 200);
  const result = await replied.json();
  assert.equal(result.changed, true);
  assert.equal(result.pane.terminal_id, source.root_pane.terminal_id);
  try { await page.locator(`[data-group-id][data-pane-id=${JSON.stringify(result.pane.pane_id)}]`).waitFor({timeout:12000}); }
  catch (e) { console.log('MOVE_STATE',await page.locator('main').innerText()); console.log('MOVE_URL',page.url()); await page.screenshot({path:join(root, 'move-failure.png')}); throw e; }
  const snapshot = await sessionSnapshot();
  assert.equal(snapshot.panes.find(pane => pane.terminal_id === source.root_pane.terminal_id)?.workspace_id, target.workspace.workspace_id);
  const evidence = join(import.meta.dir, "..", "evidence", "pane-move");
  mkdirSync(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, "keyboard-move.png"), fullPage: true });
  console.info("PASS: keyboard move, changed pane ID selection, native snapshot placement");
} finally {
  await browser.close(); server.stop();
  for (const id of [source.workspace.workspace_id, target.workspace.workspace_id]) {
    if ((await sessionSnapshot()).workspaces.some(workspace => workspace.workspace_id === id)) await workspaceClose(id);
  }
  rmSync(root, { recursive: true, force: true });
}
