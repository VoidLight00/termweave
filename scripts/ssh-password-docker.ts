/** Password authentication + key-only recovery in a disposable real Linux PC.
 * Requires Docker. No host accounts or SSH settings are changed.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server/index.ts";
import type { Machine, SetupJob } from "../shared/machines.ts";
import type { SessionSnapshot, WorkspaceCreated } from "../shared/protocol.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-ssh-password-"));
const name = `herdr-ssh-password-${process.pid}`;
const password = randomBytes(18).toString("hex");
let server: ReturnType<typeof createServer> | undefined;
const oldSocket = process.env["HERDR_SOCKET"];
process.env["HERDR_SOCKET"] = join(root, "local-offline.sock");
// Exercise the same automatic bundle discovery used by an unconfigured server.
const oldManifest = process.env["HERDR_WEB_BUNDLE_MANIFEST"];
delete process.env["HERDR_WEB_BUNDLE_MANIFEST"];
async function docker(args: string[], input?: string): Promise<string> {
  const child = Bun.spawn(["docker", ...args], { stdin: input ? new Blob([input]) : "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`docker ${args[0]} failed: ${stderr}`);
  return stdout.trim();
}
async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${server!.port}${path}`, { method, headers: { "x-herdr-machine": "1", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.ok(response.ok, `${path}: ${response.status} ${response.ok ? "" : await response.text()}`);
  return response.json();
}
try {
  await docker(["run", "--rm", "-d", "--name", name, "-p", "127.0.0.1::22", "debian:bookworm-slim", "sleep", "infinity"]);
  console.log("Preparing a disposable SSH PC (OpenSSH + Python, no Bun/Node/build tools)…");
  await docker(["exec", name, "sh", "-c", "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server python3 >/dev/null && useradd -m -s /bin/sh testpc && mkdir -p /run/sshd"]);
  await docker(["exec", "-i", name, "chpasswd"], `testpc:${password}\n`);
  await docker(["exec", "-d", name, "/usr/sbin/sshd", "-D", "-e", "-o", "UsePAM=no"]);
  const mapping = await docker(["port", name, "22/tcp"]);
  const port = Number(mapping.split(":").at(-1)); assert.ok(port > 0);
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: root });
  let job = await api<SetupJob>("/api/machines/setup", "POST", { destination: "testpc@127.0.0.1", port, session: "password-test", name: "Password PC" });
  let askedPassword = false;
  let previous = "";
  const deadline = Date.now() + 240_000;
  while (!["connected", "failed", "cancelled"].includes(job.phase)) {
    assert.ok(Date.now() < deadline, "setup deadline");
    if (job.phase !== previous) { console.log(job.phase, job.step); previous = job.phase; }
    if (job.challenge) {
      if (job.challenge.kind === "secret") askedPassword = true;
      job = await api<SetupJob>(`/api/machines/setup/${job.id}`, "POST", { action: "answer", challenge_id: job.challenge.id, answer: job.challenge.kind === "host_key" ? "yes" : password });
    } else if (job.phase === "approval") job = await api<SetupJob>(`/api/machines/setup/${job.id}`, "POST", { action: "approve" });
    else { await Bun.sleep(150); job = await api<SetupJob>(`/api/machines/setup/${job.id}`); }
  }
  assert.equal(job.phase, "connected", job.error ?? ""); assert.ok(askedPassword);
  assert.ok(!readFileSync(join(root, "machines.json"), "utf8").includes(password));
  const prefix = `/api/machines/${job.machine_id}`;
  const created = await api<WorkspaceCreated>(prefix + "/workspace/create", "POST", { cwd: "/home/testpc", label: "herdr-web-ui-test-password" });
  await api(prefix + "/pane/input", "POST", { pane_id: created.pane_id, text: "printf 'PASSWORD_PC_OK\\n'" });
  await api(prefix + "/pane/keys", "POST", { pane_id: created.pane_id, keys: ["Enter"] });
  let text = "";
  for (let i = 0; i < 100 && !text.includes("PASSWORD_PC_OK"); i++) { await Bun.sleep(100); text = (await api<{ read: { text: string } }>(prefix + `/pane/read?pane_id=${encodeURIComponent(created.pane_id)}&source=recent&format=text`)).read.text; }
  assert.ok(text.includes("PASSWORD_PC_OK"));
  // Permanently disable password authentication in this throwaway account. The
  // manager must now reconnect with the key that the app actually installed.
  await docker(["exec", name, "sh", "-c", "printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\n' > /etc/ssh/sshd_config.d/00-key-only.conf; kill -HUP $(cat /run/sshd.pid)"]);
  await api(prefix, "PATCH", { enabled: false });
  await api(prefix, "PATCH", { enabled: true });
  let connected = false;
  for (let i = 0; i < 200; i++) { const list = await api<{ machines: Machine[] }>("/api/machines"); connected = list.machines.some((m) => m.id === job.machine_id && m.state === "connected"); if (connected) break; await Bun.sleep(100); }
  assert.ok(connected, "automatic reconnect uses registered key");
  const snapshot = (await api<{ snapshot: SessionSnapshot }>(prefix + "/session")).snapshot;
  assert.ok(snapshot.panes.some((p) => p.pane_id === created.pane_id));
  await api(prefix + "/workspace/close", "POST", { workspace_id: created.workspace_id });
  console.log("PASS automatic local bundle discovery, real password auth, first install without build tools, bundled herdr, dedicated key and key-only reconnect");
} finally {
  server?.stop();
  await docker(["rm", "-f", name]).catch(() => {});
  if (oldSocket === undefined) delete process.env["HERDR_SOCKET"]; else process.env["HERDR_SOCKET"] = oldSocket;
  if (oldManifest === undefined) delete process.env["HERDR_WEB_BUNDLE_MANIFEST"]; else process.env["HERDR_WEB_BUNDLE_MANIFEST"] = oldManifest;
  rmSync(root, { recursive: true, force: true });
}
