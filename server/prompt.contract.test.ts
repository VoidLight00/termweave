import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc } from "./herdr/client.ts";

/**
 * Answers to Claude's unnumbered menus (the folder-trust check among them), against the real
 * herdr server. Each pane runs a small menu under the name `claude`, reported as that agent:
 * ↑/↓ move its `❯` and Enter logs the row it lands on, so the test sees which row an answer
 * from the chat really picked.
 */
const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-prompt-"));
let server: { port: number; stop: () => void };
const workspaces: string[] = [];

const MENU = `
const { appendFileSync, writeFileSync } = require("node:fs");
const [out, spec] = process.argv.slice(2);
const { head, rows, drift } = JSON.parse(spec);
let cursor = 0;
const draw = () => process.stdout.write("\\u001b[2J\\u001b[H" + [
  ...head, "", ...rows.map((row, index) => " " + (index === cursor ? "❯" : " ") + " " + row), "", " Enter to confirm · Esc to cancel",
].join("\\r\\n"));
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  const data = chunk.toString("utf8");
  // drift: a key typed in the pane at the same moment, one more row down
  if (/\\u001b[\\[O]B/.test(data)) cursor = Math.min(rows.length - 1, cursor + 1 + (drift ? 1 : 0));
  if (/\\u001b[\\[O]A/.test(data)) cursor = Math.max(0, cursor - 1);
  if (data.includes("\\r")) appendFileSync(out, rows[cursor] + "\\n");
  draw();
});
draw();
writeFileSync(out, "");
`;

/**
 * A numbered menu under the line an agent keeps showing while it waits: the spinner, the time and
 * the token count move on five times a second. No reader knows the screen, so the card is the
 * fallback one, whose id covers the whole screen. The row's number is its key.
 */
const TICKING = `
const { appendFileSync, writeFileSync } = require("node:fs");
const [out] = process.argv.slice(2);
const frames = ["✢", "✳", "✶", "✻", "✽"];
let tick = 0;
const draw = () => process.stdout.write("\\u001b[2J\\u001b[H" + [
  frames[tick % frames.length] + " Tempering… (" + (55 + tick) + "s · ↓ " + (10 + tick / 10).toFixed(1) + "k tokens)", "",
  "Which environment?", "", "  1. Staging", "  2. Production", "", "Enter a number, or Esc to cancel",
].join("\\r\\n"));
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  const key = chunk.toString("utf8");
  if (key === "1" || key === "2") appendFileSync(out, (key === "1" ? "Staging" : "Production") + "\\n");
});
setInterval(() => { tick += 1; draw(); }, 200);
draw();
writeFileSync(out, "");
`;

interface Menu { pane: string; log: string }
let trust: Menu;
let guessed: Menu;
let drifting: Menu;
let ticking: Menu;

async function menu(label: string, head: string[], rows: string[], drift = false, script = "menu.js"): Promise<Menu> {
  const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
    "workspace.create", { label: `herdr-web-ui-test-prompt-${label}`, cwd: root, focus: false },
  );
  workspaces.push(created.workspace.workspace_id);
  const log = join(root, `${label}.log`);
  const spec = JSON.stringify({ head, rows, drift });
  await herdrRpc("pane.send_text", { pane_id: created.root_pane.pane_id, text: `exec '${join(root, "claude")}' '${join(root, script)}' '${log}' '${spec}'\n` });
  for (let i = 0; i < 200 && !existsSync(log); i++) await Bun.sleep(50);
  expect(existsSync(log)).toBe(true);
  await herdrRpc("pane.report_agent", { pane_id: created.root_pane.pane_id, source: "manual", agent: "claude", state: "blocked" });
  return { pane: created.root_pane.pane_id, log };
}

const base = () => `http://localhost:${server.port}`;
const chosen = (target: Menu) => readFileSync(target.log, "utf8").split("\n").filter(Boolean);

/** the rows confirmed so far, once there is one: the menu logs it after the answer's 200 */
async function confirmed(target: Menu): Promise<string[]> {
  for (let i = 0; i < 40 && chosen(target).length === 0; i++) await Bun.sleep(50);
  return chosen(target);
}

async function card(target: Menu): Promise<{ id: string; kind: string; title: string; question: string; body: string | null; fallback?: true; options: { label: string }[] }> {
  for (let i = 0; i < 100; i++) {
    const { prompt } = await (await fetch(`${base()}/api/pane/prompt?pane_id=${encodeURIComponent(target.pane)}`)).json() as { prompt: any };
    if (prompt) return prompt;
    await Bun.sleep(50);
  }
  throw new Error("no card within 5s");
}

async function answer(target: Menu, promptId: string, optionIndex: number): Promise<Response> {
  return fetch(`${base()}/api/pane/prompt/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pane_id: target.pane, prompt_id: promptId, option_index: optionIndex }),
  });
}

beforeAll(async () => {
  server = createServer({ port: 0, stateDir: join(root, "push") });
  writeFileSync(join(root, "menu.js"), MENU);
  writeFileSync(join(root, "tick.js"), TICKING);
  copyFileSync(process.execPath, join(root, "claude"));
  chmodSync(join(root, "claude"), 0o755);
  trust = await menu("trust", [" Accessing workspace:", "", " Quick safety check: Is this a project you created or one you trust?"], ["No, exit", "Yes, I trust this folder"]);
  // the first row reaches past the rule, the only line off the rows, so the second reads as its wrapped tail
  guessed = await menu("guessed", ["─".repeat(35), " Trust?"], ["Yes, trust and enable all hooks", "Yes, trust this folder", "No, exit"]);
  drifting = await menu("drifting", [" Accessing workspace:", "", " Quick safety check: Is this a project you created or one you trust?"], ["No, exit", "Yes, I trust this folder", "Yes, and enable its hooks"], true);
  ticking = await menu("ticking", [], [], false, "tick.js");
}, 30_000);

afterAll(async () => {
  server?.stop();
  for (const id of workspaces) await herdrRpc("workspace.close", { workspace_id: id }).catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
});

describe("answers to Claude's unnumbered menus", () => {
  it("moves the cursor to the row answered, then confirms it", async () => {
    const prompt = await card(trust);
    expect(prompt.options.map((option) => option.label)).toEqual(["No, exit", "Yes, I trust this folder"]);
    const response = await answer(trust, prompt.id, 1);
    expect(response.status).toBe(200);
    expect(await confirmed(trust)).toEqual(["Yes, I trust this folder"]);
  });

  it("confirms nothing when the cursor lands on a row the card does not show", async () => {
    const prompt = await card(guessed);
    // two rows merged into one: the card's second option is the menu's third row
    expect(prompt.options).toHaveLength(2);
    const response = await answer(guessed, prompt.id, 1);
    expect(response.status).toBe(409);
    await Bun.sleep(300);
    expect(chosen(guessed)).toEqual([]);
  });

  it("confirms nothing when the cursor moved past the row meanwhile", async () => {
    const prompt = await card(drifting);
    const response = await answer(drifting, prompt.id, 1);
    expect(response.status).toBe(409);
    await Bun.sleep(300);
    expect(chosen(drifting)).toEqual([]);
  });

  it("takes an answer to a fallback card whose screen only ticked since it was read", async () => {
    const prompt = await card(ticking);
    expect(prompt.fallback).toBe(true);
    expect(prompt.options.map((option) => option.label)).toEqual(["Staging", "Production", "Enter", "Esc"]);
    // the working line has moved on several times: another time, spinner and token count
    let later = prompt;
    for (let i = 0; i < 40 && later.body === prompt.body; i++) { await Bun.sleep(100); later = await card(ticking); }
    expect(later.body).not.toBe(prompt.body);
    // and it is still the card that was read: the answer tapped on it goes through
    expect(later.id).toBe(prompt.id);
    const response = await answer(ticking, prompt.id, 1);
    expect(response.status).toBe(200);
    expect(await confirmed(ticking)).toEqual(["Production"]);
  });
});

/**
 * pi's dialogs against the real server. A pane runs a menu drawn the way pi draws it, reported
 * as `pi`, and — as measured on pi itself — reported **idle** while it waits: pi never calls
 * itself blocked for a dialog. So this is the case where the card has to come from the reader
 * rather than from the status badge, which is how the other agents' cards are gated.
 */
const PI_MENU = `
const { appendFileSync, writeFileSync } = require("node:fs");
const [out, spec] = process.argv.slice(2);
const { title, rows } = JSON.parse(spec);
let cursor = 0;
const draw = () => process.stdout.write("\\u001b[2J\\u001b[H" + [
  ...Array.from({ length: 10 }, (_, i) => "earlier line " + i), "",
  " " + title, "",
  ...rows.map((row, index) => (index === cursor ? " \\u2192 " : "   ") + row), "",
  " \\u2191\\u2193 navigate  enter select  escape/ctrl+c cancel",
  "\\u2500".repeat(40), "/tmp/app", "0.0%/215k (auto)                                   some-model \\u2022 medium",
].join("\\r\\n"));
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  const data = chunk.toString("utf8");
  if (/\\u001b\\[\\[?B/.test(data)) cursor = Math.min(rows.length - 1, cursor + 1);
  if (/\\u001b\\[\\[?A/.test(data)) cursor = Math.max(0, cursor - 1);
  if (data.includes("\\r")) appendFileSync(out, rows[cursor] + "\\n");
  draw();
});
draw();
writeFileSync(out, "");
`;

async function piMenu(label: string, title: string, rows: string[]): Promise<Menu> {
  const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
    "workspace.create", { label: `herdr-web-ui-test-prompt-${label}`, cwd: root, focus: false },
  );
  workspaces.push(created.workspace.workspace_id);
  const log = join(root, `${label}.log`);
  await herdrRpc("pane.send_text", { pane_id: created.root_pane.pane_id, text: `exec '${join(root, "pi")}' '${join(root, "pi-menu.js")}' '${log}' '${JSON.stringify({ title, rows })}'\n` });
  for (let i = 0; i < 200 && !existsSync(log); i++) await Bun.sleep(50);
  expect(existsSync(log)).toBe(true);
  // pi reports idle while one of its dialogs is open, and the card still has to be offered
  await herdrRpc("pane.report_agent", { pane_id: created.root_pane.pane_id, source: "manual", agent: "pi", state: "idle" });
  return { pane: created.root_pane.pane_id, log };
}

describe("answers to pi's dialogs", () => {
  let select: Menu;
  let confirm: Menu;

  beforeAll(async () => {
    writeFileSync(join(root, "pi-menu.js"), PI_MENU);
    copyFileSync(process.execPath, join(root, "pi"));
    chmodSync(join(root, "pi"), 0o755);
    select = await piMenu("pi-select", "Allow dangerous command?", ["Allow once", "Always allow", "Block"]);
    confirm = await piMenu("pi-confirm", "Clear session?", ["Yes", "No"]);
  }, 30_000);

  it("offers the card while pi reports the pane idle, and answers the row it showed", async () => {
    const prompt = await card(select);
    expect(prompt.question).toBe("Allow dangerous command?");
    expect(prompt.options.map((option) => option.label)).toEqual(["Allow once", "Always allow", "Block"]);
    expect((await answer(select, prompt.id, 2)).status).toBe(200);
    expect(await confirmed(select)).toEqual(["Block"]);
  });

  it("presses No on a confirmation rather than cancelling it", async () => {
    const prompt = await card(confirm);
    expect(prompt.options.map((option) => option.label)).toEqual(["Yes", "No"]);
    expect((await answer(confirm, prompt.id, 1)).status).toBe(200);
    // pi's own Yes/No: pressing the row answers the question false, where Escape leaves it open
    expect(await confirmed(confirm)).toEqual(["No"]);
  });
});
