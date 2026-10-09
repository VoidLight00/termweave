import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, realpath, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { PaneDirectory, terminalKey, herdrServerGeneration } from "../server/pane-directory.ts";
import { workspaceCreate, herdrRpc } from "../server/herdr/client.ts";

/** All processes, config, sockets and pane output here are synthetic and owned by this test. */
test("owned native directory: all workspaces/sockets, moved identities, stale generations, literal-only sends and cleanup", async () => {
  const herdr = Bun.which("herdr"), tmux = Bun.which("tmux");
  if (!herdr || !tmux) throw new Error("herdr and tmux required; native test cannot silently skip");
  const root = await realpath(await mkdtemp("/tmp/tw-directory-"));
  const home = join(root, "home"), config = join(root, "config");
  await mkdir(home); await mkdir(config);
  const configPath = join(root, "fixture.toml");
  const shell = join(root, "fixture-shell");
  await writeFile(shell, '#!/bin/sh\nstty -echo\nprintf "OWNED_READY\\n"\nwhile IFS= read -r line; do printf "RX:%s\\n" "$line"; done\n', { mode: 0o700 });
  await writeFile(configPath, `default_shell = "${shell}"\nshell_mode = "non_login"\n`);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HERDR_") && !k.startsWith("TMUX"))), HOME: home, XDG_CONFIG_HOME: config, HERDR_CONFIG_PATH: configPath, SHELL: shell };
  const sockets = [join(config, "herdr", "sessions", "a", "herdr.sock"), join(config, "herdr", "sessions", "b", "herdr.sock")];
  const tmuxSockets = [join(root, "a.sock"), join(root, "b.sock")];
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const start = (name: string) => {
    const child = Bun.spawn([herdr, "--session", name, "server"], { env, cwd: root, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    children.push(child); return child;
  };
  const ready = async (socket: string) => {
    for (let i = 0; i < 100; i++) {
      try { await herdrServerGeneration(socket); await herdrRpc("ping", {}, socket); return; } catch { await Bun.sleep(50); }
    }
    throw new Error("owned herdr failed to start");
  };
  const runTmux = async (socket: string, args: string[]) => {
    const child = Bun.spawn([tmux, "-S", socket, "-f", "/dev/null", ...args], { env, cwd: root, stdout: "ignore", stderr: "ignore" });
    if (await child.exited !== 0) throw new Error("owned tmux failed");
  };
  const directory = new PaneDirectory({ tmuxSockets, herdrSockets: sockets });
  try {
    start("a"); start("b"); await Promise.all(sockets.map(ready));
    const a1 = await workspaceCreate({ cwd: root, label: "owned-a1" }, sockets[0]);
    const a2 = await workspaceCreate({ cwd: root, label: "owned-a2" }, sockets[0]);
    await workspaceCreate({ cwd: root, label: "owned-b1" }, sockets[1]);
    for (const socket of tmuxSockets) await runTmux(socket, ["new-session", "-d", "-s", "fixture", shell]);
    const targets = await directory.list();
    expect(targets.filter((p) => p.backend === "tmux")).toHaveLength(2);
    expect(targets.some((p) => p.backend === "herdr" && p.address.workspaceId === a1.workspace.workspace_id)).toBe(true);
    expect(targets.some((p) => p.backend === "herdr" && p.address.workspaceId === a2.workspace.workspace_id)).toBe(true);
    expect(new Set(targets.map(terminalKey)).size).toBe(targets.length);
    const a = targets.find((p) => p.backend === "herdr" && p.socket === sockets[0] && p.address.paneId === a1.root_pane.pane_id)!;
    const b = targets.find((p) => p.backend === "herdr" && p.socket === sockets[1])!;
    expect(a.address.paneId).toBe(b.address.paneId);
    expect(terminalKey(a)).not.toBe(terminalKey(b));
    expect(a.terminalId.startsWith("%")).toBe(false);
    await herdrRpc("pane.move", { pane_id: a.address.paneId, destination: { type: "new_tab", workspace_id: a2.workspace.workspace_id }, focus: false }, a.socket);
    const moved = await directory.resolve(a);
    expect(moved.address.workspaceId).toBe(a2.workspace.workspace_id);
    expect(moved.address.paneId).not.toBe(a.address.paneId);
    expect(terminalKey(moved)).toBe(terminalKey(a));
    for (const target of [a, b, ...targets.filter((p) => p.backend === "tmux")]) {
      for (let i = 0; i < 50; i++) { if ((await directory.read(target)).includes("OWNED_READY")) break; await Bun.sleep(30); }
      await directory.send(target, "cross-session-literal", { recipientKey: terminalKey(target), mode: "literal" });
      expect(await directory.read(target)).not.toContain("RX:cross-session-literal");
      // Explicit fixture-only Enter: the directory never submits to arbitrary shell panes.
      if (target.backend === "herdr") {
        const latest = await directory.resolve(target);
        await herdrRpc("pane.send_keys", { pane_id: latest.address.paneId, keys: ["enter"] }, latest.socket);
      } else await runTmux(target.socket, ["send-keys", "-t", target.terminalId, "Enter"]);
      let received = false;
      for (let i = 0; i < 50; i++) {
        if ((await directory.read(target)).includes("RX:cross-session-literal")) { received = true; break; }
        await Bun.sleep(30);
      }
      expect(received).toBe(true);
      await expect(directory.send(target, "wrong", { recipientKey: terminalKey(target === a ? b : a), mode: "literal" })).rejects.toThrow("wrong_recipient");
    }
    // Owned report stub is detected, but this native version does not expose its session ref.
    // Agent reception is therefore UNVERIFIED; fail closed instead of inventing identity.
    const receiver = await directory.resolve(a);
    await herdrRpc("pane.report_agent", { pane_id: receiver.address.paneId, source: "owned-fixture", agent: "codex", state: "idle", agent_session_id: "owned-local-receiver", seq: 1 }, receiver.socket);
    await herdrRpc("pane.report_agent_session", { pane_id: receiver.address.paneId, source: "owned-fixture", agent: "codex", agent_session_id: "owned-local-receiver", seq: 2 }, receiver.socket);
    const identified = await directory.resolve(receiver);
    expect(identified.agent?.kind).toBe("codex");
    expect(identified.agent?.session).toBeNull();
    await expect(directory.send(identified, "native-agent-prompt-fixture", { recipientKey: terminalKey(identified), mode: "agent-prompt" })).rejects.toThrow("agent_unidentified_or_changed");
    expect(await directory.read(identified)).not.toContain("native-agent-prompt-fixture");
    expect(await directory.read(b)).not.toContain("native-agent-prompt-fixture");
    // Allowlist-free CLI lists nothing; missing allowlist refuses rather than discovering production.
    const cli = join(import.meta.dir, "terminal-mesh.ts");
    const file = join(root, "allowlist.json");
    await writeFile(file, JSON.stringify({ tmuxSockets, herdrSockets: sockets }));
    const handles = join(root, "private-handles.json");
    const proc = Bun.spawn([process.execPath, cli, "list", "--allowlist", file, "--handles", handles], { env, cwd: root, stdout: "pipe", stderr: "pipe" });
    const [out, , code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(0); expect(JSON.parse(out).terminals.length).toBe((await directory.list()).length);
    const rows = JSON.parse(out).terminals;
    expect(out).not.toContain("owned-local-receiver");
    const ref = rows.find((row: { terminalId: string; socket: string }) => row.terminalId === a.terminalId && row.socket === a.socket).ref;
    const cliSend = Bun.spawn([process.execPath, cli, "send", "--allowlist", file, "--handle", handles, "--ref", ref, "--text", "via-cli"], { env, cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(await cliSend.exited).toBe(0);
    const cliRead = Bun.spawn([process.execPath, cli, "read", "--allowlist", file, "--target", JSON.stringify(a)], { env, cwd: root, stdout: "pipe", stderr: "pipe" });
    const [readOut, , readCode] = await Promise.all([new Response(cliRead.stdout).text(), new Response(cliRead.stderr).text(), cliRead.exited]);
    expect(readCode).toBe(0); expect(readOut).toContain("OWNED_READY"); expect(readOut).not.toContain("RX:via-cli");
    const oldTmux = targets.find((p) => p.backend === "tmux")!;
    await runTmux(oldTmux.socket, ["kill-server"]);
    await runTmux(oldTmux.socket, ["new-session", "-d", "-s", "replacement", shell]);
    await expect(directory.read(oldTmux)).rejects.toThrow("stale_generation");
    await expect(directory.send(oldTmux, "stale", { recipientKey: terminalKey(oldTmux), mode: "literal" })).rejects.toThrow("stale_generation");
    const missing = Bun.spawn([process.execPath, cli, "list"], { env, cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(await missing.exited).toBe(1);
    const old = await directory.resolve(b);
    await herdrRpc("server.stop", {}, old.socket).catch(() => {});
    await children[1]!.exited;
    start("b"); await ready(old.socket);
    expect(await herdrServerGeneration(old.socket)).not.toBe(old.generation);
    await expect(directory.read(old)).rejects.toThrow();
    await expect(directory.send(old, "stale", { recipientKey: terminalKey(old), mode: "literal" })).rejects.toThrow();
  } finally {
    for (const socket of sockets) await herdrRpc("server.stop", {}, socket).catch(() => {});
    for (const child of children) { child.kill(); await child.exited; }
    for (const socket of tmuxSockets) {
      const child = Bun.spawn([tmux, "-S", socket, "kill-server"], { env, stdout: "ignore", stderr: "ignore" }); await child.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
  await expect(access(root)).rejects.toThrow();
  for (const socket of sockets) await expect(herdrServerGeneration(socket)).rejects.toThrow();
}, 60000);
