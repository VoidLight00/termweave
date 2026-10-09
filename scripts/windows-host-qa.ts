/** Manual QA against a real Windows PC over SSH: the Add PC flow with a password, the chat-side
 * APIs through the bridge, and the terminal lens's mirrored screen. Needs remote-bundles/manifest-win32-x64.json
 * (bun run scripts/build-remote-bundle.ts win32-x64) and a herdr-free or herdr-bearing Windows host.
 *
 *   WINDOWS_QA_HOST=user@pc WINDOWS_QA_PASSWORD=... bun scripts/windows-host-qa.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server/index.ts";
import type { Machine, SetupJob, SetupRequest } from "../shared/machines.ts";
import type { ServerMessage, SessionSnapshot } from "../shared/protocol.ts";

const destination = process.env["WINDOWS_QA_HOST"];
const password = process.env["WINDOWS_QA_PASSWORD"];
assert.ok(destination && password, "WINDOWS_QA_HOST and WINDOWS_QA_PASSWORD are required");
const state = mkdtempSync(join(tmpdir(), "herdr-windows-qa-"));
process.env["HERDR_SOCKET"] = join(state, "local-offline.sock");
const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: state });
const sockets: WebSocket[] = [];

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, label: string, timeout = 60_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: T;
  do { last = await read(); if (done(last)) return last; await Bun.sleep(200); } while (Date.now() < deadline);
  throw new Error(`Timed out ${label}: ${JSON.stringify(last)}`);
}
async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers: { "x-herdr-machine": "1", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.ok(r.ok, `${path}: ${r.status} ${r.ok ? "" : await r.text()}`);
  return r.json() as Promise<T>;
}
async function setup(target: SetupRequest): Promise<SetupJob> {
  let job = await api<SetupJob>("/api/machines/setup", "POST", target);
  const deadline = Date.now() + 15 * 60_000;
  let previous = "";
  for (;;) {
    const key = `${job.phase}/${job.step}`;
    if (key !== previous) { console.log("setup", job.phase, job.step ?? "", job.progress ? `${job.progress.stage} ${job.progress.done}/${job.progress.total}` : ""); previous = key; }
    if (job.phase === "connected" || job.phase === "failed" || job.phase === "cancelled") return job;
    if (Date.now() > deadline) throw new Error("Setup timed out");
    if (job.challenge) job = await api<SetupJob>(`/api/machines/setup/${job.id}`, "POST", { action: "answer", challenge_id: job.challenge.id, answer: job.challenge.kind === "host_key" ? "yes" : password });
    else if (job.phase === "approval") { console.log("approval:", JSON.stringify(job.installations)); job = await api<SetupJob>(`/api/machines/setup/${job.id}`, "POST", { action: "approve" }); }
    else { await Bun.sleep(300); job = await api<SetupJob>(`/api/machines/setup/${job.id}`); }
  }
}
async function connectWs(machineId: string): Promise<{ ws: WebSocket; frames: ServerMessage[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?machine_id=${machineId}`); sockets.push(ws);
  const frames: ServerMessage[] = [];
  ws.onmessage = (e) => { frames.push(JSON.parse(String(e.data)) as ServerMessage); };
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("Websocket failed")); });
  return { ws, frames };
}

try {
  // WINDOWS_QA_UPDATE=1 installs this checkout's bundle over one the PC already has under the same version
  const job = await setup({ destination, session: "web-qa", name: "Windows QA", ...(process.env["WINDOWS_QA_UPDATE"] === "1" ? { update_remote: true } : {}) });
  assert.equal(job.phase, "connected", job.error ?? "");
  const machineId = job.machine_id;
  const machine = (await api<{ machines: Machine[] }>("/api/machines")).machines.find((m) => m.id === machineId);
  assert.ok(machine);
  console.log("machine:", JSON.stringify({ state: machine.state, herdr: machine.herdr }));
  assert.equal(machine.herdr?.terminal_attach, false, "a Windows herdr reports no terminal attach");
  console.log("PASS Add PC with a password, dedicated key, bundle install and detached start");

  const path = `/api/machines/${machineId}`;
  const home = "C:\\Users\\" + destination.split("@")[0];
  const created = await api<{ pane_id: string }>(path + "/workspace/create", "POST", { cwd: home, label: "herdr-web-ui-test-windows" });
  const paneId = created.pane_id;
  assert.ok((await api<{ snapshot: SessionSnapshot }>(path + "/session")).snapshot.panes.some((p) => p.pane_id === paneId));
  await api(path + "/pane/input", "POST", { pane_id: paneId, text: "echo windows-bridge-input-ok" });
  await api(path + "/pane/keys", "POST", { pane_id: paneId, keys: ["Enter"] });
  await until(async () => api<{ read: { text: string } }>(path + `/pane/read?pane_id=${encodeURIComponent(paneId)}&source=recent&format=text`), (r) => r.read.text.includes("windows-bridge-input-ok"), "input reaches the Windows pane");
  await api(path + `/pane/conversation?pane_id=${encodeURIComponent(paneId)}`);
  await api(path + `/pane/prompt?pane_id=${encodeURIComponent(paneId)}`);
  const files = await api<{ files: string[] }>(path + `/pane/files?pane_id=${encodeURIComponent(paneId)}&q=`);
  assert.ok(Array.isArray(files.files));
  console.log("PASS workspace, input, keys, read, conversation, prompt and files over the Windows bridge");

  const { ws, frames } = await connectWs(machineId);
  ws.send(JSON.stringify({ type: "attach", pane_id: paneId, cols: 80, rows: 24, flow_control: "ack" }));
  const grid = (await until(async () => frames, (list) => list.some((m) => m.type === "pane-geometry" && m.pane_id === paneId), "the pane's grid")).find((m) => m.type === "pane-geometry");
  console.log("attach ->", JSON.stringify(grid));
  assert.ok(grid?.type === "pane-geometry" && grid.fixed === true, "a mirrored pane keeps its own grid");
  ws.send(JSON.stringify({ type: "input", pane_id: paneId, text: "echo ws-input-ok\r" }));
  await until(async () => frames, (list) => list.some((m) => m.type === "pty-data" && m.data.includes("ws-input-ok")), "typing shows in the mirrored terminal");
  console.log("PASS the terminal lens mirrors the Windows pane's screen, typing included");

  await api(path, "PATCH", { enabled: false });
  await api(path, "PATCH", { enabled: true });
  await until(async () => api<{ machines: Machine[] }>("/api/machines"), (r) => r.machines.some((m) => m.id === machineId && m.state === "connected"), "key-only reconnect");
  const second = await setup({ destination, identity_file: join(state, "ssh", machineId), session: "web-qa", name: "Windows QA", machine_id: machineId, update_remote: true });
  assert.equal(second.phase, "connected", second.error ?? "");
  assert.ok((await api<{ snapshot: SessionSnapshot }>(path + "/session")).snapshot.panes.some((p) => p.pane_id === paneId), "remote work survives the restart");
  console.log("PASS key-only reconnect and bridge restart keep the Windows session");
  await api(path + "/workspace/close", "POST", { workspace_id: (await api<{ snapshot: SessionSnapshot }>(path + "/session")).snapshot.panes.find((p) => p.pane_id === paneId)!.workspace_id });
  console.log(`state dir ${state} (machine ${machineId}) kept for inspection`);
} finally {
  for (const ws of sockets) ws.close();
  server.stop();
  rmSync(join(state, "local-offline.sock"), { force: true });
}
