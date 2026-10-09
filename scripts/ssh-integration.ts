/** Real OpenSSH, real isolated herdr, real bundle install. No remote API mocks.
 * SSH_TEST_PASSWORD=1 uses a temporary system account (CI sudo required).
 * Otherwise an encrypted key exercises the askpass + dedicated-key flow.
 */
import assert from "node:assert/strict";
import { createServer as tcpServer } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "../server/index.ts";
import { herdrRpc } from "../server/herdr/client.ts";
import type { Machine, SetupJob, SetupRequest } from "../shared/machines.ts";
import type { ServerMessage, SessionSnapshot, WorkspaceCreated } from "../shared/protocol.ts";
import { shellQuote } from "../server/machine-security.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-ssh-qa-"));
const remoteHome = join(root, "remote");
const state = join(root, "manager");
mkdirSync(join(remoteHome, ".ssh"), { recursive: true });
writeFileSync(join(remoteHome, ".zshrc"), "# isolated SSH test session\n");
const passwordMode = process.env["SSH_TEST_PASSWORD"] === "1";
const password = "herdr-fixture-secret-only";
const username = passwordMode ? `hbr${process.pid}` : userInfo().username;
let sshd: ReturnType<typeof Bun.spawn> | undefined;
let server: ReturnType<typeof createServer> | undefined;
const initialSocket = process.env["HERDR_SOCKET"];
process.env["HERDR_SOCKET"] = join(root, "local-offline.sock");
process.env["HERDR_WEB_BUNDLE_MANIFEST"] = resolve(`remote-bundles/manifest-${process.platform}-${process.arch}.json`);
const sockets: WebSocket[] = [];
let port = 0;
let originalKey = "";

function command(args: string[], input?: string): void {
  const result = Bun.spawnSync(args, { stdin: input ? new TextEncoder().encode(input) : undefined });
  assert.equal(result.exitCode, 0, args[0] + ": " + result.stderr.toString());
}
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, label: string, timeout = 60_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: T;
  do { last = await read(); if (done(last)) return last; await Bun.sleep(100); } while (Date.now() < deadline);
  throw new Error(`Timed out ${label}: ${JSON.stringify(last)}`);
}
async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(`http://127.0.0.1:${server!.port}${path}`, { method, headers: { "x-herdr-machine": "1", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.ok(r.ok, `${path}: ${r.status} ${r.ok ? "" : await r.text()}`);
  return r.json() as Promise<T>;
}
async function setup(target: SetupRequest, approve = true): Promise<SetupJob> {
  let job = await api<SetupJob>("/api/machines/setup", "POST", target);
  const deadline = Date.now() + 180_000;
  let previous = "";
  for (;;) {
    if (job.phase !== previous) { console.log("setup", job.phase, job.step); previous = job.phase; }
    if (job.phase === "connected" || job.phase === "failed" || job.phase === "cancelled") return job;
    if (Date.now() > deadline) throw new Error("Setup timed out");
    if (job.challenge) job = await api<SetupJob>(`/api/machines/setup/${job.id}`, "POST", { action: "answer", challenge_id: job.challenge.id, answer: job.challenge.kind === "host_key" ? "yes" : password });
    else if (job.phase === "approval") {
      if (!approve) return job;
      job = await api<SetupJob>(`/api/machines/setup/${job.id}`, "POST", { action: "approve" });
    }
    else { await Bun.sleep(100); job = await api<SetupJob>(`/api/machines/setup/${job.id}`); }
  }
}
async function connectWs(machineId: string): Promise<{ ws: WebSocket; frames: ServerMessage[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${server!.port}/ws?machine_id=${machineId}`); sockets.push(ws);
  const frames: ServerMessage[] = [];
  ws.onmessage = (e) => { const message = JSON.parse(String(e.data)) as ServerMessage; frames.push(message); if (message.type === "pty-data" && message.flow) ws.send(JSON.stringify({ type: "pty-ack", pane_id: message.pane_id, stream_id: message.flow.stream_id, offset: message.flow.offset })); };
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("Websocket failed")); });
  return { ws, frames };
}
async function stopSshd(): Promise<void> {
  if (!sshd) return;
  if (passwordMode) {
    const pidfile = join(root, "sshd.pid");
    if (existsSync(pidfile)) command(["sudo", "-n", "kill", readFileSync(pidfile, "utf8").trim()]);
  } else sshd.kill();
  await sshd.exited;
}
function remoteFile(path: string): string {
  return passwordMode ? Bun.spawnSync(["sudo", "-n", "cat", path]).stdout.toString() : readFileSync(path, "utf8");
}
function remoteExists(path: string): boolean {
  return passwordMode ? Bun.spawnSync(["sudo", "-n", "test", "-f", path]).exitCode === 0 : existsSync(path);
}
async function startSshd(): Promise<void> {
  sshd = Bun.spawn([...(passwordMode ? ["sudo", "-n"] : []), "/usr/sbin/sshd", "-D", "-e", "-f", join(root, "sshd_config")], { stdout: "ignore", stderr: Bun.file(join(root, "sshd.log")) });
  await Bun.sleep(300);
  assert.equal(sshd.exitCode, null, readFileSync(join(root, "sshd.log"), "utf8"));
}
try {
  const listener = tcpServer(); await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r)); port = (listener.address() as { port: number }).port; await new Promise<void>((r) => listener.close(() => r()));
  command(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", join(root, "host")]);
  originalKey = join(root, "client");
  command(["ssh-keygen", "-q", "-t", "ed25519", "-N", passwordMode ? "" : password, "-f", originalKey]);
  writeFileSync(join(remoteHome, ".ssh/authorized_keys"), passwordMode ? "" : readFileSync(originalKey + ".pub"), { mode: 0o600 });
  const shell = join(root, "remote-shell");
  writeFileSync(shell, `#!/bin/sh\nexport HOME=${shellQuote(remoteHome)}\nexport PATH=${shellQuote(process.env["PATH"]!)}\nunset HERDR_SOCKET HERDR_SOCKET_PATH\ncd "$HOME"\nexec /bin/sh -c "$SSH_ORIGINAL_COMMAND"\n`, { mode: 0o755 });
  writeFileSync(join(root, "sshd_config"), `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${join(root, "host")}\nPidFile ${join(root, "sshd.pid")}\nAuthorizedKeysFile ${join(remoteHome, ".ssh/authorized_keys")}\nStrictModes no\nUsePAM no\nPasswordAuthentication ${passwordMode ? "yes" : "no"}\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nAllowUsers ${username}\nAllowTcpForwarding yes\nPermitTTY no\nForceCommand ${shell}\nLogLevel VERBOSE\n`);
  if (passwordMode) {
    chmodSync(root, 0o755);
    command(["sudo", "-n", "useradd", "-M", "-d", remoteHome, "-s", "/bin/sh", username]);
    command(["sudo", "-n", "chpasswd"], `${username}:${password}\n`);
    command(["sudo", "-n", "chown", "-R", username, remoteHome]);
  }
  await startSshd();
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: state });
  const target = { destination: `${username}@127.0.0.1`, port, ...(passwordMode ? {} : { identity_file: originalKey }), session: "ssh-qa", name: "QA remote" };
  const health = await api<{ ok: boolean }>("/api/health?scope=bridge"); assert.equal(health.ok, true);
  const job = await setup(target);
  assert.equal(job.phase, "connected", job.error ?? "");
  const machineId = job.machine_id;
  assert.ok(existsSync(join(state, "ssh", machineId)), "dedicated key stored");
  assert.ok(remoteFile(join(remoteHome, ".ssh/authorized_keys")).includes(`termweave:${machineId}`));
  assert.ok(!readFileSync(join(state, "machines.json"), "utf8").includes(password), "password is never persisted");
  console.log("PASS first install, fingerprint, secret authentication and dedicated-key registration");
  const second = await setup({ ...target, identity_file: join(state, "ssh", machineId), session: "ssh-second", name: "QA second PC" });
  assert.equal(second.phase, "connected", second.error ?? "");
  const secondPath = `/api/machines/${second.machine_id}`;
  const secondCreated = await api<WorkspaceCreated>(secondPath + "/workspace/create", "POST", { cwd: remoteHome, label: "herdr-web-ui-test-ssh-second" });
  const path = `/api/machines/${machineId}`;
  const created = await api<WorkspaceCreated>(path + "/workspace/create", "POST", { cwd: remoteHome, label: "herdr-web-ui-test-ssh" });
  const paneId = created.pane_id;
  assert.equal(secondCreated.pane_id, paneId, "independent daemons intentionally produce equal pane IDs");
  const { ws, frames } = await connectWs(machineId);
  ws.send(JSON.stringify({ type: "role", mode: "observe" }));
  ws.send(JSON.stringify({ type: "attach", pane_id: paneId, cols: 80, rows: 24, flow_control: "ack" }));
  await until(async () => frames, (list) => list.some((m) => m.type === "pty-data"), "remote terminal paint");
  // a mirror paints too (pty-data), on a grid it fixes: the remote PC has Node, so this must be herdr's own attach (#265)
  assert.ok(!frames.some((m) => m.type === "pane-geometry" && m.fixed === true), "remote terminal is attached, not mirrored");
  ws.send(JSON.stringify({ type: "input", pane_id: paneId, text: "forbidden\n" }));
  await until(async () => frames, (list) => list.some((m) => m.type === "error" && m.code === "read_only"), "observe enforcement");
  ws.send(JSON.stringify({ type: "role", mode: "interact" }));
  ws.send(JSON.stringify({ type: "resize", pane_id: paneId, cols: 90, rows: 28 }));
  ws.send(JSON.stringify({ type: "input", pane_id: paneId, text: "printf 'ssh-bridge-input-ok\\n'\r" }));
  await until(async () => api<{ read: { text: string } }>(path + `/pane/read?pane_id=${encodeURIComponent(paneId)}&source=recent&format=text`), (r) => r.read.text.includes("ssh-bridge-input-ok"), "input reaches remote pane");
  const image = await api<{ path: string }>(path + "/pane/image", "POST", { pane_id: paneId, content_type: "image/png", data_base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" });
  assert.ok(image.path.startsWith(remoteHome)); assert.ok(remoteExists(image.path));
  assert.ok((await api<{ snapshot: SessionSnapshot }>(path + "/session")).snapshot.panes.some((p) => p.pane_id === paneId));
  await api(path + `/pane/conversation?pane_id=${encodeURIComponent(paneId)}`);
  await api(path + `/pane/files?pane_id=${encodeURIComponent(paneId)}&q=`);
  await api(path + `/pane/prompt?pane_id=${encodeURIComponent(paneId)}`);
  await api(path + "/pane/rename", "POST", { pane_id: paneId, label: "SSH verified" });
  const other = await api<{ read: { text: string } }>(secondPath + `/pane/read?pane_id=${encodeURIComponent(paneId)}&source=recent&format=text`);
  assert.ok(!other.read.text.includes("ssh-bridge-input-ok"), "equal pane IDs must not mix input");
  console.log("PASS equal pane ID isolation, remote terminal, observe, resize, input, image, conversation, files and prompts");
  const slow = new WebSocket(`ws://127.0.0.1:${server.port}/ws?machine_id=${machineId}`); sockets.push(slow);
  let slowCode = 0; let slowBytes = 0;
  slow.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.type === "pty-data") slowBytes += Buffer.byteLength(m.data); };
  slow.onclose = (e) => { slowCode = e.code; };
  await until(async () => slow.readyState, (state) => state === WebSocket.OPEN, "slow observer open");
  slow.send(JSON.stringify({ type: "role", mode: "observe" }));
  slow.send(JSON.stringify({ type: "attach", pane_id: paneId, cols: 80, rows: 24, flow_control: "ack" }));
  await until(async () => slowBytes, (n) => n > 0, "observer paint");
  await api(path + "/pane/input", "POST", { pane_id: paneId, text: `python3 -u -c 'import sys,time; [(sys.stdout.write("\\033[H"+(str(i%10)*79+"\\n")*23),sys.stdout.flush(),time.sleep(.01)) for i in range(1500)]'` });
  await api(path + "/pane/keys", "POST", { pane_id: paneId, keys: ["Enter"] });
  await until(async () => slowCode, (code) => code !== 0, "proxy output overload", 30_000);
  assert.equal(slowCode, 4008); assert.ok(slowBytes <= 1024 * 1024);
  ws.send(JSON.stringify({ type: "input", pane_id: paneId, text: "\x03" }));
  console.log("PASS end-to-end ACK budget and 4008 stalled observer eviction");

  await api(path, "PATCH", { enabled: false });
  await until(async () => ws.readyState, (state) => state === WebSocket.CLOSED, "disconnect closes terminal");
  assert.equal((await fetch(`http://127.0.0.1:${server.port}${path}/session`)).status, 503);
  assert.ok((await api<{ snapshot: SessionSnapshot }>(secondPath + "/session")).snapshot.panes.length, "one PC disconnect leaves the other connected");
  await api(path, "PATCH", { enabled: true });
  await until(async () => api<{ machines: Machine[] }>("/api/machines"), (r) => r.machines.some((m) => m.id === machineId && m.state === "connected"), "key-only reconnect");
  assert.ok((await api<{ snapshot: SessionSnapshot }>(path + "/session")).snapshot.panes.some((p) => p.pane_id === paneId), "remote work survives disconnect");
  server.stop(); server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: state });
  await until(async () => api<{ machines: Machine[] }>("/api/machines"), (r) => r.machines.some((m) => m.id === machineId && m.state === "connected"), "server restart reconnect");
  console.log("PASS isolated local failure, disconnect/reconnect and server restart recovery");

  const cancel = await setup({ ...target, identity_file: join(state, "ssh", machineId), session: "ssh-cancel" }, false);
  assert.equal(cancel.phase, "approval");
  await api(`/api/machines/setup/${cancel.id}`, "POST", { action: "cancel" });
  assert.equal((await api<SetupJob>(`/api/machines/setup/${cancel.id}`)).phase, "cancelled");
  assert.ok(!existsSync(join(remoteHome, ".config/herdr/sessions/ssh-cancel/herdr.sock")));
  console.log("PASS cancellation before installation leaves remote session absent");

  const manifest = process.env["HERDR_WEB_BUNDLE_MANIFEST"]!;
  const badManifest = join(root, "invalid-manifest.json");
  const data = JSON.parse(readFileSync(manifest, "utf8"));
  data.version = "incompatible-test-version";
  writeFileSync(badManifest, JSON.stringify(data));
  process.env["HERDR_WEB_BUNDLE_MANIFEST"] = badManifest;
  const failedInstall = await setup({ ...target, machine_id: machineId, identity_file: join(state, "ssh", machineId), update_remote: true });
  assert.equal(failedInstall.phase, "failed"); assert.match(failedInstall.error!, /version mismatch/);
  process.env["HERDR_WEB_BUNDLE_MANIFEST"] = manifest;
  const updated = await setup({ ...target, machine_id: machineId, identity_file: join(state, "ssh", machineId), update_remote: true });
  assert.equal(updated.phase, "connected", updated.error ?? "");
  assert.ok((await api<{ snapshot: SessionSnapshot }>(path + "/session")).snapshot.panes.some((p) => p.pane_id === paneId));
  assert.ok((await api<{ snapshot: SessionSnapshot }>(secondPath + "/session")).snapshot.panes.length);
  console.log("PASS failed install preserves sessions; explicit bridge update preserves both daemons");

  if (process.env["SSH_TEST_KEEP"] === "1") {
    writeFileSync(join(root, "fixture.json"), JSON.stringify({ root, machineId, secondMachineId: second.machine_id, paneId, port: server.port, remoteHome }));
    console.log("QA_FIXTURE " + join(root, "fixture.json"));
    await new Promise<void>((resolve) => { process.on("SIGTERM", resolve); process.on("SIGINT", resolve); });
  }
  await api(path + "/workspace/close", "POST", { workspace_id: created.workspace_id });
  await api(secondPath + "/workspace/close", "POST", { workspace_id: secondCreated.workspace_id });
  await api(secondPath, "DELETE");
  await api(path, "PATCH", { enabled: false });
  await stopSshd();
  command(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", join(root, "changed-host")]);
  writeFileSync(join(root, "sshd_config"), readFileSync(join(root, "sshd_config"), "utf8").replace(`HostKey ${join(root, "host")}`, `HostKey ${join(root, "changed-host")}`));
  await startSshd();
  const changed = await setup({ ...target, machine_id: machineId, identity_file: join(state, "ssh", machineId) });
  assert.equal(changed.phase, "failed"); assert.match(changed.error!, /HOST IDENTIFICATION HAS CHANGED|Host key verification failed/);
  console.log("PASS changed host key rejected without overwriting trust");
  await api(path, "DELETE");
  assert.ok(!existsSync(join(state, "ssh", machineId)));
  console.log("PASS remove registration and private key cleanup");
} finally {
  for (const socket of sockets) socket.close();
  server?.stop();
  // Stop only daemons created under this test's HOME; never use the user's socket.
  for (const name of ["ssh-qa", "ssh-cancel", "ssh-second"]) {
    const socket = join(remoteHome, ".config/herdr/sessions", name, "herdr.sock");
    try { await herdrRpc("server.stop", {}, socket, 1000); } catch {}
  }
  const descriptors = join(remoteHome, ".config/herdr-web-ui/bridges");
  if (!passwordMode && existsSync(descriptors)) for (const file of readdirSync(descriptors).filter((f) => f.endsWith(".json"))) { try { const d = JSON.parse(readFileSync(join(descriptors, file), "utf8")); if (passwordMode) command(["sudo", "-n", "kill", String(d.pid)]); else process.kill(d.pid, "SIGTERM"); } catch {} }
  await stopSshd();
  if (passwordMode) { Bun.spawnSync(["sudo", "-n", "pkill", "-u", username]); Bun.spawnSync(["sudo", "-n", "userdel", username]); }
  if (initialSocket === undefined) delete process.env["HERDR_SOCKET"]; else process.env["HERDR_SOCKET"] = initialSocket;
  if (passwordMode) Bun.spawnSync(["sudo", "-n", "rm", "-rf", root]); else rmSync(root, { recursive: true, force: true });
}
