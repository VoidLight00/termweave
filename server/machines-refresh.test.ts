import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Machine } from "../shared/machines.ts";
import type { ServerMessage, SessionSnapshot } from "../shared/protocol.ts";
import { CompletionTracker } from "./completion.ts";
import { MachineManager } from "./machines.ts";
import type { PushService } from "./push.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error("fixture did not reach the expected state");
}

function snapshot(agent_status = "working"): SessionSnapshot {
  return {
    protocol: 22, version: "fixture", workspaces: [], tabs: [], layouts: [], agents: [],
    panes: [{ pane_id: "fixture:p1", agent: "codex", agent_status, focused: false, revision: 1, tab_id: "fixture:t1", terminal_id: "fixture:terminal", workspace_id: "fixture" }],
  };
}

/** Actual RPC/HTTP responses wait at the server, after capturing their older state. */
function responses() {
  let current = snapshot();
  let hold = false;
  let calls = 0;
  const pending: (() => void)[] = [];
  return {
    read(): Promise<SessionSnapshot> {
      calls++;
      const captured = structuredClone(current);
      return new Promise((resolve) => { if (hold) pending.push(() => resolve(captured)); else resolve(captured); });
    },
    hold: () => { hold = true; },
    set: (next: SessionSnapshot) => { current = next; },
    calls: () => calls,
    waiting: () => pending.length,
    answer: () => pending.shift()!(),
    finish: () => { hold = false; while (pending.length) pending.shift()!(); },
  };
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "herdr-machine-refresh-"));
  const path = join(root, "herdr.sock");
  const local = responses();
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (!input.includes("\n")) return;
      const request = JSON.parse(input.split("\n")[0]!);
      if (request.method !== "session.snapshot") throw new Error(`unexpected fixture RPC: ${request.method}`);
      void local.read().then((captured) => socket.end(JSON.stringify({ id: request.id, result: { snapshot: captured } }) + "\n"));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  const previousSocket = process.env["HERDR_SOCKET"];
  process.env["HERDR_SOCKET"] = path;
  const push = { seed() {}, async onStatus() {}, async onEnded() {} } as unknown as PushService;
  const manager = new MachineManager(join(root, "state"), push, new CompletionTracker(null));
  cleanups.push(() => {
    manager.stop(); local.finish();
    for (const socket of sockets) socket.destroy();
    server.close();
    if (previousSocket === undefined) delete process.env["HERDR_SOCKET"];
    else process.env["HERDR_SOCKET"] = previousSocket;
    rmSync(root, { recursive: true, force: true });
  });
  await until(() => manager.list()[0]?.state === "connected");
  const drive = manager as unknown as {
    localBusy: boolean;
    machines: Map<string, TestRuntime>;
    runtime(machine: Machine): TestRuntime;
    refresh(runtime: TestRuntime): Promise<void>;
    observe(runtime: TestRuntime): Promise<void>;
    disconnect(runtime: TestRuntime): void;
  };
  const rosters: string[] = [];
  manager.subscribe((event) => {
    if (event.type === "machines") for (const machine of event.machines) {
      const status = machine.snapshot?.panes[0]?.agent_status;
      if (status) rosters.push(`${machine.id}:${status}`);
    }
  });
  return { manager, drive, local, rosters };
}

type TestRuntime = {
  machine: Machine;
  endpoint?: { url: string; token: string };
  ssh?: { close(): void; onExit?: () => void };
  generation: number;
  refreshing: boolean;
  refreshQueued: boolean;
  retry?: ReturnType<typeof setTimeout>;
};

async function remoteFixture() {
  const local = await fixture();
  const remote = responses();
  let observer: { send(data: string): unknown } | undefined;
  let observing = false;
  let httpStatus = 200;
  let sshCloses = 0;
  let terminalCloses = 0;
  const bridge = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(request, server) {
      if (request.headers.get("authorization") !== "Bearer fixture-token") return new Response(null, { status: 401 });
      if (new URL(request.url).pathname === "/ws") {
        if (server.upgrade(request)) return;
        return new Response(null, { status: 400 });
      }
      const status = httpStatus;
      return Response.json({ snapshot: await remote.read() }, { status });
    },
    websocket: { open(ws) { observer = ws; }, message(_ws, data) { observing = JSON.parse(String(data)).mode === "observe"; } },
  });
  cleanups.push(() => { remote.finish(); bridge.stop(true); });
  const runtime = local.drive.runtime({ id: "remote", name: "Fixture PC", kind: "ssh", enabled: true, state: "connecting", error: null, snapshot: null });
  runtime.endpoint = { url: `http://127.0.0.1:${bridge.port}`, token: "fixture-token" };
  runtime.ssh = { close() { sshCloses++; } };
  local.drive.machines.set(runtime.machine.id, runtime);
  await local.drive.observe(runtime);
  await until(() => observing);
  local.manager.trackTerminal(runtime.machine.id, () => { terminalCloses++; });
  return {
    ...local, remote, runtime, endpoint: runtime.endpoint,
    send: (message: ServerMessage) => observer!.send(JSON.stringify(message)),
    setHttpStatus: (status: number) => { httpStatus = status; },
    sshCloses: () => sshCloses,
    terminalCloses: () => terminalCloses,
  };
}

describe("machine snapshot refresh races", () => {
  it("keeps a newer local status and retries the invalidated snapshot", async () => {
    const { manager, drive, local, rosters } = await fixture();
    local.hold();
    const loading = manager.refreshLocal();
    await until(() => local.waiting() === 1);
    local.set(snapshot("blocked"));
    manager.localMessage({ type: "pane-status", pane_id: "fixture:p1", agent_status: "blocked" });
    manager.localMessage({ type: "pane-status", pane_id: "fixture:p1", agent_status: "working" });
    manager.localMessage({ type: "pane-status", pane_id: "fixture:p1", agent_status: "blocked" });
    rosters.length = 0;
    local.answer();
    await until(() => !drive.localBusy || local.waiting() === 1);
    expect(manager.list()[0]?.snapshot?.panes[0]?.agent_status).toBe("blocked");
    expect(local.calls()).toBe(3);
    local.answer();
    await loading;
    expect(rosters).not.toContain("local:working");
    expect(rosters).toContain("local:blocked");
  });

  it("queues a local structure refresh requested while another is pending", async () => {
    const { manager, drive, local } = await fixture();
    local.hold();
    const loading = manager.refreshLocal();
    await until(() => local.waiting() === 1);
    local.set({ ...snapshot("blocked"), panes: [] });
    manager.localMessage({ type: "session-changed" });
    local.answer();
    await until(() => !drive.localBusy || local.waiting() === 1);
    expect(local.calls()).toBe(3);
    local.answer();
    await loading;
    expect(manager.list()[0]?.snapshot?.panes).toEqual([]);
  });

  it("keeps a newer remote status and retries the invalidated HTTP snapshot", async () => {
    const { drive, rosters, remote, runtime, send } = await remoteFixture();
    remote.hold();
    const loading = drive.refresh(runtime);
    await until(() => remote.waiting() === 1);
    remote.set(snapshot("blocked"));
    send({ type: "pane-status", pane_id: "fixture:p1", agent_status: "blocked" });
    await until(() => runtime.machine.snapshot?.panes[0]?.agent_status === "blocked");
    rosters.length = 0;
    remote.answer();
    await until(() => !runtime.refreshing || remote.waiting() === 1);
    expect(runtime.machine.snapshot?.panes[0]?.agent_status).toBe("blocked");
    expect(remote.calls()).toBe(3);
    remote.answer();
    await loading;
    expect(rosters).not.toContain("remote:working");
    expect(rosters).toContain("remote:blocked");
  });

  it("preserves a streamed remote snapshot received during an HTTP load", async () => {
    const { drive, rosters, remote, runtime, send } = await remoteFixture();
    remote.hold();
    const loading = drive.refresh(runtime);
    await until(() => remote.waiting() === 1);
    remote.set(snapshot("blocked"));
    send({ type: "snapshot", snapshot: snapshot("blocked") });
    await until(() => runtime.machine.snapshot?.panes[0]?.agent_status === "blocked");
    rosters.length = 0;
    remote.answer();
    await until(() => !runtime.refreshing || remote.waiting() === 1);
    expect(runtime.machine.snapshot?.panes[0]?.agent_status).toBe("blocked");
    expect(remote.calls()).toBe(3);
    remote.answer();
    await loading;
    expect(rosters).toEqual(["local:working", "remote:blocked"]);
  });

  for (const event of ["pane-status", "snapshot"] as const) {
    it(`retries an obsolete remote error after a newer ${event} without disconnecting`, async () => {
      const { rosters, remote, runtime, endpoint, send, setHttpStatus, sshCloses, terminalCloses } = await remoteFixture();
      const generation = runtime.generation;
      remote.hold();
      setHttpStatus(503);
      // Use the observer's actual refresh().catch(lost) path, not a direct load.
      send({ type: "session-changed" });
      await until(() => remote.waiting() === 1);
      setHttpStatus(200);
      remote.set(snapshot("blocked"));
      send(event === "pane-status"
        ? { type: "pane-status", pane_id: "fixture:p1", agent_status: "blocked" }
        : { type: "snapshot", snapshot: snapshot("blocked") });
      await until(() => runtime.machine.snapshot?.panes[0]?.agent_status === "blocked");
      rosters.length = 0;
      remote.answer();
      await until(() => remote.waiting() === 1 || runtime.machine.state !== "connected");
      expect(remote.calls()).toBe(3);
      expect(runtime.machine.state).toBe("connected");
      expect(runtime.machine.error).toBeNull();
      expect(runtime.endpoint).toBe(endpoint);
      expect(runtime.generation).toBe(generation);
      expect(runtime.retry).toBeUndefined();
      expect(sshCloses()).toBe(0);
      expect(terminalCloses()).toBe(0);
      remote.answer();
      await until(() => !runtime.refreshing);
      expect(remote.calls()).toBe(3);
      expect(runtime.machine.state).toBe("connected");
      expect(runtime.machine.error).toBeNull();
      expect(runtime.machine.snapshot?.panes[0]?.agent_status).toBe("blocked");
      expect(runtime.retry).toBeUndefined();
      expect(sshCloses()).toBe(0);
      expect(terminalCloses()).toBe(0);
      expect(rosters).not.toContain("remote:working");
    });
  }

  it("reconnects after a current remote error from the observer", async () => {
    const { remote, runtime, send, setHttpStatus, sshCloses, terminalCloses } = await remoteFixture();
    remote.hold();
    setHttpStatus(503);
    send({ type: "session-changed" });
    await until(() => remote.waiting() === 1);
    remote.answer();
    await until(() => runtime.machine.state === "reconnecting");
    expect(remote.calls()).toBe(2);
    expect(runtime.machine.error).toBe("Remote herdr unavailable (503)");
    expect(runtime.endpoint).toBeUndefined();
    expect(runtime.retry).toBeDefined();
    expect(sshCloses()).toBe(1);
    expect(terminalCloses()).toBe(1);
  });

  it("does not swallow a current error after retrying an invalidated remote error", async () => {
    const { remote, runtime, send, setHttpStatus, sshCloses, terminalCloses } = await remoteFixture();
    remote.hold();
    setHttpStatus(503);
    send({ type: "session-changed" });
    await until(() => remote.waiting() === 1);
    send({ type: "pane-status", pane_id: "fixture:p1", agent_status: "blocked" });
    await until(() => runtime.machine.snapshot?.panes[0]?.agent_status === "blocked");
    remote.answer();
    await until(() => remote.waiting() === 1 || runtime.machine.state !== "connected");
    expect(remote.calls()).toBe(3);
    expect(runtime.machine.state).toBe("connected");
    expect(runtime.retry).toBeUndefined();
    expect(sshCloses()).toBe(0);
    expect(terminalCloses()).toBe(0);
    remote.answer();
    await until(() => runtime.machine.state === "reconnecting");
    expect(remote.calls()).toBe(3);
    expect(runtime.machine.error).toBe("Remote herdr unavailable (503)");
    expect(runtime.retry).toBeDefined();
    expect(sshCloses()).toBe(1);
    expect(terminalCloses()).toBe(1);
  });

  it("ignores an obsolete observer error after stop without retrying", async () => {
    const { manager, remote, runtime, send, setHttpStatus, sshCloses, terminalCloses } = await remoteFixture();
    remote.hold();
    setHttpStatus(503);
    send({ type: "session-changed" });
    await until(() => remote.waiting() === 1);
    send({ type: "pane-status", pane_id: "fixture:p1", agent_status: "blocked" });
    await until(() => runtime.machine.snapshot?.panes[0]?.agent_status === "blocked");
    manager.stop();
    remote.answer();
    await until(() => !runtime.refreshing);
    expect(remote.calls()).toBe(2);
    expect(runtime.machine.state).toBe("disconnected");
    expect(runtime.machine.error).toBeNull();
    expect(runtime.machine.snapshot?.panes[0]?.agent_status).toBe("blocked");
    expect(runtime.refreshQueued).toBe(false);
    expect(runtime.retry).toBeUndefined();
    expect(sshCloses()).toBe(1);
    expect(terminalCloses()).toBe(1);
  });

  it("ignores an old observer error while loading a replacement bridge", async () => {
    const { manager, drive, remote, runtime, endpoint, send, setHttpStatus, sshCloses, terminalCloses } = await remoteFixture();
    remote.hold();
    setHttpStatus(503);
    send({ type: "session-changed" });
    await until(() => remote.waiting() === 1);
    send({ type: "snapshot", snapshot: snapshot("blocked") });
    await until(() => runtime.machine.snapshot?.panes[0]?.agent_status === "blocked");
    drive.disconnect(runtime);
    const generation = runtime.generation;
    let replacementSshCloses = 0;
    let replacementTerminalCloses = 0;
    runtime.endpoint = endpoint;
    runtime.ssh = { close() { replacementSshCloses++; } };
    manager.trackTerminal(runtime.machine.id, () => { replacementTerminalCloses++; });
    setHttpStatus(200);
    remote.set(snapshot("blocked"));
    await drive.observe(runtime);
    remote.answer();
    await until(() => remote.waiting() === 1 || runtime.machine.state !== "connected");
    expect(remote.calls()).toBe(3);
    expect(runtime.machine.state).toBe("connected");
    remote.answer();
    await until(() => !runtime.refreshing);
    expect(remote.calls()).toBe(3);
    expect(runtime.machine.state).toBe("connected");
    expect(runtime.machine.error).toBeNull();
    expect(runtime.machine.snapshot?.panes[0]?.agent_status).toBe("blocked");
    expect(runtime.generation).toBe(generation);
    expect(runtime.endpoint).toBe(endpoint);
    expect(runtime.retry).toBeUndefined();
    expect(sshCloses()).toBe(1);
    expect(terminalCloses()).toBe(1);
    expect(replacementSshCloses).toBe(0);
    expect(replacementTerminalCloses).toBe(0);
  });

  it("drops a remote refresh and its queued retry when the bridge disconnects", async () => {
    const { drive, rosters, remote, runtime, send } = await remoteFixture();
    remote.hold();
    const loading = drive.refresh(runtime);
    await until(() => remote.waiting() === 1);
    send({ type: "pane-status", pane_id: "fixture:p1", agent_status: "blocked" });
    await until(() => runtime.machine.snapshot?.panes[0]?.agent_status === "blocked");
    drive.disconnect(runtime);
    rosters.length = 0;
    remote.answer();
    await loading;
    expect(remote.calls()).toBe(2);
    expect(runtime.machine.state).toBe("disconnected");
    expect(runtime.machine.snapshot?.panes[0]?.agent_status).toBe("blocked");
    expect(rosters).toEqual([]);
  });

  it("handles a replacement bridge's failed queued load with its own generation", async () => {
    const { drive, remote, runtime, endpoint, setHttpStatus } = await remoteFixture();
    remote.hold();
    const loading = drive.refresh(runtime);
    await until(() => remote.waiting() === 1);
    drive.disconnect(runtime);
    runtime.endpoint = endpoint;
    runtime.ssh = { close() {} };
    setHttpStatus(503);
    await drive.observe(runtime);
    remote.answer();
    await until(() => remote.waiting() === 1);
    expect(remote.calls()).toBe(3);
    remote.answer();
    // The old connection's caller cannot report an error for its replacement.
    expect(await loading.then(() => null, (error: unknown) => error)).toBeNull();
    await until(() => runtime.machine.state === "reconnecting");
    expect(runtime.machine.error).toBe("Remote herdr unavailable (503)");
  });

  it("stops a local refresh without publishing or retrying its pending response", async () => {
    const { manager, local, rosters } = await fixture();
    local.hold();
    const loading = manager.refreshLocal();
    await until(() => local.waiting() === 1);
    manager.localMessage({ type: "pane-status", pane_id: "fixture:p1", agent_status: "blocked" });
    manager.stop();
    rosters.length = 0;
    local.answer();
    await loading;
    expect(local.calls()).toBe(2);
    expect(manager.list()[0]?.snapshot?.panes[0]?.agent_status).toBe("blocked");
    expect(rosters).toEqual([]);
  });
});
