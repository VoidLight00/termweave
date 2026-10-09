import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, realpath, writeFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { PaneDirectory, terminalKey, herdrServerGeneration, type TerminalTarget } from "../server/pane-directory.ts";
import { workspaceCreate, herdrRpc, sessionSnapshot } from "../server/herdr/client.ts";
import { PaneMeshOwnership, verifyTaskOwner } from "../server/pane-mesh-ownership.ts";
import { applyPaneStatus } from "../src/lib/snapshot.ts";
import { workspaceStatusSummary } from "../src/lib/status.ts";

/** Synthetic native transport receiver, NOT Codex semantics, network or paid API. */
test("native agent.start: full identity and acknowledged bidirectional cross-workspace transport", async () => {
  const herdr = Bun.which("herdr");
  if (!herdr) throw new Error("native herdr required");
  const root = await realpath(await mkdtemp("/tmp/tw-agent-directory-"));
  const home = join(root, "home"), config = join(root, "config"), bin = join(root, "bin");
  await Promise.all([mkdir(home), mkdir(config), mkdir(bin)]);
  const configFile = join(root, "fixture.toml");
  await writeFile(configFile, 'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n');
  const receiver = join(root, "receiver.ts");
  // Session exists as receiver-owned state; agent.start supplies its resume identity natively.
  await writeFile(receiver, `import { appendFileSync, writeFileSync } from "node:fs";
const id = process.argv[2];
if (!id || !/^[a-z0-9-]+$/.test(id)) process.exit(2);
const base = ${JSON.stringify(root)};
writeFileSync(base + "/" + id + ".pid", String(process.pid));
writeFileSync(base + "/" + id + ".session", id);
process.stdout.write("\\x1b]0;Synthetic local receiver\\x07READY:" + id + "\\n");
let pending = "";
for await (const chunk of process.stdin) {
  pending += Buffer.from(chunk).toString("utf8");
  let at;
  while ((at = pending.indexOf("\\n")) >= 0) {
    const line = pending.slice(0, at).replace(/\\r$/, "");
    pending = pending.slice(at + 1);
    appendFileSync(base + "/" + id + ".acks", JSON.stringify({ session: id, text: line }) + "\\n");
    process.stdout.write("ACK:" + id + ":" + line + "\\n");
  }
}
`);
  await writeFile(join(bin, "codex"), `#!/bin/sh\n[ "$1" = resume ] || exit 2\nexport HERDR_AGENT=codex\nstty -echo\nexec '${process.execPath}' '${receiver}' "$2"\n`, { mode: 0o700 });
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HERDR_") && !k.startsWith("TMUX"))), HOME: home, XDG_CONFIG_HOME: config, HERDR_CONFIG_PATH: configFile, SHELL: "/bin/sh", PATH: `${bin}:/usr/bin:/bin:/opt/homebrew/bin` };
  const socket = join(config, "herdr", "sessions", "agents", "herdr.sock");
  const server = Bun.spawn([herdr, "--session", "agents", "server"], { env, cwd: root, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const directory = new PaneDirectory({ tmuxSockets: [], herdrSockets: [socket] });
  const until = async (check: () => Promise<boolean>, label: string) => {
    for (let i = 0; i < 100; i++) { if (await check().catch(() => false)) return; await Bun.sleep(50); }
    throw new Error(`owned receiver timeout: ${label}`);
  };
  const current = async (id: string): Promise<TerminalTarget> => {
    const targets = await directory.list();
    const target = targets.find((t) => t.agent?.session?.value === id);
    if (!target) throw new Error("full native identity missing");
    return target;
  };
  const ids = ["fixture-left", "fixture-right"];
  let receiverPids: readonly number[] = [];
  try {
    await until(async () => { await herdrServerGeneration(socket); return true; }, "server");
    const left = await workspaceCreate({ cwd: root, label: "owned-left" }, socket);
    const right = await workspaceCreate({ cwd: root, label: "owned-right" }, socket);
    for (const [i, workspace] of [left, right].entries()) {
      await herdrRpc("agent.start", { name: `receiver${i}`, kind: "codex", pane_id: workspace.root_pane.pane_id, args: ["resume", ids[i]], timeout_ms: 5000 }, socket);
    }
    await until(async () => (await directory.list()).filter((t) => t.agent?.session?.value && ids.includes(t.agent.session.value)).length === 2, "native identity");
    let readiness: { launch_pending?: boolean; interactive_ready?: boolean; agent_status: string }[] = [];
    try {
      await until(async () => {
        const { agents } = await herdrRpc<{ agents: typeof readiness }>("agent.list", {}, socket);
        readiness = agents.map(({ launch_pending, interactive_ready, agent_status }) => ({ launch_pending, interactive_ready, agent_status }));
        return agents.length === 2 && agents.every((agent) => agent.launch_pending !== true && agent.interactive_ready === true && agent.agent_status === "idle");
      }, "native readiness");
    } catch { throw new Error(`owned native readiness failed: ${JSON.stringify(readiness)}`); }
    const a = await current(ids[0]!), b = await current(ids[1]!);
    expect(a.address.workspaceId).not.toBe(b.address.workspaceId);
    // Local workflow: real native identities/transport, real ownership database, and the
    // UI's status reducer on a native snapshot. Status frames are synthetic, not model output.
    const owner = async (target: TerminalTarget) => verifyTaskOwner({
      backend: target.backend, serverId: target.generation, terminalId: target.terminalId,
      workspaceId: target.address.workspaceId!, tabId: target.address.tabId!, paneId: target.address.paneId,
      agentSession: target.agent!.session!,
    }, async candidate => {
      const live = await directory.resolve(target);
      return live.terminalId === candidate.terminalId && live.generation === candidate.serverId &&
        JSON.stringify(live.agent?.session) === JSON.stringify(candidate.agentSession);
    });
    const store = new PaneMeshOwnership({ stateDir: join(root, "ownership") });
    try {
      const ownerA = await owner(a), ownerB = await owner(b);
      const task = { projectRoot: bin, taskId: "workflow", scopes: [{ kind: "file" as const, path: "workflow.ts" }] };
      const claim = store.claim({ ...task, owner: ownerA });
      expect(() => store.claim({ ...task, owner: ownerB })).toThrow("task_conflict");
      expect(() => store.claim({ ...task, taskId: "overlap", owner: ownerB })).toThrow("scope_conflict");
      let snapshot = applyPaneStatus(await sessionSnapshot(socket), a.address.paneId, "working", 1);
      expect(workspaceStatusSummary(snapshot.panes, a.address.workspaceId!).running.count).toBe(1);
      await directory.send(b, "workflow-claimed:nonce-000", { recipientKey: terminalKey(b), mode: "agent-prompt" });
      await until(async () => (await readFile(join(root, `${ids[1]}.acks`), "utf8")).includes('"text":"workflow-claimed:nonce-000"'), "workflow receipt");
      await directory.send(a, "workflow-ack:nonce-000", { recipientKey: terminalKey(a), mode: "agent-prompt" });
      await until(async () => (await readFile(join(root, `${ids[0]}.acks`), "utf8")).includes('"text":"workflow-ack:nonce-000"'), "workflow acknowledgement");
      expect(store.mutate("release", { ...task, owner: ownerA, token: claim.token }).status).toBe("released");
      snapshot = applyPaneStatus(snapshot, a.address.paneId, "idle", 0);
      expect(workspaceStatusSummary(snapshot.panes, a.address.workspaceId!).running.count).toBe(0);
      const next = store.claim({ ...task, owner: ownerB });
      expect(store.mutate("complete", { ...task, owner: ownerB, token: next.token }).status).toBe("completed");
      snapshot = applyPaneStatus(snapshot, b.address.paneId, "done", 0);
      expect(workspaceStatusSummary(snapshot.panes, b.address.workspaceId!).done).toEqual({ count: 1, paneId: b.address.paneId });
      expect(store.list(bin).map(record => record.status)).toEqual(["completed"]);
      expect(() => store.claim({ ...task, owner: ownerA })).toThrow("task_completed");
    } finally { store.close(); }
    for (const [id, target] of [[ids[0]!, a], [ids[1]!, b]] as const) {
      expect(target.agent?.session).toEqual({ source: "herdr:codex", agent: "codex", kind: "id", value: id });
      expect(await readFile(join(root, `${id}.session`), "utf8")).toBe(id);
      const pid = Number(await readFile(join(root, `${id}.pid`), "utf8"));
      receiverPids = [...receiverPids, pid];
      const ps = Bun.spawn(["/bin/ps", "-p", String(pid), "-o", "command="], { stdout: "pipe", stderr: "pipe" });
      const command = await new Response(ps.stdout).text();
      expect(await ps.exited).toBe(0); expect(command).toContain(receiver); expect(command).toContain(id);
    }
    await directory.send(b, "from-left:nonce-001", { recipientKey: terminalKey(b), mode: "agent-prompt" });
    await until(async () => (await readFile(join(root, `${ids[1]}.acks`), "utf8")).includes('"text":"from-left:nonce-001"'), "right receipt");
    await directory.send(a, "ack-right:nonce-001", { recipientKey: terminalKey(a), mode: "agent-prompt" });
    await until(async () => (await readFile(join(root, `${ids[0]}.acks`), "utf8")).includes('"text":"ack-right:nonce-001"'), "left acknowledgement");
    expect(await directory.read(b)).toContain("ACK:fixture-right:from-left:nonce-001");
    expect(await directory.read(a)).toContain("ACK:fixture-left:ack-right:nonce-001");
    await herdrRpc("pane.move", { pane_id: b.address.paneId, destination: { type: "new_tab", workspace_id: left.workspace.workspace_id }, focus: false }, socket);
    const moved = await directory.resolve(b);
    expect(moved.address.paneId).not.toBe(b.address.paneId);
    expect(moved.terminalId).toBe(b.terminalId);
    await directory.send(b, "after-move:nonce-002", { recipientKey: terminalKey(b), mode: "agent-prompt" });
    await until(async () => (await readFile(join(root, `${ids[1]}.acks`), "utf8")).includes('"text":"after-move:nonce-002"'), "moved receipt");
    const stale = { ...a, agent: { ...a.agent!, session: { ...a.agent!.session!, value: "stale-session" } } };
    await expect(directory.send(stale, "must-not-arrive", { recipientKey: terminalKey(stale), mode: "agent-prompt" })).rejects.toThrow("agent_unidentified_or_changed");
    expect(await readFile(join(root, `${ids[0]}.acks`), "utf8")).not.toContain("must-not-arrive");
    await expect(directory.send(a, "wrong-target", { recipientKey: terminalKey(b), mode: "agent-prompt" })).rejects.toThrow("wrong_recipient");
  } finally {
    await herdrRpc("server.stop", {}, socket).catch(() => {});
    server.kill(); await server.exited;
    for (const pid of receiverPids) {
      await until(async () => {
        const proc = Bun.spawn(["/bin/ps", "-p", String(pid), "-o", "pid="], { stdout: "ignore", stderr: "ignore" });
        return await proc.exited !== 0;
      }, "receiver cleanup");
    }
    await rm(root, { recursive: true, force: true });
  }
  await expect(access(root)).rejects.toThrow();
  await expect(herdrServerGeneration(socket)).rejects.toThrow();
}, 30000);
