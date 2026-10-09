import { chromiumExecutable } from './browser.ts';
/** Mobile history regression using a real chat transcript and an owned herdr pane. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-file-back-"));
const codexHome = join(root, "codex-home");
const thread = "01a0c7a1-56d9-7e20-9f08-f7a2d973bc11";
mkdirSync(join(codexHome, "sessions"), { recursive: true });
const transcript = join(codexHome, "sessions", `rollout-2026-09-28T00-00-00-${thread}.jsonl`);
writeFileSync(transcript, [
  { type: "session_meta", payload: { id: thread, cwd: root } },
  { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Show me the demo video." }] } },
  { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: `Open [demo video](./preview.webm) or [notes](./notes.txt) or [file URI notes](${new URL(`file://${join(root, "notes.txt")}`).href}) or [folder](${new URL(`file://${root}`).href}).\n\n${new URL(`file://${join(root, "notes.txt")}`).href}` }] } },
].map((row) => JSON.stringify(row)).join("\n"));
const db = new Database(join(codexHome, "state_5.sqlite"));
db.exec("CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, archived INTEGER, agent_role TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, first_user_message TEXT)");
db.query("INSERT INTO threads VALUES (?, ?, ?, 0, NULL, 1, 1, 'cli', ?)").run(thread, transcript, root, "Show me the demo video.");
db.close();
const standIn = join(root, "codex");
writeFileSync(standIn, "#!/bin/sh\nsleep 600\n");
chmodSync(standIn, 0o755);
copyFileSync(join(import.meta.dir, "fixtures", "file-preview.webm"), join(root, "preview.webm"));
writeFileSync(join(root, "notes.txt"), "File preview history regression\n");
let workspace: string | undefined;
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

try {
  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-file-back" });
  workspace = created.workspace.workspace_id;
  const pane = created.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: pane, text: `${standIn} resume ${thread}\n` });
  for (let attempt = 0; attempt < 100; attempt++) {
    const info = await herdrRpc<{ process_info?: { foreground_processes?: { argv?: string[] }[] } }>("pane.process_info", { pane_id: pane });
    if (info.process_info?.foreground_processes?.some((process) => process.argv?.includes(standIn))) break;
    if (attempt === 99) throw new Error("test Codex process did not start");
    await Bun.sleep(50);
  }
  await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "codex", state: "idle", agent_session_path: transcript });
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), codexHome });
  const origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem("termweave:settings", JSON.stringify({ language: "en" })));
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // A known prior document proves explicit close leaves no invisible preview entry.
  await page.goto(`${origin}/api/health`);
  await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
  await page.locator(".conn-live").waitFor();
  const videoLink = page.getByRole("button", { name: "demo video", exact: true });
  await videoLink.waitFor();
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Keep my mobile draft");
  const chatUrl = page.url();
  await page.evaluate(() => {
    history.replaceState({ ...history.state, testMarker: "preserved" }, "");
    (window as unknown as { testDocument: string }).testDocument = "same-document";
  });
  const baseline = await page.evaluate(() => history.length);
  const preview = page.getByRole("dialog", { name: "preview.webm", exact: true });
  await videoLink.click();
  await preview.locator("video").waitFor();
  await page.waitForFunction(() => (document.querySelector("video")?.readyState ?? 0) >= 1);
  assert.equal(await page.evaluate(() => history.length), baseline + 1);
  if (process.env.UI_EVIDENCE_DIR) {
    mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "mobile-video-open.png") });
  }
  // The Android system Back button uses this same browser history traversal.
  await page.goBack();
  await preview.waitFor({ state: "hidden" });
  assert.equal(page.url(), chatUrl);
  assert.equal(await composer.inputValue(), "Keep my mobile draft");
  assert.equal(await page.evaluate(() => (window as unknown as { testDocument: string }).testDocument), "same-document");
  assert.equal(await page.evaluate(() => history.state.testMarker), "preserved");
  await videoLink.waitFor();
  if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "mobile-back-to-chat.png") });
  console.log("PASS mobile Back closes a playable video and preserves the chat document and draft");

  await page.goForward();
  await preview.waitFor();
  await preview.getByRole("button", { name: "Close file", exact: true }).click();
  await preview.waitFor({ state: "hidden" });
  // Repeated opens must not accumulate extra history entries.
  await videoLink.click();
  await preview.waitFor();
  assert.equal(await page.evaluate(() => history.length), baseline + 1);
  await page.keyboard.press("Escape");
  await preview.waitFor({ state: "hidden" });
  await videoLink.click();
  await preview.waitFor();
  // Mobile previews fill the viewport; the backdrop is exposed on desktop.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator(".file-viewer-scrim").click({ position: { x: 1, y: 1 } });
  await preview.waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 390, height: 844 });
  console.log("PASS Forward restores the viewer; X, Escape and scrim close consume its entry");

  await page.getByRole("button", { name: "notes", exact: true }).click();
  const notes = page.getByRole("dialog", { name: "notes.txt", exact: true });
  await notes.getByText("File preview history regression", { exact: true }).waitFor();
  await page.reload();
  await notes.getByText("File preview history regression", { exact: true }).waitFor();
  await page.goBack();
  await notes.waitFor({ state: "hidden" });
  await videoLink.waitFor();
  await videoLink.click();
  await preview.waitFor();
  await preview.getByRole("button", { name: "Close file", exact: true }).click();
  await preview.waitFor({ state: "hidden" });
  await page.goBack();
  assert.equal(page.url(), `${origin}/api/health`, "no ghost modal entry or back trap after explicit close");
  assert.deepEqual(errors, []);
  console.log("PASS text preview survives reload; closed viewers leave normal Back navigation intact");
  await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
  await page.getByRole("button", { name: "file URI notes", exact: true }).tap();
  await page.locator(".file-viewer-text").waitFor();
  assert.match(await page.locator(".file-viewer-text").innerText(), /File preview history regression/);
  console.log("PASS Chat file URI label opens file content through touch");
  await page.getByRole("button", { name: "Close file", exact: true }).click();
  await page.locator(".file-viewer").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "folder", exact: true }).tap();
  await page.locator(".file-viewer .dir-browser").waitFor();
  await page.locator(".file-viewer .dir-browser").getByRole("button", { name: /notes.txt/ }).tap();
  await page.locator(".file-viewer-text").waitFor();
  assert.match(await page.locator(".file-viewer-text").innerText(), /File preview history regression/);
  console.log("PASS Chat folder URI opens directory browser through touch");
  await page.locator(".file-viewer-header button").click();
  await page.locator(".file-viewer").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: new URL(`file://${join(root, "notes.txt")}`).href, exact: true }).tap();
  await page.locator(".file-viewer-text").waitFor();
  assert.match(await page.locator(".file-viewer-text").innerText(), /File preview history regression/);
  console.log("PASS Chat plain file URI opens content through touch");
} finally {
  await browser?.close();
  server?.stop();
  if (workspace) await workspaceClose(workspace);
  rmSync(root, { recursive: true, force: true });
}
