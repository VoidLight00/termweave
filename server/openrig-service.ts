import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface OpenRigServiceStatus { enabled: boolean; running: boolean; available: boolean; busy: boolean; error?: string }
type Probe = { running: boolean; available: boolean; error?: string };
type Control = (action: "status" | "start" | "stop") => Promise<Probe>;
export class OpenRigServiceError extends Error {
  constructor(public code: string, public status = 503) { super(code); }
}
function localControl(): Control {
  return (action) => new Promise((resolveResult, reject) => {
    const python = Bun.which("python3");
    if (!python) return reject(new OpenRigServiceError("python_missing"));
    execFile(python, [resolve(import.meta.dir, "../scripts/openrig-daemon.py"), action], {
      timeout: 70_000, maxBuffer: 16_384, encoding: "utf8",
    }, (error, stdout) => {
      if (error) return reject(new OpenRigServiceError("service_control_failed"));
      try {
        const result = JSON.parse(stdout);
        if (typeof result.running !== "boolean" || typeof result.available !== "boolean") throw new Error();
        resolveResult({ running: result.running, available: result.available,
          ...(typeof result.error === "string" && /^[a-z_]{1,80}$/.test(result.error) ? { error: result.error } : {}) });
      } catch { reject(new OpenRigServiceError("invalid_service_response")); }
    });
  });
}
/** The web bridge never stops the daemon during its own shutdown. Its off switch is explicit. */
export class OpenRigService {
  private file: string;
  private control: Control;
  private configured = false;
  private desired = true; // Preserve existing installations until their first explicit choice.
  private corrupt = false;
  private changing = false;
  private remote = false;
  private last: Probe = { running: false, available: false };
  private checkedAt = 0;
  private checking: Promise<Probe> | null = null;
  constructor(stateDir: string, control?: Control) {
    this.file = join(stateDir, "openrig-service.json");
    this.control = control ?? localControl();
    const origin = process.env.TERMWEAVE_OPENRIG_URL;
    this.remote = !control && !!origin && origin.replace(/\/$/, "") !== "http://127.0.0.1:7338";
    if (existsSync(this.file)) {
      try {
        if (lstatSync(this.file).isSymbolicLink()) throw new Error();
        const saved = JSON.parse(readFileSync(this.file, "utf8"));
        if (saved.version !== 1 || typeof saved.enabled !== "boolean") throw new Error();
        this.desired = saved.enabled; this.configured = true;
      } catch { this.corrupt = true; this.desired = false; }
    }
  }
  get enabled() { return this.desired && !this.corrupt; }
  get busy() { return this.changing; }
  private persist(enabled: boolean) {
    const dir = resolve(this.file, ".."); mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = this.file + "." + randomUUID() + ".tmp";
    try {
      if (existsSync(this.file) && lstatSync(this.file).isSymbolicLink()) throw new Error();
      writeFileSync(temp, JSON.stringify({ version: 1, enabled }) + "\n", { mode: 0o600, flag: "wx" });
      renameSync(temp, this.file); this.desired = enabled; this.configured = true;
    } catch { throw new OpenRigServiceError("service_storage_failed"); }
    finally { rmSync(temp, { force: true }); }
  }
  async status(force = false): Promise<OpenRigServiceStatus> {
    if (this.remote || this.corrupt) return { enabled: this.enabled, running: false, available: false, busy: this.busy,
      error: this.corrupt ? "service_storage_failed" : "external_service" };
    if (!this.changing && (force || Date.now() - this.checkedAt > 1500)) {
      this.checking ??= this.control("status").catch(() => ({ running: false, available: false, error: "service_unavailable" })).finally(() => { this.checking = null; });
      this.last = await this.checking; this.checkedAt = Date.now();
    }
    return { enabled: this.enabled, ...this.last, busy: this.busy };
  }
  async setEnabled(enabled: boolean): Promise<OpenRigServiceStatus> {
    if (this.remote || this.corrupt) throw new OpenRigServiceError("service_not_managed", 409);
    if (this.changing) throw new OpenRigServiceError("service_busy", 409);
    this.changing = true;
    try {
      // Persist intent before stopping. A failed stop still blocks team mutations and
      // cannot trigger a restart after a bridge reload. Keep the measured process state.
      this.persist(enabled);
      const result = await this.control(enabled ? "start" : "stop");
      this.last = result; this.checkedAt = Date.now();
      if (result.error || result.running !== enabled) throw new OpenRigServiceError(result.error ?? "service_state_unknown");
      return { enabled: this.enabled, ...result, busy: false };
    } finally { this.changing = false; }
  }
  /** Restore an explicit on choice after the host or web bridge starts. Never enable a new install. */
  async restore(): Promise<void> {
    if (!this.configured || !this.enabled || this.remote) return;
    try { await this.setEnabled(true); } catch { /* status exposes the failed start; native terminals remain usable. */ }
  }
}
