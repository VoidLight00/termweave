import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceStore } from "./devices.ts";
import { MachineRelay } from "./machine-relay.ts";
import type { MachineManager } from "./machines.ts";
import { startFakePushService } from "./push.fake.ts";
import { createServer } from "./index.ts";
import { workspaceCreate, workspaceClose } from "./herdr/client.ts";
import type { ServerMessage } from "../shared/protocol.ts";

const guard = { "x-herdr-machine": "1", "content-type": "application/json" };

async function connect(url: string, cookie: string) {
  // Bun supports handshake headers; lib.dom's browser constructor does not list them.
  const RuntimeSocket = WebSocket as unknown as new (url: string, options: { headers: { cookie: string } }) => WebSocket;
  const socket = new RuntimeSocket(url, { headers: { cookie } });
  const messages: ServerMessage[] = [];
  socket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data))));
  const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve, { once: true }));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  return { socket, messages, closed };
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for websocket output");
    await Bun.sleep(20);
  }
}

it("revocation closes an active device's terminal and roster stream without disconnecting another device", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-device-access-"));
  const server = createServer({ port: 0, stateDir: root, token: "test-device-access", tailscaleOwner: null });
  const base = `http://127.0.0.1:${server.port}`;
  const admin = { ...guard, authorization: "Bearer test-device-access" };
  const sockets: WebSocket[] = [];
  const abort = new AbortController();
  let workspaceId: string | undefined;
  try {
    const pair = async (label: string) => {
      const { code } = await (await fetch(`${base}/api/devices/pair/start`, { method: "POST", headers: admin })).json() as { code: string };
      const response = await fetch(`${base}/api/devices/pair`, { method: "POST", headers: guard, body: JSON.stringify({ code, label }) });
      expect(response.status).toBe(204);
      return response.headers.get("set-cookie")!.split(";")[0]!;
    };
    const cookieA = await pair("A");
    const cookieB = await pair("B");
    const { devices } = await (await fetch(`${base}/api/devices`, { headers: admin })).json() as { devices: { id: string; label: string }[] };
    const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-device-revocation" });
    workspaceId = created.workspace.workspace_id;
    const paneId = created.root_pane.pane_id;
    const a = await connect(`${base.replace("http:", "ws:")}/ws`, cookieA); sockets.push(a.socket);
    const b = await connect(`${base.replace("http:", "ws:")}/ws`, cookieB); sockets.push(b.socket);
    for (const client of [a, b]) {
      client.socket.send(JSON.stringify({ type: "attach", pane_id: paneId, cols: 80, rows: 24 }));
      await until(() => client.messages.some((message) => message.type === "pty-data"));
    }
    const events = await fetch(`${base}/api/machines/events`, { headers: { cookie: cookieA }, signal: abort.signal });
    const reader = events.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    const ended = (async () => { while (!(await reader.read()).done) {} })();
    expect((await fetch(`${base}/api/devices/${devices.find((device) => device.label === "A")!.id}`, { method: "DELETE", headers: admin })).status).toBe(204);
    expect((await a.closed).code).toBe(1008);
    await ended;
    expect((await fetch(`${base}/api/session`, { headers: { cookie: cookieA } })).status).toBe(401);
    b.socket.send(JSON.stringify({ type: "role", mode: "observe" }));
    await until(() => b.messages.some((message) => message.type === "role-ack" && message.mode === "observe"));
    expect(b.socket.readyState).toBe(WebSocket.OPEN);
    expect((await fetch(`${base}/api/session`, { headers: { cookie: cookieB } })).status).toBe(200);
  } finally {
    abort.abort();
    for (const socket of sockets) socket.close();
    server.stop();
    if (workspaceId) await workspaceClose(workspaceId);
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

it("a corrupt device registry refuses strangers while keeping local recovery and the original file", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-device-recovery-"));
  const path = join(root, "devices.json");
  writeFileSync(path, "{broken registry");
  const server = createServer({ port: 0, stateDir: root, token: "", tailscaleOwner: null });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    expect((await fetch(`${base}/api/session`, { headers: { "x-forwarded-for": "192.0.2.1" } })).status).toBe(401);
    expect((await fetch(`${base}/api/session`)).status).toBe(200);
    const response = await fetch(`${base}/api/devices/pair/start`, { method: "POST", headers: guard });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "device_store_unavailable" } });
    expect(readFileSync(path, "utf8")).toBe("{broken registry");
  } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
});

it("watch credentials cannot mutate HTTP state, read credential files, or elevate local and relayed terminals", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-watch-access-"));
  const store = new DeviceStore(root);
  const watch = store.pair(store.startPairing().code, "Watch", "watch")!;
  const server = createServer({ port: 0, stateDir: root, token: "test-watch", tailscaleOwner: null, machines: false });
  const base = `http://127.0.0.1:${server.port}`;
  const cookie = `termweave_device=${watch.token}`;
  const headers = { ...guard, cookie };
  const sockets: WebSocket[] = [];
  const relays: MachineRelay[] = [];
  const manager = { endpoint: () => ({ url: base, token: "test-watch" }), trackTerminal: () => () => {} } as unknown as MachineManager;
  const proxy = Bun.serve<{ relay: MachineRelay }>({ port: 0, hostname: "127.0.0.1", async fetch(request, instance) {
    const relay = new MachineRelay(manager, "remote", true); relays.push(relay);
    await relay.ready;
    if (instance.upgrade(request, { data: { relay } })) return;
    relay.close(); return new Response(null, { status: 426 });
  }, websocket: { open(ws) { ws.data.relay.bind(ws); }, message(ws, raw) { ws.data.relay.message(raw); }, close(ws) { ws.data.relay.close(); } } });
  try {
    expect((await fetch(`${base}/api/session`, { headers })).status).toBe(200);
    for (const path of ["pane/input", "workspace/create", "machines/setup", "updates/install", "herdr/update"]) {
      expect((await fetch(`${base}/api/${path}`, { method: "POST", headers, body: "{}" })).status).toBe(403);
    }
    expect((await fetch(`${base}/api/fs/file?path=${encodeURIComponent(join(root, "devices.json"))}`, { headers })).status).toBe(403);
    // an empty segment must not turn a file read into "some other route" (the PC proxy drops it)
    for (const path of ["api//fs/file", "api/machines/pc1//fs/file", "api/machines/pc1/fs//file"]) {
      expect((await fetch(`${base}/${path}?path=${encodeURIComponent(join(root, "devices.json"))}`, { headers })).status).toBe(404);
    }
    for (const origin of [base, `http://127.0.0.1:${proxy.port}`]) {
      const client = await connect(`${origin.replace("http:", "ws:")}/ws`, cookie); sockets.push(client.socket);
      client.socket.send(JSON.stringify({ type: "role", mode: "interact" }));
      await until(() => client.messages.some((m) => m.type === "role-ack" && m.mode === "observe"));
      for (const frame of [{ type: "input", text: "must not type" }, { type: "keys", keys: ["Enter"] }, { type: "resize", cols: 40, rows: 10 }]) {
        const before = client.messages.filter((m) => m.type === "error").length;
        client.socket.send(JSON.stringify({ ...frame, pane_id: "absent" }));
        await until(() => client.messages.filter((m) => m.type === "error").length > before);
        expect(client.messages.filter((m) => m.type === "error").at(-1)).toMatchObject({ code: "read_only" });
      }
      client.socket.send(JSON.stringify({ type: "submit", id: 1, pane_id: "absent", text: "no", payload: "no" }));
      await until(() => client.messages.some((m) => m.type === "submit-result"));
      expect(client.messages.find((m) => m.type === "submit-result")).toMatchObject({ ok: false, code: "read_only" });
    }
  } finally {
    for (const socket of sockets) socket.close();
    for (const relay of relays) relay.close();
    proxy.stop(true); server.stop(); rmSync(root, { recursive: true, force: true });
  }
});

it("revoking a paired device removes its persistent push subscription", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-device-push-"));
  const server = createServer({ port: 0, stateDir: root, token: "test-push-owner", tailscaleOwner: null, machines: false });
  const fake = await startFakePushService();
  const base = `http://127.0.0.1:${server.port}`;
  const admin = { ...guard, authorization: "Bearer test-push-owner" };
  try {
    const { code } = await (await fetch(`${base}/api/devices/pair/start`, { method: "POST", headers: admin })).json() as { code: string };
    const paired = await fetch(`${base}/api/devices/pair`, { method: "POST", headers: guard, body: JSON.stringify({ code }) });
    const cookie = paired.headers.get("set-cookie")!.split(";")[0]!;
    const registered = await fetch(`${base}/api/push/subscribe`, { method: "POST", headers: { ...guard, cookie }, body: JSON.stringify({ subscription: fake.subscription }) });
    expect(registered.status).toBe(204);
    const { devices } = await (await fetch(`${base}/api/devices`, { headers: admin })).json() as { devices: { id: string }[] };
    const id = devices[0]!.id;
    expect(JSON.parse(readFileSync(join(root, "push-subscriptions.json"), "utf8"))[0].device_id).toBe(id);
    expect((await fetch(`${base}/api/devices/${id}`, { method: "DELETE", headers: admin })).status).toBe(204);
    expect((await fetch(`${base}/api/session`, { headers: { cookie } })).status).toBe(401);
    expect(JSON.parse(readFileSync(join(root, "push-subscriptions.json"), "utf8"))).toEqual([]);
    expect((await fetch(`${base}/api/push/test`, { method: "POST", headers: admin, body: JSON.stringify({ endpoint: fake.subscription.endpoint }) })).status).toBe(404);
  } finally { fake.stop(); server.stop(); rmSync(root, { recursive: true, force: true }); }
});

it("returns an error when revocation cannot be persisted, then allows a successful retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-device-write-"));
  const store = new DeviceStore(root);
  const paired = store.pair(store.startPairing().code, "Phone", "drive")!;
  const server = createServer({ port: 0, stateDir: root, token: "test-write", tailscaleOwner: null, machines: false });
  const base = `http://127.0.0.1:${server.port}`;
  const blocked = join(root, `devices.json.${process.pid}.tmp`);
  try {
    mkdirSync(blocked);
    const revoke = () => fetch(`${base}/api/devices/${paired.device.id}`, { method: "DELETE", headers: { ...guard, authorization: "Bearer test-write" } });
    const failed = await revoke();
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({ error: { code: "internal_error" } });
    expect(new DeviceStore(root).match(paired.token)).not.toBeNull();
    rmSync(blocked, { recursive: true });
    expect((await revoke()).status).toBe(204);
    expect(new DeviceStore(root).match(paired.token)).toBeNull();
  } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
});
