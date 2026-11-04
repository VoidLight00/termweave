import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaneMeshOwnership } from "../server/pane-mesh-ownership.ts";
import { resolveHerdrTaskOwner, taskOwnerGone } from "./pane-mesh-task.ts";

// server identity = Unix socket lstat; Windows fails closed by design (native_server_identity_unavailable, pinned below); covered by CI ubuntu/macos
const noServerIdentity = process.platform === "win32";

let root: string; let socketPath: string; let stateDir: string;
let listener: ReturnType<typeof Bun.listen>; let methods: string[];
let session = "session-1";
let moved = false;
const pane = () => ({ workspace_id: moved ? "w2" : "w1", tab_id: moved ? "t2" : "t1", pane_id: moved ? "w2:p9" : "w1:p1", terminal_id: "term-1",
  agent_session: { agent: "claude", kind: "id", source: "native", value: session } });
beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "mesh-cli-test-")); socketPath = join(root, "herdr.sock"); stateDir = join(root, "state"); methods = []; session = "session-1";
  moved = false;
  mkdirSync(join(root, "project"));
  listener = Bun.listen<{ buffer: string }>({ unix: socketPath, socket: {
    open(socket) { socket.data = { buffer: "" }; },
    data(socket, bytes) {
      socket.data.buffer += Buffer.from(bytes).toString();
      if (!socket.data.buffer.includes("\n")) return;
      const request = JSON.parse(socket.data.buffer) as { id: string; method: string };
      methods = [...methods, request.method];
      socket.end(`${JSON.stringify({ id: request.id, result: { snapshot: { panes: [pane()], agents: [], tabs: [], workspaces: [], layouts: [], protocol: 22, version: "fixture" } } })}\n`);
    },
  } });
});
afterEach(() => { listener.stop(true); rmSync(root, { recursive: true, force: true }); });
async function cli(action: string, more: string[] = [], identityFile?: string) {
  const process = Bun.spawn([globalThis.process.execPath, join(import.meta.dir, "pane-mesh-task.ts"), action,
    "--project", join(root, "project"), "--state-dir", stateDir, ...(action === "list" ? [] : ["--task", "one"]), ...more,
    ...(identityFile ? ["--identity-file", identityFile] : [])], {
    env: { ...globalThis.process.env, HERDR_SOCKET: socketPath, HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1" }, stdout: "pipe", stderr: "pipe",
  });
  return { code: await process.exited, out: await new Response(process.stdout).text(), err: await new Response(process.stderr).text() };
}
test.skipIf(noServerIdentity)("CLI resolves native identity, keeps token private, heartbeats and completes", async () => {
  const claimed = await cli("claim", ["--file", "new.ts"]); expect(claimed.code).toBe(0);
  const receipt = readdirSync(stateDir).find((name) => name.endsWith(".claim.json"))!;
  const token = JSON.parse(readFileSync(join(stateDir, receipt), "utf8")).token as string;
  expect(token).toHaveLength(64); expect(claimed.out + claimed.err).not.toContain(token);
  expect((await cli("heartbeat")).code).toBe(0);
  expect((await cli("complete")).code).toBe(0);
  expect((await cli("release")).err).toContain("task_completed");
  const listing = await cli("list"); expect(listing.out).not.toContain(token);
  expect(JSON.parse(listing.out)[0].status).toBe("completed");
  expect(methods.every((method) => method === "session.snapshot")).toBe(true);
});
test.skipIf(noServerIdentity)("CLI finds moved terminal from existing private receipt despite stale environment", async () => {
  expect((await cli("claim", ["--file", "new.ts"])).code).toBe(0);
  moved = true;
  const heartbeat = await cli("heartbeat"); expect(heartbeat.code).toBe(0);
  expect(JSON.parse(heartbeat.out).owner.paneId).toBe("w2:p9");
  expect((await cli("release")).code).toBe(0);
});
test.skipIf(noServerIdentity)("replacement session can reclaim released task despite historical receipts", async () => {
  expect((await cli("claim", ["--file", "new.ts"])).code).toBe(0);
  expect((await cli("release")).code).toBe(0);
  session = "session-2";
  expect((await cli("claim", ["--file", "new.ts"])).code).toBe(0);
  expect((await cli("heartbeat")).code).toBe(0);
  session = "session-1";
  expect((await cli("release")).code).toBe(1);
  session = "session-2";
  expect((await cli("release")).code).toBe(0);
});
test.skipIf(noServerIdentity)("CLI rejects a changed agent session instead of borrowing the prior token", async () => {
  expect((await cli("claim", ["--file", "new.ts"])).code).toBe(0);
  session = "session-2";
  expect((await cli("release")).code).toBe(1);
  const db = new PaneMeshOwnership({ stateDir }); try { expect(db.list(join(root, "project"))[0]?.status).toBe("active"); } finally { db.close(); }
});
test.skipIf(noServerIdentity)("explicit future-adapter identity must match live metadata", async () => {
  const old = { ...process.env };
  process.env.HERDR_SOCKET = socketPath; process.env.HERDR_PANE_ID = "w1:p1"; process.env.HERDR_WORKSPACE_ID = "w1";
  try {
    const owner = await resolveHerdrTaskOwner(); const identity = join(root, "identity.json");
    writeFileSync(identity, JSON.stringify(owner), { mode: 0o600 });
    expect((await cli("claim", ["--file", "new.ts"], identity)).code).toBe(0);
    moved = true;
    expect((await resolveHerdrTaskOwner()).paneId).toBe("w2:p9");
    expect((await resolveHerdrTaskOwner(owner)).paneId).toBe("w2:p9");
    expect((await cli("heartbeat", [], identity)).code).toBe(0);
    expect((await cli("complete", [], identity)).code).toBe(0);
    writeFileSync(identity, JSON.stringify({ ...owner, terminalId: "unknown" }));
    expect((await cli("heartbeat", [], identity)).err).toContain("unknown_identity");
  } finally {
    for (const key of ["HERDR_SOCKET", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID"]) {
      if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key];
    }
  }
});

test.if(process.platform === "win32")("Windows refuses task ownership without a native server identity and records nothing", async () => {
  const claimed = await cli("claim", ["--file", "new.ts"]);
  expect(claimed.code).toBe(1); expect(claimed.err).toBe("pane-mesh-task: native_server_identity_unavailable\n"); expect(claimed.out).toBe("");
  expect(readdirSync(stateDir)).toEqual([]); expect(methods).toEqual([]);
  await expect(resolveHerdrTaskOwner()).rejects.toThrow("native_server_identity_unavailable");
});

test("expired claim owner counts as gone only with live evidence", () => {
  const who = (serverId: string, terminalId = "term-1") => ({ backend: "herdr", serverId, workspaceId: "w1", tabId: "t1", paneId: "w1:p1",
    terminalId, agentSession: { agent: "claude", kind: "id", source: "native", value: "s" } });
  const server = (ino: number, ctime = 1, path = "/run/herdr.sock") => JSON.stringify([path, 1, ino, 100, ctime]);
  const live = new Set(["term-1"]);
  expect(taskOwnerGone(who(server(7)), who(server(7), "term-2"), live)).toBe(false);
  expect(taskOwnerGone(who(server(7), "term-9"), who(server(7)), live)).toBe(true);
  expect(taskOwnerGone(who(server(7)), who(server(7, 2)), live)).toBe(false);
  expect(taskOwnerGone(who(server(7)), who(server(8)), live)).toBe(true);
  expect(taskOwnerGone(who(server(7, 1, "/other.sock")), who(server(8)), live)).toBe(false);
  expect(taskOwnerGone(who("not json"), who(server(8)), live)).toBe(false);
});
