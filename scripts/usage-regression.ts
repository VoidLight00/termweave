/** The plan meters beside Settings, on a staged report: no real sign-in is read or sent. */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext } from "playwright-core";
import type { UsageReport } from "../shared/protocol.ts";

const at = (hours: number): string => new Date(Date.now() + hours * 3600_000).toISOString();
const REPORT: UsageReport = {
  providers: [
    { id: "claude", key: "claude:u1", account: "me@example.com", plan: "max", problem: null, checked_at: "2026-09-29T12:00:00Z", windows: [
      { kind: "session", scope: null, used_percent: 42, resets_at: at(2.2) },
      { kind: "week", scope: null, used_percent: 63.4, resets_at: at(82) },
      { kind: "week", scope: "Sonnet", used_percent: 5, resets_at: null },
    ] },
    { id: "codex", key: "codex:work", account: "me@work.example", plan: "pro", problem: null, checked_at: "2026-09-29T12:00:00Z", windows: [
      { kind: "session", scope: null, used_percent: 12, resets_at: at(0.8) },
      { kind: "week", scope: null, used_percent: 91, resets_at: at(99) },
    ] },
    { id: "codex", key: "codex:home", account: "me@example.com", plan: "plus", problem: null, checked_at: "2026-09-29T12:00:00Z", windows: [
      { kind: "week", scope: null, used_percent: 30, resets_at: at(120) },
    ] },
    { id: "cursor", key: "cursor:c1", account: null, plan: "pro", problem: null, checked_at: "2026-09-29T12:00:00Z", windows: [{ kind: "month", scope: null, used_percent: 20, resets_at: at(300) }] },
    { id: "copilot", key: "copilot:me", account: "me", plan: "free", problem: null, checked_at: "2026-09-29T12:00:00Z", windows: [{ kind: "month", scope: "Chat", used_percent: 0, resets_at: at(34) }] },
    { id: "grok", key: "grok:g1", account: null, plan: null, problem: "rate_limited", checked_at: "2026-09-29T11:40:00Z", windows: [{ kind: "week", scope: null, used_percent: 0, resets_at: null }] },
    { id: "antigravity", key: "antigravity@keychain", account: null, plan: null, problem: "expired", checked_at: null, windows: [] },
  ],
};

async function staged(context: BrowserContext): Promise<string[]> {
  const asked: string[] = [];
  await context.route("**/api/usage*", (route) => {
    asked.push(new URL(route.request().url()).search);
    return route.fulfill({ json: REPORT });
  });
  return asked;
}

export async function checkUsageMeters(browser: Browser, origin: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    const asked = await staged(context);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin);
    const strip = page.locator(".usage-strip");
    const settingsButton = page.locator(".sidebar-footer-row .sidebar-footer-action");
    const toggle = page.getByRole("switch", { name: "Show plan limits", exact: true });

    // off until chosen: nothing is shown and no sign-in is sent anywhere
    await settingsButton.waitFor();
    assert.equal(await strip.count(), 0);
    assert.deepEqual(asked, [], "no usage request before the user turns it on");
    await settingsButton.click();
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    await toggle.click();
    await page.keyboard.press("Escape");
    await strip.waitFor();

    // three chips and "+4" past four accounts, the one nearest its limit first and red; two Codex accounts apart
    assert.equal(await page.locator(".usage-chip").count(), 3);
    assert.equal(await page.locator(".usage-more").textContent(), "+4");
    assert.equal(await strip.getAttribute("aria-label"),
      "Subscription usage: Codex · me@work.example 91%, Claude · me@example.com 63%, Codex · me@example.com 30%, Cursor 20%, Copilot · me 0%, Grok 0%, Antigravity —");
    assert.equal(await page.locator(".usage-chip").first().evaluate((chip) => chip.classList.contains("is-high")), true);
    assert.equal(await strip.evaluate((el) => el.scrollWidth <= el.clientWidth), true, "the chips fit beside Settings");
    const [settings, meters] = await Promise.all([page.locator(".sidebar-footer-row .sidebar-footer-action").boundingBox(), strip.boundingBox()]);
    assert.ok(settings && meters && settings.x + settings.width <= meters.x, "Settings and the meters do not overlap");

    await strip.click();
    const popover = page.getByRole("dialog", { name: "Subscription usage", exact: true });
    await popover.waitFor();
    assert.equal(await popover.locator(".usage-provider").count(), 7);
    assert.equal(await popover.getByRole("meter").count(), 9);
    assert.equal(await popover.locator(".usage-account").first().textContent(), "me@work.example");
    assert.equal(await popover.locator(".usage-row.is-high").count(), 1);
    assert.equal(await popover.locator(".usage-note.is-problem").count(), 1, "only the expired sign-in reads as an error");
    if (process.env.UI_EVIDENCE_DIR) {
      mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
      await page.locator(".sidebar-shell").screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "usage-popover.png") });
    }
    const refreshed = page.waitForRequest((request) => request.url().endsWith("/api/usage?refresh=1"));
    await popover.getByRole("button", { name: "Refresh", exact: true }).focus();
    await page.keyboard.press('Enter');
    await refreshed;
    await page.keyboard.press("Escape");
    await popover.waitFor({ state: "hidden" });
    assert.equal(await strip.evaluate((el) => el === document.activeElement), true, "Escape hands focus back to the strip");

    // Settings: what is left instead, an account hidden from the strip, another moved up
    const names = () => page.locator(".usage-popover .usage-provider").evaluateAll((sections) => sections.map((section) => section.getAttribute("aria-label")));
    await settingsButton.click();
    await page.getByRole("button", { name: "Remaining", exact: true }).click();
    await page.getByRole("switch", { name: "Show Codex · me@work.example", exact: true }).click();
    await page.getByRole("button", { name: "Move Cursor up", exact: true }).click();
    await page.keyboard.press("Escape");
    assert.equal(await strip.getAttribute("aria-label"),
      "Subscription usage: Claude · me@example.com 37% left, Cursor 80% left, Codex · me@example.com 70% left, Copilot · me 100% left, Grok 100% left, Antigravity —");
    assert.deepEqual(await page.locator(".usage-chip-value").allTextContents(), ["37%", "80%", "70%"]);
    await strip.click();
    assert.deepEqual((await names()).slice(0, 3), ["Claude · me@example.com", "Cursor", "Codex · me@example.com"], "a hidden account is left out of the popover too");
    assert.equal(await popover.locator(".usage-provider").count(), 6);
    assert.equal(await popover.locator(".usage-row-value").first().textContent(), "58% left");
    if (process.env.UI_EVIDENCE_DIR) await page.locator(".sidebar-shell").screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "usage-popover-left.png") });
    await page.keyboard.press("Escape");
    await settingsButton.click();
    if (process.env.UI_EVIDENCE_DIR) {
      await page.locator(".settings-section", { has: page.getByRole("heading", { name: "Subscription usage", exact: true }) }).screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "usage-settings.png") });
    }
    await page.getByRole("button", { name: "Nearest limit first", exact: true }).click();
    await page.keyboard.press("Escape");
    assert.match(await strip.getAttribute("aria-label") ?? "", /^Subscription usage: Claude · me@example.com 37% left, Codex · me@example.com 70% left, Cursor 80% left,/);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("termweave:settings") ?? "{}") as { usageHidden?: string[]; usageCount?: string });
    assert.deepEqual([stored.usageHidden, stored.usageCount], [["codex:work"], "left"]);

    // turned off in Settings: gone, and no longer asked for
    await settingsButton.click();
    await toggle.click();
    await strip.waitFor({ state: "detached" });
    const before = asked.length;
    await page.reload();
    await page.locator(".sidebar-footer").waitFor();
    assert.equal(asked.length, before, "a hidden strip asks for nothing");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }

  // on a phone the popover opens inside the drawer and stays on screen
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: "en-US" });
  try {
    await staged(phone);
    await phone.addInitScript(() => localStorage.setItem("termweave:settings", JSON.stringify({ showUsage: true })));
    const page = await phone.newPage();
    await page.goto(origin);
    await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
    await page.locator(".usage-strip").click();
    const popover = page.getByRole("dialog", { name: "Subscription usage", exact: true });
    await popover.waitFor();
    const box = await popover.boundingBox();
    assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 390, "the popover stays inside the phone's screen");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.UI_EVIDENCE_DIR) await page.locator(".sidebar-shell").screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "usage-popover-phone.png") });

    // Settings on the phone: every account row fits its card, controls included
    await page.keyboard.press("Escape");
    await page.locator(".sidebar-footer-row .sidebar-footer-action").click();
    const accounts = page.locator(".usage-accounts");
    await accounts.scrollIntoViewIfNeeded();
    assert.equal(await accounts.locator(".usage-accounts-row").count(), 7);
    assert.equal(await accounts.evaluate((card) => [...card.querySelectorAll(".usage-accounts-row")].every((row) => row.scrollWidth <= row.clientWidth)), true, "each account row fits the phone");
    if (process.env.UI_EVIDENCE_DIR) {
      await page.locator(".settings-section", { has: page.getByRole("heading", { name: "Subscription usage", exact: true }) }).screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "usage-settings-phone.png") });
    }
  } finally {
    await phone.close();
  }
  console.log("PASS plan meters beside Settings: accounts, order, hiding, used or left, overflow, popover, refresh, Escape, off switch and phone fit");

  // at the top of the list on a phone: one poller, each account told apart, the PCs still in reach
  const top = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: "en-US" });
  try {
    const asked = await staged(top);
    await top.addInitScript(() => localStorage.setItem("termweave:settings", JSON.stringify({ showUsage: true, usagePlacement: "top" })));
    const page = await top.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin);
    await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
    const panel = page.getByRole("region", { name: "Subscription usage", exact: true });
    await panel.waitFor();
    assert.equal(await page.locator(".usage-strip").count(), 0, "the strip beside Settings gives way to the panel");
    assert.equal(asked.length, 1, "only the panel asks for usage");
    const rows = panel.locator(".usage-panel-row");
    assert.equal(await rows.count(), 7);
    assert.match(await rows.nth(0).textContent() ?? "", /me@work\.example/, "two Codex accounts are told apart");
    assert.match(await rows.nth(2).textContent() ?? "", /me@example\.com/);
    assert.equal(await rows.evaluateAll((all) => all.every((row) => row.scrollWidth <= row.clientWidth)), true, "each row fits the phone");
    // a slowed-down or signed-out account says so in its row, as the footer chip dims: not only once opened
    assert.equal(await panel.locator(".usage-panel-row.has-problem").count(), 2);
    assert.deepEqual(await panel.locator(".usage-panel-problem").allTextContents(),
      ["Grok asked to slow down. These are the last numbers.", "Sign-in expired. Open Antigravity to renew it."]);
    assert.equal(await panel.locator(".usage-panel-problem.is-problem").count(), 1, "only the expired sign-in reads as an error");
    assert.equal(await panel.getByRole("button", { name: /Grok asked to slow down.*Sign-in expired\. Open Antigravity/ }).count(), 1, "the reasons are in the rows' accessible name");
    assert.equal(await panel.locator(".usage-panel-row.has-problem .usage-panel-value").first().evaluate((el) => Number(getComputedStyle(el).opacity) < 1), true, "old numbers dim");

    const toggle = panel.locator(".usage-panel-rows");
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    const detail = page.locator(`[id="${await toggle.getAttribute("aria-controls")}"]`);
    assert.equal(await detail.getByRole("meter").count(), 9);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const list = await page.locator(".machine-list").boundingBox();
    assert.ok(list && list.height >= 200, `the PCs keep room under the open panel (${list?.height}px)`);
    if (process.env.UI_EVIDENCE_DIR) {
      mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "usage-panel-phone-open.png") });
    }
    await toggle.click();
    if (process.env.UI_EVIDENCE_DIR) {
      await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "usage-panel-phone.png") });
      // the accounts with a problem sit at the bottom of the panel's scroll
      await panel.evaluate((node) => { node.scrollTop = node.scrollHeight; });
      await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "usage-panel-phone-problems.png") });
    }

    // back beside Settings: the panel stops asking and the strip takes over
    await page.locator(".sidebar-footer-row .sidebar-footer-action").click();
    await page.getByRole("button", { name: "Beside Settings", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.locator(".usage-strip").waitFor();
    assert.equal(await page.locator(".usage-panel").count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await top.close();
  }
  console.log("PASS plan meters at the top of the list: one poller, accounts apart, phone fit, open panel leaves the PCs room, back beside Settings");
}
