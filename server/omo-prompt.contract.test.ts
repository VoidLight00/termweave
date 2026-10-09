import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc } from "./herdr/client.ts";

/**
 * Answers to omo's form of several questions, against the real herdr server. The pane runs a
 * small form drawn as omo 5.1 draws its ask_user_question overlay, reported as `pi` (herdr's name
 * for an omo pane waiting on the user): a number picks an option and moves on, the last answer
 * opens the review, and Enter there submits. Every answer it takes is logged.
 */
const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-omo-prompt-"));
let server: { port: number; stop: () => void };
let workspace: string | undefined;
let pane: string;
const log = join(root, "answers.log");

const FORM = `
const { appendFileSync, writeFileSync } = require("node:fs");
const out = process.argv[2];
const questions = [
  { header: "표시 위치", question: "음성 사용량을 어디에 보여줄까요?", options: ["설정", "사이드바"] },
  { header: "월 한도", question: "월 사용 한도를 둘까요?", options: ["한도 없음", "월 $5 한도"] },
];
const picked = [];
let tab = 0;
const draw = () => {
  const tabs = questions.map((q, i) => (i === tab ? "→ " : "  ") + q.header + (picked[i] === undefined ? "" : " ✓")).join("  ")
    + "  " + (tab === questions.length ? "→ Submit" : "  Submit");
  const count = picked.filter((p) => p !== undefined).length;
  const body = tab < questions.length ? [
    " " + questions[tab].question,
    ...questions[tab].options.map((o, i) => (i === 0 ? " → " : "   ") + (i + 1) + ". " + o + (picked[tab] === i ? " ✓" : "")),
    "   Type your own answer...",
    " Submit (" + count + "/2 answered) — Enter advances",
    " ↑↓ move  1-9 select  space select  enter next  tab next question  c comment  esc cancel",
  ] : [
    " Review your answers",
    ...questions.map((q, i) => "   " + q.header + ": " + q.options[picked[i]]),
    "",
    " Comment (optional; unanswered questions are reported)",
    ">",
    " Submit (" + count + "/2 answered)",
    " enter submit  ↑ review answers  shift+tab back  tab next question  esc back",
  ];
  process.stdout.write("\\u001b[2J\\u001b[H" + ["", " Ask user · 30m", " " + tabs, ...body, "", "─".repeat(60), " ~/project · main"].join("\\r\\n"));
};
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  const data = chunk.toString("utf8");
  if (tab < questions.length && /^[1-9]$/.test(data) && questions[tab].options[Number(data) - 1]) {
    picked[tab] = Number(data) - 1;
    appendFileSync(out, questions[tab].header + "=" + questions[tab].options[picked[tab]] + "\\n");
    tab += 1;
  } else if (tab === questions.length && data.includes("\\r")) appendFileSync(out, "submitted\\n");
  draw();
});
draw();
writeFileSync(out, "");
`;

const base = () => `http://localhost:${server.port}`;
const logged = () => readFileSync(log, "utf8").split("\n").filter(Boolean);

async function card(): Promise<{ id: string; title: string; options: { label: string }[]; steps?: { label: string; answered: boolean; current: boolean }[] }> {
  const { prompt } = await (await fetch(`${base()}/api/pane/prompt?pane_id=${encodeURIComponent(pane)}`)).json() as { prompt: any };
  if (!prompt) throw new Error("no card");
  return prompt;
}

async function answer(promptId: string, optionIndex: number): Promise<Response> {
  return fetch(`${base()}/api/pane/prompt/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pane_id: pane, prompt_id: promptId, option_index: optionIndex }),
  });
}

beforeAll(async () => {
  server = createServer({ port: 0, stateDir: join(root, "push") });
  writeFileSync(join(root, "form.js"), FORM);
  copyFileSync(process.execPath, join(root, "form"));
  chmodSync(join(root, "form"), 0o755);
  const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
    "workspace.create", { label: "herdr-web-ui-test-omo-prompt", cwd: root, focus: false },
  );
  workspace = created.workspace.workspace_id;
  pane = created.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: pane, text: `exec '${join(root, "form")}' '${join(root, "form.js")}' '${log}'\n` });
  for (let i = 0; i < 200 && !existsSync(log); i++) await Bun.sleep(50);
  expect(existsSync(log)).toBe(true);
  await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "pi", state: "blocked" });
}, 30_000);

afterAll(async () => {
  server?.stop();
  if (workspace) await herdrRpc("workspace.close", { workspace_id: workspace }).catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
});

describe("answers to omo's form of several questions", () => {
  it("asks one question at a time, each answer back once the form shows the next step", async () => {
    let prompt: Awaited<ReturnType<typeof card>> | undefined;
    for (let i = 0; i < 100 && !prompt; i++) {
      prompt = await card().catch(() => undefined);
      if (!prompt) await Bun.sleep(50);
    }
    expect(prompt).toMatchObject({ title: "Question 1 of 2", steps: [{ label: "표시 위치", answered: false, current: true }, { label: "월 한도", answered: false, current: false }] });
    expect(prompt!.options.map((option) => option.label)).toEqual(["설정", "사이드바"]);
    expect((await answer(prompt!.id, 1)).status).toBe(200);

    // the answer's 200 comes once the next question shows: read at once, it is that one
    const second = await card();
    expect(second).toMatchObject({ title: "Question 2 of 2", steps: [{ label: "표시 위치", answered: true, current: false }, { label: "월 한도", answered: false, current: true }] });
    expect((await answer(second.id, 0)).status).toBe(200);

    const review = await card();
    expect(review.title).toBe("Review your answers");
    expect(review.options.map((option) => option.label)).toEqual(["Submit", "표시 위치: 사이드바", "월 한도: 한도 없음", "Comment (optional; unanswered questions are reported)"]);
    // an answer to the question just answered is stale
    expect((await answer(second.id, 1)).status).toBe(409);
    expect((await answer(review.id, 0)).status).toBe(200);
    for (let i = 0; i < 40 && !logged().includes("submitted"); i++) await Bun.sleep(50);
    expect(logged()).toEqual(["표시 위치=사이드바", "월 한도=한도 없음", "submitted"]);
  });
});

describe("slash commands of a pane herdr names pi", () => {
  const opened: string[] = [];
  afterAll(async () => {
    for (const id of opened) await herdrRpc("workspace.close", { workspace_id: id }).catch(() => undefined);
  });

  /** a pane herdr names `pi`, running a program of the given name that only waits */
  async function waiting(program: string): Promise<string> {
    const ready = join(root, `${program}.ready`);
    writeFileSync(join(root, "wait.js"), "require('node:fs').writeFileSync(process.argv[2], ''); setInterval(() => {}, 1000);");
    copyFileSync(process.execPath, join(root, program));
    chmodSync(join(root, program), 0o755);
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create", { label: `herdr-web-ui-test-commands-${program}`, cwd: root, focus: false },
    );
    opened.push(created.workspace.workspace_id);
    await herdrRpc("pane.send_text", { pane_id: created.root_pane.pane_id, text: `exec '${join(root, program)}' '${join(root, "wait.js")}' '${ready}'\n` });
    for (let i = 0; i < 200 && !existsSync(ready); i++) await Bun.sleep(50);
    expect(existsSync(ready)).toBe(true);
    await herdrRpc("pane.report_agent", { pane_id: created.root_pane.pane_id, source: "manual", agent: "pi", state: "idle" });
    return created.root_pane.pane_id;
  }
  const names = async (paneId: string) => ((await (await fetch(`${base()}/api/pane/commands?pane_id=${encodeURIComponent(paneId)}`)).json()) as { commands: { name: string }[] }).commands.map((command) => command.name);

  it("offers pi's commands to pi, and none of them to an omo pane that waits under pi's name", async () => {
    expect(await names(await waiting("pi"))).toContain("scoped-models");
    expect(await names(await waiting("omo"))).toEqual([]);
  }, 30_000);
});
