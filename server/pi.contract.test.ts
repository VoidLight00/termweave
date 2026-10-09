import { afterAll, beforeAll, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer } from "./index.ts";
import { forgetPiModels } from "./pi-models.ts";
import { herdrRpc, sessionSnapshot, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import type { ConversationResponse } from "../shared/protocol.ts";

// Real herdr metadata + HTTP + native files, all under an owned workspace/store.
const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-pi-contract-"));
const sessionDir = join(root, ".pi", "agent", "sessions");
const slug = join(sessionDir, `--${root.replaceAll("/", "-")}--`);
const transcript = join(slug, "session.jsonl");
let workspaceId: string | undefined;
let paneId: string;
let server: ReturnType<typeof createServer>;
// herdr keeps one session report per pane and refuses one older than the last.
let seq = Date.now() * 1000;
const nextSeq = () => ++seq;
const reportSession = (path: string) =>
  herdrRpc("pane.report_agent_session", { pane_id: paneId, source: "herdr:pi", agent: "pi", seq: nextSeq(), agent_session_path: path, session_start_source: "startup" });

const page = (entries: unknown[]) => [
  { type: "session", version: 3, id: "session", timestamp: new Date().toISOString(), cwd: root },
  ...entries,
].map((entry) => JSON.stringify(entry)).join("\n") + "\n";

const turns = (prompt: string, answer: string) => page([
  { type: "model_change", id: "m1", parentId: null, timestamp: "2026-09-30T00:00:00Z", provider: "test", modelId: "pi-contract-model" },
  { type: "message", id: "u1", parentId: "m1", timestamp: "2026-09-30T00:00:01Z", message: { role: "user", content: [{ type: "text", text: prompt }] } },
  { type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-30T00:00:02Z", message: {
    role: "assistant", model: "pi-contract-model", provider: "test", stopReason: "stop",
    usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 0 },
    content: [{ type: "text", text: answer }],
  } },
]);

beforeAll(async () => {
  process.env["PI_CODING_AGENT_SESSION_DIR"] = sessionDir;
  mkdirSync(slug, { recursive: true });
  // herdr takes a session report only from an agent holding the pane: one it detected
  // running there, reporting under its own integration source. A fake pi stands in.
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const fakePi = join(bin, "pi");
  // Keep a single foreground interpreter: a shell loop creates a sleep child,
  // which can become the detector's selected foreground process under load.
  writeFileSync(fakePi, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`);
  chmodSync(fakePi, 0o755);
  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-pi-contract" });
  workspaceId = created.workspace.workspace_id;
  paneId = created.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: paneId, text: `${fakePi}\n` });
  let detected = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const pane = (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === paneId);
    if (pane?.agent === "pi") { detected = true; break; }
    await Bun.sleep(50);
  }
  expect(detected).toBe(true);
  await herdrRpc("pane.report_agent", { pane_id: paneId, source: "herdr:pi", agent: "pi", state: "idle", seq: nextSeq() });
  await reportSession(transcript);
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "push") });
});

afterAll(async () => {
  server?.stop();
  if (workspaceId) await workspaceClose(workspaceId);
  delete process.env["PI_CODING_AGENT_SESSION_DIR"];
  rmSync(root, { recursive: true, force: true });
});

const read = async (): Promise<ConversationResponse> => {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`);
  expect(response.status).toBe(200);
  return await response.json() as ConversationResponse;
};

it("serves a pi pane's native transcript over HTTP", async () => {
  writeFileSync(transcript, turns("Check chat", "Answer one"));
  const first = await read();
  expect(first.source).toBe("pi-transcript");  expect(first.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  expect(first.turns[0]!.parts).toEqual([{ kind: "text", text: "Check chat" }]);
  // the figure pi's own footer shows: input + output + both cache tiers
  // the figure pi's own footer shows: input + output + both cache tiers
  expect(first.metadata).toEqual({ model: "pi-contract-model", reasoning_effort: null, context: { used: 35, window: null } });
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

it("offers a tool's own picture over the image endpoint", async () => {
  writeFileSync(transcript, page([
    { type: "model_change", id: "m1", parentId: null, timestamp: "2026-09-30T00:00:00Z", provider: "test", modelId: "pi-contract-model" },
    { type: "message", id: "u1", parentId: "m1", timestamp: "2026-09-30T00:00:01Z", message: { role: "user", content: "open shot.png" } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-30T00:00:02Z", message: {
      role: "assistant", model: "pi-contract-model", provider: "test", stopReason: "toolUse", usage: { input: 4, output: 1 },
      content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "shot.png" } }],
    } },
    { type: "message", id: "r1", parentId: "a1", timestamp: "2026-09-30T00:00:03Z", message: {
      role: "toolResult", toolCallId: "call-1", toolName: "read",
      content: [{ type: "text", text: "read 1 image" }, { type: "image", mimeType: "image/png", data: PNG.toString("base64") }],
    } },
  ]));
  // the tests after this one read the session this file first held, so put it back
  try {
    const conversation = await read();
    const tool = conversation.turns.flatMap((turn) => turn.parts).find((part) => part.kind === "tool");
    expect(tool !== undefined && tool.kind === "tool" && tool.images).toEqual([{ media_type: "image/png", ref: "pi:call-1:0" }]);
    const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/conversation/image?pane_id=${encodeURIComponent(paneId)}&ref=${encodeURIComponent("pi:call-1:0")}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer()).equals(PNG)).toBe(true);
    // a ref naming no image, and one that is no pi ref at all
      const miss = await fetch(`http://127.0.0.1:${server.port}/api/pane/conversation/image?pane_id=${encodeURIComponent(paneId)}&ref=${encodeURIComponent("pi:call-9:0")}`);
      expect(miss.status).toBe(404);
  } finally {
    writeFileSync(transcript, turns("Check chat", "Answer one"));
  }
});

it("resolves pi's context window from the agent dir pi reads its models from", async () => {
  writeFileSync(transcript, turns("Check chat", "Answer one"));
  expect((await read()).metadata?.context?.window).toBeNull();
  // the window is nowhere in the transcript: pi's own catalog is the only disk answer for it
  const agentDir = join(root, "agent-dir");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { test: { models: [{ id: "pi-contract-model", contextWindow: 200_000 }] } } }));
  const previous = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  try {
    // the window is read as the metadata is rebuilt, so a new answer carries it
    writeFileSync(transcript, turns("Check chat twice", "Answer two"));
    const withWindow = await read();
    expect(withWindow.metadata?.context).toEqual({ used: 35, window: 200_000 });
  } finally {
    if (previous === undefined) delete process.env["PI_CODING_AGENT_DIR"]; else process.env["PI_CODING_AGENT_DIR"] = previous;
    forgetPiModels();
    // the tests after this one read the session this file first held
    writeFileSync(transcript, turns("Check chat", "Answer one"));
  }
});

it("follows the pane to a new session file when /new or /resume replaces it", async () => {  const before = await read();
  const replacement = join(slug, "replacement.jsonl");
  writeFileSync(replacement, turns("New topic", "Answer from the new session"));
  // pi emits no history marker: the integration re-reports the path herdr holds.
  await reportSession(replacement);
  const after = await read();
  expect(after.source).toBe("pi-transcript");
  expect(after.history_id).not.toBe(before.history_id);
  expect(after.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  expect(after.turns[0]!.parts).toEqual([{ kind: "text", text: "New topic" }]);
  // the previous conversation is gone: it lived in the abandoned file
  expect(JSON.stringify(after.turns)).not.toContain("Check chat");
});

it("shows the branch /tree leaves the leaf on, and invalidates the pages held before it", async () => {
  await reportSession(transcript); // /resume back to the session this pane began on
  const before = await read();
  expect(JSON.stringify(before.turns)).toContain("Answer one");
  // pi writes the new answer beside the old one, parented to the prompt, and moves the leaf
  const branched = [...turns("Check chat", "Answer one").trimEnd().split("\n")];
  const prompt = JSON.parse(branched[2]!);
  branched.push(JSON.stringify({
    type: "message", id: "a2", parentId: prompt.id, timestamp: new Date().toISOString(),
    message: { role: "assistant", model: "pi-contract-model", stopReason: "stop", content: [{ type: "text", text: "the retried answer" }] },
  }));
  writeFileSync(transcript, branched.join("\n") + "\n");
  const after = await read();
  expect(after.source).toBe("pi-transcript");
  expect(after.history_id).not.toBe(before.history_id); // same file, same size class: the tree moved
  expect(JSON.stringify(after.turns)).toContain("the retried answer");
  expect(JSON.stringify(after.turns)).not.toContain("Answer one");
});

it("counts the turns a /tree left behind, over HTTP", async () => {
  // shaped like a real file: a parentless model_change is where the first turns hang, and a
  // navigation re-hangs a new turn beside an abandoned one there, exactly as /tree leaves it
  writeFileSync(transcript, page([
    { type: "model_change", id: "m1", parentId: null, timestamp: "2026-09-30T00:00:00Z", provider: "test", modelId: "pi-contract-model" },
    { type: "message", id: "u1", parentId: "m1", timestamp: "2026-09-30T00:00:01Z", message: { role: "user", content: "the question" } },
    { type: "message", id: "a-gone", parentId: "u1", timestamp: "2026-09-30T00:00:02Z", message: { role: "assistant", content: "the abandoned answer" } },
    { type: "message", id: "u2", parentId: "m1", timestamp: "2026-09-30T00:00:03Z", message: { role: "user", content: "the retried question" } },
    { type: "message", id: "a-live", parentId: "u2", timestamp: "2026-09-30T00:00:04Z", message: { role: "assistant", content: "the answer in play" } },
  ]));
  const branched = await read();
  // pi moved its leaf and wrote nothing, so the page is built from the live branch alone; the
  // count is the only thing that can tell the reader the file holds more than this
  expect(JSON.stringify(branched.turns)).not.toContain("abandoned");
  expect(branched.abandoned).toEqual({ count: 2, branches: 1, summary: null });

  // answering /tree's "Summarize branch?" writes pi's own account of the abandoned path
  writeFileSync(transcript, page([
    { type: "model_change", id: "m1", parentId: null, timestamp: "2026-09-30T00:00:00Z", provider: "test", modelId: "pi-contract-model" },
    { type: "message", id: "u1", parentId: "m1", timestamp: "2026-09-30T00:00:01Z", message: { role: "user", content: "the question" } },
    { type: "message", id: "a-gone", parentId: "u1", timestamp: "2026-09-30T00:00:02Z", message: { role: "assistant", content: "the abandoned answer" } },
    { type: "branch_summary", id: "bs", parentId: "m1", timestamp: "2026-09-30T00:00:03Z", fromId: "a-gone", summary: "Tried the first question; it failed." },
    { type: "message", id: "u2", parentId: "bs", timestamp: "2026-09-30T00:00:04Z", message: { role: "user", content: "the retried question" } },
    { type: "message", id: "a-live", parentId: "u2", timestamp: "2026-09-30T00:00:05Z", message: { role: "assistant", content: "the answer in play" } },
  ]));
  expect((await read()).abandoned?.summary).toBe("Tried the first question; it failed.");

  // a session no /tree touched answers zero, not absent: the client shows nothing at 0
  writeFileSync(transcript, turns("Check chat", "Answer one"));
  expect((await read()).abandoned).toEqual({ count: 0, branches: 0, summary: null });
});

it("falls back to the scrollback when the reported path leaves the store", async () => {
  const outside = join(root, "outside.jsonl");
  writeFileSync(outside, turns("Must not be read", "no"));
  await reportSession(outside);
  const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ source: "scrollback", turns: [] });
});
