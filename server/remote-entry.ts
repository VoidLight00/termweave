// The bundle is launched only through SSH. Keep it alive after the tunnel closes;
// herdr owns the terminal processes and no disconnect should terminate their work.
import { createServer } from "./index.ts";
import { bridgeIdentity, descriptorPath, registerBridge } from "./bridge.ts";
import { parseProcessLine, staleMarker } from "./herdr-marker.ts";
import { psQuote } from "./powershell.ts";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";

process.env["HERDR_WEB_REMOTE"] = "1";
const windows = process.platform === "win32";
// the transcript readers find agent stores under $HOME, which Windows does not set
if (windows && !process.env["HOME"]) process.env["HOME"] = homedir();
const bundle = join(import.meta.dir, "..");
process.env["PATH"] = `${join(bundle, "bin")}${delimiter}${process.env["PATH"] ?? "/usr/bin:/bin"}`;
const session = process.env["HERDR_REMOTE_SESSION"];
// herdr puts its sockets under XDG_CONFIG_HOME when it is set (GitHub's Linux runners and some
// desktops set it), so the bridge must look where the daemon it starts will listen; on
// Windows they live under %APPDATA%\herdr (`herdr status server`)
const herdrConfig = windows ? join(process.env["APPDATA"] || join(homedir(), "AppData", "Roaming"), "herdr") : join(process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "herdr");
process.env["HERDR_SOCKET"] = session ? join(herdrConfig, "sessions", session, "herdr.sock") : join(herdrConfig, "herdr.sock");
function staleWindowsMarker(path: string): boolean {
  return staleMarker(readFileSync(path, "utf8"), (pid) => {
    try {
      const probe = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.ProcessName + '|' + ([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() }`], { stdin: "ignore", stderr: "ignore" });
      if (probe.exitCode === 0) return parseProcessLine(probe.stdout.toString());
    } catch { /* no PowerShell: the pid alone has to do */ }
    try { process.kill(pid, 0); return { name: "herdr", startedMs: null }; } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH" ? null : { name: "herdr", startedMs: null }; }
  });
}

/**
 * Bun's children on Windows share its job object and die with it (live-verified: a bridge
 * killed for an update took its herdr along). WMI creates the daemon from outside that job,
 * so herdr's sessions outlive every bridge. WMI does not pass the caller's environment on,
 * and herdr finds its socket directory through it (APPDATA), so it goes along explicitly.
 */
async function spawnDetachedWindows(exe: string, args: string[], log: string): Promise<void> {
  for (const value of [exe, ...args, log]) if (/["\r\n\0]/.test(value)) throw new Error(`Invalid characters in ${value}`);
  const quote = psQuote;
  const line = `cmd.exe /d /c ""${exe}" ${args.join(" ")} >> "${log}" 2>&1"`;
  const environment = Object.entries(process.env).filter(([name, value]) => value !== undefined && !/[\r\n\0=]/.test(name) && !/[\r\n\0]/.test(value)).map(([name, value]) => quote(`${name}=${value}`));
  const script = [
    `$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0; EnvironmentVariables = [string[]]@(${environment.join(", ")}) }`,
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${quote(line)}; CurrentDirectory = ${quote(homedir())}; ProcessStartupInformation = $startup }`,
    "exit $r.ReturnValue",
  ].join("\n");
  const ps = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([ps.exited, new Response(ps.stderr).text()]);
  if (code !== 0) throw new Error(`herdr could not be started through WMI (${code}): ${stderr.trim()}`);
}

const descriptor = descriptorPath();
mkdirSync(dirname(descriptor), { recursive: true, mode: 0o700 });
const lock = descriptor + ".lock";
try { mkdirSync(lock, { mode: 0o700 }); } catch {
  let stale = false;
  try {
    const owner = Number(readFileSync(join(lock, "pid"), "utf8"));
    if (Number.isInteger(owner) && owner > 0) {
      try { process.kill(owner, 0); } catch (e) { stale = (e as NodeJS.ErrnoException).code === "ESRCH"; }
    }
  } catch { /* a concurrent starter may not yet have written its PID */ }
  if (!stale) throw new Error("Another bridge is starting; retry shortly");
  rmSync(lock, { recursive: true }); mkdirSync(lock, { mode: 0o700 });
}
writeFileSync(join(lock, "pid"), String(process.pid), { mode: 0o600 });
try {
  let existing = false;
  try { const data = JSON.parse(readFileSync(descriptor, "utf8")); process.kill(data.pid, 0); existing = true; } catch {}
  if (!existing) {
  try { await bridgeIdentity(); } catch (error) {
    // A socket that exists but cannot answer is an operator problem, not permission
    // to replace the daemon. Only absent sockets permit starting a new server.
    // on Windows the socket is a marker file `pid:start` that a killed herdr leaves behind;
    // its pid says whether a daemon is really there
    if (existsSync(process.env["HERDR_SOCKET"]!) && !(windows && staleWindowsMarker(process.env["HERDR_SOCKET"]!))) throw error;
    // a Windows bundle carries no herdr: its installer is herdr's own, and setup ran it
    const herdr = process.env["HERDR_WEB_HERDR_BIN"] || join(bundle, "bin/herdr");
    if (windows && !existsSync(herdr)) throw new Error(`herdr is not installed at ${herdr}; install it with herdr.dev/install.cmd`);
    const args = session ? ["--session", session, "server"] : ["server"];
    // one log per session on Windows: cmd holds the file a running daemon's output goes to
    const log = join(dirname(descriptor), windows && session ? `herdr-${session}.log` : "herdr.log");
    if (windows) await spawnDetachedWindows(herdr, args, log);
    else Bun.spawn([herdr, ...args], { stdin: "ignore", stdout: Bun.file(log), stderr: Bun.file(log) }).unref();
    let ready = false;
    // a cold first start (fresh HOME, slow disk or CI runner) can take well over ten seconds
    for (let i = 0; i < 300; i++) { try { await bridgeIdentity(); ready = true; break; } catch { await Bun.sleep(100); } }
    if (!ready) throw new Error("herdr did not start; inspect ~/.config/herdr-web-ui/bridges/herdr.log");
  }
  const info = await bridgeIdentity();
  if (info.herdr.protocol < 22) throw new Error("herdr 0.9+ is required; update it explicitly before connecting");
  const token = randomBytes(32).toString("hex");
  const server = createServer({ port: 0, hostname: "127.0.0.1", token, machines: false, stateDir: descriptor + ".state" });
  const registration = registerBridge(server.port, token);
  const close = () => { registration.close(); server.stop(); setTimeout(() => process.exit(0), 2000); };
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
  }
} finally { rmSync(lock, { recursive: true, force: true }); }
