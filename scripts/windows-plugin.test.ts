import { expect, it } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { socketAddress } from "../server/herdr/client.ts";
import { windowsProcessTable } from "../server/windows-processes.ts";
import { updateStateDir } from "../server/update-state.ts";

it.skipIf(process.platform !== "win32")("starts after its launcher exits, stops its owned tree and restarts on Windows", async () => {
  const root = join(import.meta.dir, "..");
  const scratch = mkdtempSync(join(tmpdir(), "herdr windows plugin "));
  const bin = join(scratch, ".bun", "bin");
  mkdirSync(bin, { recursive: true });
  copyFileSync(process.execPath, join(bin, "bun.exe"));
  const manifest = Bun.TOML.parse(readFileSync(join(root, "herdr-plugin.toml"), "utf8")) as {
    startup: { command: string[]; platforms: string[] }[];
    actions: { id: string; command: string[]; platforms?: string[] }[];
  };
  const socket = join(scratch, "herdr.sock");
  writeFileSync(socket, "test");
  const transcript = join(scratch, ".omp", "agent", "sessions", "history.jsonl");
  mkdirSync(dirname(transcript), { recursive: true });
  writeFileSync(transcript, JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "saved history" }] } }) + "\n");
  // An isolated Herdr wire peer: no real sessions, panes, plugin registry or push keys.
  const peer = createServer(connection => {
    let buffer = "";
    connection.on("error", error => {
      if ((error as NodeJS.ErrnoException).code !== "EPIPE") throw error; // the forced stop can close a reply's pipe
    });
    connection.on("data", data => {
      buffer += data.toString();
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.trim());
      const result = request.method === "ping"
        ? { version: "0.9.3", protocol: 22, capabilities: { direct_terminal_attach: false } }
        : request.method === "agent.get" ? { agent: { agent_session: { kind: "path", value: transcript } } }
        : { snapshot: { workspaces: [], panes: [{ pane_id: "history", agent: "omp", cwd: scratch }], tabs: [] } };
      connection.end(JSON.stringify({ id: request.id, result }) + "\n");
    });
  });
  await new Promise<void>((resolve, reject) => { peer.once("error", reject); peer.listen(socketAddress(socket), resolve); });
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  reservation.stop(true);
  const config = join(scratch, "config");
  const state = join(scratch, "plugin-state");
  mkdirSync(config);
  writeFileSync(join(config, ".env"), `HOST=127.0.0.1\nPORT=${port}\n`);
  const env: Record<string, string | undefined> = { ...process.env, HOME: undefined, USERPROFILE: scratch, APPDATA: join(scratch, "appdata"),
    // A running Herdr without Bun on PATH: the manifest's real Windows launcher must find it.
    Path: ["taskkill", "powershell", "git"].map(tool => dirname(Bun.which(tool)!)).join(";"),
    HERDR_SOCKET: socket, HERDR_SOCKET_PATH: socket, HERDR_PLUGIN_ROOT: undefined,
    HERDR_PLUGIN_STATE_DIR: state, HERDR_PLUGIN_CONFIG_DIR: config, HERDR_WEB_STATE_DIR: join(scratch, "app-state"),
    HERDR_WEB_AUTO_UPDATE: "0", HERDR_WEB_TOKEN: "", HOST: "127.0.0.1", PORT: String(port) };
  delete env["PATH"];
  const run = async (command: string, expectedCode = 0) => {
    const entry = command === "start" ? manifest.startup.find(entry => entry.platforms.includes("windows"))
      : manifest.actions.find(entry => entry.id === `${command}-windows` && entry.platforms?.includes("windows"));
    const child = Bun.spawn(entry!.command, { cwd: root, windowsHide: true, env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, err + out + (existsSync(join(state, "server.log")) ? readFileSync(join(state, "server.log"), "utf8") : "")).toBe(expectedCode);
    return out;
  };
  try {
    await run("start");
    // start's process has exited, but the managed server and its children must still answer.
    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json() as { herdr: { terminal_mirror: boolean } };
    expect(health.herdr.terminal_mirror).toBe(true);
    // The "not built yet" notice is a 200 too: the page itself must come back.
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toContain('<div id="root"');
    const history = await (await fetch(`http://127.0.0.1:${port}/api/pane/conversation?pane_id=history`)).json() as { source: string; turns: unknown[] };
    expect(history.source).toBe("omp-transcript");
    expect(JSON.stringify(history.turns)).toContain("saved history");
    // The spawned server must retain git on Windows' usual mixed-case Path key.
    const updates = await (await fetch(`http://127.0.0.1:${port}/api/updates`)).json() as { current_revision: string | null };
    expect(updates.current_revision).toMatch(/^[a-f0-9]{40}$/);
    const pid = Number(readFileSync(join(state, "server.pid"), "utf8").trim());
    const rows = await windowsProcessTable(30_000);
    const owned = new Set([pid]);
    for (const parent of owned) for (const row of rows) if (row.parent === parent) owned.add(row.pid);
    expect(owned.size).toBeGreaterThanOrEqual(3);
    for (let attempt = 0; attempt < 3; attempt++) await run("start"); // fast successful exits keep their exit code
    expect(Number(readFileSync(join(state, "server.pid"), "utf8"))).toBe(pid);
    const record = statSync(join(state, "server.pid"));
    try {
      utimesSync(join(state, "server.pid"), record.atime, new Date(0));
      await run("stop", 1); // a matching app started after an old PID record is not its owner
      expect((await fetch(`http://127.0.0.1:${port}/api/health`)).ok).toBe(true);
    } finally { utimesSync(join(state, "server.pid"), record.atime, record.mtime); }
    await run("stop");
    for (const member of owned) expect(() => process.kill(member, 0)).toThrow();
    expect(existsSync(join(state, "server.pid"))).toBe(false);
    await run("start"); // forced Windows shutdown leaves a stale lock; restart must recover it
    expect((await fetch(`http://127.0.0.1:${port}/api/health`)).ok).toBe(true);
    await run("stop");
    const unrelated = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 90000)"], { windowsHide: true, stdout: "ignore", stderr: "ignore" });
    try {
      writeFileSync(join(state, "server.pid"), String(unrelated.pid));
      await run("stop", 1);
      expect(() => process.kill(unrelated.pid, 0)).not.toThrow();
      expect(existsSync(join(state, "server.pid"))).toBe(true);
      rmSync(join(state, "server.pid"));
      const staleLock = join(updateStateDir(root, port, env["HERDR_WEB_STATE_DIR"]), "supervisor.lock", "pid");
      expect(existsSync(staleLock)).toBe(true);
      writeFileSync(staleLock, String(unrelated.pid));
      utimesSync(staleLock, new Date(0), new Date(0));
      await run("start"); // a reused supervisor PID must not block restart or be terminated
      expect((await fetch(`http://127.0.0.1:${port}/api/health`)).ok).toBe(true);
      expect(() => process.kill(unrelated.pid, 0)).not.toThrow();
      await run("stop");
      // Simulate PID reuse after taskkill: the real CLI must leave this live fixture alone.
      const preload = join(scratch, "stop-boundaries.ts");
      for (const missingIdentity of [false, true]) {
        writeFileSync(join(state, "server.pid"), String(unrelated.pid));
        writeFileSync(preload, `
          Bun.spawnSync = ({ cmd }) => {
            if (cmd[0] !== "taskkill") throw new Error("unexpected termination");
            console.log("simulated tree termination");
            return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), pid: 0 };
          };
          let reads = 0;
          Bun.spawn = (command) => {
            if (command[0] !== "powershell") throw new Error("unexpected probe");
            const first = reads++ === 0;
            const row = { ProcessId: ${unrelated.pid}, ParentProcessId: 0, ExecutablePath: process.execPath,
              CommandLine: '"' + process.execPath + '" "' + ${JSON.stringify(join(root, "server", "managed.ts"))} + '"',
              ...(first ? { Started: 1 } : ${missingIdentity} ? {} : { Started: 2 }) };
            return { exited: Promise.resolve(0), stdout: new Blob([JSON.stringify([row])]) };
          };
        `);
        const stop = Bun.spawn([process.execPath, "--preload", preload, join(root, "scripts", "plugin.ts"), "stop"],
          { cwd: root, windowsHide: true, env, stdout: "pipe", stderr: "pipe" });
        const [out, err, code] = await Promise.all([new Response(stop.stdout).text(), new Response(stop.stderr).text(), stop.exited]);
        expect(out).toContain("simulated tree termination");
        expect(code, out + err).toBe(missingIdentity ? 1 : 0);
        expect(() => process.kill(unrelated.pid, 0)).not.toThrow();
        expect(existsSync(join(state, "server.pid"))).toBe(missingIdentity);
      }
    } finally {
      unrelated.kill(); await unrelated.exited;
      if (existsSync(join(state, "server.pid")) && Number(readFileSync(join(state, "server.pid"), "utf8")) === unrelated.pid) {
        rmSync(join(state, "server.pid"));
      }
    }
  } finally {
    if (existsSync(join(state, "server.pid"))) await run("stop");
    await new Promise<void>(resolve => peer.close(() => resolve()));
    rmSync(scratch, { recursive: true, force: true });
  }
}, 90_000);
