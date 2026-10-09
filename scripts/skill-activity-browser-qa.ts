import { chromiumExecutable } from './browser.ts';
/** Native parser fixtures -> real React in Chrome. No live herdr pane is touched. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { parseClaudeTranscript } from "../server/conversation.ts";
import { parseCodexTranscript } from "../server/codex.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-skill-browser-"));
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
const lines = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n");
try {
  const build = await Bun.build({ entrypoints: ["scripts/chat-history-fixture.tsx"], outdir: root, target: "browser", define: { "process.env.NODE_ENV": '"development"' } });
  assert.ok(build.success, String(build.logs));
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    const path = new URL(request.url).pathname;
    return path === "/" ? new Response('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/chat-history-fixture.css"></head><body><div id="root"></div><script type="module" src="/chat-history-fixture.js"></script></body></html>', { headers: { "Content-Type": "text/html" } }) : new Response(Bun.file(join(root, path.slice(1))));
  } });
  const rows: unknown[] = [
    { type: "user", timestamp: "2026-09-27T00:00:00Z", message: { role: "user", content: "Review this change using the project skill." } },
    { type: "assistant", timestamp: "2026-09-27T00:00:01Z", message: { content: [{ type: "tool_use", id: "one", name: "Skill", input: { skill: "team:review" } }] } },
  ];
  let turns = parseClaudeTranscript(lines(rows));
  browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**/conversation?*", (route) => route.fulfill({ json: { source: "claude-transcript", history_id: "fixture", cursor: null, turns } }));
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.getByText("Skill requested", { exact: true }).waitFor();
  assert.equal(await page.locator(".chat-skill").count(), 1);
  await page.locator(".work-block-head").click();
  assert.equal(await page.locator(".work-block-rows").count(), 0);
  assert.equal(await page.locator(".chat-skill-name").textContent(), "team:review");
  rows.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "one", content: "Launching skill" }] } });
  turns = parseClaudeTranscript(lines(rows));
  await page.evaluate(() => window.qa.refresh());
  await page.getByText("Skill invoked", { exact: true }).waitFor();
  assert.equal(await page.locator(".work-block-rows").count(), 0);
  rows.push({ type: "assistant", message: { content: [{ type: "tool_use", id: "two", name: "Skill", input: { skill: "deploy" } }] } }, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "two", content: "Permission denied", is_error: true }] } });
  turns = parseClaudeTranscript(lines(rows));
  await page.evaluate(() => window.qa.refresh());
  await page.getByText("Skill invocation failed", { exact: true }).waitFor();
  assert.equal(await page.locator(".chat-skill.is-error").count(), 1);
  console.log("PASS Claude pending/success/failure updates remain visible with work folded");

  turns = parseCodexTranscript(lines([
    { type: "response_item", payload: { type: "message", role: "user", content: "Check accessibility." } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<skill>\n<name>accessibility-review</name>\n<path>/project/.agents/skills/accessibility-review/SKILL.md</path>\nPRIVATE SKILL BODY\n</skill>" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: "The keyboard flow is ready for review." } },
  ]));
  await page.evaluate(() => window.qa.chat("codex"));
  await page.getByText("Skill instructions loaded", { exact: true }).waitFor();
  assert.equal(await page.locator(".chat-turn-user").count(), 1);
  assert.equal(await page.getByText("PRIVATE SKILL BODY", { exact: true }).count(), 0);
  await page.locator(".chat-skill summary").click();
  await page.getByText("/project/.agents/skills/accessibility-review/SKILL.md", { exact: true }).waitFor();
  mkdirSync("evidence/skill-activity", { recursive: true });
  await page.screenshot({ path: "evidence/skill-activity/desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => localStorage.setItem("termweave:settings", JSON.stringify({ language: "ko", theme: "light" })));
  await page.reload();
  await page.getByText("지침 읽음", { exact: true }).waitFor();
  await page.locator(".chat-skill summary").click();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no horizontal mobile overflow");
  await page.screenshot({ path: "evidence/skill-activity/mobile-ko.png" });
  turns = [];
  await page.evaluate(() => window.qa.chat("empty"));
  await page.waitForFunction(() => document.querySelectorAll(".chat-skill").length === 0);
  assert.deepEqual(errors, []);
  console.log("PASS Codex hidden instructions, expandable provenance, Korean/light/mobile layout and pane reset; no browser errors");
} finally {
  await browser?.close(); server?.stop(true); rmSync(root, { recursive: true, force: true });
}
