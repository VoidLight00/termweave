import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

/**
 * In-app alerts on a phone-sized page: real herdr status changes reach the open app, which
 * drops a card for a pane other than the open one (and none for the open one). A tap opens
 * that pane; a flick up puts one away; one left alone goes by itself.
 */
export async function checkDroplet(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-droplet-"));
  const workspaces: string[] = [];
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
  try {
    const panes: string[] = [];
    for (const suffix of ["open", "other"]) {
      const cwd = join(root, suffix);
      mkdirSync(cwd);
      const created = await workspaceCreate({ cwd, label: `herdr-web-ui-test-droplet-${suffix}` });
      workspaces.push(created.workspace.workspace_id);
      panes.push(created.root_pane.pane_id);
    }
    const [openPane, otherPane] = panes as [string, string];
    const report = (pane: string, state: string) => herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state });
    await report(openPane, "idle");
    await report(otherPane, "idle");

    await context.addInitScript(() => {
      // finished turns stay quiet here: putting a pane back to idle between steps reads as one
      if (localStorage.getItem("termweave:settings") === null) localStorage.setItem("termweave:settings", JSON.stringify({ language: "en", alertDone: "off" }));
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/?pane=${encodeURIComponent(openPane)}`);
    await page.locator(".conn-live").waitFor();
    const droplet = page.locator(".droplet");
    const card = page.locator(".droplet-card");
    const selected = () => page.evaluate(() => new URLSearchParams(location.search).get("pane") ?? JSON.parse(sessionStorage.getItem("termweave:selection") ?? localStorage.getItem("termweave:selection") ?? "null")?.pane_id);
    // the app must have seen the pane work before it waits: a wait first seen is no news
    const seen = (pane: string, status: "working" | "blocked") => {
      const indicator = status === "working" ? "running" : "needsInput";
      return page.locator(`.workspace:has(.pane-select[data-workspace-id="${workspaces[panes.indexOf(pane)]}"]) [data-workspace-status="${indicator}"]`).waitFor({ state: "attached" });
    };
    const block = async (pane: string) => {
      await report(pane, "working");
      await seen(pane, "working");
      await report(pane, "blocked");
    };

    // the open pane: the user is looking at it already
    await block(openPane);
    await Bun.sleep(1_200);
    assert.equal(await droplet.count(), 0, "no in-app alert for the pane already open");
    console.log("PASS no in-app alert for the open pane");

    await block(otherPane);
    await card.waitFor({ state: "visible" });
    assert.match((await card.getAttribute("aria-label")) ?? "", /Needs input/);
    assert.equal(await droplet.getAttribute("data-kind"), "blocked");
    // it hangs under the top edge, centred, inside the screen
    await Bun.sleep(1_000);
    const box = (await card.boundingBox())!;
    assert.ok(box.y >= 12 && box.y < 40, `card top ${box.y}`);
    assert.ok(Math.abs(box.x + box.width / 2 - 195) <= 1, `card centre ${box.x + box.width / 2}`);
    assert.ok(box.width <= 390 - 32 && box.width > 300, `card width ${box.width}`);
    if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "droplet-phone.png") });
    await card.tap();
    await droplet.waitFor({ state: "detached" });
    await page.locator(`.pane-select[data-workspace-id="${workspaces[1]}"][aria-current="true"]`).waitFor({ state: "attached", timeout: 5_000 });
    assert.equal(await selected(), otherPane, "a tap opens the pane it is about");
    console.log("PASS an in-app alert drops in for another pane, and a tap opens it");

    // a flick up puts it away, and opens nothing
    await report(openPane, "idle");
    await block(openPane);
    await card.waitFor({ state: "visible", timeout: 5_000 });
    await Bun.sleep(700);
    const flick = (await card.boundingBox())!;
    await page.mouse.move(flick.x + flick.width / 2, flick.y + flick.height / 2);
    await page.mouse.down();
    await page.mouse.move(flick.x + flick.width / 2, flick.y + flick.height / 2 - 40, { steps: 4 });
    await page.mouse.up();
    await droplet.waitFor({ state: "detached", timeout: 2_000 });
    assert.equal(await selected(), otherPane, "a flick up opens nothing");
    console.log("PASS a flick up puts an in-app alert away");

    // left alone, it goes by itself
    await report(openPane, "idle");
    await block(openPane);
    await card.waitFor({ state: "visible" });
    const shown = Date.now();
    await droplet.waitFor({ state: "detached", timeout: 7_000 });
    const lasted = Date.now() - shown;
    assert.ok(lasted > 3_500 && lasted < 6_000, `stayed ${lasted}ms`);
    console.log("PASS an in-app alert goes by itself");

    // turned off in Settings: none
    await page.evaluate(() => {
      const settings = JSON.parse(localStorage.getItem("termweave:settings") ?? "{}");
      localStorage.setItem("termweave:settings", JSON.stringify({ ...settings, alertInApp: false }));
    });
    await page.reload();
    await page.locator(".conn-live").waitFor();
    await report(openPane, "idle");
    await block(openPane);
    await Bun.sleep(1_200);
    assert.equal(await droplet.count(), 0, "no in-app alert when turned off");
    console.log("PASS in-app alerts turned off stay off");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    for (const workspace of workspaces) await workspaceClose(workspace).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}
