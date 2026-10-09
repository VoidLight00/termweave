import { expect, test, spyOn } from "bun:test";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmuxClient } from "../server/tmux/client.ts";

/** Creates only owned servers; never discovers or addresses the user's tmux sockets. */
test("owned tmux: cross-session transport, literal safety, identity and cleanup", async () => {
  const binary = Bun.which("tmux");
  if (!binary) throw new Error("tmux required; integration may not silently skip");
  const root = await realpath(await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "tw-tmux-")));
  const home = join(root, "home");
  await mkdir(home);
  const sockets = [join(root, "a.sock"), join(root, "b.sock")];
  const ownedPids = new Set<number>();
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home, SHELL: "/bin/sh", TMUX: undefined, TMUX_PANE: undefined, TERMWEAVE_TMUX_SOCKETS: JSON.stringify(sockets) };
  const client = new TmuxClient({ binary, env, approvedSockets: sockets });
  const run = async (socket: string, args: string[]) => {
    let ownedPid: number | undefined;
    if (args[0] === "kill-server") {
      const probe = Bun.spawn([binary, "-S", socket, "display-message", "-p", "#{pid}"], { env, stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => probe.kill("SIGKILL"), 5000);
      const [pid, , code] = await Promise.all([new Response(probe.stdout).text(), new Response(probe.stderr).text(), probe.exited]).finally(() => clearTimeout(timer));
      if (code === 0 && /^[0-9]+\s*$/.test(pid)) { ownedPid = Number(pid.trim()); ownedPids.add(ownedPid); }
    }
    const proc = Bun.spawn([binary, "-S", socket, "-f", "/dev/null", ...args], { env, cwd: root, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 5000);
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).finally(() => clearTimeout(timer));
    if (code !== 0) throw new Error(`owned tmux command ${args[0]} failed (exit ${code}): ${err}`);
    if (ownedPid) {
      let stopped = false;
      for (let i = 0; i < 100; i++) {
        try { process.kill(ownedPid, 0); } catch { stopped = true; break; }
        await Bun.sleep(10);
      }
      if (!stopped) throw new Error("owned server did not terminate within shutdown deadline");
    }
    return out.trim();
  };
  const fixture = ["/bin/sh", "-c", 'stty -echo; printf "READY\\n"; while IFS= read -r line; do printf "RX:%s\\n" "$line"; done'];
  const until = async (target: Parameters<TmuxClient["read"]>[0], marker: string) => {
    for (let i = 0; i < 80; i++) {
      const text = await client.read(target);
      if (text.includes(marker)) return text;
      await Bun.sleep(25);
    }
    throw new Error(`fixture timed out: ${marker}`);
  };
  try {
    for (const socket of sockets) await run(socket, ["new-session", "-d", "-s", "one", ...fixture]);
    await run(sockets[0]!, ["new-session", "-d", "-s", "two", ...fixture]);
    let a = await client.list(sockets[0]!).catch((e) => { throw new Error(`initial server A missing: ${e}`); });
    const b = await client.list(sockets[1]!);
    expect(a.panes.length).toBe(2);
    expect(b.panes.length).toBe(1);
    expect(a.panes[0]!.paneId).toBe(b.panes[0]!.paneId);
    expect(a.generation).not.toBe(b.generation);
    const first = a.panes[0]!;
    const second = a.panes[1]!;
    await until(first, "READY"); await until(second, "READY");
    await client.send(second, "A to B 한글 ; $(bad) -n", true);
    await client.send(first, "B to A", true);
    await until(second, "RX:A to B 한글 ; $(bad) -n");
    await until(first, "RX:B to A");
    await client.send(second, ";", true);
    await until(second, "RX:;");
    const cli = join(import.meta.dir, "pane-mesh-cli.ts");
    const cliProc = Bun.spawn([process.execPath, cli, "list", sockets[0]!], { env, stdout: "pipe", stderr: "pipe" });
    const [cliOut, , cliCode] = await Promise.all([new Response(cliProc.stdout).text(), new Response(cliProc.stderr).text(), cliProc.exited]);
    expect(cliCode).toBe(0);
    expect(JSON.parse(cliOut).panes.length).toBe(2);
    const cliSend = Bun.spawn([process.execPath, cli, "send", first.socket, first.generation, first.paneId, "--submit", "--", "via-cli"], { env, stdout: "pipe", stderr: "pipe" });
    const [, , sendCode] = await Promise.all([new Response(cliSend.stdout).text(), new Response(cliSend.stderr).text(), cliSend.exited]);
    expect(sendCode).toBe(0);
    await until(first, "RX:via-cli");
    const cliRead = Bun.spawn([process.execPath, cli, "read", first.socket, first.generation, first.paneId, "--lines", "80"], { env, stdout: "pipe", stderr: "pipe" });
    const [readOut, , readCode] = await Promise.all([new Response(cliRead.stdout).text(), new Response(cliRead.stderr).text(), cliRead.exited]);
    expect(readCode).toBe(0); expect(readOut).toContain("RX:via-cli");
    await client.send(first, "not-submitted");
    expect(await client.read(first)).not.toContain("RX:not-submitted");
    await client.send(first, ".submitted", true);
    await until(first, "RX:not-submitted.submitted");
    await Promise.all([client.send(second, "concurrent-one", true), client.send(second, "concurrent-two", true)]);
    const concurrent = await until(second, "RX:concurrent-two");
    expect(concurrent).toContain("RX:concurrent-one");
    await run(sockets[0]!, ["link-window", "-s", first.windowId, "-t", "two:9"]);
    a = await client.list(sockets[0]!);
    expect(a.panes.length).toBe(2);
    expect(a.panes.find((p) => p.paneId === first.paneId)!.sessions.length).toBe(2);
    await expect(client.send(first, "oops\n", true)).rejects.toThrow("invalid_literal_text");
    await expect(client.read({ ...first, paneId: "one:0.0" })).rejects.toThrow("invalid_target");
    await expect(client.read({ ...first, socket: b.socket })).rejects.toThrow("stale_generation");
    await run(sockets[0]!, ["kill-pane", "-t", second.paneId]);
    await expect(client.send(second, "closed", true)).rejects.toThrow("pane_missing");
    await run(sockets[0]!, ["kill-server"]);
    for (let i = 0; i < 80; i++) {
      try { await client.list(sockets[0]!); } catch { break; }
      await Bun.sleep(25);
    }
    await run(sockets[0]!, ["new-session", "-d", "-s", "restarted", ...fixture]);
    await expect(client.send(first, "stale", true)).rejects.toThrow("stale_generation");
    expect((await client.list(sockets[0]!)).generation).not.toBe(first.generation);
    // Inject replacement precisely between validation and capture/send, owned sockets only.
    const fresh = (await client.list(sockets[0]!)).panes[0]!;
    const internal = client as unknown as { run(socket: string, args: readonly string[]): Promise<string> };
    const original = internal.run.bind(client);
    const captureSpy = spyOn(internal, "run").mockImplementation(async (socket, args) => {
      if (args[0] === "capture-pane") {
        await run(socket, ["kill-server"]);
        await run(socket, ["new-session", "-d", "-s", "capture-race", "/bin/sleep", "30"]);
      }
      return original(socket, args);
    });
    try { await expect(client.read(fresh)).rejects.toThrow("stale_generation"); }
    finally { captureSpy.mockRestore(); }
    const freshSend = (await client.list(sockets[0]!)).panes[0]!;
    const sendSpy = spyOn(internal, "run").mockImplementation(async (socket, args) => {
      if (args[0] === "if-shell") {
        await run(socket, ["kill-server"]);
        await run(socket, ["new-session", "-d", "-s", "send-race", "/bin/sleep", "30"]);
      }
      return original(socket, args);
    });
    try { await expect(client.send(freshSend, "never-deliver", true)).rejects.toThrow("stale_generation"); }
    finally { sendSpy.mockRestore(); }
    const current = (await client.list(sockets[0]!)).panes[0]!;
    expect(await client.read(current)).not.toContain("never-deliver");
  } finally {
    const failures: string[] = [];
    for (const socket of sockets) {
      const probe = Bun.spawn([binary, "-S", socket, "display-message", "-p", "#{pid}"], { env, stdout: "pipe", stderr: "ignore" });
      const timer = setTimeout(() => probe.kill("SIGKILL"), 5000);
      const [pid, code] = await Promise.all([new Response(probe.stdout).text(), probe.exited]).finally(() => clearTimeout(timer));
      if (code === 0 && /^[0-9]+\s*$/.test(pid)) {
        ownedPids.add(Number(pid.trim()));
        try { await run(socket, ["kill-server"]); } catch (error) { failures.push(String(error)); }
      }
    }
    for (const pid of ownedPids) {
      try { process.kill(pid, 0); failures.push(`owned PID ${pid} remains live`); } catch { /* verified absent */ }
    }
    await rm(root, { recursive: true, force: true });
    if (failures.length) throw new Error(`owned-server cleanup failed: ${failures.join("; ")}`);
  }
  for (const socket of sockets) await expect(client.list(socket)).rejects.toThrow("missing_socket");
}, 30000);
