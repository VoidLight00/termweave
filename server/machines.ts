import { authenticatedWebSocket } from "./remote-websocket.ts";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer as tcpServer } from "node:net";
import { hostname } from "node:os";
import { join } from "node:path";
import { BRIDGE_PROTOCOL, LOCAL_MACHINE, REMOTE_BUNDLE_VERSION, type BridgeIdentity, type Machine, type MachineAction, type MachineEvent, type MachineSettings, type SetupAction, type SetupJob, type SetupProgress, type SetupRequest, type SshTarget } from "../shared/machines.ts";
import type { ServerMessage, SessionSnapshot, HerdrPane } from "../shared/protocol.ts";
import type { PushService } from "./push.ts";
import type { BridgeDescriptor } from "./bridge.ts";
import { sessionSnapshot } from "./herdr/client.ts";
import { labelOmoPanes } from "./conversation.ts";
import type { CompletionTracker } from "./completion.ts";
import { validateTarget } from "./machine-security.ts";
import { detectHost, HERDR_INSTALL_CMD } from "./remote-host.ts";
import { SshConnection } from "./ssh.ts";

interface StoredMachine { id: string; name: string; target: SshTarget; enabled: boolean; snapshot?: SessionSnapshot | null }
interface Runtime {
  machine: Machine;
  ssh?: SshConnection;
  endpoint?: { url: string; token: string };
  observer?: WebSocket;
  retry?: ReturnType<typeof setTimeout>;
  poll?: ReturnType<typeof setInterval>;
  abort?: AbortController;
  attempts: number;
  generation: number;
  refreshing: boolean;
  refreshQueued: boolean;
  snapshotRevision: number;
  terminals: Set<() => void>;
}
interface JobState {
  update: boolean;
  /** started by the server for a PC whose bridge is out of date: key-only SSH, approval already given */
  auto: boolean;
  public: SetupJob;
  abort: AbortController;
  pending?: { resolve(value: string): void; reject(error: Error): void };
  ssh?: SshConnection;
  timer: ReturnType<typeof setTimeout>;
  /** the registered PC a bridge update is for, which shows it as `updating` */
  runtime?: Runtime;
  stageStartedAt: number;
  finished: Promise<void>;
}
const DEFAULT_SETTINGS: MachineSettings = { auto_update_bridges: true };

/** The step a job shows between an approve/answer and the next stage() the setup reaches. */
export function actionStep(action: "approve" | "answer"): string {
  return action === "approve" ? "Installing on this PC…" : "Connecting with SSH keys and ssh-agent…";
}

/**
 * Why a bridge refused verification, read from its error envelope. Only the code is trusted:
 * the bridge's own message carries paths of that PC and is never shown.
 */
function verificationFailure(status: number, body: unknown): string {
  const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  // a bridge older than `socket_missing` answers a missing socket with 500 internal_error and stat's ENOENT
  if (error?.code === "socket_missing" || error?.code === "internal_error" && typeof error.message === "string" && error.message.startsWith("ENOENT")) return "herdr is not running for this session on the PC (its socket is missing). Start herdr there, then reconnect.";
  if (error?.code === "connect_failed") return "herdr is not answering on the PC (its socket is there, but nothing listens). Restart herdr there, then reconnect.";
  return `Bridge verification failed (${status}). Reconnect after checking the remote bridge.`;
}

async function freePort(): Promise<number> {
  const server = tcpServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** A connection that retrying cannot fix: the PC waits for the user instead of reconnecting. */
export class MachineActionRequired extends Error {
  constructor(message: string, readonly action: MachineAction) { super(message); }
}

export class MachineManager {
  private machines = new Map<string, Runtime>();
  private jobs = new Map<string, JobState>();
  private listeners = new Set<(event: MachineEvent) => void>();
  private stopped = false;
  private localBusy = false;
  private localRefreshQueued = false;
  private localRevision = 0;
  private localTimer: ReturnType<typeof setInterval>;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private statePath: string;
  private sshDir: string;
  // TERMWEAVE_MACHINE_NAME shows another name for this PC (screen sharing, demos); the real hostname stays private
  private local: Machine = { id: LOCAL_MACHINE, name: process.env["TERMWEAVE_MACHINE_NAME"]?.trim() || hostname(), kind: "local", enabled: true, state: "connecting", error: null, snapshot: null };
  private settingsPath: string;
  private preferences: MachineSettings = { ...DEFAULT_SETTINGS };
  /** automatic bridge updates run one at a time: they share one bundle download */
  private autoChain: Promise<void> = Promise.resolve();
  private autoQueued = new Set<string>();
  private emitTimer?: ReturnType<typeof setTimeout>;

  constructor(readonly stateDir: string, private push: PushService, private completions: CompletionTracker, private readLocal: () => Promise<SessionSnapshot> = () => this.completions.readSnapshot(sessionSnapshot, labelOmoPanes)) {
    this.statePath = join(stateDir, "machines.json");
    this.sshDir = join(stateDir, "ssh");
    this.settingsPath = join(stateDir, "machine-settings.json");
    try {
      const saved: unknown = JSON.parse(readFileSync(this.settingsPath, "utf8"));
      if (saved && typeof saved === "object" && typeof (saved as MachineSettings).auto_update_bridges === "boolean") this.preferences.auto_update_bridges = (saved as MachineSettings).auto_update_bridges;
    } catch { /* absent or unreadable: the defaults */ }
    if (existsSync(this.statePath)) {
      const saved: unknown = JSON.parse(readFileSync(this.statePath, "utf8"));
      if (!Array.isArray(saved)) throw new Error("Invalid machines.json; registrations were preserved");
      for (const item of saved as StoredMachine[]) {
        if (!/^[a-f0-9-]{36}$/.test(item.id) || typeof item.name !== "string" || typeof item.enabled !== "boolean") throw new Error("Invalid machine registration");
        const machine: Machine = { id: item.id, name: item.name, kind: "ssh", enabled: item.enabled, target: validateTarget(item.target), state: "disconnected", snapshot: item.snapshot ?? null, error: null };
        const runtime = this.runtime(machine);
        this.machines.set(item.id, runtime);
        if (item.enabled) queueMicrotask(() => void this.reconnect(runtime));
      }
    }
    void this.refreshLocal();
    this.localTimer = setInterval(() => void this.refreshLocal(), 5000);
    this.localTimer.unref();
  }
  private runtime(machine: Machine): Runtime { return { machine, attempts: 0, generation: 0, refreshing: false, refreshQueued: false, snapshotRevision: 0, terminals: new Set() }; }
  list(): Machine[] { return [this.local, ...[...this.machines.values()].map((r) => r.machine)]; }
  subscribe(listener: (event: MachineEvent) => void): () => void {
    this.listeners.add(listener);
    listener({ type: "machines", machines: this.list() });
    return () => this.listeners.delete(listener);
  }
  private emit(event?: MachineEvent): void {
    if (this.stopped) return;
    for (const listener of this.listeners) listener(event ?? { type: "machines", machines: this.list() });
  }
  localMessage(message: ServerMessage): void {
    if (["pane-status", "session-changed", "pane-exited"].includes(message.type)) {
      this.localRevision++;
      if (this.localBusy) this.localRefreshQueued = true;
    }
    this.emit({ type: "machine-message", machine_id: LOCAL_MACHINE, message });
    if (message.type === "pane-status" && this.local.snapshot) {
      this.local.snapshot = { ...this.local.snapshot, panes: this.local.snapshot.panes.map((p: HerdrPane) => p.pane_id === message.pane_id ? paneAfterStatus(p, message) : p) };
    }
    if (message.type === "session-changed" || message.type === "pane-exited") void this.refreshLocal();
  }
  async refreshLocal(): Promise<void> {
    if (this.stopped) return;
    if (this.localBusy) { this.localRefreshQueued = true; return; }
    this.localBusy = true;
    try {
      do {
        this.localRefreshQueued = false;
        const revision = this.localRevision;
        try {
          const snapshot = await this.readLocal();
          if (this.stopped) break;
          // A newer event already patched the roster. Never publish this older load.
          if (revision !== this.localRevision) { this.localRefreshQueued = true; continue; }
          this.local.snapshot = snapshot; this.local.state = "connected"; this.local.error = null;
        } catch (e) {
          if (this.stopped) break;
          if (revision !== this.localRevision) { this.localRefreshQueued = true; continue; }
          this.local.state = "error"; this.local.error = String(e instanceof Error ? e.message : e);
        }
        this.emit();
      } while (this.localRefreshQueued && !this.stopped);
    } finally { this.localBusy = false; }
  }
  private saveSoon(): void {
    if (this.saveTimer || this.stopped) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = undefined; if (!this.stopped) { try { this.persist(); } catch (e) { console.error("PC state could not be saved:", e instanceof Error ? e.message : "write failed"); } } }, 1000);
    this.saveTimer.unref();
  }
  private persist(): void {
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    const data: StoredMachine[] = [...this.machines.values()].map(({ machine: m }) => ({ id: m.id, name: m.name, target: m.target!, enabled: m.enabled, snapshot: m.snapshot }));
    const tmp = this.statePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    chmodSync(tmp, 0o600); renameSync(tmp, this.statePath);
  }
  job(id: string): SetupJob | undefined { return this.jobs.get(id)?.public; }
  settings(): MachineSettings { return { ...this.preferences }; }
  updateSettings(patch: Record<string, unknown>): MachineSettings {
    if (patch["auto_update_bridges"] !== undefined) {
      if (typeof patch["auto_update_bridges"] !== "boolean") throw new Error("auto_update_bridges must be boolean");
      this.preferences.auto_update_bridges = patch["auto_update_bridges"];
    }
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    const tmp = this.settingsPath + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.preferences), { mode: 0o600 });
    renameSync(tmp, this.settingsPath);
    return this.settings();
  }
  /**
   * Update a PC's bridge now, without a dialog: the tap (or the app update) is the approval,
   * and SSH uses the PC's saved key only. A PC that needs a password fails with the reason,
   * and its dialog stays the way in.
   */
  updateBridge(id: string): SetupJob {
    const runtime = this.machines.get(id);
    if (!runtime) throw new Error("PC not found");
    return this.setup({ ...runtime.machine.target!, machine_id: id, update_remote: true }, { auto: true });
  }
  setup(request: SetupRequest, options: { auto?: boolean } = {}): SetupJob {
    if (this.stopped) throw new Error("Server stopping");
    const target = validateTarget(request);
    if (request.name !== undefined && (typeof request.name !== "string" || request.name.length > 100)) throw new Error("PC name must be at most 100 characters");
    if ([...this.jobs.values()].filter((j) => !["connected", "failed", "cancelled"].includes(j.public.phase)).length >= 4) throw new Error("Finish or cancel the current connection jobs first");
    const existing = request.machine_id ? this.machines.get(request.machine_id) : undefined;
    if (request.machine_id && !existing) throw new Error("PC not found");
    if (existing && [...this.jobs.values()].some((j) => j.public.machine_id === existing.machine.id && !["connected", "failed", "cancelled"].includes(j.public.phase))) throw new Error("A connection job for this PC is already running");
    const id = randomUUID();
    const machineId = existing?.machine.id ?? randomUUID();
    const auto = options.auto === true && request.update_remote === true && !!existing;
    const job: JobState = { update: request.update_remote === true, auto, public: { id, machine_id: machineId, target, phase: "connecting", step: "Connecting with SSH keys and ssh-agent…", challenge: null, installations: [], error: null, ssh_output: null, progress: null }, abort: new AbortController(), timer: setTimeout(() => this.cancelJob(id), 600_000), stageStartedAt: Date.now(), finished: Promise.resolve() };
    if (job.update && existing) job.runtime = existing;
    job.timer.unref();
    this.jobs.set(id, job);
    if (this.jobs.size > 40) for (const [key, j] of this.jobs) if (["connected", "failed", "cancelled"].includes(j.public.phase) && key !== id) { this.jobs.delete(key); break; }
    const runtime = existing ?? this.runtime({ id: machineId, name: request.name?.trim() || target.destination, kind: "ssh", enabled: true, state: "connecting", target, snapshot: null, error: null });
    this.disconnect(runtime);
    runtime.machine.target = target;
    const ssh = new SshConnection(target, this.sshDir, join(this.sshDir, machineId));
    job.ssh = ssh;
    runtime.ssh = ssh;
    runtime.abort = job.abort;
    const generation = ++runtime.generation;
    this.showUpdate(job);
    // ssh's own words reach the dialog while it waits, not only in the error it ends with
    ssh.onOutput = (text) => { if (job.public.phase === "connecting" || job.public.phase === "authentication") job.public.ssh_output = text || null; };
    job.finished = (async () => {
      try {
        // an automatic update never asks: a PC that needs a password says so and waits
        await ssh.start(auto ? undefined : (prompt, host) => {
          job.public.phase = "authentication";
          job.public.challenge = { id: randomUUID(), kind: host ? "host_key" : "secret", prompt };
          job.public.step = host ? "Verify the server fingerprint" : "SSH authentication required";
          return this.wait(job);
        });
        this.stage(job, "checking", "Checking the remote environment…");
        await this.prepare(runtime, job);
        if (job.abort.signal.aborted || runtime.generation !== generation || this.stopped) throw new Error("Setup cancelled");
        runtime.machine.enabled = true;
        this.machines.set(machineId, runtime);
        await this.observe(runtime);
        this.persist();
        this.stage(job, "connected", "Connected");
        this.emit();
      } catch (e) {
        const ownsRuntime = runtime.generation === generation;
        if (ownsRuntime) this.disconnect(runtime);
        if (job.public.phase !== "cancelled") {
          job.public.phase = "failed"; job.public.step = "Connection failed";
          job.public.error = e instanceof Error ? e.message : String(e);
          // a failed bridge update keeps its button: the bridge is still out of date, and the
          // error says why this attempt failed (no network, a password needed, …)
          if (ownsRuntime) { runtime.machine.state = "error"; runtime.machine.error = job.public.error; runtime.machine.action_required = e instanceof MachineActionRequired ? e.action : job.update && existing ? "update_bridge" : null; }
          this.emit();
        }
      } finally {
        clearTimeout(job.timer); job.public.challenge = null; job.public.ssh_output = null; job.pending = undefined; job.ssh = undefined;
        if (job.runtime) { job.runtime.machine.updating = null; this.emit(); }
      }
    })();
    return job.public;
  }
  private stage(job: JobState, phase: SetupJob["phase"], step: string): void {
    if (job.abort.signal.aborted) throw new Error("Setup cancelled");
    job.public.phase = phase; job.public.step = step; job.public.challenge = null; job.public.ssh_output = null;
    // approved: from here on the install's own timeouts apply, not the setup's 10 minutes
    if (phase === "installing") clearTimeout(job.timer);
    // byte progress belongs to the stage that reported it: a step without its own bytes (the SSH
    // key registration after a bundle install, a first bridge start) shows its own text instead
    job.public.progress = null;
    this.showUpdate(job);
  }
  /** A stage's bytes so far; a new stage restarts the clock its rate is measured on. */
  private progress(job: JobState, stage: SetupProgress["stage"], done: number, total: number | null): void {
    const now = Date.now();
    if (job.public.progress?.stage !== stage) job.stageStartedAt = now;
    const elapsed = now - job.stageStartedAt;
    job.public.progress = { stage, done, total, rate: elapsed >= 500 && done > 0 ? Math.round(done / (elapsed / 1000)) : null, elapsed_ms: elapsed };
    this.showUpdate(job);
  }
  /** Mirror a bridge update onto its PC, so the sidebar and header show it without the dialog. */
  private showUpdate(job: JobState): void {
    if (!job.runtime) return;
    job.runtime.machine.updating = { job_id: job.public.id, step: job.public.step, progress: job.public.progress ?? null };
    // progress arrives per chunk: a few events a second are plenty
    if (!this.emitTimer) { this.emitTimer = setTimeout(() => { this.emitTimer = undefined; this.emit(); }, 250); this.emitTimer.unref(); }
  }
  private wait(job: JobState): Promise<string> {
    if (job.abort.signal.aborted) return Promise.reject(new Error("Setup cancelled"));
    return new Promise((resolve, reject) => { job.pending = { resolve, reject }; });
  }
  action(id: string, action: SetupAction): void {
    const job = this.jobs.get(id);
    if (!job) throw new Error("Setup job not found");
    if (action.action === "cancel") { this.cancelJob(id); return; }
    if (!job.pending) throw new Error("This setup step has already changed");
    if (action.action === "approve") {
      if (job.public.phase !== "approval") throw new Error("No installation is awaiting approval");
    } else if (action.action === "answer") {
      if (!job.public.challenge || action.challenge_id !== job.public.challenge.id) throw new Error("SSH question changed; read it again");
      if (typeof action.answer !== "string" || action.answer.length > 4096 || /[\r\n\0]/.test(action.answer)) throw new Error("Invalid SSH response");
      if (job.public.challenge.kind === "host_key" && !["yes", "no"].includes(action.answer)) throw new Error("Confirm or reject the fingerprint");
    } else throw new Error("Unknown setup action");
    const pending = job.pending;
    job.pending = undefined; job.public.challenge = null;
    // the step moves with the phase right here: the response to this request is serialized
    // before prepare resumes, and must not still carry the question that was just answered
    job.public.phase = action.action === "approve" ? "installing" : "connecting";
    job.public.step = actionStep(action.action);
    pending.resolve(action.action === "answer" ? action.answer : "approved");
  }
  private cancelJob(id: string): void {
    const job = this.jobs.get(id);
    if (!job || ["connected", "failed", "cancelled"].includes(job.public.phase)) return;
    job.public.phase = "cancelled"; job.public.step = "Cancelled"; job.public.challenge = null; job.public.ssh_output = null;
    job.abort.abort(); job.pending?.reject(new Error("Setup cancelled")); job.pending = undefined;
    job.ssh?.close(); clearTimeout(job.timer);
  }
  private async prepare(runtime: Runtime, job?: JobState): Promise<void> {
    const generation = runtime.generation;
    const ssh = runtime.ssh!;
    const session = runtime.machine.target!.session;
    const { host, inspection } = await detectHost(ssh, session);
    const { platform, expectedSocket } = inspection;
    let { herdrPath } = inspection;
    if (herdrPath) {
      const version = await host.herdrVersion(ssh, herdrPath);
      const match = /herdr (\d+)\.(\d+)\.(\d+)/.exec(version);
      if (!match || Number(match[1]) === 0 && Number(match[2]) < 9) throw new Error("The installed herdr is incompatible. Update it explicitly to 0.9+ before connecting; it was left unchanged.");
    }
    const descriptors = inspection.descriptors.filter((d) => d.socket_path === expectedSocket);
    let descriptor = descriptors.find((d) => d.bridge_protocol === BRIDGE_PROTOCOL && d.bundle_version === REMOTE_BUNDLE_VERSION);
    if (job?.update && !descriptor) descriptor = descriptors[0];
    if (descriptors.length && !descriptor) throw new MachineActionRequired("This PC runs a bridge from a different version. Update the bridge to reconnect; herdr sessions keep running.", "update_bridge");
    // a descriptor whose bridge is gone (a crash, a reboot, a Windows kill): the next bridge
    // replaces it, but until then it is still the first one listed
    let stalePid: number | null = null;
    if (descriptor) {
      if (!Number.isInteger(descriptor.pid) || descriptor.pid < 1) throw new Error("Invalid bridge process identity");
      if (!(await host.alive(ssh, descriptor.pid))) { stalePid = descriptor.pid; descriptor = undefined; }
    }
    const hasBundle = inspection.bundleReady;
    // a runtime from another bundle version and no bridge running (the PC rebooted since): an update
    if (!descriptor && !hasBundle && inspection.bundleOlder && !job) throw new MachineActionRequired("This PC has the bridge runtime of a different version. Update the bridge to reconnect; herdr sessions keep running.", "update_bridge");
    const installs: string[] = [];
    if (job?.update) installs.push("Download and verify the bridge runtime, then restart this bridge (herdr sessions keep running)");
    if (!descriptor && !hasBundle) installs.push(host.bundleDescription);
    if (!descriptor && !herdrPath) installs.push(host.installHerdr ? `herdr 0.9.3 through its own installer (${HERDR_INSTALL_CMD})` : "Bundled herdr 0.9.3 (existing installations are preserved)");
    if (!descriptor && job) installs.push("Start the loopback bridge and, only if absent, the herdr daemon");
    if (ssh.usedSecret) installs.push("Register a dedicated SSH public key for automatic reconnection");
    if (installs.length) {
      if (!job) throw new MachineActionRequired("Remote setup needs approval. Use Reconnect / setup on this PC.", "setup");
      job.public.installations = installs;
      // an automatic bridge update was approved by the app update (or the tap that started it)
      if (!job.auto) {
        this.stage(job, "approval", "Review the changes on this PC");
        await this.wait(job);
      }
      if (job.update || !descriptor && !hasBundle) { this.stage(job, "installing", `Installing verified ${platform} bundle…`); await host.installBundle(ssh, platform, job.abort.signal, { cacheDir: join(this.stateDir, "bundles"), onProgress: (stage, done, total) => this.progress(job, stage, done, total) }); }
      if (!descriptor && !herdrPath && host.installHerdr) { this.stage(job, "installing", "Installing herdr with its own installer…"); herdrPath = await host.installHerdr(ssh); }
      if (ssh.usedSecret) {
        this.stage(job, "installing", "Registering the app SSH key…");
        const path = join(this.sshDir, runtime.machine.id);
        if (!existsSync(path)) {
          const keygen = Bun.spawn(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", `termweave:${runtime.machine.id}`, "-f", path], { stdout: "ignore", stderr: "pipe" });
          if (await keygen.exited !== 0) throw new Error("Could not generate the dedicated SSH key");
        }
        chmodSync(path, 0o600);
        const publicKey = readFileSync(path + ".pub", "utf8").trim();
        await host.authorizeKey(ssh, "no-agent-forwarding,no-X11-forwarding,no-pty " + publicKey);
        // A separate master proves the new key actually works without a password.
        const proof = new SshConnection({ ...runtime.machine.target!, identity_file: path }, this.sshDir, path, true);
        try { await proof.start(); await (host.kind === "windows" ? proof.runPowerShell("Write-Output ok") : proof.run("true")); } finally { proof.close(); }
      }
    }
    if (job?.update && descriptor) {
      if (!descriptor.managed_remote) throw new Error("This socket uses an independently managed web server. Update it through its own Settings; it was left running.");
      const verified = await this.verify(ssh, descriptor, expectedSocket, true);
      if (!verified.identity.managed_remote || verified.identity.pid !== descriptor.pid) throw new Error("Bridge process verification failed; no process was stopped");
      this.stage(job, "starting", "Restarting the verified remote bridge…");
      this.progress(job, "restart", 0, null);
      await host.stop(ssh, descriptor.pid);
      await Bun.sleep(2500);
      descriptor = undefined;
    }
    if (!descriptor) {
      if (job) this.stage(job, "starting", "Starting the remote bridge…");
      await host.start(ssh, { session, herdrPath, inspection });
      for (let i = 0; i < 40; i++) {
        if (job?.abort.signal.aborted || this.stopped) throw new Error("Setup cancelled");
        descriptor = (await host.descriptors(ssh)).find((d) => d.socket_path === expectedSocket && d.pid !== stalePid);
        if (descriptor) break;
        await Bun.sleep(250);
      }
      if (!descriptor) throw new Error(`Bridge did not start. Check ${host.logHint} on the PC.`);
    }
    const verified = await this.verify(ssh, descriptor, expectedSocket);
    if (runtime.generation !== generation || this.stopped || job?.abort.signal.aborted) throw new Error("Setup cancelled");
    runtime.endpoint = verified.endpoint;
    runtime.machine.herdr = verified.identity.herdr;
  }
  private async verify(ssh: SshConnection, descriptor: BridgeDescriptor, expectedSocket: string, allowOldBundle = false): Promise<{ endpoint: { url: string; token: string }; identity: BridgeIdentity }> {
    if (!Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535 || typeof descriptor.token !== "string" || !/^[a-f0-9]{64}$/.test(descriptor.token)) throw new Error("Invalid bridge credentials");
    const port = await freePort();
    await ssh.forward(port, descriptor.port);
    const endpoint = { url: `http://127.0.0.1:${port}`, token: descriptor.token };
    const response = await fetch(`${endpoint.url}/api/bridge`, { headers: { authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(verificationFailure(response.status, await response.json().catch(() => null)));
    const identity: BridgeIdentity = await response.json();
    if (identity.bridge_protocol !== BRIDGE_PROTOCOL || !allowOldBundle && identity.bundle_version !== REMOTE_BUNDLE_VERSION) throw new MachineActionRequired("This PC runs a bridge from a different version. Update the bridge to reconnect; herdr sessions keep running.", "update_bridge");
    if (identity.socket_path !== expectedSocket || !identity.socket_id || identity.herdr.protocol < 22) throw new Error("Remote bridge/socket is incompatible; update it explicitly");
    return { endpoint, identity };
  }
  endpoint(id: string): { url: string; token: string } | undefined {
    const runtime = this.machines.get(id);
    return runtime?.machine.enabled && runtime.machine.state === "connected" ? runtime.endpoint : undefined;
  }
  trackTerminal(id: string, close: () => void): () => void {
    const runtime = this.machines.get(id);
    runtime?.terminals.add(close);
    return () => runtime?.terminals.delete(close);
  }
  private async refresh(runtime: Runtime): Promise<void> {
    if (!runtime.endpoint || this.stopped) return;
    if (runtime.refreshing) { runtime.refreshQueued = true; return; }
    runtime.refreshing = true;
    const endpoint = runtime.endpoint;
    const generation = runtime.generation;
    try {
      do {
        runtime.refreshQueued = false;
        const revision = runtime.snapshotRevision;
        try {
          const r = await fetch(endpoint.url + "/api/session", { headers: { authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(15_000) });
          if (!r.ok) throw new Error(`Remote herdr unavailable (${r.status})`);
          const { snapshot } = await r.json() as { snapshot: SessionSnapshot };
          if (generation !== runtime.generation || this.stopped) return;
          if (revision !== runtime.snapshotRevision) { runtime.refreshQueued = true; continue; }
          runtime.machine.snapshot = snapshot; runtime.machine.error = null;
          this.saveSoon();
          this.push.seed(snapshot.panes, runtime.machine.id, runtime.machine.name);
          this.emit();
        } catch (e) {
          if (generation !== runtime.generation || this.stopped) return;
          if (revision !== runtime.snapshotRevision) { runtime.refreshQueued = true; continue; }
          throw e;
        }
      } while (runtime.refreshQueued && generation === runtime.generation && !this.stopped);
    } finally {
      runtime.refreshing = false;
      // A reconnect can request its first load while the old connection is still
      // finishing. Start that queued load with the new generation's error handler.
      if (runtime.refreshQueued && generation !== runtime.generation && runtime.endpoint && !this.stopped) {
        const nextGeneration = runtime.generation;
        void this.refresh(runtime).catch((e) => this.lost(runtime, nextGeneration, e));
      }
    }
  }
  private async observe(runtime: Runtime): Promise<void> {
    const generation = runtime.generation;
    await this.refresh(runtime);
    if (generation !== runtime.generation || this.stopped) throw new Error("Connection cancelled");
    runtime.machine.state = "connected"; runtime.machine.action_required = null; runtime.attempts = 0;
    const endpoint = runtime.endpoint!;
    const ws = authenticatedWebSocket(endpoint.url.replace("http:", "ws:") + "/ws", endpoint.token);
    runtime.observer = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "role", mode: "observe" }));
    ws.onmessage = (event) => {
      if (generation !== runtime.generation || this.stopped) return;
      let message: ServerMessage;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (["snapshot", "pane-status", "pane-exited", "session-changed"].includes(message.type)) runtime.snapshotRevision++;
      if (message.type === "snapshot") { runtime.machine.snapshot = message.snapshot; this.push.seed(message.snapshot.panes, runtime.machine.id, runtime.machine.name); this.emit(); }
      if (message.type === "pane-status") {
        if (runtime.machine.snapshot) runtime.machine.snapshot = { ...runtime.machine.snapshot, panes: runtime.machine.snapshot.panes.map((p) => p.pane_id === message.pane_id ? paneAfterStatus(p, message) : p) };
        void this.push.onStatus(message.pane_id, message.agent_status, runtime.machine.id).catch(() => {});
      }
      if (message.type === "pane-exited") void this.push.onEnded(message.pane_id, runtime.machine.id).catch(() => {});
      this.emit({ type: "machine-message", machine_id: runtime.machine.id, message });
      if (["pane-status", "pane-exited", "session-changed"].includes(message.type)) void this.refresh(runtime).catch((e) => this.lost(runtime, generation, e));
    };
    ws.onclose = () => this.lost(runtime, generation, new Error("SSH bridge connection interrupted"));
    ws.onerror = () => ws.close();
    runtime.ssh!.onExit = () => this.lost(runtime, generation, new Error("SSH connection ended"));
    runtime.poll = setInterval(() => void this.refresh(runtime).catch((e) => this.lost(runtime, generation, e)), 5000);
    runtime.poll.unref();
  }
  private lost(runtime: Runtime, generation: number, error: unknown): void {
    if (generation !== runtime.generation || !runtime.machine.enabled || this.stopped) return;
    this.disconnect(runtime);
    runtime.machine.error = error instanceof Error ? error.message : String(error);
    if (error instanceof MachineActionRequired) {
      runtime.machine.state = "error"; runtime.machine.action_required = error.action;
      this.emit();
      // SSH itself just worked without a password, so the update can run unattended
      if (error.action === "update_bridge" && this.preferences.auto_update_bridges) this.queueAutoUpdate(runtime.machine.id);
      return;
    }
    runtime.machine.state = "reconnecting";
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(runtime.attempts++, 6));
    runtime.retry = setTimeout(() => void this.reconnect(runtime), delay); runtime.retry.unref();
    this.emit();
  }
  private async reconnect(runtime: Runtime): Promise<void> {
    if (this.stopped || !runtime.machine.enabled) return;
    this.disconnect(runtime);
    runtime.machine.state = "reconnecting"; runtime.machine.action_required = null; this.emit();
    const generation = runtime.generation;
    runtime.ssh = new SshConnection(runtime.machine.target!, this.sshDir, join(this.sshDir, runtime.machine.id));
    try {
      await runtime.ssh.start(); await this.prepare(runtime);
      if (generation !== runtime.generation || this.stopped) return;
      await this.observe(runtime); this.emit();
    } catch (e) { this.lost(runtime, generation, e); }
  }
  private queueAutoUpdate(id: string): void {
    if (this.autoQueued.has(id)) return;
    this.autoQueued.add(id);
    this.autoChain = this.autoChain.then(async () => {
      const runtime = this.machines.get(id);
      // still wanted: the PC may have been updated by hand, removed or disabled meanwhile
      if (this.stopped || !runtime?.machine.enabled || runtime.machine.action_required !== "update_bridge" || !this.preferences.auto_update_bridges) return;
      if ([...this.jobs.values()].some((j) => j.public.machine_id === id && !["connected", "failed", "cancelled"].includes(j.public.phase))) return;
      const job = this.updateBridge(id);
      await this.jobs.get(job.id)?.finished;
    }).catch((e) => { console.error("Automatic bridge update failed:", e instanceof Error ? e.message : String(e)); })
      .finally(() => { this.autoQueued.delete(id); });
  }
  private disconnect(runtime: Runtime): void {
    runtime.generation++;
    runtime.refreshQueued = false;
    clearTimeout(runtime.retry); clearInterval(runtime.poll);
    runtime.abort?.abort(); runtime.abort = undefined;
    runtime.observer?.close(); runtime.observer = undefined;
    for (const close of runtime.terminals) close(); runtime.terminals.clear();
    runtime.ssh?.close(); runtime.ssh = undefined; runtime.endpoint = undefined;
    runtime.machine.state = "disconnected";
  }
  patch(id: string, patch: { name?: unknown; enabled?: unknown }): void {
    const runtime = this.machines.get(id);
    if (!runtime) throw new Error("PC not found");
    if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") throw new Error("enabled must be boolean");
    if (patch.name !== undefined) { if (typeof patch.name !== "string" || !patch.name.trim() || patch.name.length > 100) throw new Error("Enter a PC name (1–100 characters)"); runtime.machine.name = patch.name.trim(); }
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== "boolean") throw new Error("enabled must be boolean");
      runtime.machine.enabled = patch.enabled;
      this.disconnect(runtime);
      for (const [id, job] of this.jobs) if (job.public.machine_id === runtime.machine.id) this.cancelJob(id);
      if (patch.enabled) void this.reconnect(runtime);
    }
    this.persist(); this.emit();
  }
  remove(id: string): void {
    const runtime = this.machines.get(id);
    if (!runtime) throw new Error("PC not found");
    runtime.machine.enabled = false; this.disconnect(runtime);
    for (const [jobId, job] of this.jobs) if (job.public.machine_id === id) this.cancelJob(jobId);
    this.machines.delete(id); this.persist();
    for (const suffix of ["", ".pub"]) try { unlinkSync(join(this.sshDir, id + suffix)); } catch {}
    this.emit();
  }
  stop(): void {
    this.stopped = true; clearInterval(this.localTimer); clearTimeout(this.saveTimer);
    for (const id of this.jobs.keys()) this.cancelJob(id);
    for (const runtime of this.machines.values()) this.disconnect(runtime);
    this.listeners.clear();
  }
}

/** A pane after a status frame: a frame that names a count of background tasks replaces it; one that names none leaves it. */
export function paneAfterStatus(p: HerdrPane, message: Extract<ServerMessage, { type: "pane-status" }>): HerdrPane {
  const { background_tasks: before, ...pane } = p;
  const tasks = message.background_tasks === undefined ? before : message.background_tasks > 0 ? message.background_tasks : undefined;
  return { ...pane, agent_status: message.agent_status, ...(tasks === undefined ? {} : { background_tasks: tasks }) };
}
