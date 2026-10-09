import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

/** Settings > Chat > Panes open in: one choice puts every agent pane on that lens, the ones that remembered another included. */
export async function checkDefaultView(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-view-"));
  const workspaces: string[] = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    const panes: string[] = [];
    for (const name of ["one", "two"]) {
      const cwd = join(root, name);
      mkdirSync(cwd);
      const created = await workspaceCreate({ cwd, label: `herdr-web-ui-test-view-${name}` });
      workspaces.push(created.workspace.workspace_id);
      panes.push(created.root_pane.pane_id);
      await herdrRpc("pane.report_agent", { pane_id: created.root_pane.pane_id, source: "manual", agent: "claude", state: "idle" });
    }
    const [one, two] = panes as [string, string];
    await context.addInitScript((pane) => {
      if (localStorage.getItem("termweave:settings") !== null) return;
      localStorage.setItem("termweave:settings", JSON.stringify({ language: "en" }));
      localStorage.setItem(`termweave:view:local:${pane}`, "terminal"); // a pane that remembered the terminal
    }, two);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const lens = () => page.locator(".view-switch button[aria-pressed='true']").getAttribute("title");
    await page.goto(`${origin}/?pane=${encodeURIComponent(one)}`);
    await page.locator(".conn-live").waitFor();
    assert.match((await lens()) ?? "", /^Live terminal/, "a desktop opens an agent pane's terminal by default");

    await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+Comma" : "Control+Shift+Comma");
    await page.getByRole("group", { name: "Panes open in" }).or(page.locator('[aria-label="Panes open in"]')).getByRole("button", { name: "Chat", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector(".view-switch button[aria-pressed='true']")?.getAttribute("title")?.startsWith("Chat transcript") === true);
    await page.locator(`.pane-select[data-workspace-id="${workspaces[1]}"]`).click();
    await page.waitForFunction(() => document.querySelector(".view-switch button[aria-pressed='true']")?.getAttribute("title")?.startsWith("Chat transcript") === true);
    assert.equal(await page.evaluate((pane) => localStorage.getItem(`termweave:view:local:${pane}`), two), null, "what a pane remembered gives way to the choice");
    // a pane switched by hand keeps its lens until the choice changes again
    await page.getByTitle("Live terminal (⌘⇧J)", { exact: true }).click();
    await page.locator(`.pane-select[data-workspace-id="${workspaces[0]}"]`).click();
    await page.locator(`.pane-select[data-workspace-id="${workspaces[1]}"]`).click();
    await page.waitForFunction(() => document.querySelector(".view-switch button[aria-pressed='true']")?.getAttribute("title")?.startsWith("Live terminal") === true);
    assert.deepEqual(errors, []);
    console.log("PASS one choice in Settings opens every agent pane in the chat");
  } finally {
    await context.close();
    for (const workspace of workspaces) await workspaceClose(workspace).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}
