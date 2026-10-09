import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";

import { forgetHistoryChains } from "./codex.ts";
import { ConversationUnavailable, gjcTranscriptPath, HistoryChanged, isOmoProcess, ompSessionPath, parseClaudeTranscript, unwrapPastes, transcriptImage, transcriptPage, transcriptToolOutput } from "./conversation.ts";
import { MAX_TURNS, parseOmpTranscript } from "./transcript-records.ts";

/** Minimal but shape-true slices of a Claude Code session jsonl. */
const lines = [
  JSON.stringify({ type: "user", timestamp: "2026-09-19T08:00:00.000Z", message: { role: "user", content: "리팩터링 시작해줘" } }),
  JSON.stringify({ type: "assistant", timestamp: "2026-09-19T08:00:02.000Z", message: { role: "assistant", content: [
    { type: "text", text: "먼저 상태를 확인하겠습니다." },
    { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "git status --short", description: "check tree" } },
  ] } }),
  JSON.stringify({ type: "user", timestamp: "2026-09-19T08:00:03.000Z", message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "toolu_1", content: "M src/app.ts" },
  ] } }),
  JSON.stringify({ type: "assistant", timestamp: "2026-09-19T08:00:05.000Z", message: { role: "assistant", content: [
    { type: "thinking", thinking: "internal reasoning stays private" },
    { type: "text", text: "변경된 파일이 하나입니다." },
  ] } }),
  JSON.stringify({ type: "user", timestamp: "2026-09-19T08:01:00.000Z", message: { role: "user", content: "<command-name>/help</command-name>" } }),
].join("\n");

describe("parseClaudeTranscript", () => {
  it("builds user and merged assistant turns with folded tool results", () => {
    const turns = parseClaudeTranscript(lines);
    expect(turns).toEqual([
      { role: "user", ts: "2026-09-19T08:00:00.000Z", parts: [{ kind: "text", text: "리팩터링 시작해줘" }] },
      { role: "assistant", ts: "2026-09-19T08:00:02.000Z", end_ts: "2026-09-19T08:00:05.000Z", parts: [
        { kind: "text", text: "먼저 상태를 확인하겠습니다." },
        { kind: "tool", name: "Bash", summary: "git status --short", input: expect.stringContaining("git status"), output: "M src/app.ts" },
        { kind: "thinking", text: "internal reasoning stays private" },
        { kind: "text", text: "변경된 파일이 하나입니다." },
      ] },
    ]);
  });

  it("shows a pasted text without Claude Code's paste wrapper, in string and block prompts", () => {
    const pasted = '\n\n<pasted_content id="6d8b">\n| a | b |\n\nsecond paragraph\n</pasted_content id="6d8b">\n';
    const turns = parseClaudeTranscript([
      JSON.stringify({ type: "user", message: { role: "user", content: pasted } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: `look at this${pasted}` }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "typed <\\pasted_content id=\"6d8b\"> stays" } }),
    ].join("\n"));
    expect(turns.map((turn) => turn.parts[0])).toEqual([
      { kind: "text", text: "| a | b |\n\nsecond paragraph" },
      { kind: "text", text: "look at this\n\n| a | b |\n\nsecond paragraph" },
      { kind: "text", text: 'typed <\\pasted_content id="6d8b"> stays' },
    ]);
  });

  it("drops slash-command bookkeeping entries", () => {
    const turns = parseClaudeTranscript(lines);
    expect(turns.some((turn) => turn.parts.some((part) => part.kind === "text" && part.text.includes("/clear")))).toBe(false);
  });

  it("keeps thinking blocks in transcript order", () => {
    const assistant = parseClaudeTranscript(lines)[1];
    expect(assistant?.parts.map((part) => part.kind)).toEqual(["text", "tool", "thinking", "text"]);
  });

  it("survives a torn tail line while Claude is mid-append", () => {
    expect(parseClaudeTranscript(`${lines}\n{"type":"ass`).length).toBe(2);
  });

  it("trims a huge tool result instead of shipping megabytes to the browser", () => {
    const big = [
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [
        { type: "tool_use", id: "t", name: "Read", input: { file_path: "/etc/big" } },
      ] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "t", content: "x".repeat(10_000) },
      ] } }),
    ].join("\n");
    const turns = parseClaudeTranscript(big);
    const tool = turns[0]?.parts[0];
    expect(tool && tool.kind === "tool" ? tool.output.length : 0).toBeLessThanOrEqual(4100);
  });

  it("caps the turn list", () => {
    const many = Array.from({ length: MAX_TURNS + 50 }, (_, i) =>
      JSON.stringify({ type: "user", message: { role: "user", content: `m${i}` } }),
    ).join("\n");
    expect(parseClaudeTranscript(many).length).toBe(MAX_TURNS);
  });

  it("returns nothing for an empty transcript", () => {
    expect(parseClaudeTranscript("")).toEqual([]);
  });

  it("shows a message the person sent while the agent was working", () => {
    const queued = (attachment: Record<string, unknown>) => ({ type: "attachment", timestamp: "2026-10-02T04:00:05.000Z", attachment: { type: "queued_command", timestamp: "2026-10-02T04:00:05.000Z", ...attachment } });
    const transcript = [
      { type: "user", timestamp: "2026-10-02T04:00:00.000Z", message: { role: "user", content: "start" } },
      { type: "assistant", timestamp: "2026-10-02T04:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "working" }] } },
      // the queue pair repeats the text; only the attachment becomes a turn
      { type: "queue-operation", operation: "enqueue", timestamp: "2026-10-02T04:00:05.000Z", content: "also fix the tests" },
      { type: "queue-operation", operation: "remove", timestamp: "2026-10-02T04:00:09.000Z", content: "also fix the tests", reason: "absorbed_mid_turn" },
      queued({ prompt: "also fix the tests", commandMode: "prompt", origin: { kind: "human" }, humanTurn: true }),
      // a background task's notice and another agent's message are not the person's words
      queued({ prompt: "<task-notification>\n<status>completed</status>\n</task-notification>", commandMode: "task-notification" }),
      queued({ prompt: "<agent-message from=\"reviewer\">\ndone\n</agent-message>", commandMode: "prompt", origin: { kind: "peer" }, isMeta: true }),
      { type: "assistant", timestamp: "2026-10-02T04:00:10.000Z", message: { role: "assistant", content: [{ type: "text", text: "on it" }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n");
    expect(parseClaudeTranscript(transcript).map((turn) => [turn.role, turn.ts, turn.parts])).toEqual([
      ["user", "2026-10-02T04:00:00.000Z", [{ kind: "text", text: "start" }]],
      ["assistant", "2026-10-02T04:00:02.000Z", [{ kind: "text", text: "working" }]],
      ["user", "2026-10-02T04:00:05.000Z", [{ kind: "text", text: "also fix the tests" }]],
      ["assistant", "2026-10-02T04:00:10.000Z", [{ kind: "text", text: "on it" }]],
    ]);
  });

  it("preserves array user text, including mixed tool results, without exposing bookkeeping", () => {
    const transcript = [
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Read", input: {} }] } },
      { type: "user", message: { content: [null, { type: "tool_result", tool_use_id: "t", content: "result" }, { type: "text", text: "Actual request" }] } },
      { type: "user", message: { content: [{ type: "text", text: "<command-name>/clear</command-name>" }] } },
      { type: "user", isMeta: true, message: { content: "internal reminder" } },
      { type: "user", isCompactSummary: true, message: { content: "compacted context" } },
      null,
    ].map((entry) => JSON.stringify(entry)).join("\n");
    const turns = parseClaudeTranscript(transcript);
    // the compaction is no bookkeeping: it marks where the conversation was folded
    expect(turns).toHaveLength(3);
    expect(turns[0]?.parts[0]).toMatchObject({ kind: "tool", output: "result" });
    expect(turns[1]?.parts).toEqual([{ kind: "text", text: "Actual request" }]);
    expect(turns[2]?.parts).toEqual([{ kind: "compact", text: "compacted context" }]);
  });
});

/** Minimal but shape-true slices of an omp session jsonl. */
const ompLines = [
  JSON.stringify({ type: "title", v: 1, title: "프로젝트 불편사항 패치" }),
  JSON.stringify({ type: "session", version: 3, id: "01a0bdf7-b9e3-72bb-bad1-671dde7082f8" }),
  JSON.stringify({ type: "message", timestamp: "2026-09-20T08:39:00.000Z", message: { role: "user", attribution: "user", content: [
    { type: "text", text: "주소좀 줘봐" },
  ] } }),
  JSON.stringify({ type: "message", timestamp: "2026-09-20T08:39:02.000Z", message: { role: "assistant", content: [
    { type: "thinking", text: "internal reasoning stays private" },
    { type: "thinking", thinking: "alternate thinking field" },
    { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ss -tlnp", i: "Checking ports" }, intent: "Checking ports" },
  ] } }),
  JSON.stringify({ type: "message", timestamp: "2026-09-20T08:39:03.000Z", message: { role: "toolResult", toolCallId: "call_1", toolName: "bash", isError: false, content: [
    { type: "text", text: "LISTEN 0 512 100.123.228.51:7317" },
  ] } }),
  JSON.stringify({ type: "message", timestamp: "2026-09-20T08:39:05.000Z", message: { role: "assistant", content: [
    { type: "text", text: "http://100.123.228.51:7317" },
  ] } }),
  JSON.stringify({ type: "message", timestamp: "2026-09-20T08:40:00.000Z", message: { role: "user", content: [
    { type: "image", blob: "..." },
  ] } }),
].join("\n");

describe("parseOmpTranscript", () => {
  it("builds user and merged assistant turns with folded tool results", () => {
    const turns = parseOmpTranscript(ompLines);
    expect(turns).toEqual([
      { role: "user", ts: "2026-09-20T08:39:00.000Z", parts: [{ kind: "text", text: "주소좀 줘봐" }] },
      { role: "assistant", ts: "2026-09-20T08:39:02.000Z", end_ts: "2026-09-20T08:39:05.000Z", parts: [
        { kind: "thinking", text: "internal reasoning stays private" },
        { kind: "thinking", text: "alternate thinking field" },
        { kind: "tool", name: "bash", summary: "Checking ports", input: expect.stringContaining("ss -tlnp"), output: "LISTEN 0 512 100.123.228.51:7317" },
        { kind: "text", text: "http://100.123.228.51:7317" },
      ] },
    ]);
  });

  it("keeps thinking parts while ignoring title/session headers", () => {
    const rendered = JSON.stringify(parseOmpTranscript(ompLines));
    expect(rendered).toContain("\"kind\":\"thinking\",\"text\":\"internal reasoning stays private\"");
    expect(rendered).toContain("\"kind\":\"thinking\",\"text\":\"alternate thinking field\"");
    expect(rendered).not.toContain("프로젝트 불편사항 패치");
  });

  it("skips an image-only user part instead of an empty turn", () => {
    const turns = parseOmpTranscript(ompLines);
    expect(turns.filter((turn) => turn.role === "user")).toHaveLength(1);
  });

  it("falls back to the first interesting argument when a toolCall has no intent", () => {
    const noIntent = [
      JSON.stringify({ type: "message", message: { role: "assistant", content: [
        { type: "toolCall", id: "c", name: "read", arguments: { file_path: "/tmp/x" } },
      ] } }),
    ].join("\n");
    const tool = parseOmpTranscript(noIntent)[0]?.parts[0];
    expect(tool && tool.kind === "tool" ? tool.summary : "").toBe("/tmp/x");
  });

  it("survives a torn tail line while omp is mid-append", () => {
    expect(parseOmpTranscript(`${ompLines}\n{"type":"mess`).length).toBe(2);
  });

  it("trims a huge tool result and caps the turn list", () => {
    const big = [
      JSON.stringify({ type: "message", message: { role: "assistant", content: [
        { type: "toolCall", id: "t", name: "bash", arguments: { command: "cat /etc/big" } },
      ] } }),
      JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "t", content: [
        { type: "text", text: "x".repeat(10_000) },
      ] } }),
    ].join("\n");
    const tool = parseOmpTranscript(big)[0]?.parts[0];
    expect(tool && tool.kind === "tool" ? tool.output.length : 0).toBeLessThanOrEqual(4100);

    const many = Array.from({ length: MAX_TURNS + 50 }, (_, i) =>
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: `m${i}` }] } }),
    ).join("\n");
    expect(parseOmpTranscript(many).length).toBe(MAX_TURNS);
  });
});

describe("omo transcript resolution", () => {
  it("recognizes omo from a pane's foreground processes, not from herdr's label", () => {
    // argv exactly as herdr's pane.process_info reported them for an omo pane
    expect(isOmoProcess(["node", "/home/u/.nvm/versions/node/v24.18.0/bin/omo"])).toBeTrue(); // leakscan:allow: test fixture
    expect(isOmoProcess(["bun", "/home/u/lib/node_modules/omo-ai/bin/omo.js"])).toBeTrue(); // leakscan:allow: test fixture
    expect(isOmoProcess(["bun", "/home/u/lib/node_modules/omo-ai/node_modules/@code-yeongyu/senpi/dist/bundle/cli.js", "--extension", "/home/u/lib/node_modules/omo-ai/plugin"])).toBeTrue(); // leakscan:allow: test fixture
    // the pane herdr labels `claude` because of omo's child still names omo
    expect(isOmoProcess(["/home/u/lib/node_modules/omo-ai/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude", "--output-format", "stream-json"])).toBeTrue(); // leakscan:allow: test fixture

    expect(isOmoProcess(["/home/u/.local/bin/claude"])).toBeFalse(); // leakscan:allow: test fixture
    expect(isOmoProcess(["omp"])).toBeFalse();
    expect(isOmoProcess(["node", "/home/u/omo-tools/watch.js"])).toBeFalse(); // leakscan:allow: test fixture
    // a shell rc file printing a PATH that has omo-ai's bin directory in it
    expect(isOmoProcess(["printf", "%s\\n", "/home/u/.local/bin:/home/u/lib/node_modules/omo-ai/node_modules/.bin:/usr/bin"])).toBeFalse(); // leakscan:allow: test fixture
    expect(isOmoProcess(["printf", "%s\\n", "/usr/bin:/home/u/.nvm/versions/node/v24.18.0/bin/omo"])).toBeFalse(); // leakscan:allow: test fixture
  });
});

describe("omp session path", () => {
  it("accepts the path herdr reports only inside the user's own store", () => {
    const home = "/home/u", store = "/home/u/.omp/agent/sessions"; // leakscan:allow: test fixture
    expect(ompSessionPath(`${store}/project/session.jsonl`, home)).toBe(`${store}/project/session.jsonl`);
    expect(ompSessionPath(`${store}-evil/project/session.jsonl`, home)).toBeNull();
    expect(ompSessionPath(`${store}/../../../../etc/session.jsonl`, home)).toBeNull();
    expect(ompSessionPath(`${store}/project/notes.txt`, home)).toBeNull();
    expect(ompSessionPath(".omp/agent/sessions/project/session.jsonl", home)).toBeNull();
    expect(ompSessionPath(undefined, home)).toBeNull();
  });

  it("accepts a Windows PC's native path, and refuses the same ways out", () => {
    const home = "C:\\Users\\u", store = "C:\\Users\\u\\.omp\\agent\\sessions";
    const session = `${store}\\project\\session.jsonl`;
    expect(ompSessionPath(session, home, win32)).toBe(session);
    expect(ompSessionPath(session.replaceAll("\\", "/"), home, win32)).toBe(session.replaceAll("\\", "/"));
    expect(ompSessionPath(`${store}-evil\\project\\session.jsonl`, home, win32)).toBeNull();
    expect(ompSessionPath(`${store}\\..\\sessions-evil\\session.jsonl`, home, win32)).toBeNull();
    expect(ompSessionPath(`${store}\\project\\..\\..\\..\\..\\session.jsonl`, home, win32)).toBeNull();
    expect(ompSessionPath(`D:${session.slice(2)}`, home, win32)).toBeNull();
    expect(ompSessionPath(`\\\\server\\share\\.omp\\agent\\sessions\\session.jsonl`, home, win32)).toBeNull();
    expect(ompSessionPath(`${store}\\project\\notes.txt`, home, win32)).toBeNull();
  });
});

describe("gjc sessions", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  const session = (dir: string, name: string, cwd: string, mtime: string) => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, `${JSON.stringify({ type: "session", version: 5, cwd })}\n`);
    utimesSync(path, new Date(mtime), new Date(mtime));
    return path;
  };

  it("does not infer a session from cwd, even if there is only one file", async () => {
    const home = mkdtempSync(join(tmpdir(), "herdr-gjc-")); roots.push(home);
    const dir = join(home, ".gjc", "agent", "sessions", "v2-abc");
    session(dir, "only.jsonl", "/home/u/project", "2026-09-20T00:00:00.000Z"); // leakscan:allow: test fixture
    writeFileSync(join(dir, ".gjc-managed-session-scope.v2.json"), JSON.stringify({ canonicalPath: "/home/u/project" })); // leakscan:allow: test fixture
    await expect(gjcTranscriptPath("w9999:p9999", "/home/u/project", home)).rejects.toThrow(ConversationUnavailable); // leakscan:allow: test fixture
  });

  it("shows a failed request's error instead of an empty answer", () => {
    const text = [
      JSON.stringify({ type: "message", timestamp: "2026-09-25T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
      JSON.stringify({ type: "message", timestamp: "2026-09-25T00:00:01.000Z", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "401 Authentication Failed" } }),
    ].join("\n");
    expect(parseOmpTranscript(text).at(-1)?.parts).toEqual([{ kind: "text", text: "Error: 401 Authentication Failed" }]);
  });

  it("ends a turn at a background result gjc delivers, so the answer before it stays the answer", () => {
    const assistant = (ts: string, text: string) => JSON.stringify({ type: "message", timestamp: ts, message: { role: "assistant", content: [{ type: "text", text }] } });
    const text = [
      JSON.stringify({ type: "message", timestamp: "2026-10-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "run it in the background" }] } }),
      assistant("2026-10-01T00:00:01.000Z", "Started; here is the summary."),
      JSON.stringify({ type: "custom_message", customType: "async-result", display: true, timestamp: "2026-10-01T00:05:00.000Z", content: "<system-notice>\nBackground job bg_1 has completed.\nPASS all\n</system-notice>" }),
      assistant("2026-10-01T00:05:02.000Z", "CI is green."),
      JSON.stringify({ type: "custom_message", customType: "async-result", display: false, timestamp: "2026-10-01T00:06:00.000Z", content: "<system-notice>hidden</system-notice>" }),
      JSON.stringify({ type: "custom", customType: "workflow-intent-diff", data: { route: "direct" } }),
      assistant("2026-10-01T00:06:01.000Z", "Still green."),
    ].join("\n");
    expect(parseOmpTranscript(text)).toEqual([
      { role: "user", ts: "2026-10-01T00:00:00.000Z", parts: [{ kind: "text", text: "run it in the background" }] },
      { role: "assistant", ts: "2026-10-01T00:00:01.000Z", end_ts: "2026-10-01T00:00:01.000Z", parts: [{ kind: "text", text: "Started; here is the summary." }] },
      { role: "user", ts: "2026-10-01T00:05:00.000Z", parts: [{ kind: "notice", text: "Background job bg_1 has completed.\nPASS all" }] },
      { role: "assistant", ts: "2026-10-01T00:05:02.000Z", end_ts: "2026-10-01T00:06:01.000Z", parts: [{ kind: "text", text: "CI is green." }, { kind: "text", text: "Still green." }] },
    ]);
  });
});

describe("transcript pages", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  const temp = (): string => { const root = mkdtempSync(join(tmpdir(), "herdr-pages-")); roots.push(root); return root; };
  /** a prompt, a tool call and its result: the result answers the turn, never the next page */
  const claudeTurn = (n: number) => [
    { type: "user", timestamp: `2026-09-23T00:00:${String(n % 60).padStart(2, "0")}.000Z`, message: { role: "user", content: `prompt ${n}` } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `t${n}`, name: "Bash", input: { command: `echo ${n}` } }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${n}`, content: `out ${n}` }] } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `answer ${n}` }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n");
  const texts = (turns: { parts: { kind: string; text?: string; output?: string }[] }[]) =>
    turns.map((turn) => turn.parts.map((part) => part.kind === "tool" ? `[${part.output}]` : part.text).join(" "));

  it("reads a growing file's newest page incrementally, exactly as a cold read of it", () => {
    const root = temp();
    const path = join(root, "session.jsonl");
    const whole = Buffer.from(`${Array.from({ length: 80 }, (_, n) => claudeTurn(n)).join("\n")}\n`);
    writeFileSync(path, whole.subarray(0, 1000));
    // appends of every size, cut mid-line too, including one that ends the file without a newline
    for (let at = 1000, step = 1; at < whole.length; step = (step * 7) % 997 + 1) {
      appendFileSync(path, whole.subarray(at, at + step * 23));
      at += step * 23;
      const cold = join(root, `cold-${at}.jsonl`);
      copyFileSync(path, cold);
      const live = transcriptPage("claude-transcript", path);
      const reference = transcriptPage("claude-transcript", cold);
      rmSync(cold);
      expect(texts(live.turns)).toEqual(texts(reference.turns));
      expect(live.metadata).toEqual(reference.metadata);
      expect(live.cursor?.split(":").at(-1)).toBe(reference.cursor?.split(":").at(-1));
    }
  });

  it("pages back through a long conversation without gaps, overlaps or split turns", () => {
    const path = join(temp(), "session.jsonl");
    const whole = Array.from({ length: 120 }, (_, n) => claudeTurn(n)).join("\n");
    writeFileSync(path, `${whole}\n`);

    const newest = transcriptPage("claude-transcript", path);
    expect(newest.turns).toHaveLength(MAX_TURNS);
    expect(texts(newest.turns)[0]).toBe("prompt 70");
    expect(newest.cursor).not.toBeNull();
    const middle = transcriptPage("claude-transcript", path, { before: newest.cursor! });
    expect(texts(middle.turns)[0]).toBe("prompt 20");
    const first = transcriptPage("claude-transcript", path, { before: middle.cursor! });
    expect(first.cursor).toBeNull();
    expect(texts([...first.turns, ...middle.turns, ...newest.turns])).toEqual(texts(parseClaudeTranscript(whole, Infinity)));
    expect(texts(middle.turns).at(-1)).toBe("[out 69] answer 69");
  });

  it("keeps a held start while it is inside the newest page, then fills the turns it moved past a page at a time", () => {
    const path = join(temp(), "session.jsonl");
    writeFileSync(path, `${Array.from({ length: 60 }, (_, n) => claudeTurn(n)).join("\n")}\n`);
    const held = transcriptPage("claude-transcript", path).cursor!;
    // while the last turn grows, the held start (prompt 10) is still inside the newest page
    const more = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "still working" }] } });
    writeFileSync(path, `${Array.from({ length: 60 }, (_, n) => claudeTurn(n)).join("\n")}\n${more}\n`);
    const growing = transcriptPage("claude-transcript", path, { from: held });
    expect(growing.cursor).toBe(held);
    expect(texts(growing.turns).at(-1)).toBe("[out 59] answer 59 still working");
    writeFileSync(path, `${Array.from({ length: 70 }, (_, n) => claudeTurn(n)).join("\n")}\n`);
    // the newest page slid past it: the answer is the newest page, never more than a page
    const newest = transcriptPage("claude-transcript", path, { from: held });
    expect(newest.cursor).not.toBe(held);
    expect(texts(newest.turns)[0]).toBe("prompt 20");
    // the turns in between come from `before` the newest page, `since` the held start
    const gap = transcriptPage("claude-transcript", path, { before: newest.cursor!, since: held });
    expect(gap.cursor).toBe(held);
    expect(texts(gap.turns)[0]).toBe("prompt 10");
    expect(texts(gap.turns).at(-1)).toBe("[out 19] answer 19");
    for (const cursor of ["another-file:10", `${held.split(":")[0]}:999999999`, "garbage"]) {
      expect(() => transcriptPage("claude-transcript", path, { before: cursor })).toThrow(HistoryChanged);
    }
    expect(() => transcriptPage("claude-transcript", path, { before: held, since: newest.cursor! })).toThrow(HistoryChanged);
  });

  it("reads one window for the newest page even when no turn starts in it; an older page reaches the turn's start", () => {
    const path = join(temp(), "session.jsonl");
    const prompt = JSON.stringify({ type: "user", message: { role: "user", content: "run the long job" } });
    // one turn of 20MB of tool output: no turn starts in the newest window
    const output = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "y".repeat(1024 * 1024) }] } });
    writeFileSync(path, `${claudeTurn(0)}\n${prompt}\n${Array.from({ length: 20 }, () => output).join("\n")}\n`);
    const size = Buffer.byteLength(`${claudeTurn(0)}\n${prompt}\n`) + 20 * (Buffer.byteLength(output) + 1);
    const newest = transcriptPage("claude-transcript", path);
    const start = Number(newest.cursor!.split(":").at(-1));
    expect(size - start).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(newest.turns.every((turn) => turn.role === "assistant")).toBe(true);
    const older = transcriptPage("claude-transcript", path, { before: newest.cursor! });
    expect(texts(older.turns).slice(0, 3)).toEqual(["prompt 0", "[out 0] answer 0", "run the long job"]);
  });

  it("refuses a cursor once the rollouts before the live file change, instead of pointing at other turns", () => {
    const home = join(temp(), "codex");
    const thread = "01a0a337-19e8-7712-92f5-aa0883392afd";
    const task = (n: number) => [
      { type: "event_msg", timestamp: "2026-09-23T00:00:00.000Z", payload: { type: "task_started" } },
      { type: "response_item", timestamp: "2026-09-23T00:00:00.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `prompt ${n}` }] } },
      { type: "response_item", timestamp: "2026-09-23T00:00:01.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `answer ${n}` }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n");
    const meta = (extra = {}) => JSON.stringify({ type: "session_meta", payload: { source: "cli", thread_source: "user", ...extra } });
    mkdirSync(join(home, "sessions", "2026", "09", "15"), { recursive: true });
    mkdirSync(join(home, "sessions", "2026", "09", "23"), { recursive: true });
    const kept = `${meta()}\n${Array.from({ length: 20 }, (_, n) => task(n)).join("\n")}\n`;
    const segment = join(home, "sessions", "2026", "09", "23", `rollout-2026-09-23T10-46-43-${thread}_01a0cbf1-9b0e-7383-a345-80974b279c68.jsonl`);
    writeFileSync(segment, `${meta({ history_base: { thread_id: thread, end_ordinal_exclusive: kept.split("\n").length - 1, end_byte_offset: Buffer.byteLength(kept) } })}\n${Array.from({ length: 60 }, (_, n) => task(20 + n)).join("\n")}\n`);
    // the earlier rollout is not there yet: the chain stops at the segment
    forgetHistoryChains();
    const newest = transcriptPage("codex-transcript", segment, {}, home);
    const older = transcriptPage("codex-transcript", segment, { before: newest.cursor! }, home);
    expect(texts(older.turns)[0]).toBe("prompt 20");
    // it appears: positions now count from its start, and the old cursors name another chain
    writeFileSync(join(home, "sessions", "2026", "09", "15", `rollout-2026-09-15T12-58-12-${thread}.jsonl`), kept);
    forgetHistoryChains();
    expect(() => transcriptPage("codex-transcript", segment, { before: newest.cursor! }, home)).toThrow(HistoryChanged);
    expect(() => transcriptPage("codex-transcript", segment, { from: newest.cursor! }, home)).toThrow(HistoryChanged);
    // read afresh, the pages reach the earlier rollout
    const again = transcriptPage("codex-transcript", segment, {}, home);
    const all = [...transcriptPage("codex-transcript", segment, { before: again.cursor! }, home).turns, ...again.turns];
    expect(texts(all)[0]).toBe("prompt 0");
  });

  it("looks a remembered chain up again once a rollout in it is archived, instead of failing every read", () => {
    const home = join(temp(), "codex");
    const thread = "01a0a337-19e8-7712-92f5-aa0883392afd";
    const task = (n: number) => [
      { type: "event_msg", timestamp: "2026-09-23T00:00:00.000Z", payload: { type: "task_started" } },
      { type: "response_item", timestamp: "2026-09-23T00:00:00.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `prompt ${n}` }] } },
      { type: "response_item", timestamp: "2026-09-23T00:00:01.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `answer ${n}` }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n");
    const meta = (extra = {}) => JSON.stringify({ type: "session_meta", payload: { source: "cli", thread_source: "user", ...extra } });
    mkdirSync(join(home, "sessions", "2026", "09", "15"), { recursive: true });
    mkdirSync(join(home, "sessions", "2026", "09", "23"), { recursive: true });
    mkdirSync(join(home, "archived_sessions"), { recursive: true });
    const kept = `${meta()}\n${Array.from({ length: 80 }, (_, n) => task(n)).join("\n")}\n`;
    const parent = join(home, "sessions", "2026", "09", "15", `rollout-2026-09-15T12-58-12-${thread}.jsonl`);
    writeFileSync(parent, kept);
    // right after a backtrack the live file is small: its newest page reaches into the parent
    const segment = join(home, "sessions", "2026", "09", "23", `rollout-2026-09-23T10-46-43-${thread}_01a0cbf1-9b0e-7383-a345-80974b279c68.jsonl`);
    writeFileSync(segment, `${meta({ history_base: { thread_id: thread, end_ordinal_exclusive: kept.split("\n").length - 1, end_byte_offset: Buffer.byteLength(kept) } })}\n${Array.from({ length: 3 }, (_, n) => task(80 + n)).join("\n")}\n`);
    forgetHistoryChains();
    const before = transcriptPage("codex-transcript", segment, {}, home);
    expect(texts(before.turns)[0]).toBe("prompt 33");
    expect(before.cursor).not.toBeNull();
    // archived while the complete chain is remembered
    renameSync(parent, join(home, "archived_sessions", `rollout-2026-09-15T12-58-12-${thread}.jsonl`));
    const after = transcriptPage("codex-transcript", segment, {}, home);
    expect(texts(after.turns)).toEqual(["prompt 80", "answer 80", "prompt 81", "answer 81", "prompt 82", "answer 82"]);
    // a reader holding a position in the old chain reloads once
    expect(() => transcriptPage("codex-transcript", segment, { before: before.cursor! }, home)).toThrow(HistoryChanged);
  });

  it("pages across the rollouts a backtracked Codex conversation continues", () => {
    const home = join(temp(), "codex");
    const thread = "01a0a337-19e8-7712-92f5-aa0883392afd";
    const task = (n: number) => [
      { type: "event_msg", timestamp: "2026-09-23T00:00:00.000Z", payload: { type: "task_started" } },
      { type: "response_item", timestamp: "2026-09-23T00:00:00.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `prompt ${n}` }] } },
      { type: "response_item", timestamp: "2026-09-23T00:00:01.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `answer ${n}` }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n");
    const meta = (extra = {}) => JSON.stringify({ type: "session_meta", payload: { source: "cli", thread_source: "user", ...extra } });
    mkdirSync(join(home, "sessions", "2026", "09", "15"), { recursive: true });
    mkdirSync(join(home, "sessions", "2026", "09", "23"), { recursive: true });
    const kept = `${meta()}\n${Array.from({ length: 60 }, (_, n) => task(n)).join("\n")}\n`;
    const keptLines = kept.split("\n").length - 1;
    writeFileSync(join(home, "sessions", "2026", "09", "15", `rollout-2026-09-15T12-58-12-${thread}.jsonl`), `${kept}${task(999)}\n`);
    const segment = join(home, "sessions", "2026", "09", "23", `rollout-2026-09-23T10-46-43-${thread}_01a0cbf1-9b0e-7383-a345-80974b279c68.jsonl`);
    writeFileSync(segment, `${meta({ history_base: { thread_id: thread, end_ordinal_exclusive: keptLines, end_byte_offset: Buffer.byteLength(kept) } })}\n${Array.from({ length: 10 }, (_, n) => task(60 + n)).join("\n")}\n`);

    const newest = transcriptPage("codex-transcript", segment, {}, home);
    expect(texts(newest.turns)[0]).toBe("prompt 20");
    const older = transcriptPage("codex-transcript", segment, { before: newest.cursor! }, home);
    expect(older.cursor).toBeNull();
    const all = texts([...older.turns, ...newest.turns]);
    expect(all).toEqual(Array.from({ length: 70 }, (_, n) => [`prompt ${n}`, `answer ${n}`]).flat());
  });
});

describe("tool calls that failed", () => {
  const lines = (...records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n");
  it("keeps Claude's is_error and omp's isError on the call they answer", () => {
    const claude = parseClaudeTranscript(lines(
      { type: "assistant", timestamp: "2026-09-27T00:00:00Z", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "false" } }, { type: "tool_use", id: "t2", name: "Bash", input: { command: "true" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "exit 1", is_error: true }, { type: "tool_result", tool_use_id: "t2", content: "" }] } },
    ));
    expect(claude.flatMap((turn) => turn.parts).filter((part) => part.kind === "tool").map((part) => part.error === true)).toEqual([true, false]);
    const omp = parseOmpTranscript(lines(
      { type: "message", timestamp: "2026-09-27T00:00:00Z", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "false" } }] } },
      { type: "message", message: { role: "toolResult", toolCallId: "c1", isError: true, content: [{ type: "text", text: "exit 1" }] } },
    ));
    expect(omp.flatMap((turn) => turn.parts).filter((part) => part.kind === "tool").map((part) => part.error === true)).toEqual([true]);
  });
});

describe("images and compactions in a Claude transcript", () => {
  const lines = (...records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n");
  it("names a pasted image by its entry and block, and never carries its data", () => {
    const turns = parseClaudeTranscript(lines(
      { type: "user", uuid: "11111111-2222-3333-4444-555555555555", timestamp: "2026-09-27T00:00:00Z", message: { content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
        { type: "text", text: "what is this?" },
        { type: "image", source: { type: "base64", media_type: "image/svg+xml", data: "PHN2Zz4=" } },
      ] } },
      { type: "user", uuid: "66666666-2222-3333-4444-555555555555", message: { content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/" } }] } },
    ));
    expect(turns.map((turn) => turn.parts)).toEqual([
      [{ kind: "image", media_type: "image/png", ref: "11111111-2222-3333-4444-555555555555:0" }, { kind: "text", text: "what is this?" }],
      [{ kind: "image", media_type: "image/jpeg", ref: "66666666-2222-3333-4444-555555555555:0" }],
    ]);
    expect(JSON.stringify(turns)).not.toContain("iVBOR");
  });

  it("marks where a compaction folded the conversation, with its summary", () => {
    const turns = parseClaudeTranscript(lines(
      { type: "user", timestamp: "2026-09-27T00:00:00Z", message: { content: "before" } },
      { type: "user", isCompactSummary: true, timestamp: "2026-09-27T01:00:00Z", message: { content: "This session is being continued. Summary: X" } },
    ));
    expect(turns.at(-1)).toEqual({ role: "user", ts: "2026-09-27T01:00:00Z", parts: [{ kind: "compact", text: "This session is being continued. Summary: X" }] });
  });
});

describe("transcriptImage", () => {
  it("decodes the image a ref names, and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-image-"));
    try {
      const path = join(dir, "session.jsonl");
      const uuid = "11111111-2222-3333-4444-555555555555";
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      writeFileSync(path, [
        { type: "user", uuid: "99999999-2222-3333-4444-555555555555", message: { content: [{ type: "text", text: "x" }] } },
        { type: "user", uuid, message: { content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } }, { type: "text", text: "what?" }, { type: "image", source: { type: "base64", media_type: "image/svg+xml", data: "PHN2Zz4=" } }] } },
      ].map((entry) => JSON.stringify(entry)).join("\n"));
      const image = transcriptImage(path, `${uuid}:0`);
      expect(image?.mediaType).toBe("image/png");
      expect(Buffer.from(image!.bytes).equals(png)).toBe(true);
      // a text block, a type a page never shows, another entry's index, a ref that is no ref
      expect(transcriptImage(path, `${uuid}:1`)).toBeNull();
      expect(transcriptImage(path, `${uuid}:2`)).toBeNull();
      expect(transcriptImage(path, "99999999-2222-3333-4444-555555555555:0")).toBeNull();
      expect(transcriptImage(path, "../../etc/passwd:0")).toBeNull();
      expect(transcriptImage(join(dir, "missing.jsonl"), `${uuid}:0`)).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("a cut tool output and the whole of it", () => {
  it("keeps the call id of an output cut for the page, and finds the whole one by it", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-output-"));
    try {
      const long = "x".repeat(9_000);
      const claude = [
        { type: "assistant", timestamp: "2026-09-27T00:00:00Z", message: { content: [{ type: "tool_use", id: "toolu_long", name: "Bash", input: { command: "big" } }, { type: "tool_use", id: "toolu_short", name: "Bash", input: { command: "small" } }] } },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_long", content: long }, { type: "tool_result", tool_use_id: "toolu_short", content: "ok" }] } },
      ].map((entry) => JSON.stringify(entry)).join("\n");
      const tools = parseClaudeTranscript(claude).flatMap((turn) => turn.parts).filter((part) => part.kind === "tool");
      expect(tools.map((tool) => [tool.output_ref, tool.output_size])).toEqual([["toolu_long", 9_000], [undefined, undefined]]);
      expect(tools[0]!.output.length).toBeLessThan(4_100);
      const path = join(dir, "claude.jsonl");
      writeFileSync(path, claude);
      expect(transcriptToolOutput("claude-transcript", path, "toolu_long")).toBe(long);
      expect(transcriptToolOutput("claude-transcript", path, "toolu_none")).toBeNull();
      expect(transcriptToolOutput("claude-transcript", path, "../etc")).toBeNull();
      const omp = join(dir, "omp.jsonl");
      writeFileSync(omp, JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "call_1", content: [{ type: "text", text: long }] } }));
      expect(transcriptToolOutput("omp-transcript", omp, "call_1")).toBe(long);
      const codex = join(dir, "codex.jsonl");
      writeFileSync(codex, JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "call_x", output: long } }));
      expect(transcriptToolOutput("codex-transcript", codex, "call_x")).toBe(long);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});


it("preserves literal paste lookalikes, partial wrappers and mismatched ids", () => {
  const cases = [
    '<pasted_content id="a">\nverbatim\n</pasted_content id="b">',
    '<pasted_content>\nverbatim\n</pasted_content>',
    '<pasted_content id="a">verbatim</pasted_content id="a">',
    '<pasted_content id="a">\nunfinished',
    '\n\nordinary prompt\n',
  ];
  for (const text of cases) expect(unwrapPastes(text)).toBe(text);
  expect(unwrapPastes('before\n<pasted_content id="a_1">\r\nfirst\r\n</pasted_content id="a_1">\nafter')).toBe("before\nfirst\nafter");
});

it("incrementally reads one growing Codex task across split UTF-8, partial records and a rewrite", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-codex-growing-"));
  try {
    const path = join(root, "live.jsonl");
    const cold = join(root, "cold.jsonl");
    const records = [
      { type: "event_msg", payload: { type: "task_started" } },
      { type: "event_msg", timestamp: "2026-09-27T00:00:00Z", payload: { type: "user_message", message: "한글 👋" } },
      { type: "turn_context", payload: { model: "model-a", effort: "high" } },
      ...Array.from({ length: 30 }, (_, n) => [
        { type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: `c${n}`, arguments: '{"cmd":"ls"}' } },
        { type: "response_item", payload: { type: "function_call_output", call_id: `c${n}`, output: "x".repeat(5000) } },
      ]).flat(),
      { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "끝났어요" }] } },
    ];
    const whole = Buffer.from(records.map((entry) => JSON.stringify(entry)).join("\n"));
    writeFileSync(path, "");
    for (let at = 0, step = 1; at < whole.length; step = (step * 13) % 571 + 1) {
      const next = whole.subarray(at, at + step * 7);
      appendFileSync(path, next); at += next.length;
      writeFileSync(cold, whole.subarray(0, at));
      const live = transcriptPage("codex-transcript", path);
      const reference = transcriptPage("codex-transcript", cold);
      expect(live.turns).toEqual(reference.turns);
      expect(live.metadata).toEqual(reference.metadata);
    }
    const original = transcriptPage("codex-transcript", path);
    writeFileSync(path, whole.toString("utf8").replace("model-a", "model-b"));
    // Some filesystems coalesce immediate writes into one timestamp tick.
    utimesSync(path, new Date(), new Date(Date.now() + 1000));
    expect(transcriptPage("codex-transcript", path).metadata.model).toBe("model-b");
    expect(original.metadata.model).toBe("model-a");
    writeFileSync(path, records.slice(0, 2).map((entry) => JSON.stringify(entry)).join("\n"));
    expect(transcriptPage("codex-transcript", path).turns).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("expands inherited Codex tool output without exposing output discarded by a backtrack", () => {
  const home = mkdtempSync(join(tmpdir(), "herdr-tool-history-"));
  try {
    const directory = join(home, "sessions", "2026", "09", "30");
    mkdirSync(directory, { recursive: true });
    const thread = "11111111-1111-4111-8111-111111111111";
    const parent = join(directory, `rollout-2026-09-30T01-00-00-${thread}.jsonl`);
    const leaf = join(directory, `rollout-2026-09-30T01-00-01-${thread}_1.jsonl`);
    const line = (type: string, payload: unknown) => JSON.stringify({ type, payload }) + "\n";
    const meta = (extra = {}) => line("session_meta", { id: thread, source: "cli", thread_source: "user", ...extra });
    const long = "inherited output ".repeat(1000);
    const kept = meta()
      + line("event_msg", { type: "user_message", message: "earlier request" })
      + line("response_item", { type: "function_call", name: "exec_command", call_id: "kept", arguments: "{}" })
      + line("response_item", { type: "function_call_output", call_id: "kept", output: long });
    writeFileSync(parent, kept + line("response_item", { type: "function_call_output", call_id: "discarded", output: "discarded output" }));
    writeFileSync(leaf, meta({ history_base: { thread_id: thread, end_ordinal_exclusive: 4, end_byte_offset: Buffer.byteLength(kept) } })
      + line("response_item", { type: "function_call_output", call_id: "current", output: "current output" }));
    const page = transcriptPage("codex-transcript", leaf, {}, home);
    expect(page.turns.flatMap((turn) => turn.parts).some((part) => part.kind === "tool" && part.output_ref === "kept")).toBe(true);
    expect(transcriptToolOutput("codex-transcript", leaf, "kept", home)).toBe(long);
    expect(transcriptToolOutput("codex-transcript", leaf, "current", home)).toBe("current output");
    expect(transcriptToolOutput("codex-transcript", leaf, "discarded", home)).toBeNull();
    // an inherited rollout that can no longer be read costs its own output, not the leaf's
    // (a directory in its place fails to read even for root, unlike a mode change)
    rmSync(parent);
    mkdirSync(parent);
    expect(transcriptToolOutput("codex-transcript", leaf, "current", home)).toBe("current output");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
