import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright-core";

/** Duplicate an owned pane's ID on a stand-in remote PC to catch routing by pane ID alone. */
export async function checkNeedsInput(browser: Browser, origin: string, paneId: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  let resumed = false;
  let offline = false;
  try {
    await context.addInitScript(() => {
      if (!localStorage.getItem('termweave:settings')) localStorage.setItem('termweave:settings', JSON.stringify({ language: 'en' }));
      localStorage.setItem("termweave:pc-collapsed:local", "1");
      localStorage.setItem("termweave:pc-collapsed:qa-remote", "1");
    });
    await context.route("**/api/machines/events", (route) => route.abort());
    await context.route("**/api/machines", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const local = body.machines.find((machine: any) => machine.id === "local");
      const pane = local.snapshot.panes.find((pane: any) => pane.pane_id === paneId);
      local.name = "QA host";
      local.snapshot.panes = [{ ...pane, label: "Local waiting", agent: "claude", agent_status: resumed ? "working" : "blocked" }];
      local.snapshot.workspaces = local.snapshot.workspaces.filter((workspace: any) => workspace.workspace_id === pane.workspace_id);
      const remote = { ...local, id: "qa-remote", kind: "ssh", name: "QA remote", state: offline ? "disconnected" : "connected", snapshot: { ...local.snapshot, panes: [{ ...pane, label: "Remote waiting", agent: "codex", agent_status: "blocked" }] } };
      await route.fulfill({ json: { machines: [local, remote] } });
    });
    await context.route("**/api/machines/qa-remote/**", (route) => route.fulfill({ status: 503, json: { error: { code: "qa_remote", message: "Stand-in PC" } } }));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`);
    const group = page.getByRole("region", { name: "Needs you", exact: true });
    await group.getByRole("button", { name: /Local waiting/ }).waitFor();
    assert.equal(await group.getByRole("button").count(), 2);
    assert.equal(await page.locator(".machine-toggle[aria-expanded=false]").count(), 2);
    assert.equal(await page.locator(".machine-list > section:first-of-type").getAttribute("aria-label"), "Needs you");
    await group.getByRole("button", { name: /Remote waiting/ }).click();
    await page.locator(".context .machine-context-name").filter({ hasText: "QA remote" }).waitFor();
    assert.equal(await group.getByRole("button", { name: /Remote waiting/ }).getAttribute("aria-current"), "true");
    assert.equal(await group.getByRole("button", { name: /Local waiting/ }).getAttribute("aria-current"), null);
    await group.getByRole("button", { name: /Local waiting/ }).click();
    await page.locator(".context .machine-context-name").filter({ hasText: "QA host" }).waitFor();
    await page.locator(".conn-live").waitFor();
    if (process.env.UI_EVIDENCE_DIR) {
      mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "needs-input-desktop.png") });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('[aria-controls="workspace-drawer"]').click();
      await group.getByRole("button", { name: /Remote waiting/ }).waitFor();
      await page.waitForFunction(() => (document.getElementById("workspace-drawer")?.getBoundingClientRect().x ?? -1) >= 0);
      await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "needs-input-mobile.png") });
      await group.getByRole("button", { name: /Local waiting/ }).click();
      assert.equal(await page.locator('[aria-controls="workspace-drawer"]').getAttribute("aria-expanded"), "false");
    }
    resumed = true;
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await group.getByRole("button", { name: /Local waiting/ }).waitFor({ state: "detached" });
    offline = true;
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await group.waitFor({ state: "detached" });
    assert.equal(await page.locator('.machine-list > [role="status"]').textContent(), "Panes waiting for input: 0");
    assert.deepEqual(errors, []);
    console.log("PASS Needs you: collapsed PCs, same pane IDs, selection, resume, offline and mobile drawer");
  } finally { await context.close(); }
}
