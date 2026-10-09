import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeProgress } from "../src/lib/bridgeProgress.ts";
import type { SetupJob } from "../shared/machines.ts";
import { paneNotificationTag } from "../shared/notify-policy.ts";
import { machinePath, paneStorageId, REMOTE_BUNDLE_VERSION } from "../shared/machines.ts";
import { canSendSecret, sameOrigin, shellQuote, validateTarget } from "./machine-security.ts";
import { handleMachineRequest, MACHINE_PROXY_PATH } from "./machine-api.ts";
import type { BridgeDescriptor } from "./bridge.ts";
import { createServer } from "./index.ts";
import { MachineManager } from "./machines.ts";
import { detectHost, psQuote, UNSUPPORTED_HOST, windowsBridgeFiles } from "./remote-host.ts";
import { decodeClixml, type SshConnection } from "./ssh.ts";
import { terminalAttachSupported } from "./herdr/client.ts";
import { attachableIdentity, isRealNode, sidecarAvailable } from "./pty/sidecar.ts";
import { CompletionTracker } from "./completion.ts";
import type { PushService } from "./push.ts";
import { recentSshOutput } from "./ssh.ts";

describe("machine boundaries", () => {
  it("separates equal pane IDs while preserving historical local storage", () => {
    expect(paneStorageId("local", "p:1")).toBe("p:1");
    expect(new Set(["local", "one", "two"].map((id) => paneStorageId(id, "p:1"))).size).toBe(3);
    expect(paneNotificationTag("p:1", "one")).not.toBe(paneNotificationTag("p:1", "two"));
    expect(machinePath("pc/name", "pane/image")).toBe("/api/machines/pc%2Fname/pane/image");
  });
  it("rejects shell and SSH-option injection in user-controlled target fields", () => {
    for (const destination of ["-oProxyCommand=touch /tmp/no", "host;id", "x\ny", "$(id)", "user@host -p 22", ""]) expect(() => validateTarget({ destination })).toThrow();
    expect(validateTarget({ destination: "user@[::1]", port: 2222, session: "work" }).port).toBe(2222);
    for (const session of ["../default", "$(id)", "work;id"]) expect(() => validateTarget({ destination: "host", session })).toThrow();
    const value = "a'$(touch /tmp/no)";
    expect(Bun.spawnSync(["sh", "-c", `printf %s ${shellQuote(value)}`]).stdout.toString()).toBe(value);
  });
  it("rejects cross-origin controls and limits secret submission to secure origins", () => {
    expect(sameOrigin(new Request("http://localhost:7317/api/machines", { headers: { origin: "http://evil.test" } }))).toBe(false);
    expect(sameOrigin(new Request("http://localhost:7317/api/machines", { headers: { origin: "http://localhost:7317" } }))).toBe(true);
    expect(canSendSecret(new Request("http://192.0.2.1/api/machines"))).toBe(false);
    expect(canSendSecret(new Request("https://app.example/api/machines"))).toBe(true);
    expect(canSendSecret(new Request("http://127.0.0.1/api/machines"))).toBe(true);
  });
  it("proxies only pane/workspace data and never remote management credentials", () => {
    for (const path of ["auth", "push", "updates/install", "machines/setup", "bridge", "../auth", "pane/../../auth", "pane/prompt/answer/extra"]) expect(MACHINE_PROXY_PATH.test(path)).toBe(false);
    for (const path of ["session", "agents", "pane/files", "pane/image", "pane/prompt/answer", "workspace/create"]) expect(MACHINE_PROXY_PATH.test(path)).toBe(true);
  });
});

// A setup job placed directly in the manager: driving a whole setup needs a real SSH host, but
// action() and stage() are the code that decides what the dialog shows.
type TestJob = { public: SetupJob; abort: AbortController; timer: ReturnType<typeof setTimeout>; stageStartedAt: number; pending?: { resolve(value: string): void; reject(error: Error): void }; update: boolean; auto: boolean; finished: Promise<void> };
describe("setup job labels", () => {
  const dirs: string[] = [];
  const managers: MachineManager[] = [];
  afterEach(() => {
    for (const manager of managers.splice(0)) manager.stop();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function fixture(phase: SetupJob["phase"], step: string, challenge: SetupJob["challenge"] = null) {
    const dir = mkdtempSync(join(tmpdir(), "herdr-machines-"));
    dirs.push(dir);
    const manager = new MachineManager(dir, {} as PushService, {} as CompletionTracker);
    managers.push(manager);
    const job: TestJob = {
      public: { id: "job", machine_id: "machine", target: { destination: "pc" }, phase, step, challenge, installations: [], error: null, ssh_output: null, progress: null },
      abort: new AbortController(), timer: setTimeout(() => {}, 0), stageStartedAt: Date.now(), update: false, auto: false, finished: Promise.resolve(),
    };
    clearTimeout(job.timer);
    job.pending = { resolve: () => {}, reject: () => {} };
    (manager as unknown as { jobs: Map<string, TestJob> }).jobs.set("job", job);
    const drive = manager as unknown as { stage(job: TestJob, phase: SetupJob["phase"], step: string): void; progress(job: TestJob, stage: "download" | "upload" | "install" | "restart", done: number, total: number | null): void };
    return { manager, job, drive };
  }

  it("drops the review heading as soon as an approval is given", () => {
    const { manager, job } = fixture("approval", "Review the changes on this PC");
    manager.action("job", { action: "approve" });
    expect(manager.job("job")?.phase).toBe("installing");
    expect(manager.job("job")?.step).not.toBe("Review the changes on this PC");
    expect(job.public.step).toBe("Installing on this PC…");
  });

  it("drops the SSH question's heading as soon as it is answered", () => {
    for (const [step, kind] of [["Verify the server fingerprint", "host_key"], ["SSH authentication required", "secret"]] as const) {
      const { manager } = fixture("authentication", step, { id: "c1", kind, prompt: "?" });
      manager.action("job", { action: "answer", challenge_id: "c1", answer: kind === "host_key" ? "yes" : "pw" });
      expect(manager.job("job")?.phase).toBe("connecting");
      expect(manager.job("job")?.step).not.toBe(step);
    }
  });

  it("labels the first start of a bridge as its own step, not as a restart", () => {
    const { manager, drive, job } = fixture("installing", "Installing verified linux-x64 bundle…");
    drive.progress(job, "install", 0, null);
    drive.stage(job, "starting", "Starting the remote bridge…");
    expect(manager.job("job")?.step).toBe("Starting the remote bridge…");
    expect(manager.job("job")?.progress).toBeNull();
    expect(describeProgress(manager.job("job")?.progress)).toBeNull();
  });

  it("keeps the restart label for the restart of a bridge update", () => {
    const { manager, drive, job } = fixture("installing", "Installing verified linux-x64 bundle…");
    drive.stage(job, "starting", "Restarting the verified remote bridge…");
    drive.progress(job, "restart", 0, null);
    expect(describeProgress(manager.job("job")?.progress)?.label).toBe("Restarting the bridge");
  });

  it("shows a step without byte progress by its own text, not the previous stage's label", () => {
    const { manager, drive, job } = fixture("installing", "Installing verified linux-x64 bundle…");
    drive.progress(job, "install", 0, null);
    expect(describeProgress(manager.job("job")?.progress)?.label).toBe("Verifying and installing");
    drive.stage(job, "installing", "Registering the app SSH key…");
    expect(manager.job("job")?.progress).toBeNull();
    expect(describeProgress(manager.job("job")?.progress)).toBeNull();
  });
});

describe("SSH output during setup", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

  /** A PC whose ssh prints a line and then waits for the user, like Tailscale SSH's browser check. */
  function waitingSsh(script: string): MachineManager {
    const root = mkdtempSync(join(tmpdir(), "herdr-ssh-output-"));
    const bin = join(root, "bin");
    Bun.spawnSync(["mkdir", bin]);
    writeFileSync(join(bin, "ssh"), `#!/bin/sh\n${script}\n`);
    chmodSync(join(bin, "ssh"), 0o755);
    const path = process.env["PATH"];
    process.env["PATH"] = `${bin}:${path}`;
    const manager = new MachineManager(join(root, "state"), {} as PushService, new CompletionTracker(null));
    // stop() cancels the job, which kills the fake ssh (it `exec`s sleep, so there is no orphan)
    cleanups.push(() => { manager.stop(); process.env["PATH"] = path; rmSync(root, { recursive: true, force: true }); });
    return manager;
  }
  async function until<T>(read: () => T | undefined | null | false): Promise<T> {
    for (let i = 0; i < 100; i += 1) { const value = read(); if (value) return value; await Bun.sleep(50); }
    throw new Error("timed out");
  }

  it("shows what ssh printed while it is still waiting, and drops it once the setup is cancelled", async () => {
    const manager = waitingSsh(`echo "To authenticate, visit: https://login.tailscale.com/a/check123" >&2\nexec sleep 30`);
    const started = manager.setup({ destination: "check-pc" });
    expect(started.ssh_output).toBeNull();
    const job = await until(() => manager.job(started.id)?.ssh_output ? manager.job(started.id) : null);
    expect(job.phase).toBe("connecting");
    expect(job.ssh_output).toBe("To authenticate, visit: https://login.tailscale.com/a/check123");
    // the dialog polls this route: the line has to be in its answer, not only on the manager
    const response = await handleMachineRequest(new Request(`http://localhost:7317/api/machines/setup/${started.id}`, { headers: { origin: "http://localhost:7317" } }), manager);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ phase: "connecting", ssh_output: "To authenticate, visit: https://login.tailscale.com/a/check123" });
    manager.action(started.id, { action: "cancel" });
    expect(manager.job(started.id)).toMatchObject({ phase: "cancelled", ssh_output: null });
  });

  it("keeps only the recent lines, without terminal control characters", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    expect(recentSshOutput(lines).split("\n")).toEqual(["line 12", "line 13", "line 14", "line 15", "line 16", "line 17", "line 18", "line 19"]);
    expect(recentSshOutput("\x1b[31mred\x1b[0m\r\n\n  \nspinner\rdone\x07\n")).toBe("red\nspinner\ndone");
    expect(recentSshOutput("x".repeat(5000)).length).toBe(2048);
    expect(recentSshOutput("")).toBe("");
  });
});

describe("terminal attach capability", () => {
  it("follows herdr's own word when it gives one, and the platform otherwise", () => {
    expect(terminalAttachSupported({ direct_terminal_attach: false, live_handoff: true })).toBe(false);
    expect(terminalAttachSupported({ direct_terminal_attach: true })).toBe(true);
    expect(terminalAttachSupported({ live_handoff: true })).toBe(process.platform !== "win32");
    expect(terminalAttachSupported(undefined)).toBe(process.platform !== "win32");
  });

  it("mirrors a PC whose bridge cannot run the PTY sidecar, whatever herdr declares", () => {
    const declared = { version: "0.9.9", protocol: 22, terminal_attach: terminalAttachSupported({ direct_terminal_attach: true }) };
    expect(attachableIdentity(declared, false)).toEqual({ version: "0.9.9", protocol: 22, terminal_attach: false, terminal_mirror: true });
    expect(attachableIdentity(declared, true)).toEqual(declared);
    const mirrored = { version: "0.9.9", protocol: 22, terminal_attach: false, terminal_mirror: true };
    expect(attachableIdentity(mirrored, true)).toEqual(mirrored);
    expect(attachableIdentity(mirrored, false)).toEqual(mirrored);
  });

  it("counts the sidecar as runnable only with both node and node-pty", () => {
    expect(sidecarAvailable({ node: () => true, pty: () => true })).toBe(true);
    expect(sidecarAvailable({ node: () => false, pty: () => true })).toBe(false);
    expect(sidecarAvailable({ node: () => true, pty: () => false })).toBe(false);
  });

  it("takes a node for Node only when it answers in time and is not Bun", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-sidecar-probe-"));
    const stand = (name: string, body: string) => {
      const path = join(dir, name);
      writeFileSync(path, `#!/bin/sh\n${body}\n`);
      chmodSync(path, 0o755);
      return path;
    };
    try {
      expect(isRealNode(stand("node", "echo"))).toBe(true);
      expect(isRealNode(stand("bun-as-node", "echo 1.4.2"))).toBe(false);
      expect(isRealNode(stand("broken", "exit 1"))).toBe(false);
      expect(isRealNode(join(dir, "absent"))).toBe(false);
      // a node that never answers is given up on, not waited for
      expect(isRealNode(stand("hung", "exec sleep 30"), process.env, 200)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("host detection", () => {
  /** a PC that answers sh with `shError` (or not at all) and PowerShell with `ps` */
  const pc = (shError: string | null, ps: string | Error): SshConnection => ({
    run: async (script: string) => {
      if (shError !== null) throw new Error(shError);
      // the sh probe, then the socket realpath
      return script.includes("uname") ? "Linux\nx86_64\n/home/u\n/home/u/.config\n/usr/bin/herdr\nbundle-ready\n" : "/home/u/.config/herdr/herdr.sock"; // leakscan:allow: test fixture
    },
    runPowerShell: async () => { if (ps instanceof Error) throw ps; return ps; },
  } as unknown as SshConnection);
  const windowsAnswer = "Windows\nAMD64\nC:\\Users\\u\nC:\\Users\\u\\AppData\\Roaming\nC:\\Users\\u\\AppData\\Local\nC:\\Users\\u\\AppData\\Local\\Programs\\Herdr\\bin\\herdr.exe\n";

  it("takes a PC that answers sh as Linux or macOS without asking PowerShell", async () => {
    const { host, inspection } = await detectHost(pc(null, new Error("never asked")));
    expect(host.kind).toBe("posix");
    expect(inspection).toMatchObject({ platform: "linux-x64", home: "/home/u", herdrPath: "/usr/bin/herdr", expectedSocket: "/home/u/.config/herdr/herdr.sock", bundleReady: true }); // leakscan:allow: test fixture
  });
  it("asks a PC whose cmd or PowerShell cannot find sh in PowerShell, and reads Windows paths", async () => {
    for (const shError of ["'sh' is not recognized as an internal or external command,\r\noperable program or batch file.", "sh : The term 'sh' is not recognized as a name of a cmdlet, function, script file, or executable program."]) {
      const { host, inspection } = await detectHost(pc(shError, windowsAnswer), "qa");
      expect(host.kind).toBe("windows");
      expect(inspection).toMatchObject({
        platform: "win32-x64", home: "C:\\Users\\u", herdrPath: "C:\\Users\\u\\AppData\\Local\\Programs\\Herdr\\bin\\herdr.exe",
        expectedSocket: "C:\\Users\\u\\AppData\\Roaming\\herdr\\sessions\\qa\\herdr.sock",
        runtimeDir: `C:\\Users\\u\\AppData\\Local\\termweave\\remote-v${REMOTE_BUNDLE_VERSION}`, bundleReady: false,
      });
    }
  });
  it("refuses a Windows PC that is not x64, by name", async () => {
    await expect(detectHost(pc("sh: not found", windowsAnswer.replace("AMD64", "ARM64")))).rejects.toThrow(UNSUPPORTED_HOST);
  });
  it("reports sh's own error for a PC that answers neither shell", async () => {
    await expect(detectHost(pc("ssh: connect to host pc port 22: Connection refused", new Error("Connection refused")))).rejects.toThrow("connect to host pc port 22");
  });
  it("reads PowerShell's words out of its CLIXML stderr", () => {
    const stderr = '#< CLIXML\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><MS><PR N="Record"><AV>처음 사용하기 위해 모듈을 준비하는 중입니다.</AV></PR></MS></Obj><S S="Error">Another installation is in progress; retry shortly_x000D__x000A_</S><S S="Error">At line:4 char:1 &lt;x&gt;_x000D__x000A_</S></Objs>';
    expect(decodeClixml(stderr)).toBe("Another installation is in progress; retry shortly\nAt line:4 char:1 <x>");
    expect(decodeClixml("#< CLIXML\n<Objs><Obj S=\"progress\"/></Objs>")).toBe("PowerShell failed");
  });
  it("gives each herdr session its own bridge log and launcher on Windows", () => {
    expect(windowsBridgeFiles()).toEqual({ log: "bridge.log", launcher: "start-bridge.cmd" });
    expect(windowsBridgeFiles("web-qa")).toEqual({ log: "bridge-web-qa.log", launcher: "start-bridge-web-qa.cmd" });
  });
  it("quotes for PowerShell with doubled single quotes only", () => {
    expect(psQuote("C:\\Users\\o'brien\\x")).toBe("'C:\\Users\\o''brien\\x'");
    // PowerShell ends a single-quoted literal at a curly quote too
    expect(psQuote("a\u2019; Write-Output injected; #")).toBe("'a\u2019\u2019; Write-Output injected; #'");
    expect(psQuote("\u2018\u201A\u201B")).toBe("'\u2018\u2018\u201A\u201A\u201B\u201B'");
    expect(() => psQuote("a\nb")).toThrow();
  });
});

// verify() runs inside a setup that needs a real SSH host. Here its SSH forward is a loopback
// relay, and the bridge is a real server whose herdr is absent, or a stand-in with a fixed answer.
describe("bridge verification failures", () => {
  const TOKEN = "a".repeat(64);
  const GENERIC = (status: number) => `Bridge verification failed (${status}). Reconnect after checking the remote bridge.`;
  const socketBefore = process.env["HERDR_SOCKET"];
  const stops: (() => void)[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    if (socketBefore === undefined) delete process.env["HERDR_SOCKET"]; else process.env["HERDR_SOCKET"] = socketBefore;
  });
  const temp = () => { const dir = mkdtempSync(join(tmpdir(), "herdr-bridge-verify-")); dirs.push(dir); return dir; };
  /** a bridge whose herdr socket is `socket` */
  function bridge(socket: string): number {
    process.env["HERDR_SOCKET"] = socket;
    const server = createServer({ port: 0, hostname: "127.0.0.1", token: TOKEN, stateDir: temp(), machines: false, registerBridge: false, tailscaleOwner: null });
    stops.push(() => server.stop());
    return server.port!;
  }
  /** a bridge that answers /api/bridge with one fixed response */
  function answering(status: number, body: string): number {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(body, { status }) });
    stops.push(() => server.stop(true));
    return server.port!;
  }
  /** what the person adding the PC is told when verification of the bridge on `port` fails */
  async function told(port: number, socket = "/home/u/.config/herdr/herdr.sock"): Promise<string> { // leakscan:allow: test fixture
    const manager = new MachineManager(temp(), {} as PushService, {} as CompletionTracker);
    stops.push(() => manager.stop());
    const ssh = { forward: async (local: number, remote: number) => {
      const relay = Bun.serve({ port: local, hostname: "127.0.0.1", fetch: (request) => fetch(`http://127.0.0.1:${remote}${new URL(request.url).pathname}`, { headers: request.headers }) });
      stops.push(() => relay.stop(true));
    } } as unknown as SshConnection;
    const descriptor: BridgeDescriptor = { port, token: TOKEN, pid: process.pid, socket_path: socket, bridge_protocol: 0, bundle_version: "" };
    const verify = (manager as unknown as { verify(ssh: SshConnection, descriptor: BridgeDescriptor, socket: string): Promise<unknown> }).verify.bind(manager);
    return verify(ssh, descriptor, socket).then(() => "verified", (error: Error) => error.message);
  }

  it("says herdr is not running when the bridge finds no socket", async () => {
    const dir = temp();
    const socket = join(dir, "herdr.sock");
    const port = bridge(socket);
    const response = await fetch(`http://127.0.0.1:${port}/api/bridge`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const body = await response.json() as { error: { code: string; message: string } };
    expect({ status: response.status, code: body.error.code }).toEqual({ status: 404, code: "socket_missing" });
    expect(body.error.message).not.toContain(dir);
    const message = await told(port, socket);
    expect(message).toContain("herdr is not running");
    expect(message).not.toContain(dir);
  });

  it("says herdr is not answering when the socket is there without a daemon", async () => {
    const dir = temp();
    const socket = join(dir, "herdr.sock");
    writeFileSync(socket, "");
    const message = await told(bridge(socket), socket);
    expect(message).toContain("herdr is not answering");
    expect(message).not.toContain(dir);
  });

  it("reads a missing socket from the 500 an installed older bridge still answers", async () => {
    const old = JSON.stringify({ error: { code: "internal_error", message: "ENOENT: no such file or directory, stat '/home/u/.config/herdr/herdr.sock'" } }); // leakscan:allow: test fixture
    const message = await told(answering(500, old));
    expect(message).toContain("herdr is not running");
    expect(message).not.toContain("/home/u");
  });

  it("keeps the status-only message for any other answer, without repeating its text", async () => {
    expect(await told(answering(500, JSON.stringify({ error: { code: "internal_error", message: "EACCES: permission denied, stat '/home/u/x'" } })))).toBe(GENERIC(500)); // leakscan:allow: test fixture
    expect(await told(answering(503, "<html>proxy</html>"))).toBe(GENERIC(503));
    expect(await told(answering(500, "null"))).toBe(GENERIC(500));
  });
});
