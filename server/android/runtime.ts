import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import type { AndroidDevice, AndroidOverview, MirrorMode, MirrorSession } from "../../shared/android.ts";

export class AndroidError extends Error {
  constructor(public code: string, public status = 409) { super(code); }
}
type Command = (args: string[], input?: string) => Promise<string>;
export interface MirrorProcess { exited: Promise<number>; stop(): void }
interface Dependencies { command: Command; launch: (args: string[]) => MirrorProcess; available: () => { adb: boolean; scrcpy: boolean } }
type Registered = Pick<AndroidDevice, "id" | "name" | "model" | "androidVersion">;
type Connected = { public: AndroidDevice; serial: string };
const idFor = (serial: string) => createHash("sha256").update(`termweave-android:${serial}`).digest("hex");
function binary(name: string) { return [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`].find(existsSync) ?? Bun.which(name); }
export function localEndpoint(value: unknown): string {
  if (typeof value !== "string") throw new AndroidError("invalid_endpoint", 400);
  const match = /^(\d+\.\d+\.\d+\.\d+):(\d{1,5})$/.exec(value);
  if (!match || isIP(match[1]!) !== 4) throw new AndroidError("invalid_endpoint", 400);
  const [a,b] = match[1]!.split(".").map(Number), port = Number(match[2]);
  if (!(a === 10 || a === 192 && b === 168 || a === 172 && b! >= 16 && b! <= 31) || port < 1024 || port > 65535)
    throw new AndroidError("private_wifi_endpoint_required", 400);
  return `${match[1]}:${port}`;
}
function defaults(): Dependencies {
  return {
    available: () => ({ adb: !!binary("adb"), scrcpy: !!binary("scrcpy") }),
    command: (args, input) => new Promise((resolve, reject) => {
      const adb = binary("adb"); if (!adb) { reject(new AndroidError("adb_missing", 503)); return; }
      const child = execFile(adb, args, { timeout: 12_000, maxBuffer: 128 * 1024 }, (error, stdout) => {
        if (error) reject(new AndroidError("adb_command_failed")); else resolve(stdout);
      });
      // Pairing codes are sent on stdin, never in process arguments or logs.
      child.stdin?.end(input);
    }),
    launch: args => {
      const scrcpy = binary("scrcpy"); if (!scrcpy) throw new AndroidError("scrcpy_missing", 503);
      const child: ChildProcess = spawn(scrcpy, args, { stdio: "ignore" });
      let ended = false;
      const exited = new Promise<number>(resolve => {
        child.once("error", () => { ended = true; resolve(1); });
        child.once("exit", code => { ended = true; resolve(code ?? 1); });
      });
      return { exited, stop() { if (!ended) child.kill("SIGTERM"); } };
    },
  };
}
export class AndroidRuntime {
  private registry = new Map<string, Registered>();
  private sessions = new Map<string, { public: MirrorSession; process: MirrorProcess }>();
  private file: string;
  private queue: Promise<unknown> = Promise.resolve();
  private deps: Dependencies;
  constructor(stateDir: string, deps?: Dependencies) {
    this.deps = deps ?? defaults(); this.file = join(stateDir, "android-devices.json");
    if (existsSync(this.file)) {
      const data = JSON.parse(readFileSync(this.file, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.devices) || data.devices.length > 32) throw new Error("Invalid Android registry");
      for (const device of data.devices) {
        if (!/^[a-f0-9]{64}$/.test(device.id) || typeof device.name !== "string" || typeof device.model !== "string" || typeof device.androidVersion !== "string") throw new Error("Invalid Android device");
        this.registry.set(device.id, device);
      }
    }
  }
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.queue.then(fn); this.queue = task.catch(() => {}); return task;
  }
  private save() {
    mkdirSync(join(this.file, ".."), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 1, devices: [...this.registry.values()] }), { mode: 0o600 });
    renameSync(temp, this.file);
  }
  private async connected(): Promise<Connected[]> {
    if (!this.deps.available().adb) return [];
    const rows = (await this.deps.command(["devices", "-l"])).split("\n").slice(1).filter(Boolean);
    const results: Connected[] = [];
    for (const row of rows.slice(0,32)) {
      const [serial, status] = row.trim().split(/\s+/); if (!serial || status !== "device") continue;
      // A transport address changes. The hardware identity must not.
      const hardware = (await this.deps.command(["-s", serial, "shell", "getprop", "ro.serialno"])).trim();
      if (!hardware || hardware === "unknown" || !/^[\w.-]{1,128}$/.test(hardware)) continue;
      const id = idFor(hardware);
      const model = row.match(/model:(\S+)/)?.[1]?.replaceAll("_", " ") ?? "Android";
      const androidVersion = (await this.deps.command(["-s", serial, "shell", "getprop", "ro.build.version.release"])).trim().slice(0,32);
      const saved = this.registry.get(id);
      const transport = /:|_adb/.test(serial) ? "wifi" : "usb";
      const item: Connected = { serial, public: { id, model, androidVersion, name: saved?.name ?? model, registered: !!saved, transport, state: "ready" } };
      const old = results.findIndex(d => d.public.id === id);
      if (old < 0) results.push(item); else if (transport === "usb") results[old] = item;
    }
    return results;
  }
  async overview(): Promise<AndroidOverview> {
    const connected = await this.connected();
    return { host: "server", available: this.deps.available(), devices: [...connected.map(d=>d.public), ...[...this.registry.values()].filter(d=>!connected.some(c=>c.public.id===d.id)).map(d=>({...d,registered:true,transport:"usb" as const,state:"offline" as const}))],
      sessions: [...this.sessions.values()].map(s=>({...s.public})), unattended: {status:"not_verified",reason:"physical_device_test_required"} };
  }
  register(id: string, name: string) { return this.locked(async () => {
    if (!name.trim() || name.length > 80) throw new AndroidError("invalid_name",400);
    if (this.registry.size >= 32 && !this.registry.has(id)) throw new AndroidError("device_limit");
    const device = (await this.connected()).find(d=>d.public.id===id);
    if (!device) throw new AndroidError("device_not_connected");
    const { model, androidVersion } = device.public;
    const previous = this.registry.get(id); this.registry.set(id,{id,name:name.trim(),model,androidVersion});
    try { this.save(); } catch (error) { if(previous)this.registry.set(id,previous);else this.registry.delete(id);throw error; }
    return { id };
  }); }
  forget(id: string) { return this.locked(async () => {
    if ([...this.sessions.values()].some(s=>s.public.deviceId===id && ["connecting","running"].includes(s.public.state))) throw new AndroidError("stop_mirror_first");
    const previous=this.registry.get(id);this.registry.delete(id);
    try { this.save(); } catch(error){if(previous)this.registry.set(id,previous);throw error;}
    return { forgotten: true };
  }); }
  pair(endpoint: unknown, code: unknown) { return this.locked(async () => {
    const address = localEndpoint(endpoint);
    if (typeof code !== "string" || !/^\d{6}$/.test(code)) throw new AndroidError("invalid_pairing_code",400);
    const output = await this.deps.command(["pair", address], `${code}\n`);
    if (!/Successfully paired/i.test(output)) throw new AndroidError("pairing_failed");
    return { paired: true };
  }); }
  connect(endpoint: unknown) { return this.locked(async () => {
    const address = localEndpoint(endpoint);
    const output = await this.deps.command(["connect",address]);
    if (!/connected to/i.test(output)) throw new AndroidError("connection_failed");
    return { connected: true };
  }); }
  start(id: string, mode: MirrorMode) { return this.locked(async () => {
    if (!["standard","light","screen-off"].includes(mode)) throw new AndroidError("invalid_mode",400);
    if (!this.registry.has(id)) throw new AndroidError("device_not_registered",403);
    if ([...this.sessions.values()].some(s=>s.public.deviceId===id && ["connecting","running"].includes(s.public.state))) throw new AndroidError("mirror_already_running");
    const device = (await this.connected()).find(d=>d.public.id===id);
    if (!device) throw new AndroidError("device_not_connected");
    const args = ["-s",device.serial,"--window-title",`TermWeave · ${this.registry.get(id)!.name}`,"--max-size",mode==="light"?"1024":"1600","--max-fps",mode==="light"?"30":"60"];
    if(mode==="light")args.push("--video-bit-rate","4M","--no-audio");
    if(mode==="screen-off")args.push("--turn-screen-off");
    const process = this.deps.launch(args);
    const session: MirrorSession={id:randomUUID(),deviceId:id,mode,state:"connecting",startedAt:new Date().toISOString(),error:null};
    this.sessions.set(session.id,{public:session,process});
    process.exited.then(code=>{if(session.state!=="stopped"){session.state=code===0?"stopped":"error";session.error=code===0?null:"mirror_process_failed";}});
    await Promise.race([process.exited,new Promise(resolve=>setTimeout(resolve,400))]);
    // Running means process running, not verified image delivery.
    if(session.state==="connecting")session.state="running";
    for(const [key,value] of this.sessions)if(this.sessions.size>64&&["stopped","error"].includes(value.public.state))this.sessions.delete(key);
    return {...session};
  }); }
  stop(id: string) { return this.locked(async () => {
    const session=this.sessions.get(id);if(!session)throw new AndroidError("mirror_not_found",404);
    if(["connecting","running"].includes(session.public.state)) {
      session.process.stop();
      const exited = await Promise.race([session.process.exited.then(()=>true),new Promise<false>(resolve=>setTimeout(()=>resolve(false),3000))]);
      if(!exited)throw new AndroidError("mirror_stop_unconfirmed");
      session.public.state="stopped";
    }
    return {...session.public};
  }); }
  dispose() { for(const s of this.sessions.values())if(["connecting","running"].includes(s.public.state))s.process.stop(); }
}
