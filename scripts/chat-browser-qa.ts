import { chromiumExecutable } from './browser.ts';
/** Native transcript -> real HTTP -> React checks on an owned herdr pane.
 * Run after bun run build. No live user's terminal is attached or written. */
import "./test-herdr.ts"; // a herdr session of its own: nothing shows in the user's
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-chat-browser-"));
const codexHome = join(root, "codex");
const rollout = join(codexHome, "sessions", "rollout.jsonl");
const answer = "The conversation is now clean. Native transcript records preserve the user request and final answer while internal instructions stay hidden.";
const records: unknown[] = [];
const add = (payload: unknown, second: number) => records.push({ type: "response_item", timestamp: `2026-09-22T00:00:${String(second).padStart(2, "0")}Z`, payload });
const message = (role: string, text: string, phase?: string) => ({ type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }], ...(phase ? { phase } : {}) });
const persist = () => writeFileSync(rollout, records.map((record) => JSON.stringify(record)).join("\n"));
let workspaceId: string | undefined;
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let release: (() => void) | undefined;

try {
  mkdirSync(join(codexHome, "sessions"), { recursive: true });
  const db = new Database(join(codexHome, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (rollout_path TEXT, cwd TEXT, archived INTEGER, agent_role TEXT, updated_at INTEGER)");
  db.query("INSERT INTO threads VALUES (?, ?, 0, NULL, 1)").run(rollout, root);
  db.close();
  records.push({ type: "session_meta", payload: { id: "01a0c7a1-56d9-7e20-9f08-f7a2d973bcbb", cwd: root } });
  records.push({ type: "turn_context", payload: { model: "codex-test-model", effort: "xhigh" } });
  add(message("developer", "PRIVATE DEVELOPER CONTEXT"), 0);
  add(message("user", "# AGENTS.md instructions for /demo\n<INSTRUCTIONS>PRIVATE PROJECT CONTEXT</INSTRUCTIONS>"), 0);
  add(message("user", "Please check the chat display."), 0);
  add(message("assistant", "I am checking the transcript.", "commentary"), 1);
  add({ type: "function_call", name: "exec_command", call_id: "c1", arguments: '{"cmd":"git status"}' }, 2);
  add({ type: "function_call_output", call_id: "c1", output: "clean" }, 3);
  add(message("assistant", answer, "final_answer"), 8);
  persist();
  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-chat-browser" });
  workspaceId = created.workspace.workspace_id;
  const paneId = created.root_pane.pane_id;
  await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "codex", state: "idle", agent_session_path: rollout });
  await herdrRpc("pane.send_text", { pane_id: paneId, text: `printf '%s\\n' '${answer}'\n` });
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "push"), codexHome });
  browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  // a pane opens its terminal the first time; this QA is about the chat lens
  await page.addInitScript((id) => localStorage.setItem(`termweave:view:${id}`, "chat"), paneId);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(10_000);
  await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(paneId)}`);
  await page.locator(".conn-live").waitFor();
  const log = page.getByRole("log", { name: `conversation of ${paneId}` });
  await log.getByText(answer, { exact: true }).waitFor();
  assert.equal(await log.locator(".chat-turn-user").count(), 1);
  assert.equal((await log.innerText()).includes("PRIVATE"), false);
  const modelInfo = page.getByLabel("Model and reasoning");
  await modelInfo.getByText("codex-test-model", { exact: true }).waitFor();
  await modelInfo.getByText("Reasoning xhigh", { exact: true }).waitFor();
  const work = log.locator(".work-block-head");
  assert.equal(await work.getAttribute("aria-expanded"), "true");
  assert.match(await work.innerText(), /Worked for 7s/);
  await log.getByRole("button", { name: /exec_command/ }).click();
  await log.getByText("git status", { exact: true }).last().waitFor();
  assert.equal(await log.locator(".chat-agent-meta").count(), 1);
  console.log("PASS native user/answer rendering, internal context filtering, tool expansion, duration");

  add(message("user", "A second request."), 20); persist();
  await log.getByText("A second request.", { exact: true }).waitFor();
  assert.equal(await work.getAttribute("aria-expanded"), "false", "old work auto-folds when a new turn arrives");
  await work.click();
  add(message("assistant", "Checking the second request.", "commentary"), 21); persist();
  await log.getByText("Checking the second request.", { exact: true }).waitFor();
  assert.equal(await work.first().getAttribute("aria-expanded"), "true", "manual expansion is preserved");
  assert.equal(await log.locator(".chat-agent-meta").count(), 1, "commentary is not a final answer");
  console.log("PASS old work folds, manual state persists, live commentary stays inside work");

  records.push({ type: "turn_context", payload: { model: "codex-updated-model", effort: "low" } }); persist();
  await modelInfo.getByText("codex-updated-model", { exact: true }).waitFor();
  await modelInfo.getByText("Reasoning low", { exact: true }).waitFor();
  assert.equal(await modelInfo.getByText("codex-test-model", { exact: true }).count(), 0);
  console.log("PASS model and reasoning metadata update without a new message");

  const imagePath = join(root, "native-image.png");
  copyFileSync("public/icons/icon-192.png", imagePath);
  records.push({ type: "event_msg", timestamp: "2026-09-22T00:00:22Z", payload: { type: "user_message", message: "", local_images: [imagePath] } });
  persist();
  const nativeImage = log.locator(".chat-user-images img");
  await nativeImage.waitFor();
  await page.waitForFunction(() => {
    const image = document.querySelector<HTMLImageElement>(".chat-user-images img");
    return image !== null && image.complete && image.naturalWidth > 0;
  });
  assert.equal(await nativeImage.count(), 1);
  console.log("PASS native Codex image-only turn loads its pane-scoped thumbnail");

  const gate = new Promise<void>((resolve) => { release = resolve; });
  let requests = 0;
  await page.route("**/api/pane/conversation?*", async (route) => { requests += 1; await gate; await route.continue(); });
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("true");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.waitForTimeout(250);
  assert.equal(await log.getByText(answer, { exact: true }).count(), 1, "send refresh must not blank existing history");
  const beforeWait = requests;
  await page.waitForTimeout(2500);
  assert.equal(requests, beforeWait, "slow polls must not overlap");
  release();
  await page.unrouteAll({ behavior: "wait" });
  console.log("PASS send refresh preserves history and slow polling does not overlap");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#workspace-drawer").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await log.evaluate((node) => node.scrollWidth <= node.clientWidth), true, "chat contents fit the mobile scroller");
  // the wrapper has no box of its own (display: contents): measure the name and the level themselves
  const statusItems = page.locator(".composer-model, .composer-reasoning");
  assert.equal(await statusItems.evaluateAll((items) => items.length === 2 && items.every((item) => item.getBoundingClientRect().width > 0 && item.getBoundingClientRect().right <= innerWidth)), true, "model and reasoning stay visible on mobile");
  assert.equal(await page.locator(".composer-status").evaluate((node) => node.scrollWidth <= node.clientWidth), true, "the status line fits its one row");
  mkdirSync("evidence/chat-mode", { recursive: true });
  await page.screenshot({ path: "evidence/chat-mode/mobile.png", fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: "evidence/chat-mode/desktop.png", fullPage: true, animations: "disabled" });
  rmSync(rollout);
  const fallback = log.locator(".chat-terminal-fallback");
  await fallback.waitFor();
  await modelInfo.waitFor({ state: "hidden" });
  assert.equal(await fallback.getAttribute("open"), null, "unmatched Codex output stays folded");
  assert.deepEqual(errors, []);
  console.log("PASS mobile layout, explicit collapsed fallback, no browser errors");
} finally {
  release?.();
  await browser?.close();
  server?.stop();
  if (workspaceId) await workspaceClose(workspaceId);
  rmSync(root, { recursive: true, force: true });
}
