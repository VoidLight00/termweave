import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetTranscriptState, HistoryChanged, parseClaudeTranscript, transcriptPage, transcriptToolOutput, TRANSCRIPT_WINDOW_BYTES } from "./conversation.ts";
import { parseConversationMetadata } from "./conversation-metadata.ts";
import { isContextClear, parseOmpTranscript } from "./transcript-records.ts";

const roots: string[] = [];
const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
const message = (role: string, content: unknown, extra = {}) => ({ type: "message", message: { role, content, ...extra } });
const clear = { type: "custom", customType: "context_clear" };
const claudeClear = { type: "user", message: { role: "user", content: "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>" } };
const fixture = (text: string) => {
  const root = mkdtempSync(join(tmpdir(), "herdr-chat-history-")); roots.push(root);
  const path = join(root, "session.jsonl"); writeFileSync(path, text); return path;
};
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); forgetTranscriptState(); });

test("Pi variants normalize visible text, tool aliases and nested/string results consistently", () => {
  const rows = [
    message("user", "hidden", { display: false }),
    message("user", "visible"),
    message("assistant", "plain answer"),
    message("assistant", [{ type: "toolCall", callId: "a", toolName: "Read", toolInput: { file_path: "one" } }]),
    message("toolResult", "A".repeat(9000), { callId: "a", isError: true }),
    message("assistant", [
      { type: "toolCall", toolCallId: "b", name: "Bash", input: { command: "pwd" } },
      { type: "toolResult", id: "b", result: [{ type: "text", text: "B".repeat(9000) }] },
    ]),
    message("assistant", "hidden answer", { display: false, model: "wrong", usage: { input: 100 } }),
    message("toolResult", "hidden result", { callId: "a", display: false }),
  ];
  const text = jsonl(rows), path = fixture(text);
  const turns = parseOmpTranscript(text);
  expect(turns).toHaveLength(2);
  expect(turns[0]?.parts).toEqual([{ kind: "text", text: "visible" }]);
  expect(turns[1]?.parts[0]).toEqual({ kind: "text", text: "plain answer" });
  expect(turns[1]?.parts[1]).toMatchObject({ kind: "tool", name: "Read", summary: "one", output_ref: "a", error: true });
  expect(turns[1]?.parts[2]).toMatchObject({ kind: "tool", name: "Bash", summary: "pwd", output_ref: "b" });
  for (const source of ["omp-transcript", "omo-transcript", "gjc-transcript"] as const) {
    expect(transcriptToolOutput(source, path, "a")).toBe("A".repeat(9000));
    expect(transcriptToolOutput(source, path, "b")).toBe("B".repeat(9000));
    expect(transcriptPage(source, path).turns).toEqual(turns);
    expect(parseConversationMetadata(text, source)).toEqual({ model: null, reasoning_effort: null });
  }
});

test("hidden Pi users never become page boundaries, including spaced JSON", () => {
  const text = Array.from({ length: 90 }, (_, i) => JSON.stringify(message("user", `hidden ${i}`, { display: false }))).join("\n");
  const path = fixture(JSON.stringify(message("user", "visible"), null, 0).replaceAll(':', ': ') + "\n" + text);
  const page = transcriptPage("omp-transcript", path);
  expect(page.cursor).toBeNull();
  expect(page.turns).toHaveLength(1);
});

test("only explicit complete reset records clear history; compaction and quoted commands do not", () => {
  expect(isContextClear(clear, "omp-transcript")).toBe(true);
  expect(isContextClear(claudeClear, "claude-transcript")).toBe(true);
  for (const content of ["Please explain /clear", "<command-name>/clear", "quoted <command-name>/clear</command-name>", "<command-name>/clear</command-name>\nextra", "<command-name>/clear</command-name>\n<command-args>argument</command-args>"]) {
    expect(isContextClear({ ...claudeClear, message: { role: "user", content } }, "claude-transcript")).toBe(false);
  }
  expect(isContextClear({ ...claudeClear, isCompactSummary: true }, "claude-transcript")).toBe(false);
  expect(isContextClear({ ...claudeClear, isMeta: true }, "claude-transcript")).toBe(false);
  expect(isContextClear(clear, "codex-transcript")).toBe(false);
});

for (const source of ["omp-transcript", "omo-transcript", "gjc-transcript", "claude-transcript"] as const) {
  test(`${source}: clear invalidates held/cached cursors and metadata, even before the next prompt`, () => {
    const user = (text: string) => source === "claude-transcript" ? { type: "user", message: { role: "user", content: text } } : message("user", text);
    const reset = source === "claude-transcript" ? claudeClear : clear;
    const path = fixture(jsonl(Array.from({ length: 130 }, (_, i) => user(`old ${i}`))));
    const before = transcriptPage(source, path);
    expect(before.cursor).toBeString();
    transcriptPage(source, path, { before: before.cursor! }); // warm an older page
    appendFileSync(path, JSON.stringify(reset).slice(0, -1)); // torn control record
    expect(transcriptPage(source, path).history_id).toBe(before.history_id);
    appendFileSync(path, "}"); // valid object, no newline yet
    const cleared = transcriptPage(source, path);
    expect(cleared.turns).toEqual([]);
    expect(cleared.cursor).toBeNull();
    expect(cleared.history_id).not.toBe(before.history_id);
    expect(cleared.version).not.toBe(before.version);
    expect(() => transcriptPage(source, path, { before: before.cursor! })).toThrow(HistoryChanged);
    expect(() => transcriptPage(source, path, { from: before.cursor! })).toThrow(HistoryChanged);
    appendFileSync(path, "\n" + jsonl(Array.from({ length: 80 }, (_, i) => user(`new ${i}`))));
    const latest = transcriptPage(source, path);
    expect(latest.history_id).toBe(cleared.history_id);
    const older = transcriptPage(source, path, { before: latest.cursor! });
    expect(older.cursor).toBeNull();
    expect([...older.turns, ...latest.turns]).toHaveLength(80);
    expect(JSON.stringify([...older.turns, ...latest.turns])).not.toContain("old ");
    forgetTranscriptState();
    expect(transcriptPage(source, path)).toEqual(latest);
  });
}

test("reset scanning crosses chunk boundaries, excludes pre-clear full outputs and pending tools", () => {
  const opening = jsonl([message("assistant", [{ type: "toolCall", id: "old", name: "Read", arguments: {} }]), message("toolResult", "old output", { toolCallId: "old" })]);
  const padding = JSON.stringify({ type: "padding", text: "x".repeat(TRANSCRIPT_WINDOW_BYTES - opening.length - 40) }) + "\n";
  const text = opening + padding + jsonl([clear, message("toolResult", "late", { toolCallId: "old" }), message("user", "new")]);
  const path = fixture(text);
  const expected = [{ role: "user" as const, ts: null, parts: [{ kind: "text" as const, text: "new" }] }];
  expect(transcriptPage("omp-transcript", path).turns).toEqual(expected);
  expect(parseOmpTranscript(text)).toEqual(expected);
  expect(transcriptToolOutput("omp-transcript", path, "old")).toBe("late");
  expect(transcriptToolOutput("omp-transcript", fixture(opening + jsonl([clear])), "old")).toBeNull();
  const claude = jsonl([{ type: "user", message: { role: "user", content: "old" } }, claudeClear]);
  expect(parseClaudeTranscript(claude)).toEqual([]);
});

for (const source of ["omp-transcript", "omo-transcript", "gjc-transcript"] as const) {
  test(`${source}: a thinking-level change between the metadata head and the newest page sets the reasoning shown`, () => {
    const level = (thinkingLevel: string) => ({ type: "thinking_level_change", thinkingLevel });
    const padding = { type: "padding", text: "x".repeat(70 * 1024) }; // past the 64 KiB metadata head
    const path = fixture(jsonl([
      { type: "model_change", modelId: "first" }, level("high"), message("user", "start"), padding,
      { type: "model_change", modelId: "second" }, level("medium"),
      ...Array.from({ length: 130 }, (_, i) => message("user", `turn ${i}`)),
    ]));
    const page = transcriptPage(source, path);
    expect(page.cursor).toBeString(); // the newest page starts after both changes
    expect(page.metadata).toEqual({ model: "second", reasoning_effort: "medium" });
    forgetTranscriptState();
    expect(transcriptPage(source, path).metadata).toEqual({ model: "second", reasoning_effort: "medium" });
    // a change inside the page still wins
    appendFileSync(path, jsonl([level("low")]));
    expect(transcriptPage(source, path).metadata.reasoning_effort).toBe("low");
    // a clear forgets them all, also once the newest page starts past the cleared head
    appendFileSync(path, jsonl([clear, padding, ...Array.from({ length: 130 }, (_, i) => message("user", `after clear ${i}`))]));
    const cleared = transcriptPage(source, path);
    expect(cleared.cursor).toBeString();
    expect(cleared.metadata).toEqual({ model: null, reasoning_effort: null });
  });
}

test("metadata clears old context and ignores hidden assistant usage", () => {
  const text = jsonl([{ type: "model_change", modelId: "old" }, message("assistant", "answer", { model: "old", usage: { input: 123 } }), clear]);
  expect(parseConversationMetadata(text, "omp-transcript")).toEqual({ model: null, reasoning_effort: null });
  expect(transcriptPage("omp-transcript", fixture(text)).metadata).toEqual({ model: null, reasoning_effort: null });
});
