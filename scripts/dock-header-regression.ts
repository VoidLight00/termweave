import { chromiumExecutable } from "./browser.ts";
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { workspaceCreate, workspaceClose, herdrRpc, sessionSnapshot } from "../server/herdr/client.ts";
import { UsageService } from "../server/usage.ts";

assert.ok(process.env.TERMWEAVE_TEST_ROOT && process.env.HERDR_TEST_SESSION && !process.env.HERDR_TEST_LIVE);
const root = mkdtempSync(join(tmpdir(), "termweave-header-"));
let workspace: string | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof createServer> | undefined;
try {
  const created = await workspaceCreate({ cwd: root, label: "header-owned" });
  workspace = created.workspace.workspace_id;
  const ids = [created.root_pane.pane_id];
  for (let i = 0; i < 4; i++) ids.push((await herdrRpc<{ pane: { pane_id: string } }>("pane.split", {
    target_pane_id: ids[0], direction: "right", cwd: root, focus: false,
  })).pane.pane_id);
  for (const id of ids) await herdrRpc("pane.rename", { pane_id: id, label: `${id} 긴 제목 팀별 작업과 분할 화면 검증 `.repeat(5) });
  const before = await sessionSnapshot();
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: root, usage: new UsageService(undefined, []) });
  browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(({ workspace, ids }) => {
    localStorage.setItem("termweave:settings", JSON.stringify({ language: "ko", terminalInputMode: "direct" }));
    const group = (id: string, tabs: string[]) => ({ kind: "group", id, tabs, active: tabs.at(-1) });
    localStorage.setItem(`termweave:dock:workspace:v3:local:${encodeURIComponent(workspace)}`, JSON.stringify({
      workspace, primary: ids[0], tree: { kind: "split", id: "header-split", axis: "columns", ratio: .5,
        first: group("header-a", ids.slice(0, 4)), second: group("header-b", ids.slice(4)) },
    }));
  }, { workspace, ids });
  await page.goto(`http://127.0.0.1:${server.port}/?pane=${ids[0]}`);
  await page.locator(".conn-live").waitFor();
  await page.locator('[data-group-id="header-a"]').waitFor();
  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => document.documentElement.setAttribute("data-theme", theme), theme);
    for (const width of [1440, 768, 375, 320]) {
      await page.setViewportSize({ width, height: 950 });
      await page.waitForTimeout(150);
      const metrics = await page.locator(".dock-group").evaluateAll(groups => groups.map(group => {
        const header = group.querySelector<HTMLElement>(".dock-tabs")!;
        const strip = group.querySelector<HTMLElement>(".dock-tab-strip")!;
        const active = strip.querySelector<HTMLElement>('[aria-selected="true"]')!;
        const bounds = strip.getBoundingClientRect(), tab = active.getBoundingClientRect();
        return { headerHeight: header.getBoundingClientRect().height, stripHeight: bounds.height,
          visible: tab.left >= bounds.left - 1 && tab.right <= bounds.right + 1 && tab.top >= bounds.top - 1 && tab.bottom <= bounds.bottom + 1,
          overflow: header.scrollWidth > header.clientWidth + 1 };
      }));
      assert.ok(metrics.every(metric => metric.visible), `active tab hidden at ${width}: ${JSON.stringify(metrics)}`);
      assert.ok(metrics.every(metric => !metric.overflow), `header overflow at ${width}`);
      assert.ok(metrics.every(metric => metric.stripHeight === metrics[0]!.stripHeight));
      if (width >= 768) assert.equal(metrics[0]!.headerHeight, metrics[1]!.headerHeight, "split headers must align");
    }
  }
  const touch = await browser.newPage({ viewport: { width: 768, height: 950 }, hasTouch: true });
  await touch.goto(page.url());
  await touch.locator(".conn-live").waitFor();
  assert.ok(await touch.locator('.dock-tab-strip').evaluateAll(strips => strips.every(strip => {
    const bounds = strip.getBoundingClientRect();
    return Array.from(strip.querySelectorAll('button')).every(button => {
      const tab = button.getBoundingClientRect();
      return tab.height >= 44 && tab.top >= bounds.top && tab.bottom <= bounds.bottom;
    });
  })), "touch tabs must fit vertically");
  await touch.close();
  await page.setViewportSize({ width: 1440, height: 950 });
  const first = page.locator('[data-group-id="header-a"]');
  await first.getByRole("tab").first().click();
  await page.waitForTimeout(100);
  assert.equal(await first.locator(".dock-tab-strip").evaluate(strip => strip.scrollLeft), 0);
  await first.getByRole("tab").last().click();
  await page.setViewportSize({ width: 768, height: 950 });
  await page.waitForTimeout(100);
  assert.ok(await first.locator(".dock-tab-strip").evaluate(strip => strip.scrollLeft > 0));
  for (const id of ids.slice(0, 3)) await herdrRpc("pane.rename", { pane_id: id, label: "短" });
  await page.waitForTimeout(300);
  await herdrRpc("pane.rename", { pane_id: ids[0], label: "앞쪽 탭 이름을 길게 바꾼 뒤에도 선택한 탭이 보여야 합니다".repeat(5) });
  await page.waitForTimeout(300);
  assert.ok(await first.locator('.dock-tab-strip').evaluate(strip => {
    const bounds = strip.getBoundingClientRect(), active = strip.querySelector('[aria-selected="true"]')!.getBoundingClientRect();
    return active.left >= bounds.left - 1 && active.right <= bounds.right + 1;
  }), "title changes must reveal the active tab");
  await page.screenshot({ path: process.env.DOCK_HEADER_SCREENSHOT ?? join(root, "header.png") });
  const after = await sessionSnapshot();
  for (const id of ids) {
    const old = before.panes.find(pane => pane.pane_id === id)!;
    const next = after.panes.find(pane => pane.pane_id === id)!;
    for (const key of ["pane_id", "terminal_id", "workspace_id", "tab_id", "cwd"] as const) assert.equal(next[key], old[key]);
  }
  await page.setViewportSize({ width: 1440, height: 950 });
  const sidebar = page.locator('.sidebar');
  if (await sidebar.isVisible()) {
    await sidebar.getByRole('button', { name: '팀 폴더 추가', exact: true }).first().click();
    await sidebar.getByLabel('팀 폴더 이름', { exact: true }).fill('상단 검증팀');
    await sidebar.getByRole('button', { name: '저장', exact: true }).click();
    await sidebar.getByRole('button', { name: '상단 검증팀 안에 팀 폴더 추가', exact: true }).click();
    await sidebar.getByLabel('팀 폴더 이름', { exact: true }).fill('소규모 팀');
    await sidebar.getByRole('button', { name: '저장', exact: true }).click();
    const assignment = sidebar.locator('.team-assignment select').first();
    const folderId = await assignment.locator('option').last().getAttribute('value');
    assert.ok(folderId);
    await assignment.selectOption(folderId);
    await page.reload();
    await page.locator('.conn-live').waitFor();
    assert.equal(await sidebar.locator('.team-folder .team-folder').count(), 1);
    assert.equal(await sidebar.locator('.team-folder .team-folder .team-pane').count(), 1);
  } else throw new Error('Sidebar must be visible for nested team folder check');
  assert.deepEqual(errors, []);
  console.log("PASS dock header: nested folder create and reload, long titles, split alignment, active tab reveal, resize, light/dark, 320/375/768/1440, session identity");
} finally {
  await browser?.close(); server?.stop();
  if (workspace) await workspaceClose(workspace);
  rmSync(root, { recursive: true, force: true });
}
