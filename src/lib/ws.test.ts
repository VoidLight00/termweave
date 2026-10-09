import { afterAll, beforeAll, expect, it } from "bun:test";
import { HerdrSocket } from "./ws.ts";

/** A WebSocket the test drives: it opens, receives and records what the client sends. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static last: FakeSocket;
  readyState = FakeSocket.CONNECTING;
  readonly sent: { type: string; [key: string]: unknown }[] = [];
  private readonly listeners = new Map<string, ((event: any) => void)[]>();
  constructor(readonly url: string) { FakeSocket.last = this; }
  addEventListener(type: string, listener: (event: any) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(): void { this.readyState = 3; }
  private emit(type: string, event: unknown): void { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  open(): void { this.readyState = FakeSocket.OPEN; this.emit("open", {}); }
  disconnect(): void { this.readyState = 3; this.emit('close', { code: 1006 }); }
  receive(message: unknown): void { this.emit("message", { data: JSON.stringify(message) }); }
}

const globals = globalThis as unknown as { WebSocket?: unknown; window?: unknown };
const before = { WebSocket: globals.WebSocket, window: globals.window };
beforeAll(() => { globals.WebSocket = FakeSocket; globals.window = globalThis; });
afterAll(() => { globals.WebSocket = before.WebSocket; globals.window = before.window; });

const snapshot = (features: string[]) => ({ type: "snapshot", snapshot: { workspaces: [], panes: [], agents: [], layouts: [] }, features });
const secrets = (socket: FakeSocket) => socket.sent.filter((frame) => frame.type === "secret");

it("sends a secret entered before the reconnect's snapshot arrived, once the snapshot lists masked input", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  // terminal output is already on screen and the masked field is up; the snapshot is still on its way
  const result = client.sendSecret("w1:p1", "Password:", "hunter2");
  expect(result).not.toBeNull();
  await Promise.resolve();
  expect(secrets(socket)).toEqual([]);
  socket.receive(snapshot(["submit", "secret-input"]));
  // the secret goes out as soon as the snapshot is in, not at the wait's deadline
  for (let turn = 0; turn < 10 && secrets(socket).length === 0; turn++) await Promise.resolve();
  expect(secrets(socket)).toMatchObject([{ type: "secret", pane_id: "w1:p1", prompt: "Password:", secret: "hunter2" }]);
  socket.receive({ type: "secret-result", id: secrets(socket)[0]!["id"], pane_id: "w1:p1", ok: true });
  expect(await result).toEqual({ ok: true });
  client.close();
});

it("answers unsupported, sending nothing, when the snapshot lists no masked input", async () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["submit"]));
  expect(await client.sendSecret("w1:p1", "Password:", "hunter2")).toMatchObject({ ok: false, code: "unsupported" });
  expect(secrets(socket)).toEqual([]);
  client.close();
});

it("requires attachment readiness and never replays held input after a detach", () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(snapshot(["submit", "input-ready"]));
  client.attach("w1:p1", 80, 24);
  expect(client.sendInput("w1:p1", "lost?")).toBe(false);
  socket.receive({ type: "pty-data", pane_id: "w1:p1", data: "screen" });
  expect(client.canInput("w1:p1")).toBe(false);
  socket.receive({ type: "input-ready", pane_id: "w1:p1" });
  expect(client.sendInput("w1:p1", "한글")).toBe(true);
  client.detach("w1:p1");
  socket.receive({ type: "input-ready", pane_id: "w1:p1" });
  expect(client.sendInput("w1:p1", "wrong pane")).toBe(false);
  expect(socket.sent.filter((m) => m.type === "input")).toEqual([{ type: "input", pane_id: "w1:p1", text: "한글" }]);
  client.close();
});

it("attaches a grid the chat lens covers without resizing the shared pty, on a reconnect too, until it drives the size again", () => {
  const client = new HerdrSocket("ws://test/ws");
  client.connect();
  const socket = FakeSocket.last;
  const lastAttach = () => socket.sent.filter((m) => m.type === "attach").at(-1);
  // attached before the socket opened: the open replays it, as a reconnect does
  client.attach("w1:p1", 40, 20, true);
  socket.open();
  expect(lastAttach()).toEqual({ type: "attach", pane_id: "w1:p1", cols: 40, rows: 20, flow_control: "ack", keep_size: true });
  // the terminal lens is shown and resizes: from then on it drives the size
  client.resize("w1:p1", 100, 30, true);
  socket.open();
  expect(lastAttach()).toEqual({ type: "attach", pane_id: "w1:p1", cols: 100, rows: 30, flow_control: "ack" });
  // the chat lens covers it again
  client.keepSize("w1:p1");
  socket.open();
  expect(lastAttach()).toEqual({ type: "attach", pane_id: "w1:p1", cols: 100, rows: 30, flow_control: "ack", keep_size: true });
  client.close();
});

it("waits for capabilities when output precedes snapshot, and supports old bridges", () => {
  for (const features of [["input-ready"], []]) {
    const client = new HerdrSocket("ws://test/ws"); client.connect();
    const socket = FakeSocket.last; socket.open(); client.attach("w1:p1", 80, 24);
    socket.receive({ type: "pty-data", pane_id: "w1:p1", data: "screen" });
    expect(client.canInput("w1:p1")).toBe(false);
    socket.receive(snapshot(features));
    expect(client.canInput("w1:p1")).toBe(features.length === 0);
    socket.receive({ type: "input-ready", pane_id: "w1:p1" });
    expect(client.canInput("w1:p1")).toBe(true);
    socket.receive({ type: "input-ready", pane_id: "w1:p1", ready: false });
    expect(client.sendInput("w1:p1", "no replay")).toBe(false);
    client.close();
  }
});

it("drains an in-flight submit ACK across view unmount without terminal/input leaks or replay", async () => {
  const client = new HerdrSocket("ws://test/ws"); client.connect(); const socket = FakeSocket.last;
  socket.open(); socket.receive(snapshot(["submit", "input-ready"])); client.attach("owned-a", 80, 24);
  socket.receive({ type: "input-ready", pane_id: "owned-a" });
  const result = client.submit("owned-a", "synthetic", "synthetic");
  for (let i = 0; i < 10 && !socket.sent.some(frame => frame.type === 'submit'); i++) await Promise.resolve();
  const request = socket.sent.find(frame => frame.type === 'submit')!;
  client.closeAfterSubmits();
  expect(socket.readyState).toBe(FakeSocket.OPEN);
  expect(socket.sent.filter(frame => frame.type === 'detach')).toHaveLength(1);
  expect(client.sendInput('owned-a', 'forbidden')).toBe(false);
  expect(client.submit('owned-b', 'forbidden', 'forbidden')).toBeNull();
  socket.receive({ type: 'submit-result', id: request.id, ok: true });
  expect(await result).toEqual({ ok: true }); expect(socket.readyState).toBe(3);
  socket.receive({ type: 'submit-result', id: request.id, ok: true });
  expect(socket.sent.filter(frame => frame.type === 'submit')).toHaveLength(1);
});
it("draining disconnect preserves uncertainty and never reconnects or replays", async () => {
  const client = new HerdrSocket('ws://test/ws'); client.connect(); const socket = FakeSocket.last;
  socket.open(); socket.receive(snapshot(['submit']));
  const result = client.submit('owned-a', 'synthetic', 'synthetic');
  for (let i = 0; i < 10; i++) await Promise.resolve();
  client.closeAfterSubmits(); socket.disconnect();
  expect(await result).toMatchObject({ ok: false, code: 'disconnected' });
  await Bun.sleep(300); expect(FakeSocket.last).toBe(socket);
  expect(socket.sent.filter(frame => frame.type === 'submit')).toHaveLength(1);
});
it("draining timeout settles once and closes its bounded connection", async () => {
  const timers: (() => void)[] = [];
  const original = window.setTimeout;
  window.setTimeout = ((callback: () => void) => { timers.push(callback); return 1; }) as typeof window.setTimeout;
  try {
    const client = new HerdrSocket('ws://test/ws'); client.connect(); const socket = FakeSocket.last;
    socket.open(); socket.receive(snapshot(['submit']));
    const result = client.submit('owned-a', 'synthetic', 'synthetic');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    client.closeAfterSubmits(); timers.at(-1)!();
    expect(await result).toMatchObject({ ok: false, code: 'timeout' }); expect(socket.readyState).toBe(3);
    expect(socket.sent.filter(frame => frame.type === 'submit')).toHaveLength(1);
  } finally { window.setTimeout = original; }
});

it('secret drain rejects new secrets and closes after ACK with timers cancelled', async () => {
  const client = new HerdrSocket('ws://test/ws'); client.connect(); const socket = FakeSocket.last;
  socket.open(); socket.receive(snapshot(['secret-input', 'submit']));
  const result = client.sendSecret('owned-a', 'Password:', 'synthetic');
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const request = socket.sent.find(frame => frame.type === 'secret')!;
  client.closeAfterSubmits(); expect(client.sendSecret('owned-b', 'Password:', 'blocked')).toBeNull();
  socket.receive({ type: 'secret-result', id: request.id, ok: true });
  expect(await result).toEqual({ ok: true }); expect(socket.readyState).toBe(3);
  expect((client as any).requestTimers.size).toBe(0); expect((client as any).snapshotTimers.size).toBe(0);
});
it('secret timeout closes a draining socket without replay', async () => {
  const timers: (() => void)[] = []; const original = window.setTimeout;
  window.setTimeout = ((callback: () => void) => { timers.push(callback); return timers.length; }) as typeof window.setTimeout;
  try {
    const client = new HerdrSocket('ws://test/ws'); client.connect(); const socket = FakeSocket.last;
    socket.open(); socket.receive(snapshot(['secret-input'])); const result = client.sendSecret('owned-a', 'Password:', 'synthetic');
    for (let i = 0; i < 10; i++) await Promise.resolve(); client.closeAfterSubmits(); timers.at(-1)!();
    expect(await result).toMatchObject({ ok: false, code: 'timeout' }); expect(socket.readyState).toBe(3);
    expect((client as any).requestTimers.size).toBe(0);
  } finally { window.setTimeout = original; }
});
it('snapshot-wait submission cannot send after another request begins draining', async () => {
  const client = new HerdrSocket('ws://test/ws'); client.connect(); const socket = FakeSocket.last;
  socket.open(); socket.receive(snapshot(['submit'])); const first = client.submit('owned-a', 'first', 'first');
  for (let i = 0; i < 10; i++) await Promise.resolve();
  (client as any).snapshotSeen = new Promise(() => {});
  const waiting = client.submit('owned-b', 'never-send', 'never-send');
  client.closeAfterSubmits(); expect(await waiting).toMatchObject({ ok: false, code: 'disconnected' });
  expect(socket.sent.filter(frame => frame.type === 'submit')).toHaveLength(1);
  const request = socket.sent.find(frame => frame.type === 'submit')!; socket.receive({ type: 'submit-result', id: request.id, ok: true });
  expect(await first).toEqual({ ok: true }); expect((client as any).snapshotTimers.size).toBe(0); expect(socket.readyState).toBe(3);
});
