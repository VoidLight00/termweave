import { afterAll, beforeAll, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import type { ConversationResponse } from "../shared/protocol.ts";

// Real herdr metadata + HTTP + native files, all under an owned workspace/store.
const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-codex-contract-"));
const codexHome = join(root, "codex");
const rollout = join(codexHome, "sessions", "rollout.jsonl");
const answerPrefix = "The native Codex conversation now preserves the actual user request and final response while removing internal instructions. ";
let workspaceId: string | undefined;
let paneId: string;
let server: ReturnType<typeof createServer>;
const transcript = (answer: string) => [
  { type: "session_meta", payload: { id: "01a0c7a1-56d9-7e20-9f08-f7a2d973bcbb", cwd: root } },
  { type: "turn_context", payload: { model: "codex-test-model", effort: "xhigh" } },
  { type: "response_item", timestamp: "2026-09-22T00:00:00Z", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "Hidden instructions" }] } },
  { type: "response_item", timestamp: "2026-09-22T00:00:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Check chat" }] } },
  { type: "response_item", timestamp: "2026-09-22T00:00:07Z", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: answer }] } },
].map((entry) => JSON.stringify(entry)).join("\n");

beforeAll(async () => {
  mkdirSync(join(codexHome, "sessions"), { recursive: true });
  const db = new Database(join(codexHome, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (rollout_path TEXT, cwd TEXT, archived INTEGER, agent_role TEXT, updated_at INTEGER)");
  db.query("INSERT INTO threads VALUES (?, ?, 0, NULL, 1)").run(rollout, root);
  db.close();
  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-codex-contract" });
  workspaceId = created.workspace.workspace_id;
  paneId = created.root_pane.pane_id;
  await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "codex", state: "idle", agent_session_path: rollout });
  await herdrRpc("pane.send_text", { pane_id: paneId, text: `printf '%s\\n' '${answerPrefix}Answer one' '${answerPrefix}Answer two'\n` });
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "push"), codexHome });
});

afterAll(async () => {
  server?.stop();
  if (workspaceId) await workspaceClose(workspaceId);
  rmSync(root, { recursive: true, force: true });
});

const read = async (): Promise<ConversationResponse> => {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`);
  expect(response.status).toBe(200);
  return await response.json() as ConversationResponse;
};

it("serves native Codex conversations and invalidates replaced files even at the same byte size", async () => {
  writeFileSync(rollout, transcript(`${answerPrefix}Answer one`));
  const first = await read();
  expect(first.source).toBe("codex-transcript");
  expect(first.history_id).toBeString();
  expect((await read()).history_id).toBe(first.history_id);
  expect(first.metadata).toEqual({ model: "codex-test-model", reasoning_effort: "xhigh" });
  expect((await read()).metadata).toEqual(first.metadata); // cached response keeps metadata
  expect(first.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  expect(JSON.stringify(first)).not.toContain("Hidden instructions");
  expect(first.turns.at(-1)?.parts[0]).toMatchObject({ text: `${answerPrefix}Answer one`, phase: "final_answer" });
  writeFileSync(`${rollout}.new`, transcript(`${answerPrefix}Answer two`));
  renameSync(`${rollout}.new`, rollout);
  const replaced = await read();
  expect(replaced.history_id).not.toBe(first.history_id);
  expect(replaced.turns.at(-1)?.parts[0]).toMatchObject({ text: `${answerPrefix}Answer two` });
  rmSync(rollout);
  expect(await read()).toEqual({ source: "scrollback", turns: [] });
});

it("answers an unchanged conversation with a bodyless 304 and a changed one in full", async () => {
  writeFileSync(rollout, transcript(`${answerPrefix}Answer one`));
  const url = `http://127.0.0.1:${server.port}/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`;
  const first = await fetch(url);
  const etag = first.headers.get("etag");
  expect(first.status).toBe(200);
  expect(etag).toMatch(/^"[\w-]+"$/);
  expect(first.headers.get("cache-control")).toBe("no-store");
  await first.json();
  const unchanged = await fetch(url, { headers: { "if-none-match": etag! } });
  expect(unchanged.status).toBe(304);
  expect(await unchanged.text()).toBe("");
  writeFileSync(rollout, transcript(`${answerPrefix}Answer two`));
  const changed = await fetch(url, { headers: { "if-none-match": etag! } });
  expect(changed.status).toBe(200);
  expect(changed.headers.get("etag")).not.toBe(etag);
  expect(((await changed.json()) as ConversationResponse).turns.at(-1)?.parts[0]).toMatchObject({ text: `${answerPrefix}Answer two` });
});

it("serves a native image-only Codex turn through the pane-scoped image API", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1sAAAAASUVORK5CYII=", "base64");
  const imagePath = join(root, "shot.png");
  writeFileSync(imagePath, png);
  writeFileSync(rollout, `${transcript(`${answerPrefix}Answer one`)}\n${JSON.stringify({ type: "event_msg", timestamp: "2026-09-27T00:00:00Z", payload: { type: "user_message", message: "", local_images: [imagePath] } })}`);
  const conversation = await read();
  const image = conversation.turns.at(-1)?.parts[0];
  expect(image?.kind).toBe("image");
  if (image?.kind !== "image") throw new Error("missing image");
  const url = `http://127.0.0.1:${server.port}/api/pane/conversation/image?${new URLSearchParams({ pane_id: paneId, ref: image.ref })}`;
  const response = await fetch(url);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
  writeFileSync(rollout, transcript(`${answerPrefix}Answer one`));
  expect((await fetch(url)).status).toBe(404);
});

it("serves skill activity without shipping the selected skill's instruction body", async () => {
  const envelope = { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<skill>\n<name>review</name>\n<path>/project/skills/review/SKILL.md</path>\nPRIVATE SKILL INSTRUCTIONS\n</skill>" }] } };
  writeFileSync(rollout, `${transcript(`${answerPrefix}Answer one`)}\n${JSON.stringify(envelope)}`);
  const conversation = await read();
  expect(conversation.source).toBe("codex-transcript");
  expect(conversation.turns.at(-1)?.parts).toContainEqual({ kind: "skill", skill: { name: "review", path: "/project/skills/review/SKILL.md", evidence: "instructions", status: "loaded" } });
  expect(JSON.stringify(conversation)).not.toContain("PRIVATE SKILL INSTRUCTIONS");
});
