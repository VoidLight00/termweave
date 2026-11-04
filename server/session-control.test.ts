import { afterAll, beforeAll, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createNetServer, type Socket as NetSocket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { UsageService } from "./usage.ts";
import { sessionControlStandIn, type StandInEntry } from "./herdr/session-control-fixture.ts";

/**
 * Panes of a herdr that cannot attach (Windows), on the real server: each streams through
 * `herdr terminal session control` (a stand-in CLI, server/herdr/session-control-fixture.ts),
 * and one whose session control does not start is mirrored, in front of a stand-in herdr on its
 * own socket that records what it was sent.
 */
const PANES = {
  shell: { pane: "w1:p1", terminal: "terminal-1" },
  agent: { pane: "w1:p2", terminal: "terminal-2" },
  old: { pane: "w1:p3", terminal: "terminal-3" },
  held: { pane: "w1:p4", terminal: "terminal-4" },
};
const MODES = { [PANES.old.terminal]: "silent", [PANES.held.terminal]: "closed" };

interface Request { method: string; params: any }

function standInHerdr(address: string, cwd: string) {
  const log: Request[] = [];
  const panes = Object.values(PANES).map(({ pane, terminal }, index) => ({
    pane_id: pane, tab_id: "w1:t1", workspace_id: "w1", terminal_id: terminal, focused: index === 0, agent_status: "idle", revision: 1, cwd,
    ...(pane === PANES.agent.pane ? { agent: "claude" } : {}),
  }));
  const snapshot = {
    version: "0.9.5", protocol: 1, agents: [], focused_pane_id: PANES.shell.pane, focused_tab_id: "w1:t1", focused_workspace_id: "w1",
    workspaces: [{ workspace_id: "w1", label: "session-control", number: 1, focused: true, active_tab_id: "w1:t1", agent_status: "idle", pane_count: panes.length, tab_count: 1 }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "session-control", number: 1, focused: true, agent_status: "idle", pane_count: panes.length }],
    panes,
    layouts: [{ workspace_id: "w1", tab_id: "w1:t1", focused_pane_id: PANES.shell.pane, zoomed: false, splits: [], area: { x: 0, y: 0, width: 160, height: 48 },
      panes: panes.map((pane, index) => ({ pane_id: pane.pane_id, focused: index === 0, rect: { x: 0, y: 0, width: 80, height: 24 } })) }],
  };
  const answer = (method: string, params: any): object => {
    if (method === "ping") return { result: { version: "0.9.5", protocol: 1, capabilities: { direct_terminal_attach: false } } };
    if (method === "session.snapshot") return { result: { snapshot } };
    if (method === "pane.send_text" || method === "pane.send_keys") return { result: {} };
    if (method === "pane.read" && params?.pane_id === PANES.old.pane) {
      return { result: { read: { format: params.format, pane_id: PANES.old.pane, revision: 1, source: params.source, tab_id: "w1:t1", workspace_id: "w1", truncated: false, text: "mirrored screen" } } };
    }
    return { error: { code: method === "pane.read" ? "pane_not_found" : "unsupported", message: `the stand-in herdr does not answer ${method}` } };
  };
  const open = new Set<NetSocket>();
  const server = createNetServer((socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    socket.on("error", () => undefined);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const request = JSON.parse(buffer.slice(0, end)) as { id: string; method: string; params: any };
      buffer = buffer.slice(end + 1);
      if (request.method === "events.subscribe") { socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`); return; }
      log.push({ method: request.method, params: request.params });
      socket.end(`${JSON.stringify({ id: request.id, ...answer(request.method, request.params) })}\n`);
    });
  });
  return {
    log,
    listen: () => new Promise<void>((done, fail) => { server.once("error", fail); server.listen(address, () => done()); }),
    close: () => new Promise<void>((done) => { for (const socket of open) socket.destroy(); server.close(() => done()); }),
  };
}

const root = mkdtempSync(join(tmpdir(), "termweave-session-control-"));
const address = process.platform === "win32" ? `\\\\.\\pipe\\termweave-session-control-${process.pid}-${Date.now().toString(36)}` : join(root, "herdr.sock");
const herdr = standInHerdr(address, root);
const standInLog = join(root, "standin.log");
const saved = Object.fromEntries(["HERDR_SOCKET", "HERDR_WEB_HERDR_BIN", "STANDIN_LOG", "STANDIN_MODES"].map((name) => [name, process.env[name]]));
let server: ReturnType<typeof createServer>;

class Client {
  readonly seen: any[] = [];
  private constructor(readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => this.seen.push(JSON.parse(String(event.data))));
  }
  static async connect(): Promise<Client> {
    const client = new Client(new WebSocket(`ws://127.0.0.1:${server.port}/ws`));
    await until("the snapshot", () => client.seen.some((frame) => frame.type === "snapshot"));
    return client;
  }
  send(message: object): void { this.socket.send(JSON.stringify(message)); }
  frames(pane: string, type: string): any[] { return this.seen.filter((frame) => frame.pane_id === pane && frame.type === type); }
  output(pane: string): string { return this.frames(pane, "pty-data").map((frame) => frame.data).join(""); }
}

async function until(what: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

const entries = (terminal: string): StandInEntry[] => !existsSync(standInLog) ? [] : readFileSync(standInLog, "utf8").split("\n").filter(Boolean)
  .map((line) => JSON.parse(line) as StandInEntry).filter((entry) => entry.terminal === terminal);
/** what the stand-in CLI read for a terminal, as messages */
const read = (terminal: string): any[] => entries(terminal).flatMap((entry) => entry.line ? [JSON.parse(entry.line)] : []);
const inputs = (terminal: string): string[] => read(terminal).filter((message) => message.type === "terminal.input").map((message) => Buffer.from(message.bytes, "base64").toString("utf8"));

let first: Client;
let second: Client | undefined;

beforeAll(async () => {
  await herdr.listen();
  process.env["HERDR_SOCKET"] = address;
  process.env["HERDR_WEB_HERDR_BIN"] = sessionControlStandIn(join(root, "bin"));
  process.env["STANDIN_LOG"] = standInLog;
  process.env["STANDIN_MODES"] = JSON.stringify(MODES);
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), terminalAttach: false, terminalSession: true,
    machines: false, tailscaleOwner: null, usage: new UsageService(undefined, []), attachHeldRetryMs: 60_000 });
  first = await Client.connect();
  // building the stand-in, and its first start, take a few seconds
}, 60_000);

afterAll(async () => {
  first?.socket.close();
  second?.socket.close();
  server?.stop();
  for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  await herdr.close();
  // the released stand-ins have exited by now; a Windows file in use would only keep the temp dir
  await Bun.sleep(200);
  rmSync(root, { recursive: true, force: true });
});

it("streams a pane herdr cannot attach through session control, at the browser's grid, and says so", async () => {
  const { pane, terminal } = PANES.shell;
  first.send({ type: "attach", pane_id: pane, cols: 100, rows: 30 });
  await until("the streamed screen", () => first.output(pane).includes(`screen of ${terminal} 한글`));
  await until("input-ready", () => first.frames(pane, "input-ready").length > 0);
  expect(first.frames(pane, "input-ready")[0]).toEqual({ type: "input-ready", pane_id: pane, session: true });
  // the grid is the browser's: nothing fixed is sent, and herdr starts at its size, on the RPCs' socket
  expect(first.frames(pane, "pane-geometry").some((frame) => frame.fixed)).toBe(false);
  expect(entries(terminal)[0]).toEqual({ terminal, argv: ["terminal", "session", "control", terminal, "--cols", "100", "--rows", "30"], socket: address });
  await until("the partial frame", () => first.output(pane).includes("\x1b[2;1Hpartial"));
});

it("types raw bytes into the stream, never through herdr's send_text", async () => {
  const { pane, terminal } = PANES.shell;
  const before = herdr.log.length;
  first.send({ type: "input", pane_id: pane, text: "a" });
  first.send({ type: "input", pane_id: pane, text: "\x03" });
  first.send({ type: "input", pane_id: pane, text: "\x1b" });
  // a pasted block for a pane without an agent goes as it came
  first.send({ type: "input", pane_id: pane, text: "one\rtwo" });
  await until("the typed bytes", () => inputs(terminal).length === 4);
  expect(inputs(terminal)).toEqual(["a", "\x03", "\x1b", "one\rtwo"]);
  expect(herdr.log.slice(before).filter((entry) => entry.method === "pane.send_text" || entry.method === "pane.send_keys")).toEqual([]);
});

it("resizes the stream with the browser, and scrolls it with the wheel", async () => {
  const { pane, terminal } = PANES.shell;
  first.send({ type: "resize", pane_id: pane, cols: 90, rows: 20 });
  await until("the resized screen", () => first.output(pane).includes("size 90x20"));
  first.send({ type: "scroll", pane_id: pane, direction: "up", lines: 3, column: 5, row: 7 });
  first.send({ type: "scroll", pane_id: pane, direction: "sideways", lines: 3, column: 5, row: 7 });
  first.send({ type: "scroll", pane_id: pane, direction: "down", lines: 0, column: 5, row: 7 });
  await until("the wheel", () => read(terminal).some((message) => message.type === "terminal.scroll"));
  await until("two refusals", () => first.seen.filter((frame) => frame.type === "error" && frame.code === "invalid_scroll").length === 2);
  expect(read(terminal).filter((message) => message.type !== "terminal.input")).toEqual([
    { type: "terminal.resize", cols: 90, rows: 20 },
    { type: "terminal.scroll", direction: "up", lines: 3, column: 5, row: 7 },
  ]);
});

it("hands a late joiner the screen from the last full frame on", async () => {
  const { pane } = PANES.shell;
  second = await Client.connect();
  second.send({ type: "attach", pane_id: pane, cols: 90, rows: 20 });
  await until("the joiner's screen", () => second!.frames(pane, "pty-data").length > 0);
  expect(second.frames(pane, "pty-data")[0].data).toStartWith("\x1b[2J\x1b[1;1Hsize 90x20");
  await until("the joiner's input-ready", () => second!.frames(pane, "input-ready").length > 0);
  expect(second.frames(pane, "input-ready")[0].session).toBe(true);
});

it("wraps a block pasted into an agent's pane in paste markers: the stream carries no paste mode", async () => {
  const { pane, terminal } = PANES.agent;
  first.send({ type: "attach", pane_id: pane, cols: 100, rows: 30 });
  await until("input-ready", () => first.frames(pane, "input-ready").length > 0);
  first.send({ type: "input", pane_id: pane, text: "line one\rline two" });
  first.send({ type: "input", pane_id: pane, text: "\r" });
  await until("the paste and its Enter", () => inputs(terminal).length === 2);
  expect(inputs(terminal)).toEqual(["\x1b[200~line one\rline two\x1b[201~", "\r"]);
});

it("mirrors a pane whose session control does not start", async () => {
  const { pane, terminal } = PANES.old;
  first.send({ type: "attach", pane_id: pane, cols: 100, rows: 30 });
  await until("the mirrored screen", () => first.output(pane).includes("mirrored screen"));
  expect(entries(terminal)).toHaveLength(1);
  expect(first.frames(pane, "pane-geometry")).toContainEqual({ type: "pane-geometry", pane_id: pane, cols: 80, rows: 24, fixed: true });
  await until("input-ready", () => first.frames(pane, "input-ready").length > 0);
  expect(first.frames(pane, "input-ready").every((frame) => frame.session === undefined)).toBe(true);
  // typing goes the mirror's way; a wheel message for it is not the stream's
  const before = herdr.log.length;
  first.send({ type: "scroll", pane_id: pane, direction: "up", lines: 3, column: 1, row: 1 });
  first.send({ type: "input", pane_id: pane, text: "ls" });
  await until("the mirrored input", () => herdr.log.slice(before).some((entry) => entry.method === "pane.send_text"));
  expect(herdr.log.slice(before).find((entry) => entry.method === "pane.send_text")?.params.text).toBe("ls");
});

it("waits for a terminal another client controls, as for a held attach", async () => {
  const { pane } = PANES.held;
  first.send({ type: "attach", pane_id: pane, cols: 100, rows: 30 });
  await until("attach_held", () => first.seen.some((frame) => frame.type === "error" && frame.code === "attach_held" && frame.pane_id === pane));
  expect(first.frames(pane, "input-ready")).toEqual([]);
  expect(first.frames(pane, "pty-exit")).toEqual([]);
  first.send({ type: "detach", pane_id: pane });
});

it("lets go of the terminal when its last client leaves", async () => {
  const { pane, terminal } = PANES.shell;
  first.send({ type: "detach", pane_id: pane });
  await Bun.sleep(200);
  expect(read(terminal).some((message) => message.type === "terminal.release")).toBe(false);
  second!.send({ type: "detach", pane_id: pane });
  await until("the release", () => read(terminal).some((message) => message.type === "terminal.release"));
});
