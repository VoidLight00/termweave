/** Browser UI with a stand-in push service: never sends a notification to a real device. */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright-core";

export async function checkPushSettings(browser: Browser, origin: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ["notifications"] });
  const endpoint = "https://push.example/settings-test";
  let status = 204;
  let release: (() => void) | undefined;
  let hold: Promise<void> | undefined;
  const tests: string[] = [];
  let registrations = 0;
  try {
    await context.addInitScript((endpoint) => {
      localStorage.setItem("termweave:settings", JSON.stringify({ language: "en" }));
      let subscription: object | null = null;
      const pushManager = {
        getSubscription: async () => subscription,
        subscribe: async (options: { applicationServerKey: Uint8Array }) => {
          subscription = {
            endpoint,
            options: { applicationServerKey: options.applicationServerKey.buffer },
            unsubscribe: async () => { subscription = null; return true; },
            toJSON: () => ({ endpoint, keys: { p256dh: "p", auth: "a" } }),
          };
          return subscription;
        },
      };
      Object.defineProperty(navigator.serviceWorker, "ready", { value: Promise.resolve({ pushManager }) });
      Object.defineProperty(navigator.serviceWorker, "getRegistration", { value: async () => ({ pushManager }) });
    }, endpoint);
    await context.route("**/api/push", (route) => route.fulfill({ json: { public_key: Buffer.alloc(65, 4).toString("base64url") } }));
    await context.route("**/api/push/subscribe", (route) => {
      registrations++;
      return route.fulfill({ status: 204 });
    });
    await context.route("**/api/push/test", async (route) => {
      tests.push(route.request().postDataJSON().endpoint);
      await hold;
      await route.fulfill(status === 204 ? { status } : { status, json: { error: { code: status === 404 ? "subscription_not_found" : "push_failed", message: "Test failure" } } });
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin);
    await page.locator(".conn-live").waitFor();
    await page.waitForFunction(() => document.querySelector(".bell-button")?.getAttribute("aria-label") === "Alerts on");
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+Comma" : "Control+Shift+Comma");
    const send = page.getByRole("button", { name: "Send test", exact: true });
    hold = new Promise<void>((resolve) => { release = resolve; });
    await send.click();
    assert.equal(await page.getByRole("button", { name: "Sending…", exact: true }).isDisabled(), true);
    release!();
    hold = undefined;
    await page.getByText("Test notification sent. Check this device for the alert.", { exact: true }).waitFor();
    assert.deepEqual(tests, [endpoint]);
    assert.equal(registrations, 1, "Send test must not repair the registration first");
    if (process.env.UI_EVIDENCE_DIR) {
      mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
      await page.getByRole("heading", { name: "Alerts", exact: true }).evaluate((el) => el.scrollIntoView({ block: "start" }));
      await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "push-test-desktop.png") });
    }

    status = 404;
    await send.click();
    await page.getByText("This device's push subscription is missing. Turn alerts on again.", { exact: true }).waitFor();
    status = 204;
    await page.getByRole("button", { name: "Turn alerts on again", exact: true }).click();
    await page.getByText("Test notification sent. Check this device for the alert.", { exact: true }).waitFor();
    assert.equal(registrations, 2, "explicit recovery registers this device again");

    status = 502;
    await send.click();
    await page.getByText("Could not send the test notification. Try again.", { exact: true }).waitFor();
    assert.equal(await send.isEnabled(), true);
    await page.setViewportSize({ width: 390, height: 844 });
    await send.scrollIntoViewIfNeeded();
    if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "push-test-mobile.png") });
    assert.equal(await page.locator(".settings-dialog").evaluate((el) => el.scrollWidth <= el.clientWidth), true);

    // A browser can lose its local subscription while the server still has the endpoint.
    await page.evaluate(async () => (await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription())?.unsubscribe());
    const beforeMissing = tests.length;
    await send.click();
    await page.getByText("This device's push subscription is missing. Turn alerts on again.", { exact: true }).waitFor();
    assert.equal(tests.length, beforeMissing);

    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    await page.locator(".bell-button").click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+Comma" : "Control+Shift+Comma");
    assert.equal(await send.isDisabled(), true, "testing must not turn alerts on implicitly");
    await page.getByRole("button", { name: "Turn alerts on again", exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log("PASS Settings push test: sent, stale/local missing subscription, recovery, failure, off, mobile layout");
  } finally {
    release?.();
    await context.close();
  }
}
