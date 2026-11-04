import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer, type Socket as NetSocket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { UsageService } from "./usage.ts";

/**
 * A mirrored pane scrolled into its history, on the real server, in front of a stand-in herdr
 * on its own socket: herdr's own cannot be asked what it was sent, nor made to refuse a scroll.
 * herdr leaves its viewport where it is when a pane is typed into, so the server returns the
 * pane to the bottom first.
 */
const PANE = "w1:p1";
const MAX_OFFSET = 262;
const ROWS = 24;

interface Request { method: string; params: any }

function standInHerdr(address: string, cwd: string) {
  const state = { offset: 0, refuseScroll: false, log: [] as Request[] };
  const scroll = () => ({ offset_from_bottom: state.offset, max_offset_from_bottom: MAX_OFFSET, viewport_rows: ROWS });
  const snapshot = {
    version: "0.9.5", protocol: 1, agents: [], focused_pane_id: PANE, focused_tab_id: "w1:t1", focused_workspace_id: "w1",
    workspaces: [{ workspace_id: "w1", label: "mirror-scroll", number: 1, focused: true, active_tab_id: "w1:t1", agent_status: "idle", pane_count: 1, tab_count: 1 }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "mirror-scroll", number: 1, focused: true, agent_status: "idle", pane_count: 1 }],
    panes: [{ pane_id: PANE, tab_id: "w1:t1", workspace_id: "w1", terminal_id: "terminal-1", focused: true, agent_status: "idle", revision: 1, cwd }],
    layouts: [{ workspace_id: "w1", tab_id: "w1:t1", focused_pane_id: PANE, zoomed: false, splits: [], area: { x: 0, y: 0, width: 80, height: ROWS },
      panes: [{ pane_id: PANE, focused: true, rect: { x: 0, y: 0, width: 80, height: ROWS } }] }],
  };
  const answer = (method: string, params: any): object => {
    if (method === "ping") return { result: { version: "0.9.5", protocol: 1, capabilities: { direct_terminal_attach: false } } };
    if (method === "session.snapshot") return { result: { snapshot } };
    if (method === "pane.send_text" || method === "pane.send_keys") return { result: {} };
    if (method === "pane.get" && params?.pane_id === PANE) return { result: { pane: { ...snapshot.panes[0], scroll: scroll() } } };
    if (method === "pane.scroll" && params?.pane_id === PANE) {
      if (state.refuseScroll) return { error: { code: "scroll_refused", message: "refused by the stand-in herdr" } };
      state.offset = params.offset_from_bottom;
      return { result: { pane: { ...snapshot.panes[0], scroll: scroll() } } };
    }
    if (method === "pane.read" && params?.pane_id === PANE) {
      // the visible rows follow the viewport: offset 100 of 262 shows line 162 first
      const first = MAX_OFFSET - state.offset;
      const text = Array.from({ length: ROWS }, (_, row) => `line ${first + row}`).join("\n");
      return { result: { read: { format: params.format, pane_id: PANE, revision: 1, source: params.source, tab_id: "w1:t1", workspace_id: "w1", truncated: false, text } } };
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
      // a subscription stays open and says nothing more
      if (request.method === "events.subscribe") { socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`); return; }
      state.log.push({ method: request.method, params: request.params });
      socket.end(`${JSON.stringify({ id: request.id, ...answer(request.method, request.params) })}\n`);
    });
  });
  return {
    state,
    listen: () => new Promise<void>((done, fail) => { server.once("error", fail); server.listen(address, () => done()); }),
    close: () => new Promise<void>((done) => { for (const socket of open) socket.destroy(); server.close(() => done()); }),
  };
}

const root = mkdtempSync(join(tmpdir(), "termweave-mirror-scroll-"));
const address = process.platform === "win32" ? `\\\\.\\pipe\\termweave-mirror-scroll-${process.pid}-${Date.now().toString(36)}` : join(root, "herdr.sock");
const herdr = standInHerdr(address, root);
const previousSocket = process.env["HERDR_SOCKET"];
let server: ReturnType<typeof createServer>;
let socket: WebSocket;
const seen: any[] = [];

async function until(what: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** what the pane was sent from `from` on: its scrolls and its input, in order */
const sent = (from: number) => herdr.state.log.slice(from)
  .filter((entry) => entry.method === "pane.scroll" || entry.method === "pane.send_text" || entry.method === "pane.send_keys")
  .map((entry) => entry.method === "pane.scroll" ? `scroll ${entry.params.offset_from_bottom}`
    : entry.method === "pane.send_text" ? `text ${entry.params.text}` : `keys ${entry.params.keys.join(" ")}`);
const inputs = (from: number) => sent(from).filter((entry) => !entry.startsWith("scroll"));

async function scrollTo(offset: number): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/scroll`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pane_id: PANE, offset_from_bottom: offset }),
  });
  expect(response.status).toBe(200);
  expect(((await response.json()) as { scroll: { offset_from_bottom: number } }).scroll.offset_from_bottom).toBe(offset);
}

beforeAll(async () => {
  await herdr.listen();
  process.env["HERDR_SOCKET"] = address;
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), terminalAttach: false, machines: false,
    tailscaleOwner: null, usage: new UsageService(undefined, []) });
  socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  socket.addEventListener("message", (event) => seen.push(JSON.parse(String(event.data))));
  await until("the snapshot", () => seen.some((frame) => frame.type === "snapshot"));
  socket.send(JSON.stringify({ type: "attach", pane_id: PANE, cols: 80, rows: ROWS }));
  await until("the mirrored screen", () => seen.some((frame) => frame.type === "pty-data" && frame.data.includes(`line ${MAX_OFFSET}`)));
});

afterAll(async () => {
  socket?.close();
  server?.stop();
  if (previousSocket === undefined) delete process.env["HERDR_SOCKET"]; else process.env["HERDR_SOCKET"] = previousSocket;
  await herdr.close();
  rmSync(root, { recursive: true, force: true });
});

it("shows a scrolled mirror's history rows, read at once rather than at the next idle read", async () => {
  // an unchanged screen relaxes its reads to one per 400 ms: scrolled just after one, the next is that far away
  await Bun.sleep(1000);
  const reads = () => herdr.state.log.filter((entry) => entry.method === "pane.read").length;
  const before = reads();
  await until("an idle read", () => reads() > before);
  await Bun.sleep(30);
  const from = seen.length;
  const asked = Date.now();
  await scrollTo(100);
  await until("the scrolled screen", () => seen.slice(from).some((frame) => frame.type === "pty-data" && frame.data.includes("line 162")));
  // the poke reads within the echo delay
  expect(Date.now() - asked).toBeLessThan(200);
});

it("returns a scrolled mirror to the bottom before typing reaches it, and only once", async () => {
  await scrollTo(100);
  const from = herdr.state.log.length;
  socket.send(JSON.stringify({ type: "input", pane_id: PANE, text: "a" }));
  await until("the typed text", () => inputs(from).length === 1);
  socket.send(JSON.stringify({ type: "input", pane_id: PANE, text: "b" }));
  await until("the second typed text", () => inputs(from).length === 2);
  expect(sent(from)).toEqual(["scroll 0", "text a", "text b"]);
  expect(herdr.state.offset).toBe(0);
});

it("returns a scrolled mirror to the bottom before a key and an API input", async () => {
  let from: number;
  // a key herdr drops as text goes as its own key (a lone Esc, on Windows)
  if (process.platform === "win32") {
    await scrollTo(40);
    from = herdr.state.log.length;
    socket.send(JSON.stringify({ type: "input", pane_id: PANE, text: "\x1b" }));
    await until("the typed key", () => inputs(from).length === 1);
    expect(sent(from)).toEqual(["scroll 0", "keys esc"]);
  }

  await scrollTo(20);
  from = herdr.state.log.length;
  socket.send(JSON.stringify({ type: "keys", pane_id: PANE, keys: ["Enter"] }));
  await until("the key-bar key", () => inputs(from).length === 1);
  expect(sent(from)).toEqual(["scroll 0", "keys Enter"]);

  await scrollTo(30);
  from = herdr.state.log.length;
  const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/input`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pane_id: PANE, text: "ls" }),
  });
  expect(response.status).toBe(200);
  expect(sent(from)).toEqual(["scroll 0", "text ls"]);
});

it("still types into a scrolled mirror whose scroll back herdr refused", async () => {
  await scrollTo(60);
  herdr.state.refuseScroll = true;
  try {
    const from = herdr.state.log.length;
    socket.send(JSON.stringify({ type: "input", pane_id: PANE, text: "c" }));
    await until("the typed text", () => inputs(from).length === 1);
    expect(sent(from)).toEqual(["scroll 0", "text c"]);
    expect(seen.some((frame) => frame.type === "error" && frame.code === "input_failed")).toBe(false);
  } finally {
    herdr.state.refuseScroll = false;
  }
});
