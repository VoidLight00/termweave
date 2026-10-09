import { chromiumExecutable } from './browser.ts';
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { workspaceCreate, workspaceClose } from "../server/herdr/client.ts";
import { UsageService } from "../server/usage.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-split-test-"));
const owned: string[] = [];
const ids: string[] = [];
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  for (let i = 0; i < 4; i++) {
    const created = await workspaceCreate({ cwd: root, label: `split-regression-${i}` });
    owned.push(created.workspace.workspace_id);
    ids.push(created.root_pane.pane_id);
  }
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: root, usage: new UsageService(undefined, []) });
  browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  const inputs: { pane_id: string; text: string }[] = [];
  await page.addInitScript(() => localStorage.setItem("termweave:settings", JSON.stringify({ language: "en", terminalInputMode: "direct" })));
  page.on("pageerror", error => errors.push(error.message));
  page.on("websocket", socket => socket.on("framesent", ({ payload }) => {
    const message = JSON.parse(String(payload));
    if (message.type === "input" || message.type === "submit") inputs.push(message);
  }));
  await page.goto(`http://127.0.0.1:${server.port}/?pane=${ids[0]}`);
  await page.locator(".conn-live").waitFor();
  for (const [label, count] of [["좌우 2분할", 2], ["상하 2분할", 2], ["4분할", 4]] as const) {
    await page.getByRole("button", { name: label, exact: true }).click();
    assert.equal(await page.locator(".split-pane").count(), count);
    const targets = await page.locator(".split-pane").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-pane-id")));
    assert.equal(new Set(targets).size, count);
    const boxes = await page.locator(".split-pane").evaluateAll(nodes => nodes.map(node => {
      const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height };
    }));
    assert.ok(boxes.every(box => box.width > 250 && box.height > 200));
    if (label === "좌우 2분할") assert.ok(boxes[1]!.x > boxes[0]!.x);
    if (label === "상하 2분할") assert.ok(boxes[1]!.y > boxes[0]!.y);
  }
  const targets = await page.locator(".split-pane").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-pane-id")));
  // Type inert comment text without Enter; only test-owned shell panes receive it.
  for (let slot = 0; slot < 4; slot++) {
    const terminal = page.locator(".split-pane").nth(slot);
    await terminal.locator(".xterm-helper-textarea").focus();
    await page.waitForTimeout(500);
    await page.keyboard.type(`#split-check-${slot}`);
    await page.waitForTimeout(150);
    assert.ok(inputs.some(input => input.pane_id === targets[slot]));
    const start = inputs.length;
    await page.keyboard.type(`-${slot}`);
    await page.waitForTimeout(150);
    assert.ok(inputs.slice(start).length > 0);
    assert.ok(inputs.slice(start).every(input => input.pane_id === targets[slot]), "input crossed terminal target");
  }
  // A duplicate option is disabled, and a selected terminal closes cleanly.
  const currentPrimary = await page.locator(".split-pane").first().getAttribute("data-pane-id");
  assert.equal(await page.getByLabel("화면 2 터미널").locator(`option[value="${currentPrimary}"]`).getAttribute("disabled"), "");
  const closed = owned[3]!;
  await workspaceClose(closed);
  owned.splice(3, 1);
  await page.waitForFunction(id => !Array.from(document.querySelectorAll(".split-pane")).some(node => node.getAttribute("data-pane-id") === id), ids[3]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelectorAll(".split-pane").length === 1);
  assert.ok(await page.getByText("휴대폰에서는 한 화면씩 표시합니다.").isVisible());
  assert.ok(await page.getByLabel("화면 1 터미널").isVisible());
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.getByRole("button", { name: "단일", exact: true }).click();
  assert.equal(await page.locator(".split-pane").count(), 1);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const before = (await (await fetch(`http://127.0.0.1:${server.port}/api/session`)).json()).snapshot;
  const current = await page.locator(".split-pane").first().getAttribute("data-pane-id");
  const source = before.panes.find((pane: any) => pane.pane_id === current);
  await page.getByRole("button", { name: "+ 터미널", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".split-pane").length === 2);
  await page.waitForTimeout(500);
  const after = (await (await fetch(`http://127.0.0.1:${server.port}/api/session`)).json()).snapshot;
  const added = after.panes.find((pane: any) => !before.panes.some((old: any) => old.pane_id === pane.pane_id));
  assert.ok(added, "button must create, not select an existing terminal");
  assert.equal(after.workspaces.length, before.workspaces.length);
  assert.equal(added.workspace_id, source.workspace_id);
  assert.equal(added.tab_id, source.tab_id);
  assert.equal(added.cwd, source.foreground_cwd ?? source.cwd);
  const inserted = await page.locator(".split-pane").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-pane-id")));
  assert.deepEqual(inserted, [current, added.pane_id]);
  await page.route("**/api/pane/split", route => route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: { code: "unavailable", message: "test failure" } }) }));
  await page.getByRole("button", { name: "+ 터미널", exact: true }).first().click();
  await page.getByRole("alert").filter({ hasText: "터미널을 추가하지 못했습니다" }).waitFor();
  assert.equal((await (await fetch(`http://127.0.0.1:${server.port}/api/session`)).json()).snapshot.panes.length, after.panes.length);
  assert.deepEqual(errors, []);
  console.log("PASS split browser: layouts, distinct PTYs, independent inputs, phone, add real shell in same workspace/tab/cwd, insertion and failure recovery; page errors=0");
} finally {
  await browser?.close();
  server?.stop(true);
  for (const workspace of owned) await workspaceClose(workspace).catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}
