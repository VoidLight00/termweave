import { chromiumExecutable } from './browser.ts';
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { createServer } from "../server/index.ts";
import { paneSendText, workspaceCreate, workspaceClose } from "../server/herdr/client.ts";

/** Only owned no-echo fixtures; assert delivery without storing the entered value. */
export async function checkSecretInput(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-secret-ui-"));
  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-secret-ui" });
  const pane = created.root_pane.pane_id;
  const result = join(root, "accepted");
  const script = join(root, "ask.cjs");
  writeFileSync(script, `
const { writeFileSync } = require("node:fs");
process.stdin.setRawMode(true); process.stdin.resume();
let count = 0;
process.stdout.write("\\x1b[2J\\x1b[HPassword:");
process.stdin.on("data", chunk => {
  const text = chunk.toString();
  if (text === "\\x10") { count = 0; process.stdout.write("\\x1b[2J\\x1b[HEnter passphrase for key '/tmp/my private key for testing':"); return; }
  if (text === "\\x03") { count = 0; process.stdout.write("\\r\\nCancelled>"); return; }
  count += text.length;
  if (text.includes("\\r")) { writeFileSync(${JSON.stringify(result)}, String(count)); count = 0; process.stdout.write("\\r\\nAccepted\\r\\nReady>"); }
});
`);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await context.addInitScript((pane) => {
      if (!localStorage.getItem('termweave:settings')) localStorage.setItem('termweave:settings', JSON.stringify({ language: 'en' }));
      localStorage.setItem(`termweave:view:${pane}`, "terminal");
      const Native = window.WebSocket;
      const sockets = new Set<WebSocket>();
      window.WebSocket = class extends Native {
        constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); sockets.add(this); }
      };
      (window as any).dropTestSockets = () => { for (const socket of sockets) socket.close(); };
    }, pane);
    await paneSendText(pane, `exec '${Bun.which("node")}' '${script}'\n`);
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    const sent: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("websocket", (socket) => {
      socket.on("framereceived", ({ payload }) => {
        const frame = JSON.parse(String(payload));
        if (frame.type === "secret-result" && !frame.ok) console.error("Secret fixture refusal:", frame.code);
      });
      socket.on("framesent", ({ payload }) => {
      const frame = JSON.parse(String(payload));
      if (["secret", "submit", "input"].includes(frame.type)) sent.push(frame.type);
      // Never retain payloads in browser-test logs either.
      });
    });
    await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
    const field = page.getByLabel("Password or PIN", { exact: true });
    await field.waitFor();
    assert.equal(await field.getAttribute("type"), "password");
    assert.equal(await page.locator(".terminal-input").count(), 0);
    await field.fill("fixture-secret");
    assert.equal(await field.evaluate((element) => element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true, cancelable: true }))), false);
    assert.equal(await page.locator("body").innerText().then((text) => text.includes("fixture-secret")), false);
    assert.equal(await page.evaluate(() => JSON.stringify({ ...localStorage }).includes("fixture-secret")), false);
    await page.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
    await field.waitFor();
    await page.getByText("Loading conversation…", { exact: true }).waitFor({ state: "hidden" });
    assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).count(), 0);
    if (process.env.UI_EVIDENCE_DIR) {
      mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "secret-input-mobile.png") });
    }
    // A dropped connection must discard the DOM value even if it reconnects before the 1s poll.
    await page.evaluate(() => (window as any).dropTestSockets());
    await page.waitForFunction(() => (document.querySelector('.secret-input input') as HTMLInputElement | null)?.value === "");
    assert.deepEqual(sent, []);
    await field.fill("fixture-secret");
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
      delete (document as any).hidden;
    });
    assert.equal(await field.inputValue(), "");
    await field.fill("fixture-secret");
    await page.locator(".secret-input").getByRole("button", { name: "Send", exact: true }).click();
    await field.waitFor({ state: "detached" });
    const deadline = Date.now() + 5000;
    while (!existsSync(result)) { if (Date.now() > deadline) throw new Error("Masked input never reached fixture"); await Bun.sleep(25); }
    assert.equal(readFileSync(result, "utf8"), String("fixture-secret\r".length));
    assert.deepEqual(sent, ["secret"]);
    assert.equal(await page.evaluate(() => JSON.stringify({ ...localStorage }).includes("fixture-secret")), false);
    assert.equal(await page.locator("body").innerText().then((text) => text.includes("fixture-secret")), false);
    // A new request is empty; Cancel sends only Ctrl+C.
    await paneSendText(pane, "\u0010");
    await field.waitFor();
    assert.equal(await field.inputValue(), "");
    await field.fill("wrapped-secret");
    await page.locator(".secret-input").getByRole("button", { name: "Send", exact: true }).click();
    await field.waitFor({ state: "detached" });
    assert.deepEqual(sent, ["secret", "secret"]);
    await paneSendText(pane, "\u0010");
    await field.waitFor();
    await page.getByTitle("Live terminal (⌘⇧J)", { exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 800 });
    if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "secret-input-desktop.png") });
    await field.fill("discarded-secret");
    await page.locator(".secret-input").getByRole("button", { name: "Cancel", exact: true }).click();
    await field.waitFor({ state: "detached" });
    assert.deepEqual(sent, ["secret", "secret", "input"]);
    assert.deepEqual(errors, []);
    console.log("PASS masked secret input: both lenses, no drafts/queue/echo, disconnect, background and cancel");
  } finally { await context.close(); await workspaceClose(created.workspace.workspace_id); rmSync(root, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const root = mkdtempSync(join(tmpdir(), "herdr-secret-browser-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: root });
  const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true, args: ["--no-sandbox"] });
  try { await checkSecretInput(browser, `http://127.0.0.1:${server.port}`); }
  finally { await browser.close(); server.stop(); rmSync(root, { recursive: true, force: true }); }
}
