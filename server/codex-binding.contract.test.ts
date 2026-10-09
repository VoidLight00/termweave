import { afterAll, beforeAll, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc, paneRead, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import type { ConversationResponse } from "../shared/protocol.ts";

// Real herdr panes running a stand-in `codex` process: which rollout the chat reads
// while nothing Codex said is on screen.
const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-codex-binding-"));
const codexHome = join(root, "codex");
const threads = {
  resumed: "01a0c7a1-56d9-7e20-9f08-f7a2d973bc01",
  matched: "01a0c7a1-56d9-7e20-9f08-f7a2d973bc02",
  other: "01a0c7a1-56d9-7e20-9f08-f7a2d973bc03",
  fresh: "01a0c7a1-56d9-7e20-9f08-f7a2d973bc04",
  hinted: "01a0c7a1-56d9-7e20-9f08-f7a2d973bc05",
  short: "01a0c7a1-56d9-7e20-9f08-f7a2d973bc06",
};
// a session whose answers are all short (#283): none is an anchor alone
const shortAnswers = ["세 사진을 확인하고 한 장으로 합칠게요. 이미지 편집을 위해 imagegen 스킬을 사용할게요.", "세 화면이 모두 보이도록, 올려주신 순서대로 가로로 나란히 배치할게요."];
const answers = {
  resumed: "The resumed thread answers from its own rollout, found by the id on the command line without any screen match.",
  matched: "The matched thread was recognised on screen once, and stays bound while tool output scrolls its answer away.",
  other: "Another pane in the same repository started this thread later, and it is that pane's own conversation entirely.",
  fresh: "A third Codex pane started this fresh thread in the repository, and only the pane that typed its question owns it.",
  hinted: "Only herdr names this thread for its pane, and nothing on that pane's screen or in any other pane contradicts it.",
};
const workspaces: string[] = [];
let server: ReturnType<typeof createServer>;

const rollout = (name: keyof typeof answers) => {
  const path = join(codexHome, "sessions", `rollout-2026-09-24T00-00-00-${threads[name]}.jsonl`);
  writeFileSync(path, [
    { type: "session_meta", payload: { id: threads[name], cwd: root } },
    { type: "response_item", timestamp: "2026-09-24T00:00:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `question for ${name}` }] } },
    { type: "response_item", timestamp: "2026-09-24T00:00:05Z", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: answers[name] }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n"));
  return path;
};

/** Waits until the pane's foreground runs the stand-in codex (a shell can be slow to start). */
const codexRunning = async (paneId: string, not?: string): Promise<string> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const info = await herdrRpc<{ process_info?: { foreground_processes?: { pid: number; argv?: string[] }[] } }>("pane.process_info", { pane_id: paneId });
    const pids = (info.process_info?.foreground_processes ?? []).filter((process) => process.argv?.some((arg) => arg.endsWith("/codex"))).map((process) => String(process.pid)).join(",");
    if (pids !== "" && pids !== not) return pids;
    await Bun.sleep(100);
  }
  throw new Error(`no codex process in ${paneId}`);
};

const pane = async (label: string, command: string): Promise<string> => {
  const created = await workspaceCreate({ cwd: root, label: `herdr-web-ui-test-codex-binding-${label}` });
  workspaces.push(created.workspace.workspace_id);
  const paneId = created.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: paneId, text: `${command}\n` });
  await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "codex", state: "working" });
  await codexRunning(paneId);
  return paneId;
};

const read = async (paneId: string): Promise<ConversationResponse> => {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`);
  return await response.json() as ConversationResponse;
};
/** A thread row begun now in the panes' cwd, as /new starts one (or a subagent, or `codex exec`); returns its removal. */
let rows = 10;
const newerThread = (source = "cli", id = `01a0c7a1-56d9-7e20-9f08-f7a2d973bc${rows++}`, path = join(codexHome, "sessions", "missing.jsonl"), first: string | null = null): (() => void) => {
  const db = new Database(join(codexHome, "state_5.sqlite"));
  const now = Math.ceil(Date.now() / 1000) + 1;
  db.query("INSERT INTO threads VALUES (?, ?, ?, 0, NULL, ?, ?, ?, ?)").run(id, path, root, now, now, source, first);
  db.close();
  return () => {
    const db = new Database(join(codexHome, "state_5.sqlite"));
    db.query("DELETE FROM threads WHERE id = ?").run(id);
    db.close();
  };
};
/** Waits until the answer shows in the pane. */
const onScreen = async (paneId: string, answer: string): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const recent = await paneRead({ paneId, source: "recent", lines: 400, stripAnsi: true });
    if (recent.text.replace(/\s+/g, " ").includes(answer.slice(0, 48))) return;
    await Bun.sleep(100);
  }
  throw new Error(`the answer never showed in ${paneId}`);
};
/** Waits until the pane's flood has pushed the answer out of the 400 lines the match reads. */
const floodedAway = async (paneId: string, answer: string): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const recent = await paneRead({ paneId, source: "recent", lines: 400, stripAnsi: true });
    if (!recent.text.replace(/\s+/g, " ").includes(answer.slice(0, 48))) return;
    await Bun.sleep(100);
  }
  throw new Error(`the answer is still on screen in ${paneId}`);
};
/** What Codex's SessionStart hook tells herdr: the pane (from the hook's environment) runs this thread. */
const reportThread = (paneId: string, thread: string) =>
  herdrRpc("pane.report_agent_session", { pane_id: paneId, source: "herdr:codex", agent: "codex", seq: Date.now(), agent_session_id: thread });
const lastAnswer = (conversation: ConversationResponse) =>
  conversation.turns.at(-1)?.parts.map((part) => part.kind === "text" ? part.text : "").join("") ?? null;

beforeAll(() => {
  mkdirSync(join(codexHome, "sessions"), { recursive: true });
  const db = new Database(join(codexHome, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, archived INTEGER, agent_role TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, first_user_message TEXT)");
  for (const name of ["resumed", "matched"] as const) {
    db.query("INSERT INTO threads VALUES (?, ?, ?, 0, NULL, 1, 1, 'cli', ?)").run(threads[name], rollout(name), root, `question for ${name}`);
  }
  db.close();
  // a stand-in TUI: its command line names it codex; `--say` prints the matched answer
  // from a file (never from the typed command), then output floods the screen
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "matched.txt"), `${answers.matched}\n`);
  writeFileSync(join(root, "bin", "other.txt"), `${answers.other}\n`);
  writeFileSync(join(root, "bin", "fresh.txt"), `${answers.fresh}\n`);
  writeFileSync(join(root, "bin", "short.txt"), `${shortAnswers.join("\n")}\n`);
  const script = join(root, "bin", "codex");
  // `--say NAME` shows the question typed and its answer; `--quote NAME` only the answer, as
  // pasted; `--both NAME` the question and answer of NAME and the matched thread's answer too;
  // THEN=NAME shows NAME's answers after the flood
  writeFileSync(script, `#!/bin/sh\nname="\${2:-matched}"\n[ "$1" = --say ] || [ "$1" = --both ] && echo "› question for $name"\n[ "$1" = --say ] || [ "$1" = --quote ] || [ "$1" = --both ] && cat "$(dirname "$0")/$name.txt"\n[ "$1" = --both ] && cat "$(dirname "$0")/matched.txt"\nsleep "\${FLOOD_AFTER:-600}"\nseq 1 600\n[ -n "$THEN" ] && cat "$(dirname "$0")/$THEN.txt"\nsleep 600\n`);
  chmodSync(script, 0o755);
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "push"), codexHome });
});

afterAll(async () => {
  server?.stop();
  for (const id of workspaces) await workspaceClose(id);
  rmSync(root, { recursive: true, force: true });
});

it("reads the thread a Codex TUI was resumed on while none of its answers is on screen, until a newer thread begins", async () => {
  const paneId = await pane("resumed", `${join(root, "bin", "codex")} resume ${threads.resumed}`);
  const conversation = await read(paneId);
  expect(conversation.source).toBe("codex-transcript");
  expect(lastAnswer(conversation)).toBe(answers.resumed);
  // /new in that TUI (or any Codex in this cwd) starts a thread after it: the command
  // line no longer tells, and the chat says so rather than show the resumed thread
  const remove = newerThread();
  try {
    expect((await read(paneId)).source).toBe("scrollback");
  } finally {
    remove();
  }
});

it("keeps a matched rollout while tool output scrolls the answer away, and drops it for another process", async () => {
  const paneId = await pane("matched", `FLOOD_AFTER=3 ${join(root, "bin", "codex")} --say`);
  const first = await codexRunning(paneId);
  for (let attempt = 0; attempt < 30 && lastAnswer(await read(paneId)) !== answers.matched; attempt++) await Bun.sleep(100);
  expect(lastAnswer(await read(paneId))).toBe(answers.matched);
  // 600 lines of output: the answer is past the 400 the match reads
  await floodedAway(paneId, answers.matched);
  expect(lastAnswer(await read(paneId))).toBe(answers.matched);
  // another codex process in the pane is not the one that was matched
  await herdrRpc("pane.send_keys", { pane_id: paneId, keys: ["ctrl+c"] });
  await herdrRpc("pane.send_text", { pane_id: paneId, text: `${join(root, "bin", "codex")}\n` });
  await codexRunning(paneId, first);
  expect((await read(paneId)).source).toBe("scrollback");
}, 20_000);

it("reads a thread whose answers are all short by its newest answers on screen, and never rebinds a matched pane by them", async () => {
  const path = join(codexHome, "sessions", `rollout-2026-09-24T00-00-00-${threads.short}.jsonl`);
  writeFileSync(path, [
    { type: "session_meta", payload: { id: threads.short, cwd: root } },
    { type: "response_item", timestamp: "2026-09-24T00:00:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "question for short" }] } },
    ...shortAnswers.map((text) => ({ type: "response_item", timestamp: "2026-09-24T00:00:05Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } })),
  ].map((entry) => JSON.stringify(entry)).join("\n"));
  // an old thread: begun before any match, so no pane takes it for a /new
  const db = new Database(join(codexHome, "state_5.sqlite"));
  db.query("INSERT INTO threads VALUES (?, ?, ?, 0, NULL, 1, 1, 'cli', ?)").run(threads.short, path, root, "question for short");
  db.close();
  const opened = workspaces.length;
  try {
    const shortPane = await pane("short", `${join(root, "bin", "codex")} --quote short`);
    await onScreen(shortPane, shortAnswers[1]!);
    // both answers are one turn's
    expect(lastAnswer(await read(shortPane))).toBe(shortAnswers.join(""));
    // a thread of this cwd whose rollout is gone, or one continuing a rollout that is not found,
    // may be the pane's own and have said those lines: the chat cannot tell
    const thread = (id: string, rollout: string) => {
      const db = new Database(join(codexHome, "state_5.sqlite"));
      db.query("INSERT INTO threads VALUES (?, ?, ?, 0, NULL, 1, 1, 'cli', 'unread')").run(id, rollout, root);
      db.close();
      return () => {
        const db = new Database(join(codexHome, "state_5.sqlite"));
        db.query("DELETE FROM threads WHERE id = ?").run(id);
        db.close();
      };
    };
    const gone = thread("01a0c7a1-56d9-7e20-9f08-f7a2d973bd01", join(codexHome, "sessions", "rollout-2026-09-24T00-00-00-01a0c7a1-56d9-7e20-9f08-f7a2d973bd01.jsonl"));
    try { expect((await read(shortPane)).source).toBe("scrollback"); } finally { gone(); }
    expect((await read(shortPane)).source).toBe("codex-transcript");
    const forkId = "01a0c7a1-56d9-7e20-9f08-f7a2d973bd02";
    const fork = join(codexHome, "sessions", `rollout-2026-09-24T00-00-00-${forkId}.jsonl`);
    writeFileSync(fork, [
      { type: "session_meta", payload: { id: forkId, cwd: root, history_base: { thread_id: "01a0c7a1-56d9-7e20-9f08-f7a2d973bd03", end_ordinal_exclusive: 3, end_byte_offset: 400 } } },
      { type: "response_item", timestamp: "2026-09-24T00:00:05Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n"));
    const forked = thread(forkId, fork);
    try { expect((await read(shortPane)).source).toBe("scrollback"); } finally { forked(); }
    expect((await read(shortPane)).source).toBe("codex-transcript");
    // a pane a long answer bound keeps that rollout when another thread's short answers show later
    const bound = await pane("bound-short", `FLOOD_AFTER=3 THEN=short ${join(root, "bin", "codex")} --say`);
    for (let attempt = 0; attempt < 30 && lastAnswer(await read(bound)) !== answers.matched; attempt++) await Bun.sleep(100);
    expect(lastAnswer(await read(bound))).toBe(answers.matched);
    await floodedAway(bound, answers.matched);
    await onScreen(bound, shortAnswers[1]!);
    expect(lastAnswer(await read(bound))).toBe(answers.matched);
    // 32 threads updated since push the pane's own out of the ones looked at, and one of them
    // ends with the same short lines: the chat cannot tell, rather than show that one
    const db = new Database(join(codexHome, "state_5.sqlite"));
    for (let index = 0; index < 32; index++) {
      const id = `01a0c7a1-56d9-7e20-9f08-f7a2d973c${String(index).padStart(3, "0")}`;
      const later = join(codexHome, "sessions", `rollout-2026-09-25T00-00-00-${id}.jsonl`);
      writeFileSync(later, [
        { type: "session_meta", payload: { id, cwd: root } },
        ...(index === 0 ? shortAnswers : [`Unrelated answer number ${index}.`]).map((text) => ({ type: "response_item", timestamp: "2026-09-25T00:00:05Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } })),
      ].map((entry) => JSON.stringify(entry)).join("\n"));
      db.query("INSERT INTO threads VALUES (?, ?, ?, 0, NULL, 1, 9999999999, 'cli', 'later')").run(id, later, root);
    }
    db.close();
    expect((await read(shortPane)).source).toBe("scrollback");
  } finally {
    const db = new Database(join(codexHome, "state_5.sqlite"));
    db.query("DELETE FROM threads WHERE id = ? OR first_user_message = 'later'").run(threads.short);
    db.close();
    // the claim check looks at 8 other Codex panes in the cwd: leave the later tests theirs
    for (const id of workspaces.splice(opened)) await workspaceClose(id);
  }
}, 30_000);

it("drops a matched rollout once a newer interactive thread begins in its cwd, as /new does, not for a subagent or codex exec", async () => {
  const paneId = await pane("renewed", `FLOOD_AFTER=3 ${join(root, "bin", "codex")} --say`);
  for (let attempt = 0; attempt < 30 && lastAnswer(await read(paneId)) !== answers.matched; attempt++) await Bun.sleep(100);
  expect(lastAnswer(await read(paneId))).toBe(answers.matched);
  await floodedAway(paneId, answers.matched);
  // the pane's own subagent (agent_role NULL, as many are) and a `codex exec` in the repo
  const spawned = [
    newerThread(JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: threads.matched, depth: 1, agent_role: null } } })),
    newerThread("exec"),
  ];
  try {
    expect(lastAnswer(await read(paneId))).toBe(answers.matched);
    // the process now writes a thread begun after the match: the chat cannot tell which
    const remove = newerThread();
    try {
      expect((await read(paneId)).source).toBe("scrollback");
    } finally {
      remove();
    }
  } finally {
    for (const remove of spawned) remove();
  }
}, 30_000);

it("keeps a matched rollout when the newer thread shows in another Codex pane, whether or not its chat was opened", async () => {
  const paneId = await pane("mine", `FLOOD_AFTER=3 ${join(root, "bin", "codex")} --say`);
  for (let attempt = 0; attempt < 30 && lastAnswer(await read(paneId)) !== answers.matched; attempt++) await Bun.sleep(100);
  await floodedAway(paneId, answers.matched);
  const remove = newerThread("cli", threads.other, rollout("other"), "question for other");
  try {
    // no other Codex pane here shows that thread: this pane cannot tell it from its own /new
    expect((await read(paneId)).source).toBe("scrollback");
    // one that only shows its answer, pasted without the question typed there, does not claim it
    const quoting = await pane("quoting", `${join(root, "bin", "codex")} --quote other`);
    await onScreen(quoting, answers.other);
    expect((await read(paneId)).source).toBe("scrollback");
    // a second Codex in the same repo shows its answer, and nobody opens its chat
    const otherPane = await pane("theirs", `${join(root, "bin", "codex")} --say other`);
    await onScreen(otherPane, answers.other);
    expect(lastAnswer(await read(paneId))).toBe(answers.matched);
    // and the other pane was bound to its thread on the way
    expect(lastAnswer(await read(otherPane))).toBe(answers.other);
  } finally {
    remove();
  }
}, 30_000);

it("finds a pane's thread however many codex exec runs the repo had since", async () => {
  const paneId = await pane("burst", `${join(root, "bin", "codex")} --say`);
  await onScreen(paneId, answers.matched);
  const removes = Array.from({ length: 40 }, () => newerThread("exec"));
  try {
    expect(lastAnswer(await read(paneId))).toBe(answers.matched);
  } finally {
    for (const remove of removes) remove();
  }
}, 30_000);

it("claims nothing for a pane whose screen matches this pane's thread as well, nor for a closed pane", async () => {
  const paneId = await pane("unique", `FLOOD_AFTER=3 ${join(root, "bin", "codex")} --say`);
  for (let attempt = 0; attempt < 30 && lastAnswer(await read(paneId)) !== answers.matched; attempt++) await Bun.sleep(100);
  await floodedAway(paneId, answers.matched);
  const remove = newerThread("cli", threads.fresh, rollout("fresh"), "question for fresh");
  try {
    // shows the other thread's question and answer, and this pane's answer too: not unique
    const both = await pane("both", `${join(root, "bin", "codex")} --both fresh`);
    await onScreen(both, answers.fresh);
    expect((await read(paneId)).source).toBe("scrollback");
    await workspaceClose(workspaces.pop()!);
    // the pane that typed it claims it; once that pane is closed, its binding no longer counts
    const theirs = await pane("owner", `${join(root, "bin", "codex")} --say fresh`);
    await onScreen(theirs, answers.fresh);
    expect(lastAnswer(await read(paneId))).toBe(answers.matched);
    await workspaceClose(workspaces.pop()!);
    expect((await read(paneId)).source).toBe("scrollback");
  } finally {
    remove();
  }
}, 40_000);

it("takes the thread herdr has for a Codex pane as a hint: the shared daemon reports every TUI's thread to the pane that started it", async () => {
  const codex = join(root, "bin", "codex");
  const remove = newerThread("cli", threads.other, rollout("other"), "question for other");
  try {
    // the daemon's pane shows its own thread; a TUI resumed later reported its thread there
    const daemon = await pane("daemon", `${codex} --say other`);
    const resumed = await pane("resumer", `${codex} resume ${threads.resumed}`);
    await onScreen(daemon, answers.other);
    await reportThread(daemon, threads.resumed);
    expect((await herdrRpc<{ agent: { agent_session?: { value?: string } } }>("agent.get", { target: daemon })).agent.agent_session?.value).toBe(threads.resumed);
    expect(lastAnswer(await read(daemon))).toBe(answers.other);
    expect(lastAnswer(await read(resumed))).toBe(answers.resumed);
    // with nothing on screen, the thread another pane was resumed on is not this pane's
    const silent = await pane("silent", codex);
    await reportThread(silent, threads.resumed);
    expect((await read(silent)).source).toBe("scrollback");
  } finally {
    remove();
  }
  // and a thread nothing else owns is still read from the id alone, before any answer shows
  const db = new Database(join(codexHome, "state_5.sqlite"));
  db.query("INSERT INTO threads VALUES (?, ?, ?, 0, NULL, 1, 1, 'cli', ?)").run(threads.hinted, rollout("hinted"), root, "question for hinted");
  db.close();
  const alone = await pane("hinted", codex);
  await reportThread(alone, threads.hinted);
  expect(lastAnswer(await read(alone))).toBe(answers.hinted);
}, 40_000);
