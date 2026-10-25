/** Tap Send while a phone IME still composes the last syllable. Needs `bun run build` first. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { workspaceCreate, workspaceClose, paneSendText } from "../server/herdr/client.ts";
import { chromiumExecutable } from "./browser.ts";

const root = mkdtempSync(join(tmpdir(), "termweave-send-composing-"));
const received = join(root, "received.bin");
const ready = join(root, "ready");
const script = join(root, "capture.cjs");
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
writeFileSync(received, "");
writeFileSync(script, `const fs=require('node:fs'); process.stdin.setRawMode(true); process.stdout.write('ready\\r\\n'); fs.writeFileSync(${JSON.stringify(ready)},'ready'); process.stdin.on('data',b=>fs.appendFileSync(${JSON.stringify(received)},b));`);
const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state") });
const browser = await chromium.launch({ executablePath: chromiumExecutable() });
let workspace: string | undefined;
const until = async (condition: () => boolean | Promise<boolean>, label: string) => {
  const deadline = Date.now() + 10_000;
  while (!(await condition())) { assert(Date.now() < deadline, label); await Bun.sleep(50); }
};
try {
  const created = await workspaceCreate({ cwd: root, label: "termweave-test-send-composing" });
  workspace = created.workspace.workspace_id;
  const pane = created.root_pane.pane_id;
  await paneSendText(pane, `exec ${quote(Bun.which("node")!)} ${quote(script)}\r`);
  await until(() => existsSync(ready), "capture process was not ready");
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
  await context.addInitScript((pane) => {
    localStorage.setItem("termweave:settings", JSON.stringify({ language: "en", terminalInputMode: "line" }));
    localStorage.setItem(`termweave:view:${pane}`, "terminal");
  }, pane);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await page.goto(`http://localhost:${server.port}/?pane=${encodeURIComponent(pane)}`);
  const line = page.locator(".terminal-input-text");
  const sendButton = page.locator(".terminal-input-send");
  await line.tap();

  // "가나" committed, "다" still composing: the state a Korean phone keyboard leaves before Send
  await page.keyboard.insertText("가나");
  await cdp.send("Input.imeSetComposition", { text: "다", selectionStart: 1, selectionEnd: 1 });
  await until(async () => (await line.inputValue()) === "가나다", "composition did not reach the line");
  await until(async () => await sendButton.isEnabled(), "send button stayed disabled");
  await sendButton.tap();
  await until(() => readFileSync(received, "utf8") === "가나다\r", `Send during composition did not reach the PTY: ${JSON.stringify(readFileSync(received, "utf8"))}`);
  await until(async () => (await line.inputValue()) === "", "the sent line was not cleared");

  // the next line still works after the commit: no stuck composing flag
  writeFileSync(received, "");
  await page.keyboard.insertText("ls");
  await sendButton.tap();
  await until(() => readFileSync(received, "utf8") === "ls\r", `plain Send failed after composition: ${JSON.stringify(readFileSync(received, "utf8"))}`);
  console.log("PASS terminal send during IME composition");
} finally {
  await browser.close().catch(() => {});
  try {
    server.stop();
  } finally {
    try {
      if (workspace) await workspaceClose(workspace).catch((error) => { if (error?.code !== "workspace_not_found") throw error; });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}
