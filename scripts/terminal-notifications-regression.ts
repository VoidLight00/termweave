import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
// Initialize isolation before loading runtime clients; inherited production sockets fail closed.
const { isolateTestEnvironment } = await import("./test-isolation.ts");
isolateTestEnvironment();
const binaryFlag = process.argv.indexOf("--herdr-bin");
if (binaryFlag >= 0) {
  const binary = process.argv[binaryFlag + 1];
  assert.ok(binary?.startsWith("/") && existsSync(binary), "explicit test binary must exist at an absolute path");
  process.env.HERDR_WEB_HERDR_BIN = binary;
}
const { testSocketPath } = await import("./test-herdr.ts");
assert.equal(process.env.HERDR_SOCKET, testSocketPath());
assert.notEqual(process.env.HERDR_TEST_LIVE, "1");
const { createServer } = await import("../server/index.ts");
const { workspaceCreate, workspaceClose, sessionSnapshot, paneSendText, paneSendKeys } = await import("../server/herdr/client.ts");
const { DeviceStore } = await import("../server/devices.ts");
const root = mkdtempSync(join(tmpdir(), "tw-notify-live-"));
const stateDir = join(root, "state");
const devices = new DeviceStore(stateDir); const watch = devices.pair(devices.startPairing().code, "notification-watch", "watch")!;
const token = "isolated-notification-test";
const headers = { authorization: `Bearer ${token}`, "x-herdr-machine": "1" };
const watchHeaders = { cookie: `termweave_device=${watch.token}`, "x-herdr-machine": "1" };
let server: ReturnType<typeof createServer> | undefined;
const owned: string[] = []; const sockets: WebSocket[] = []; let testOutput = "";
const until = async (check: () => boolean | Promise<boolean>, label: string, ms = 12000) => {
  const end = Date.now() + ms;
  while (!(await check())) { if (Date.now() >= end) throw new Error(`Timed out: ${label}`); await Bun.sleep(50); }
};
function start() { server = createServer({ port: 0, hostname: "127.0.0.1", token, stateDir, tailscaleOwner: null, machines: false, registerBridge: false }); return `http://127.0.0.1:${server.port}`; }
async function connect(base: string, paneId: string) {
  const RuntimeSocket = WebSocket as unknown as new(url: string, options: { headers: Record<string, string> }) => WebSocket;
  const ws = new RuntimeSocket(base.replace("http:", "ws:") + "/ws", { headers }); sockets.push(ws);
  let ready = false, received = 0;
  ws.addEventListener("message", event => {
    const message = JSON.parse(String(event.data));
    if (message.type === "input-ready" && message.pane_id === paneId && message.ready !== false) ready = true;
    if (message.type === "pty-data" && message.pane_id === paneId) { received++; testOutput = (testOutput + message.data).slice(-12000); }
  });
  await until(() => ws.readyState === WebSocket.OPEN, "socket open");
  ws.send(JSON.stringify({ type: "attach", pane_id: paneId, cols: 80, rows: 24 }));
  await until(() => ready || received > 0, "native attach");
  return ws;
}
try {
  const a = await workspaceCreate({ cwd: root, label: "notification-test-a" }); owned.push(a.workspace.workspace_id);
  const b = await workspaceCreate({ cwd: root, label: "notification-test-b" }); owned.push(b.workspace.workspace_id);
  let base = start();
  const list = async () => { const response = await fetch(`${base}/api/terminal-notifications`, { headers }); assert.equal(response.status, 200); return response.json(); };
  await connect(base, a.root_pane.pane_id);
  await until(async () => (await list()).sourceStatus === "available", "native notification API available");
  // B is deliberately unattached: collection must not depend on a terminal view.
  const source = join(root, "emit.py");
  writeFileSync(source, "import os,time\nopen('" + join(root, "emitted") + "','w').write('yes')\nos.write(1,b'NATIVE_TEST_MARKER\\n')\nparts=[b'\\x1b',b']9;native-nine',b'\\x07',b'\\x1b]99;i=native:d=0;native-title\\x1b',b'\\\\',b'\\x1b]99;i=native:p=body;native-body\\x07',b'\\x1b]777;notify;native-seven;native-detail\\x1b',b'\\\\']\nfor part in parts:\n os.write(1,part);time.sleep(0.05)\n");
  await paneSendText(b.root_pane.pane_id, `/usr/bin/python3 '${source}'`); await paneSendKeys(b.root_pane.pane_id, ["Enter"]);
  await until(() => existsSync(join(root, "emitted")), "emitter executed");
  await until(async () => (await list()).items.length === 3, "three native OSC announcements").catch(async error => { console.log(JSON.stringify({ items: (await list()).items.length, outputLength: testOutput.length, osc9Present: testOutput.includes("\x1b]9;"), osc99Present: testOutput.includes("\x1b]99;"), osc777Present: testOutput.includes("\x1b]777;"), screenRedrawPresent: testOutput.includes("\x1b[2J") })); throw error; });
  const initial = await list();
  assert.deepEqual(initial.items.map((item: any) => item.protocol).sort(), ["777", "9", "99"].sort());
  assert.equal(initial.items.find((item: any) => item.protocol === "99").body, "native-body");
  for (const item of initial.items) {
    assert.equal(item.terminalId, b.root_pane.terminal_id); assert.equal(item.target.workspaceId, b.workspace.workspace_id);
    assert.equal(item.target.paneId, b.root_pane.pane_id); assert.ok(item.target.paneNumber > 0);
    const target = await fetch(`${base}/api/terminal-notifications/${item.id}/target`, { headers: watchHeaders }); assert.equal(target.status, 200);
    assert.deepEqual(await target.json(), item.target);
  }
  assert.equal((await fetch(`${base}/api/terminal-notifications`, { headers: watchHeaders })).status, 200);
  for (const path of [`/${initial.items[0].id}/read`, "/clear"]) assert.equal((await fetch(`${base}/api/terminal-notifications${path}`, { method: "POST", headers: watchHeaders })).status, 403);
  assert.equal((await fetch(`${base}/api/terminal-notifications/clear`, { method: "POST", headers: { ...headers, origin: "https://foreign.invalid" } })).status, 403);
  // Outlast the dedupe window so replay would create duplicates if it were parsed again.
  await Bun.sleep(10500);
  const duplicateClient = await connect(base, b.root_pane.pane_id); await Bun.sleep(250);
  assert.equal((await list()).items.length, 3); duplicateClient.close();
  const readId = initial.items[0].id;
  assert.equal((await fetch(`${base}/api/terminal-notifications/${readId}/read`, { method: "POST", headers })).status, 200);
  for (const socket of sockets.splice(0)) socket.close(); server!.stop(); server = undefined;
  assert.ok((await sessionSnapshot()).panes.some(p => p.terminal_id === b.root_pane.terminal_id));
  base = start(); const restored = await list(); assert.equal(restored.items.length, 3);
  assert.equal(restored.items.find((item: any) => item.id === readId).read, true);
  assert.deepEqual(restored.items.map((item: any) => item.target), initial.items.map((item: any) => item.target));
  await connect(base, b.root_pane.pane_id); await Bun.sleep(500); assert.equal((await list()).items.length, 3);
  await workspaceClose(b.workspace.workspace_id); owned.splice(owned.indexOf(b.workspace.workspace_id), 1);
  assert.equal((await fetch(`${base}/api/terminal-notifications/${readId}/target`, { headers })).status, 410);
  assert.ok((await list()).items.every((item: any) => item.target === null));
  assert.equal((await fetch(`${base}/api/terminal-notifications/clear`, { method: "POST", headers })).status, 200);
  assert.equal((await list()).items.length, 0);
  assert.ok((await sessionSnapshot()).panes.some(p => p.terminal_id === a.root_pane.terminal_id));
  console.log("PASS native fragmented OSC9/99/777; exact terminal/global P and other-workspace target; persistence/read across bridge restart; watch/origin rejection; no reconnect replay duplicate after dedupe window; unavailable target; clear preserves other native terminal");
} finally {
  for (const socket of sockets) socket.close(); server?.stop();
  for (const workspaceId of owned) await workspaceClose(workspaceId);
  rmSync(root, { recursive: true, force: true });
}
