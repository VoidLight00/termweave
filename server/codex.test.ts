import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexCallFailed, codexHistoryTail, codexRolloutPath, forgetHistoryChains, matchCodexTranscript, matchShortCodexAnswers, parseCodexTranscript, resumedThread, unansweredCodexQuestions } from "./codex.ts";
import { splitTurn } from "../src/lib/workBlocks.ts";

const ts = "2026-09-22T01:00:00.000Z";
const item = (payload: unknown, timestamp = ts) => ({ type: "response_item", timestamp, payload });
const event = (payload: unknown, timestamp = ts) => ({ type: "event_msg", timestamp, payload });
const message = (role: string, text: string, phase?: string) => item({
  type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }], ...(phase ? { phase } : {}),
});
const jsonl = (...records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n");

describe("Codex conversation records", () => {
  it("hides injected context, metadata and developer messages while preserving the real request", () => {
    const turns = parseCodexTranscript(jsonl(
      { type: "session_meta", payload: { base_instructions: "internal system prompt" } },
      message("developer", "internal developer prompt"),
      message("user", "# AGENTS.md instructions for /project\n<INSTRUCTIONS>internal rules</INSTRUCTIONS>\n<environment_context>cwd</environment_context>"),
      message("user", "<environment_context>cwd</environment_context>"),
      item({ type: "message", role: "user", content: [null, { type: "input_text", text: "<environment_context>cwd</environment_context>" }, { type: "input_text", text: "Fix chat" }] }),
      event({ type: "user_message", kind: "internal", message: "injected reminder" }),
      event({ type: "token_count", info: { total: 10 } }),
      message("assistant", "Fixed", "final_answer"),
    ));
    expect(turns).toHaveLength(2);
    expect(turns[0]?.parts).toEqual([{ kind: "text", text: "Fix chat" }]);
    expect(turns[1]?.parts).toEqual([{ kind: "text", text: "Fixed", phase: "final_answer" }]);
  });

  it("pairs duplicate display/model records in either order but keeps genuine repeated prompts", () => {
    for (const reverse of [false, true]) {
      const pair = [message("user", "continue"), event({ type: "user_message", message: "continue" })];
      if (reverse) pair.reverse();
      const turns = parseCodexTranscript(jsonl(
        ...pair,
        event({ type: "agent_message", message: "Done" }), message("assistant", "Done", "final_answer"),
        message("user", "continue"), message("user", "continue"),
      ));
      expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant", "user", "user"]);
      expect(turns[1]?.parts).toEqual([{ kind: "text", text: "Done", phase: "final_answer" }]);
    }
  });

  it("does not deduplicate identical messages in separate turns", () => {
    expect(parseCodexTranscript(jsonl(
      message("user", "continue"),
      event({ type: "user_message", message: "continue" }, "2026-09-22T01:00:02.000Z"),
    ))).toHaveLength(2);
  });

  it("folds matched function/freeform tool output and commentary, keeping only the final answer outside", () => {
    const turns = parseCodexTranscript(jsonl(
      message("user", "Check"),
      message("assistant", "Checking", "commentary"),
      item({ type: "function_call", call_id: "read", name: "exec_command", arguments: '{"cmd":"git status"}' }),
      item({ type: "custom_tool_call", call_id: "patch", name: "apply_patch", input: "*** Begin Patch\n*** End Patch" }),
      item({ type: "custom_tool_call_output", call_id: "patch", output: "applied" }),
      item({ type: "function_call_output", call_id: "read", output: [{ type: "text", text: "clean" }] }),
      item({ type: "function_call_output", call_id: "unknown", output: "not a chat message" }),
      message("assistant", "Verifying", "commentary"),
      message("assistant", "All fixed", "final_answer"),
    ));
    const split = splitTurn(turns[1]!.parts);
    expect(split.work.map((part) => part.kind)).toEqual(["text", "tool", "tool", "text"]);
    expect(split.work[1]).toMatchObject({ summary: "git status", output: "clean" });
    expect(split.work[2]).toMatchObject({ name: "apply_patch", output: "applied" });
    expect(split.answer).toEqual([{ kind: "text", text: "All fixed", phase: "final_answer" }]);
  });

  it("retains reasoning summaries as thinking without decoding encrypted context", () => {
    const turns = parseCodexTranscript(jsonl(
      item({ type: "reasoning", summary: [{ type: "summary_text", text: "Considering options" }], encrypted_content: "secret" }),
      item({ type: "message", role: "assistant", channel: "analysis", content: [{ type: "output_text", text: "Analysis text" }] }),
      message("assistant", "Answer", "final_answer"),
    ));
    expect(turns[0]?.parts.map((part) => part.kind)).toEqual(["thinking", "thinking", "text"]);
    expect(JSON.stringify(turns)).not.toContain("secret");
  });

  it("uses task timestamps rather than idle time before the next user prompt", () => {
    const turns = parseCodexTranscript(jsonl(
      event({ type: "task_started", started_at: ts }),
      message("user", "Check"),
      item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }], phase: "final_answer" }, "2026-09-22T01:00:06.000Z"),
      event({ type: "task_complete" }, "2026-09-22T01:00:07.000Z"),
      event({ type: "user_message", message: "Next" }, "2026-09-22T02:00:00.000Z"),
    ));
    expect(turns[1]).toMatchObject({ ts, end_ts: "2026-09-22T01:00:07.000Z" });
  });

  it("bounds tool output and history and tolerates malformed or partially written records", () => {
    const text = jsonl(null, 1, { type: "response_item", payload: null },
      item({ type: "function_call", call_id: "c", name: "exec_command", arguments: "{bad json" }),
      item({ type: "function_call_output", call_id: "c", output: "x".repeat(10_000) }));
    const part = parseCodexTranscript(`${text}\n{"type":`)[0]?.parts[0];
    expect(part?.kind === "tool" ? part.output.length : 0).toBeGreaterThan(4000);
    expect(part?.kind === "tool" ? part.output.length : 0).toBeLessThan(4100);
    expect(parseCodexTranscript(jsonl(...Array.from({ length: 150 }, (_, i) => message("user", `request ${i}`))))).toHaveLength(100);
  });
});

describe("Codex queued questions (request_user_input_async)", () => {
  const ask = (callId: string, questions: unknown[]) => item({
    type: "function_call", name: "request_user_input_async", call_id: callId, arguments: JSON.stringify({ questions }),
  });
  const reply = (...answers: { callId: string; index: number; question: string; answer: string }[]) => message("user",
    `<send_user_message_question_reply>\n${JSON.stringify(answers.map((answer) => ({
      answer: answer.answer, question: answer.question,
      questionItemId: JSON.stringify(["request_user_input_async", answer.callId, answer.index]),
    })))}\n</send_user_message_question_reply>`);
  const asked = ask("call_a", [
    { title: "Which dataset?", options: ["LM-O", "YCB-V"] },
    { title: "Any notes?" },
  ]);
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  it("shows only what was answered, and the questions asked as the tool's summary", () => {
    const turns = parseCodexTranscript(jsonl(
      message("user", "Clean up the outputs"),
      asked,
      item({ type: "function_call_output", call_id: "call_a", output: "{\"accepted\":true}" }),
      reply({ callId: "call_a", index: 0, question: "Which dataset?", answer: "YCB-V" }),
      reply({ callId: "call_a", index: 1, question: "Any notes?", answer: "keep the logs" }, { callId: "call_b", index: 0, question: "Split?", answer: "test" }),
      message("user", "<send_user_message_question_reply>not json</send_user_message_question_reply>"),
    ));
    expect(turns.filter((turn) => turn.role === "user").map((turn) => turn.parts[0])).toEqual([
      { kind: "text", text: "Clean up the outputs" },
      { kind: "text", text: "YCB-V" },
      { kind: "text", text: "keep the logs\ntest" },
      // not a reply Codex wrote: shown as it is
      { kind: "text", text: "<send_user_message_question_reply>not json</send_user_message_question_reply>" },
    ]);
    expect(turns[1]!.parts[0]).toMatchObject({ kind: "tool", name: "request_user_input_async", summary: "Which dataset? · Any notes?" });
  });

  it("scans a rollout once however many ask at the same time", async () => {
    dir = mkdtempSync(join(tmpdir(), "herdr-web-ui-codex-questions-"));
    const path = join(dir, "rollout.jsonl");
    writeFileSync(path, `${jsonl(message("user", "go"), ask("call_x", [{ title: "First?", options: ["a"] }]))}\n`);
    await unansweredCodexQuestions(path);
    appendFileSync(path, `${jsonl(ask("call_y", [{ title: "Second?", options: ["b"] }]))}\n`);
    // two viewers polling at once: the append is read once, not once per poll
    const [one, two] = await Promise.all([unansweredCodexQuestions(path), unansweredCodexQuestions(path)]);
    expect(one.map((question) => question.title)).toEqual(["First?", "Second?"]);
    expect(two).toEqual(one);
    expect((await unansweredCodexQuestions(path)).map((question) => question.title)).toEqual(["First?", "Second?"]);
  });

  it("lists the questions still unanswered, reading only what the rollout appends", async () => {
    dir = mkdtempSync(join(tmpdir(), "herdr-web-ui-codex-questions-"));
    const path = join(dir, "rollout.jsonl");
    writeFileSync(path, `${jsonl(message("user", "go"), asked)}\n`);
    expect(await unansweredCodexQuestions(path)).toEqual([
      { key: "call_a:0", title: "Which dataset?", options: ["LM-O", "YCB-V"] },
      { key: "call_a:1", title: "Any notes?", options: [] },
    ]);
    appendFileSync(path, `${jsonl(reply({ callId: "call_a", index: 0, question: "Which dataset?", answer: "LM-O" }))}\n`);
    // a record still being written is not read yet
    appendFileSync(path, JSON.stringify(ask("call_b", [{ title: "Split?", options: [{ label: "train" }, { label: "test" }] }])).slice(0, 40));
    expect((await unansweredCodexQuestions(path)).map((question) => question.key)).toEqual(["call_a:1"]);
    appendFileSync(path, `${JSON.stringify(ask("call_b", [{ title: "Split?", options: [{ label: "train" }, { label: "test" }] }])).slice(40)}\n`);
    expect(await unansweredCodexQuestions(path)).toEqual([
      { key: "call_a:1", title: "Any notes?", options: [] },
      { key: "call_b:0", title: "Split?", options: ["train", "test"] },
    ]);
  });
});

describe("Codex rollout resolution", () => {
  it("reads the thread a TUI was resumed on from its command line", () => {
    const thread = "01a0a337-19e8-7712-92f5-aa0883392afd";
    expect(resumedThread([["node", "/usr/bin/codex", "resume", thread, "--yolo"], ["/vendor/codex", "resume"]])).toBe(thread);
    expect(resumedThread([["codex", "resume", "--last"], ["codex"]])).toBeNull();
    expect(resumedThread([["codex", "exec", "resume"]])).toBeNull();
    expect(resumedThread([])).toBeNull();
  });

  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  it("accepts files inside the store and rejects traversal, external symlinks, missing files and directories", () => {
    // an accepted rollout comes back canonical; macOS's tmpdir is a symlink into /private
    const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-codex-path-"))); roots.push(root);
    const home = join(root, "codex"); const sessions = join(home, "sessions");
    mkdirSync(sessions, { recursive: true });
    const path = join(sessions, "rollout.jsonl"); writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { source: "cli", thread_source: "user" } }));
    const outside = join(root, "other.jsonl"); writeFileSync(outside, "");
    symlinkSync(outside, join(sessions, "escape.jsonl"));
    expect(codexRolloutPath(path, home)).toBe(path);
    for (const candidate of [outside, join(sessions, "escape.jsonl"), join(sessions, "missing.jsonl"), sessions]) {
      expect(codexRolloutPath(candidate, home)).toBeNull();
    }
    writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { source: { subagent: { parent_thread_id: "parent" } } } }));
    expect(codexRolloutPath(path, home)).toBeNull();
    writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { source: "cli", thread_source: "subagent" } }));
    expect(codexRolloutPath(path, home)).toBeNull();
  });

  /** Rollouts as Codex 0.156 writes them: one record per line, ordinals running on from the cut a rollout starts at. */
  type Cut = { thread: string; ordinal: number; byte: number };
  const store = () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-codex-chain-")); roots.push(root);
    const home = join(root, "codex");
    const rollout = (day: string, name: string, thread: string, records: unknown[], base?: Cut) => {
      const header = { type: "session_meta", payload: { source: "cli", thread_source: "user",
        ...(base ? { history_base: { thread_id: base.thread, end_ordinal_exclusive: base.ordinal, end_byte_offset: base.byte } } : {}) } };
      const lines = [header, ...records].map((record) => `${JSON.stringify(record)}\n`);
      mkdirSync(join(home, "sessions", "2026", "09", day), { recursive: true });
      const path = join(home, "sessions", "2026", "09", day, name);
      writeFileSync(path, lines.join(""));
      const first = base?.ordinal ?? 0;
      return {
        path, size: Buffer.byteLength(lines.join("")),
        /** the cut a backtrack to just before records[index] names */
        cutBefore: (index: number): Cut => ({ thread, ordinal: first + 1 + index, byte: Buffer.byteLength(lines.slice(0, index + 1).join("")) }),
      };
    };
    const texts = (path: string, budget = 1024 * 1024) => parseCodexTranscript(codexHistoryTail(path, budget, home))
      .map((turn) => turn.parts.map((part) => part.kind === "text" ? part.text : "").join(""));
    return { rollout, texts };
  };
  const parent = "01a09a35-5c5f-7830-94f7-4a1854613531";
  const thread = "01a0a337-19e8-7712-92f5-aa0883392afd";

  it("reads a paginated rollout through the history it continues, without the turns a backtrack discarded", () => {
    const { rollout, texts } = store();
    const forked = rollout("13", `rollout-2026-09-13T18-59-43-${parent}.jsonl`, parent, [message("user", "parent question"), message("assistant", "parent answer")]);
    const original = rollout("15", `rollout-2026-09-15T12-58-12-${thread}.jsonl`, thread,
      [message("user", "첫 질문"), message("assistant", "첫 답"), message("user", "discarded"), message("assistant", "discarded answer")], forked.cutBefore(2));
    // an unrelated later rollout of the same thread must not be taken for the base
    rollout("24", `rollout-2026-09-24T09-00-00-${thread}_01a0cc00-0000-7000-8000-000000000000.jsonl`, thread, [message("user", "future")]);
    const segment = rollout("23", `rollout-2026-09-23T10-46-43-${thread}_01a0cbf1-9b0e-7383-a345-80974b279c68.jsonl`, thread,
      [message("user", "다시 묻기"), message("assistant", "새 답")], original.cutBefore(2));

    expect(texts(segment.path)).toEqual(["parent question", "parent answer", "첫 질문", "첫 답", "다시 묻기", "새 답"]);
    // a small budget reads only the newest bytes and never reaches the parent; the cut line is dropped
    const answerLine = Buffer.byteLength(JSON.stringify(message("assistant", "첫 답"))) + 1;
    expect(texts(segment.path, segment.size + answerLine + 10)).toEqual(["첫 답", "다시 묻기", "새 답"]);
  });

  it("follows each backtrack to the rollout that holds its cut, however many there were", () => {
    const { rollout, texts } = store();
    const turns = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => [
      message("user", `${prefix}${index}? ${"x".repeat(200)}`), message("assistant", `${prefix}${index}.`),
    ]).flat();
    const first = rollout("15", `rollout-2026-09-15T12-00-00-${thread}.jsonl`, thread, turns("a", 6));
    // backtrack 1 to before a4, backtrack 2 further back to before a2, backtrack 3 into the second rollout
    const second = rollout("20", `rollout-2026-09-20T12-00-00-${thread}_01a0c000-0000-7000-8000-000000000001.jsonl`, thread, turns("b", 2), first.cutBefore(8));
    const third = rollout("21", `rollout-2026-09-21T12-00-00-${thread}_01a0c000-0000-7000-8000-000000000002.jsonl`, thread, turns("c", 1), first.cutBefore(4));
    const fourth = rollout("22", `rollout-2026-09-22T12-00-00-${thread}_01a0c000-0000-7000-8000-000000000003.jsonl`, thread, turns("d", 1), second.cutBefore(2));
    // the second rollout is newer and larger than the third one's cut: a name-and-size guess would take it
    expect(second.size).toBeGreaterThan(first.cutBefore(4).byte);
    const answers = (path: string) => texts(path).filter((text) => text.endsWith("."));
    expect(answers(second.path)).toEqual(["a0.", "a1.", "a2.", "a3.", "b0.", "b1."]);
    expect(answers(third.path)).toEqual(["a0.", "a1.", "c0."]);
    expect(answers(fourth.path)).toEqual(["a0.", "a1.", "a2.", "a3.", "b0.", "d0."]);
  });

  it("reads a remembered chain again once a rollout in it is archived, instead of failing the read", () => {
    const { rollout, texts } = store();
    const first = rollout("22", `rollout-2026-09-22T12-00-00-${thread}.jsonl`, thread, [message("user", "earlier question"), message("assistant", "earlier answer")]);
    const segment = rollout("23", `rollout-2026-09-23T12-00-00-${thread}_01a0cbf1-9b0e-7383-a345-80974b279c68.jsonl`, thread,
      [message("user", "later question"), message("assistant", "later answer")], { thread, ordinal: 3, byte: first.size });
    forgetHistoryChains();
    expect(texts(segment.path)).toEqual(["earlier question", "earlier answer", "later question", "later answer"]);
    // archived while its complete chain is remembered: the tail the screen match reads still comes
    const archive = join(first.path, "..", "..", "..", "..", "..", "archived_sessions");
    mkdirSync(archive, { recursive: true });
    renameSync(first.path, join(archive, `rollout-2026-09-22T12-00-00-${thread}.jsonl`));
    expect(texts(segment.path)).toEqual(["later question", "later answer"]);
  });

  it("shows less history, never the wrong one, when no rollout holds a cut, and finds it once one does", () => {
    const { rollout, texts } = store();
    const other = "01a0d000-0000-7000-8000-00000000000a";
    const cut = { thread: other, ordinal: 3, byte: 0 };
    const pending = [message("user", "earlier question"), message("assistant", "earlier answer")];
    const lines = [{ type: "session_meta", payload: { source: "cli", thread_source: "user" } }, ...pending].map((record) => `${JSON.stringify(record)}\n`);
    cut.byte = Buffer.byteLength(lines.join(""));
    const segment = rollout("23", `rollout-2026-09-23T12-00-00-${thread}.jsonl`, thread, [message("user", "later question"), message("assistant", "later answer")], cut);
    expect(texts(segment.path)).toEqual(["later question", "later answer"]);
    rollout("22", `rollout-2026-09-22T12-00-00-${other}.jsonl`, other, pending);
    // an incomplete chain is kept a short while (no walk of sessions/ on every append)...
    expect(texts(segment.path)).toEqual(["later question", "later answer"]);
    // ...and looked up afresh once that expires
    forgetHistoryChains();
    expect(texts(segment.path)).toEqual(["earlier question", "earlier answer", "later question", "later answer"]);
  });

  const answer = "The chat parser now reads native session records, removes internal context, and keeps assistant commentary inside the expandable work section.";
  it("requires a unique substantial rendered assistant match and handles terminal wrapping", () => {
    const candidates = [
      { path: "correct", text: jsonl(message("assistant", answer, "final_answer")) },
      { path: "newer-unrelated", text: jsonl(message("assistant", "Another conversation")) },
    ];
    expect(matchCodexTranscript(`• ${answer.replaceAll(" ", "\n  ")}`, candidates)).toBe("correct");
    expect(matchCodexTranscript("Different pane", candidates)).toBeNull();
    expect(matchCodexTranscript(answer, [...candidates, { ...candidates[0]!, path: "ambiguous-copy" }])).toBeNull();
    expect(matchCodexTranscript("Done", [{ path: "short", text: jsonl(message("assistant", "Done")) }])).toBeNull();
  });

  it("matches an answer that links a file, which Codex shows as the label and a path relative to the cwd", () => {
    const linked = `${answer} [The report](/home/user/repo/output/test/REPORT.md)`; // leakscan:allow: test fixture
    const candidates = [{ path: "linked", text: jsonl(message("assistant", linked, "final_answer")) }];
    expect(matchCodexTranscript(`• ${answer} The report (output/test/REPORT.md)`, candidates)).toBe("linked");
    // a link in the middle: the end after it is what is looked for
    const middle = `See [the report](/home/user/repo/REPORT.md) for the numbers. ${answer}`; // leakscan:allow: test fixture
    expect(matchCodexTranscript(`• See the report (REPORT.md) for the numbers. ${answer}`, [{ path: "middle", text: jsonl(message("assistant", middle)) }])).toBe("middle");
    expect(matchCodexTranscript("• The report (output/test/REPORT.md)", candidates)).toBeNull();
  });

  // issue #283: no answer of this session reaches 64 letters and digits (40, 29 and 38)
  const short = [
    "세 사진을 확인하고 한 장으로 합칠게요. 이미지 편집을 위해 imagegen 스킬을 사용할게요.",
    "세 화면이 모두 보이도록, 올려주신 순서대로 가로로 나란히 배치할게요.",
    "imagegen으로 세 사진을 올려주신 순서대로 가로로 합쳤어요.\n\n[합친 이미지 다운로드](/home/user/repo/.herdr-web-ui/combined-20261002.png)", // leakscan:allow: test fixture
  ];
  const shortRollout = jsonl(
    message("user", "이거 세개 사진 합처서 하나의 이미지로 만들어줘."),
    message("assistant", short[0]!, "commentary"), message("assistant", short[1]!, "commentary"), message("assistant", short[2]!, "final_answer"),
  );
  const shortScreen = [
    "› 이거 세개 사진 합처서 하나의 이미지로 만들어줘.",
    "• 세 사진을 확인하고 한 장으로 합칠게요. 이미지 편집을 위해 imagegen\n  스킬을 사용할게요.",
    "• 세 화면이 모두 보이도록, 올려주신 순서대로 가로로 나란히 배치할게요.",
    "• imagegen으로 세 사진을 올려주신 순서대로 가로로 합쳤어요.\n\n  합친 이미지 다운로드 (.herdr-web-ui/combined-20261002.png)",
  ];
  const answered = (...texts: string[]) => jsonl(...texts.map((text) => message("assistant", text)));
  const bullets = (...texts: string[]) => texts.map((text) => `• ${text}`).join("\n");

  it("reads a session whose answers are all short by its newest answers shown together, in order", () => {
    const candidates = [
      { path: "short", text: shortRollout },
      { path: "other", text: jsonl(message("assistant", answer, "final_answer")) },
    ];
    // the long-answer match alone, as every caller but the last resort uses it, still says nothing
    expect(matchCodexTranscript(shortScreen.join("\n\n"), candidates)).toBeNull();
    expect(matchShortCodexAnswers(shortScreen.join("\n\n"), candidates)).toBe("short");
    // the newest answer not rendered yet: the two before it are enough together
    expect(matchShortCodexAnswers(shortScreen.slice(0, 3).join("\n\n"), candidates)).toBe("short");
    // one short answer alone is too little, and so are the same lines out of order
    expect(matchShortCodexAnswers(shortScreen[2]!, candidates)).toBeNull();
    expect(matchShortCodexAnswers([shortScreen[3], shortScreen[2], shortScreen[1]].join("\n\n"), candidates)).toBeNull();
    // older answers with the newest two missing from the screen are not this rollout's end
    expect(matchShortCodexAnswers(shortScreen.slice(0, 2).join("\n\n"), candidates)).toBeNull();
  });

  it("does not read short answers that two rollouts share, or ones above the welcome card", () => {
    const shared = [{ path: "one", text: shortRollout }, { path: "two", text: jsonl(message("user", "다시 해줘"), ...short.map((text) => message("assistant", text))) }];
    expect(matchShortCodexAnswers(shortScreen.join("\n\n"), shared)).toBeNull();
    expect(matchShortCodexAnswers(`${shortScreen.join("\n\n")}\nOpenAI Codex (v1.0)\nNew session`, [shared[0]!])).toBeNull();
  });

  // the review of #284: each case once bound the wrong rollout, or lost the right one
  const looked = "I'll look at the file and run the tests.";
  const changed = "I'll make the change and verify the result.";
  it("does not take a fork's inherited answers for its parent", () => {
    const fixes = Array.from({ length: 8 }, (_, index) => `Fixed test ${index}.`);
    const candidates = [{ path: "parent", text: answered(looked, changed) }, { path: "fork", text: answered(looked, changed, ...fixes) }];
    const screen = bullets(looked, changed, ...fixes);
    expect(matchCodexTranscript(screen, candidates)).toBeNull();
    expect(matchShortCodexAnswers(screen, candidates)).toBeNull();
  });

  it("does not count the links of one answer as several answers, wherever they point", () => {
    const linked = "[Open the project report](/other/0.md)\n[Download the updated image](/other/1.md)\n[Review the verification results](/other/2.md)";
    const candidates = [{ path: "linked", text: answered(linked) }];
    const screen = "• Open the project report (my/0.md)\n  Download the updated image (my/1.md)\n  Review the verification results (my/2.md)";
    expect(matchCodexTranscript(screen, candidates)).toBeNull();
    expect(matchShortCodexAnswers(screen, candidates)).toBeNull();
  });

  it("keeps a unique long-answer match when another rollout shares its short answers", () => {
    const candidates = [{ path: "real", text: answered(looked, changed, answer) }, { path: "unrelated", text: answered(looked, changed) }];
    expect(matchCodexTranscript(bullets(looked, changed, answer), candidates)).toBe("real");
  });

  const migrated = "The migration script now rewrites every legacy record in place.";
  it("needs 64 letters and digits together, 16 in each answer and 12 distinct", () => {
    const read = (...texts: string[]) => matchShortCodexAnswers(bullets(...texts), [{ path: "short", text: answered(...texts) }]);
    // 29 + 34 = 63, and 29 + 36 = 65
    expect(read("The build finished without errors.", "All checks on the feature branch pass now.")).toBeNull();
    expect(read("The build finished without errors.", "All checks on the feature branch pass again.")).toBe("short");
    // 14 + 53 = 67 with an answer below 16, and the same with one of 16
    expect(read("Updated the docs", migrated)).toBeNull();
    expect(read("Updated the README", migrated)).toBe("short");
    // 18 + 29 + 31 = 78 from 10 distinct letters
    expect(read("The tests have passed.", "Tests passed. The tests have passed.", "Ha, the tests passed; these have passed.")).toBeNull();
  });

  // the second review of #284
  const inspect = "I'll inspect the file and run the tests.";
  it("does not read short answers another rollout said inside longer ones", () => {
    const candidates = [
      { path: "wrong", text: answered(inspect, changed) },
      { path: "real", text: answered(`Sure. ${inspect}`, `Sure. ${changed}`, "Done.", "Done.") },
    ];
    expect(matchShortCodexAnswers(bullets(`Sure. ${inspect}`, `Sure. ${changed}`, "Done.", "Done."), candidates)).toBeNull();
  });

  it("does not take a fork for its parent however many turns ago it inherited the answers", () => {
    const later = Array.from({ length: 51 }, () => [message("user", "continue"), message("assistant", "Done.")]).flat();
    const candidates = [
      { path: "parent", text: answered(inspect, changed) },
      { path: "fork", text: jsonl(message("assistant", inspect), message("assistant", changed), ...later) },
    ];
    const screen = [bullets(inspect, changed), ...Array.from({ length: 51 }, () => "› continue\n• Done.")].join("\n");
    expect(matchShortCodexAnswers(screen, candidates)).toBeNull();
    // and a rollout read only from its end may have said them before: no answer then
    expect(matchShortCodexAnswers(bullets(inspect, changed), [candidates[0]!, { path: "fork", text: answered("Done."), cut: true }])).toBeNull();
    expect(matchShortCodexAnswers(bullets(inspect, changed), [candidates[0]!, { path: "fork", text: answered("Done.") }])).toBe("parent");
  });

  // the third review of #284
  it("takes no answer with a link for evidence: the screen shows its target its own way", () => {
    const linked = ["The [build results](reports/build-results.md) are ready for review.", "All [feature branch checks](reports/check-results.md) passed the verification."];
    // the pane's own conversation said the words after the links, as answers of its own, and
    // the user's prompts hold the labels: the linked rollout's pieces add up on that screen
    const own = ["are ready for review.", "passed the verification.", "Done.", "Done."];
    const screen = "› The build results?\n• are ready for review.\n› All feature branch checks?\n• passed the verification.\n› next\n• Done.\n› next\n• Done.";
    expect(matchShortCodexAnswers(screen, [{ path: "linked", text: answered(...linked) }, { path: "own", text: answered(...own) }])).toBeNull();
    expect(matchShortCodexAnswers("• The build results (reports/build-results.md) are ready for review.\n• All feature branch checks (reports/check-results.md) passed the verification.", [{ path: "linked", text: answered(...linked) }])).toBeNull();
    // the newest answer may hold one: the two before it still tell (the report's own case ends in a download link)
    const report = ["The build finished without errors this time.", "All checks on the feature branch pass again.", "Here is [the image](out/merged.png)."];
    expect(matchShortCodexAnswers(bullets(report[0]!, report[1]!, "Here is the image (out/merged.png)."), [{ path: "report", text: answered(...report) }])).toBe("report");
  });

  it("reads no short answers that another rollout's linked answers show as", () => {
    // the pane's own rollout says them with links, which Codex shows as "label (path)": the screen
    // reads exactly like an older rollout's plain answers
    const live = ["The [build results](/repo/reports/build.md) are ready for review.", "All [feature checks](/repo/reports/check.md) passed verification."];
    const older = ["The build results (reports/build.md) are ready for review.", "All feature checks (reports/check.md) passed verification."];
    const screen = bullets(...older);
    expect(matchShortCodexAnswers(screen, [{ path: "older", text: answered(...older) }])).toBe("older");
    expect(matchShortCodexAnswers(screen, [{ path: "older", text: answered(...older) }, { path: "live", text: answered(...live) }])).toBeNull();
    // also with labels of a few letters, after many later answers, and with many links in one answer
    const terse = ["[Build](/repo/reports/feature-branch-build-results.md)", "[Checks](/repo/reports/feature-branch-check-results.md)"];
    const shownTerse = ["Build (reports/feature-branch-build-results.md)", "Checks (reports/feature-branch-check-results.md)"];
    expect(matchShortCodexAnswers(bullets(...shownTerse), [{ path: "older", text: answered(...shownTerse) }, { path: "live", text: answered(...terse) }])).toBeNull();
    expect(matchShortCodexAnswers(screen, [{ path: "older", text: answered(...older) }, { path: "live", text: answered(...live, ...Array.from({ length: 220 }, () => "Done.")) }])).toBeNull();
    // a linked answer of another rollout that says something else vetoes nothing
    expect(matchShortCodexAnswers(screen, [{ path: "older", text: answered(...older) }, { path: "else", text: answered("See [the notes](docs/notes.md) for the migration plan.") }])).toBe("older");
  });

  it("reads no short answers when a rollout was not read whole, the one that shows them included", () => {
    const texts = ["The build finished without errors this time.", "All checks on the feature branch pass again."];
    const screen = bullets(...texts);
    expect(matchShortCodexAnswers(screen, [{ path: "only", text: answered(...texts) }])).toBe("only");
    expect(matchShortCodexAnswers(screen, [{ path: "only", text: answered(...texts), cut: true }])).toBeNull();
    expect(matchShortCodexAnswers(screen, [{ path: "only", text: answered(...texts) }, { path: "other", text: answered("Done."), cut: true }])).toBeNull();
  });

  it("does not read short answers when two rollouts show that way, sharing nothing", () => {
    const first = ["The build finished without errors.", "All checks on the feature branch pass again."];
    const second = ["Updated the README", migrated];
    const candidates = [{ path: "first", text: answered(...first) }, { path: "second", text: answered(...second) }];
    // the second's answers below, and the first's between them: each is found bottom-up
    expect(matchShortCodexAnswers(bullets(first[0]!, second[0]!, first[1]!, second[1]!), candidates)).toBeNull();
    expect(matchShortCodexAnswers(bullets(second[0]!, second[1]!), candidates)).toBe("second");
  });

  it("reads short answers in bounded time however many unclosed links the answers hold", () => {
    const many = answered(...Array.from({ length: 450 }, () => "](".repeat(1000)));
    const candidates = Array.from({ length: 32 }, (_, index) => ({ path: `unclosed-${index}`, text: many }));
    const screen = Array.from({ length: 400 }, () => "q".repeat(120)).join("\n");
    const started = performance.now();
    expect(matchShortCodexAnswers(screen, candidates)).toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("reads short answers in bounded time however many links a large answer has", () => {
    const huge = answered("[abcdefghijklmnop](/a)".repeat(40_000));
    const candidates = Array.from({ length: 32 }, (_, index) => ({ path: `large-${index}`, text: huge }));
    const screen = Array.from({ length: 400 }, () => "q".repeat(120)).join("\n");
    const started = performance.now();
    expect(matchShortCodexAnswers(screen, candidates)).toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("does not bind using user context, tool output or a previous session above the welcome card", () => {
    expect(matchCodexTranscript(answer, [{ path: "user", text: jsonl(message("user", answer)) }])).toBeNull();
    expect(matchCodexTranscript(`${answer}\nOpenAI Codex (v1.0)\nNew session`, [{ path: "old", text: jsonl(message("assistant", answer)) }])).toBeNull();
  });
});

describe("Codex tool calls that failed, and patches", () => {
  it("reads a failure from the output Codex records, judging a completed script as a whole", () => {
    expect(codexCallFailed("Chunk ID: 1\nWall time: 0.0 seconds\nProcess exited with code 1\nOutput:\n")).toBe(true);
    expect(codexCallFailed("Process exited with code 0\nOutput:\nok")).toBe(false);
    expect(codexCallFailed('{"output":"boom","metadata":{"exit_code":2}}')).toBe(true);
    expect(codexCallFailed("Script failed\nError: x")).toBe(true);
    expect(codexCallFailed("apply_patch verification failed: Failed to find expected lines in /x")).toBe(true);
    expect(codexCallFailed("Script completed\nProcess exited with code 1")).toBe(false);
    expect(codexCallFailed("{\"accepted\":true}")).toBe(false);
  });

  it("marks the failed call and sums a patch up by its files", () => {
    const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** End Patch\n";
    const turns = parseCodexTranscript(jsonl(
      { type: "response_item", payload: { type: "custom_tool_call", call_id: "p", name: "apply_patch", input: patch } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "p", output: "Success. Updated the following files:\nM src/a.ts" } },
      { type: "response_item", payload: { type: "function_call", call_id: "c", name: "exec_command", arguments: JSON.stringify({ cmd: "false" }) } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "c", output: "Process exited with code 1\nOutput:\n" } },
    ));
    const tools = turns.flatMap((turn) => turn.parts).filter((part) => part.kind === "tool");
    expect(tools.map((tool) => [tool.summary, tool.error === true])).toEqual([["src/a.ts", false], ["false", true]]);
  });
});

describe("incremental Codex records", () => {
  it("pairs duplicates and tool results across writes without mutating earlier snapshots", async () => {
    const { createCodexTranscriptParser } = await import("./codex.ts");
    const parser = createCodexTranscriptParser();
    const first = jsonl(event({ type: "task_started" }), message("user", "Inspect"), item({ type: "function_call", call_id: "long", name: "exec_command", arguments: '{"cmd":"pwd"}' }));
    parser.write(first);
    const previous = parser.snapshot();
    const previousJSON = JSON.stringify(previous);
    const second = jsonl(item({ type: "function_call_output", call_id: "long", output: "done" }), event({ type: "agent_message", message: "Finished" }));
    parser.write(second);
    const final = jsonl(message("assistant", "Finished", "final_answer"), event({ type: "task_complete" }));
    expect(parser.snapshot(final)).toEqual(parseCodexTranscript(`${first}\n${second}\n${final}`));
    expect(JSON.stringify(previous)).toBe(previousJSON);
    expect(parser.snapshot()).toEqual(parseCodexTranscript(`${first}\n${second}`));
    parser.write(final);
    expect(parser.snapshot()).toEqual(parseCodexTranscript(`${first}\n${second}\n${final}`));
    expect(parser.snapshot().at(-1)?.parts.at(-1)).toMatchObject({ phase: "final_answer", text: "Finished" });
  });
});
