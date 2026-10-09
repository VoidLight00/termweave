import { chromiumExecutable } from './browser.ts';
/** Real React + browser regressions with controlled HTTP timing. No herdr panes are touched. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const root = mkdtempSync(join(tmpdir(), "herdr-history-browser-"));
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const releases: Array<() => void> = [];
try {
  const build = await Bun.build({ entrypoints: ["scripts/chat-history-fixture.tsx"], outdir: root, target: "browser", define: { "process.env.NODE_ENV": '"development"' } });
  assert.ok(build.success, String(build.logs));
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    const path = new URL(request.url).pathname;
    return path === "/" ? new Response('<html><head><link rel="stylesheet" href="/chat-history-fixture.css"></head><body><div id="root"></div><script type="module" src="/chat-history-fixture.js"></script></body></html>', { headers: { "Content-Type": "text/html" } }) : new Response(Bun.file(join(root, path.slice(1))));
  } });
  browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => { errors.push(error.message); console.error(error.message); });
  let epoch = "one", newest = "old newest", before: string | null = "one:100";
  let holdOlder = false, olderRequested = false;
  const user = (text: string) => ({ role: "user", ts: text, parts: [{ kind: "text", text }] });
  await page.route("**/api/**/conversation?*", async (route) => {
    const url = new URL(route.request().url());
    const captured = epoch;
    const cursor = url.searchParams.get("before") ?? url.searchParams.get("from");
    if (cursor && !cursor.startsWith(`${epoch}:`)) {
      await route.fulfill({ status: 409, json: { error: { code: "history_changed", message: "reload history" } } });
      return;
    }
    if (url.searchParams.has("before")) {
      olderRequested = true;
      if (holdOlder) await new Promise<void>((resolve) => releases.push(resolve));
      await route.fulfill({ json: { source: "omp-transcript", history_id: captured, cursor: null, turns: [user("old earlier")] } });
    } else {
      const tool = { role: "assistant", ts: "reused", parts: [{ kind: "tool", name: "Read", summary: "same", input: "{}", output: "preview", output_ref: "reused", output_size: 9000 }] };
      await route.fulfill({ json: { source: "omp-transcript", history_id: epoch, cursor: before, turns: newest ? [user(newest), tool] : [] } });
    }
  });
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.getByText("old newest", { exact: true }).waitFor();
  const refresh = () => page.evaluate(() => window.qa.refresh());
  const output = page.locator("#output");
  await page.locator("#fetch-output").click();
  assert.equal(await page.evaluate(() => window.qa.requests.length), 1, "duplicate load deduplicated");
  await page.evaluate(() => window.qa.target("/qa-output?pane=b&ref=x", "one"));
  await page.waitForFunction(() => window.qa.requests[0].signal.aborted);
  await page.evaluate(() => window.qa.requests[0].resolve("STALE A"));
  assert.equal(await output.textContent(), "idle:");
  await page.locator("#fetch-output").click();
  await page.evaluate(() => window.qa.requests[1].resolve("B result"));
  await page.waitForFunction(() => document.querySelector("#output")?.textContent === "idle:B result");
  await page.evaluate(() => window.qa.target("/qa-output?pane=b&ref=y", "one"));
  await page.waitForFunction(() => document.querySelector("#output")?.textContent === "idle:");
  await page.locator("#fetch-output").click();
  await page.evaluate(() => window.qa.target("/qa-output?pane=b&ref=y", "two"));
  await page.waitForFunction(() => window.qa.requests[2].signal.aborted);
  await page.evaluate(() => window.qa.requests[2].reject());
  assert.equal(await output.textContent(), "idle:");
  console.log("PASS duplicate requests, pane/ref/history changes, abort, late success and late failure");

  // Start an older-page request, then observe clear before it completes.
  holdOlder = true;
  await page.locator(".chat-older").click();
  while (!olderRequested) await Bun.sleep(20);
  epoch = "two"; newest = ""; before = null;
  await refresh();
  await page.getByText("No conversation yet — say something below", { exact: true }).waitFor();
  releases.splice(0).forEach((release) => release());
  await page.waitForTimeout(100);
  assert.equal(await page.locator(".chat-turn").count(), 0, "late older page cannot revive cleared history");
  assert.equal(await page.locator(".chat-older").count(), 0);
  console.log("PASS clear while earlier page is in flight and empty history before a new prompt");

  newest = "new newest";
  await refresh();
  await page.getByText(newest, { exact: true }).waitFor();
  await page.locator(".work-row-head").click();
  await page.locator(".chat-tool-more").click();
  const requestIndex = await page.evaluate(() => window.qa.requests.length - 1);
  epoch = "three"; newest = "newest after another clear";
  await refresh();
  await page.getByText(newest, { exact: true }).waitFor();
  await page.waitForFunction((i) => window.qa.requests[i].signal.aborted, requestIndex);
  await page.evaluate((i) => window.qa.requests[i].resolve("STALE TOOL OUTPUT"), requestIndex);
  await page.locator(".work-row-head").click();
  assert.equal(await page.getByText("STALE TOOL OUTPUT", { exact: true }).count(), 0);
  assert.equal(await page.locator(".chat-tool-more").count(), 1);
  // A remote PC with the same pane/tool id is a distinct target too.
  await page.locator(".chat-tool-more").click();
  const remoteIndex = await page.evaluate(() => window.qa.requests.length - 1);
  await page.evaluate(() => window.qa.chat("a", "remote-pc"));
  await page.waitForFunction((i) => window.qa.requests[i].signal.aborted, remoteIndex);
  await page.evaluate((i) => window.qa.requests[i].reject(), remoteIndex);
  await page.getByText(newest, { exact: true }).waitFor();
  assert.equal(await page.getByText("Couldn't load the whole output — retry", { exact: true }).count(), 0);
  // Already loaded older history must be discarded when a held cursor gets 409.
  epoch = "four"; newest = "loaded history newest"; before = "four:100"; holdOlder = false;
  await page.evaluate(() => window.qa.chat("b"));
  await page.getByText(newest, { exact: true }).waitFor();
  await page.locator(".chat-older").click();
  await page.getByText("old earlier", { exact: true }).waitFor();
  epoch = "five"; newest = "after held cursor reset"; before = null;
  await refresh();
  await page.getByText(newest, { exact: true }).waitFor();
  assert.equal(await page.getByText("old earlier", { exact: true }).count(), 0);
  assert.equal(await page.locator(".chat-older").count(), 0);

  // A stale cursor discovered by the Earlier button also triggers a fresh poll.
  epoch = "six"; newest = "before older cursor reset"; before = "six:100";
  await refresh();
  await page.getByText(newest, { exact: true }).waitFor();
  epoch = "seven"; newest = "after older cursor reset"; before = null;
  await page.locator(".chat-older").click();
  await page.getByText(newest, { exact: true }).waitFor();
  assert.equal(await page.locator(".chat-older").count(), 0);
  console.log("PASS held-cursor and older-page 409 recovery discard history and immediately reload");
  assert.deepEqual(errors, []);
  console.log("PASS reused tool ids after clear, machine switch and unmount cancellation; no browser errors");
} finally {
  releases.forEach((release) => release());
  await browser?.close();
  server?.stop(true);
  rmSync(root, { recursive: true, force: true });
}
