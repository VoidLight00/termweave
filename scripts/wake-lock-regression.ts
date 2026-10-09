/** Exercise the real React lifecycle without depending on the test machine's power policy. */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright-core";

export async function checkWakeLock(browser: Browser, origin: string, paneId: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    await context.route("**/api/access", (route) => route.fulfill({ json: {
      port: 7317,
      tailscale: { state: "running", dns_name: "demo.example.ts.net", serving_url: null, serve_command: "tailscale serve -bg --https=7317 http://127.0.0.1:7317", serve_url: "https://demo.example.ts.net:7317" },
    } }));
    await context.addInitScript(() => {
      if (!localStorage.getItem('termweave:settings')) localStorage.setItem('termweave:settings', JSON.stringify({ language: 'en' }));
      const stats = { requests: 0, releases: 0, refuse: false };
      Object.assign(window, { wakeLockStats: stats });
      Object.defineProperty(navigator, "wakeLock", { configurable: true, value: {
        request: async (type: string) => {
          if (type !== "screen") throw new Error("Only screen locks are allowed");
          stats.requests++;
          if (stats.refuse) throw new DOMException("Refused by browser", "NotAllowedError");
          return { release: async () => { stats.releases++; } };
        },
      } });
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`);
    await page.locator(".conn-live").waitFor();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+Comma" : "Control+Shift+Comma");
    const toggle = page.getByRole("switch", { name: "Keep screen on", exact: true });
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    assert.equal(await page.evaluate(() => (window as any).wakeLockStats.requests), 0);
    await toggle.click();
    await page.waitForFunction(() => (window as any).wakeLockStats.requests === 1);
    if (process.env.UI_EVIDENCE_DIR) {
      mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
      await page.getByRole("heading", { name: "Phone", exact: true }).evaluate((el) => el.scrollIntoView({ block: "start" }));
      await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "keep-screen-on-mobile.png") });
    }

    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForFunction(() => (window as any).wakeLockStats.releases === 1);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForFunction(() => (window as any).wakeLockStats.requests === 2);
    await toggle.click();
    await page.waitForFunction(() => (window as any).wakeLockStats.releases === 2);

    await toggle.click();
    await page.waitForFunction(() => (window as any).wakeLockStats.requests === 3);
    await page.reload();
    await page.waitForFunction(() => (window as any).wakeLockStats.requests === 1);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+Comma" : "Control+Shift+Comma");
    assert.equal(await toggle.getAttribute("aria-checked"), "true", "setting survives a reload");
    await toggle.click();
    await page.waitForFunction(() => (window as any).wakeLockStats.releases === 1);
    await page.evaluate(() => { (window as any).wakeLockStats.refuse = true; });
    await toggle.click();
    await page.waitForFunction(() => (window as any).wakeLockStats.requests === 2);
    await toggle.click();
    await page.evaluate(() => { Object.defineProperty(navigator, "wakeLock", { value: undefined }); });
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-checked"), "true", "unsupported browsers keep the preference without failing");

    // A saved opt-in alone must not acquire a lock when the roster contains no pane.
    await context.route("**/api/machines/events", (route) => route.abort());
    await context.route("**/api/machines", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      for (const machine of body.machines) {
        if (machine.snapshot) machine.snapshot = { ...machine.snapshot, panes: [], workspaces: [], focused_pane_id: null };
      }
      await route.fulfill({ json: body });
    });
    await context.route('**/api/session*', async route => { const response = await route.fetch(); const body = await response.json(); await route.fulfill({ json: { ...body, panes: [], workspaces: [], focused_pane_id: null } }); });
    await page.evaluate(() => { sessionStorage.removeItem('termweave:selection'); localStorage.removeItem('termweave:selection'); });
    await context.routeWebSocket(/\/ws(?:\?|$)/, socket => {
      const upstream = socket.connectToServer();
      upstream.onMessage(raw => { const message = JSON.parse(String(raw)); if (message.type === 'snapshot') { message.panes = []; message.workspaces = []; message.focused_pane_id = null; } socket.send(JSON.stringify(message)); });
      socket.onMessage(raw => upstream.send(raw));
    });
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('.view-switch'));
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+Comma" : "Control+Shift+Comma");
    await toggle.waitFor();
    assert.equal(await toggle.getAttribute("aria-checked"), "true");
    assert.equal(await page.evaluate(() => (window as any).wakeLockStats.requests), 0, "no pane, no screen lock");
    assert.deepEqual(errors, []);
    console.log("PASS screen wake lock: opt-in, hide/return, off, persistence, refusal, unsupported, no pane");
  } finally {
    await context.close();
  }
}
