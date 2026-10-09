import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc, sessionSnapshot } from "./herdr/client.ts";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";

/**
 * A live handoff (`herdr update --handoff`, `herdr server live-handoff`) moves every pane to a
 * new herdr server under a new terminal id and ends each `terminal attach` the way a pane that
 * exited ends it. A pane that lives on is attached again for the same clients; a pane that is
 * gone, or a server that does not come back, still ends the terminal.
 *
 * The handoff runs on a herdr of its own: replacing the shared test server would cut every
 * other suite's attach, and a failed one would leave them no herdr. That herdr keeps its
 * sessions in a config directory under /tmp, made for this run: a session directory holds
 * herdr's sockets, the longest of them `herdr-handoff-<pid>.sock`, and a Unix socket path
 * ends at 107 bytes (103 on macOS). Under CI's own config directory a second session name
 * was already too long for it, and the server died as it started.
 */
const SESSION = "handoff";
const config = mkdtempSync(process.platform === "win32" ? join(tmpdir(), "hwu-") : "/tmp/hwu-");
const socket = join(config, "herdr", "sessions", SESSION, "herdr.sock");
const herdr = process.env["HERDR_WEB_HERDR_BIN"] || Bun.which("herdr") || "herdr";
// run from inside a herdr pane, this process carries that pane's HERDR_* variables
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("HERDR_"))), XDG_CONFIG_HOME: config };

async function cli(...args: string[]): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn([herdr, "--session", SESSION, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, output: `${stdout}${stderr}`.trim() };
}

async function answers(): Promise<boolean> {
  try { await herdrRpc("ping", {}, socket, 2_000); return true; } catch { return false; }
}

async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(20);
  }
}

const root = mkdtempSync(join(tmpdir(), "herdr-reattach-"));
const sockets: WebSocket[] = [];
/** set once this file spawns its herdr: it is stopped again, whatever herdr supports */
let started = false;
/** the server this file spawned; a handoff replaces it with one of another pid */
let serverPid = 0;
let handoffs = false;
let previousSocket: string | undefined;
let server: ReturnType<typeof createServer>;
// a short relookup, for the server that does not come back
let quick: ReturnType<typeof createServer>;

async function startSession(): Promise<void> {
  mkdirSync(dirname(socket), { recursive: true });
  const log = join(dirname(socket), "test-server.log");
  started = true;
  const proc = Bun.spawn([herdr, "--session", SESSION, "server"], { stdin: "ignore", stdout: Bun.file(log), stderr: Bun.file(log), env });
  serverPid = proc.pid;
  proc.unref();
  try {
    await until(async () => existsSync(socket) && await answers(), "handoff session started", 15_000);
  } catch (error) {
    // the directory goes with the run: what herdr said goes into the failure
    const said = existsSync(log) ? readFileSync(log, "utf8").slice(-2_000) : "";
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${said}`);
  }
}

// registered before the server starts, so a start that fails still cleans up after itself
afterAll(async () => {
  for (const ws of sockets) ws.close();
  if (handoffs) {
    server.stop();
    quick.stop();
    if (previousSocket === undefined) delete process.env["HERDR_SOCKET"];
    else process.env["HERDR_SOCKET"] = previousSocket;
  }
  if (started) {
    if (await answers()) await cli("server", "stop");
    await until(async () => !(await answers()), "handoff session stopped").catch(() => {});
  }
  rmSync(config, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

// a herdr that cannot `terminal attach` (Windows) has no attach to end
if (process.env["HERDR_TEST_MODE"] !== "unit" && process.platform !== "win32" && Bun.which(herdr)) {
  await startSession();
  const pong = await herdrRpc<{ capabilities?: { live_handoff?: boolean } }>("ping", {}, socket);
  handoffs = pong.capabilities?.live_handoff === true;
}

beforeAll(() => {
  if (!handoffs) return;
  // the attach, the RPCs and the status collector all read HERDR_SOCKET when they start
  previousSocket = process.env["HERDR_SOCKET"];
  process.env["HERDR_SOCKET"] = socket;
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: root });
  quick = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: root, attachRelookupForMs: 1_000 });
});

function connect(port: number, paneId: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  sockets.push(ws);
  const state = { tail: "", ready: 0, exits: 0, errors: [] as string[] };
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as ServerMessage;
    if (frame.type === "error") state.errors.push(frame.code);
    if (frame.type === "pty-exit" && frame.pane_id === paneId) state.exits++;
    if (frame.type === "input-ready" && frame.pane_id === paneId && frame.ready !== false) state.ready++;
    if (frame.type === "pty-data" && frame.pane_id === paneId) state.tail = (state.tail + frame.data).slice(-8192);
  });
  const send = (message: ClientMessage) => ws.send(JSON.stringify(message));
  const open = until(() => ws.readyState === WebSocket.OPEN, "socket open");
  return { state, send, open };
}

async function pane(label: string): Promise<string> {
  const created = await herdrRpc<{ root_pane: { pane_id: string } }>(
    "workspace.create", { label: `herdr-web-ui-test-${label}`, cwd: root, focus: false }, socket,
  );
  return created.root_pane.pane_id;
}

async function terminalOf(paneId: string): Promise<string | undefined> {
  const found = (await sessionSnapshot(socket)).panes.find((entry) => entry.pane_id === paneId);
  return (found as { terminal_id?: string } | undefined)?.terminal_id;
}

/** the attach-leak oracle: `herdr terminal attach <id>` processes still running (not their pty-host sidecars) */
async function attaches(terminalId: string): Promise<number> {
  const proc = Bun.spawn(["pgrep", "-f", `^[^ ]*herdr terminal attach ${terminalId}$`], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.split("\n").filter(Boolean).length;
}

async function attached(port: number, paneId: string) {
  const client = connect(port, paneId);
  await client.open;
  client.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
  await until(() => client.state.ready > 0, "attach took");
  return client;
}

describe.skipIf(!handoffs)("a pane herdr hands off to a new server", () => {
  // first: it stops the server this file spawned, which the handoff below replaces
  it("ends within the relookup window when herdr takes the lookup and never answers", async () => {
    const paneId = await pane("stall");
    const client = await attached(quick.port, paneId);
    const terminal = await terminalOf(paneId);
    await until(async () => (await attaches(terminal!)) === 1, "the attach runs");
    // a stopped herdr still accepts connections on its socket, and answers none of them
    process.kill(serverPid, "SIGSTOP");
    try {
      const killed = Bun.spawn(["pkill", "-f", `^[^ ]*herdr terminal attach ${terminal}$`]);
      await killed.exited;
      const startedAt = Date.now();
      // the 1 s window, not the RPC's own 10 s
      await until(() => client.state.exits === 1, "pty-exit once the relookup window ran out", 6_000);
      expect(Date.now() - startedAt).toBeLessThan(4_000);
    } finally {
      process.kill(serverPid, "SIGCONT");
    }
    await until(answers, "herdr answers again");
  }, 20_000);

  it("is attached again under its new terminal, for the same client, without ending", async () => {
    const paneId = await pane("handoff");
    const client = await attached(server.port, paneId);
    const before = await terminalOf(paneId);
    expect(before).toBeDefined();
    await until(async () => (await attaches(before!)) === 1, "the first attach runs");

    const handoff = await cli("server", "live-handoff", "--import-exe", herdr);
    expect(handoff.code, handoff.output).toBe(0);

    await until(() => client.state.ready >= 2, "attach took again after the handoff");
    const after = await terminalOf(paneId);
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    // typing reaches the same shell through the new terminal
    client.send({ type: "input", pane_id: paneId, text: "echo reattached-$((40+2))\r" });
    await until(() => client.state.tail.includes("reattached-42"), "the shell answers through the new attach");
    expect(client.state.exits).toBe(0);
    expect(client.state.errors).not.toContain("input_not_ready");
    // one attach, on the new terminal: the old one is gone, nothing leaked
    await until(async () => (await attaches(before!)) === 0, "no attach left on the old terminal", 5_000);
    expect(await attaches(after!)).toBe(1);
  }, 30_000);

  it("still ends at once when the pane itself exits", async () => {
    const paneId = await pane("exit");
    const client = await attached(server.port, paneId);
    const startedAt = Date.now();
    client.send({ type: "input", pane_id: paneId, text: "exit\r" });
    await until(() => client.state.exits === 1, "pty-exit for the pane that exited");
    // a gone pane is told at its first lookup, not after the whole relookup window
    expect(Date.now() - startedAt).toBeLessThan(2_500);
  }, 15_000);

  it("ends once the server does not come back", async () => {
    const paneId = await pane("stop");
    const client = await attached(quick.port, paneId);
    const stopped = await cli("server", "stop");
    expect(stopped.code, stopped.output).toBe(0);
    await until(() => client.state.exits === 1, "pty-exit after the relookups ran out", 8_000);
    await Bun.sleep(1_500);
    expect(client.state.exits).toBe(1);
  }, 20_000);
});
