import { expect, test } from "bun:test";
import { PaneDirectory, terminalKey, type DirectoryDeps, type TerminalTarget } from "./pane-directory.ts";
import type { PaneInfo } from "../shared/herdr-api.generated.ts";
const G = "a".repeat(64), H = "b".repeat(64);
function fixture() {
  let generation = G;
  let panes = [pane("terminal-A", "w1:p1", "w1"), pane("terminal-B", "w2:p1", "w2")];
  let agents: unknown[] = [];
  let reads = 0, sends = 0;
  let afterRead = () => {};
  let afterSend = () => {};
  const calls: { method: string; params: Record<string, unknown>; socket?: string }[] = [];
  const deps: DirectoryDeps = {
    tmux: {
      list: async (socket) => ({ socket, generation, panes: [{ socket, generation, paneId: "%0", windowId: "@0", sessions: ["$0"] }] }),
      read: async () => { reads++; afterRead(); return "owned output"; },
      send: async (_target, _text, submit) => { expect(submit).toBe(false); sends++; afterSend(); },
    },
    herdrGeneration: async () => generation,
    rpc: (async (method: string, params: Record<string, unknown>, socket?: string) => {
      calls.push({ method, params, socket });
      if (method === "workspace.list") return { workspaces: [{ workspace_id: "w1" }, { workspace_id: "w2" }] };
      if (method === "pane.list") return { panes: panes.filter((p) => p.workspace_id === params.workspace_id) };
      if (method === "agent.list") return { agents };
      throw new Error("unexpected RPC");
    }) as DirectoryDeps["rpc"],
    read: async (options, socket) => {
      reads++; expect(socket).toBe("/herdr.sock");
      const p = panes.find((p) => p.pane_id === options.paneId)!;
      const result = { pane_id: p.pane_id, workspace_id: p.workspace_id, tab_id: p.tab_id, source: "recent", format: "text", revision: 1, text: "owned output", truncated: false };
      afterRead(); return result;
    },
    literal: async (id, _text, socket) => { expect(panes.some((p) => p.pane_id === id)).toBe(true); expect(socket).toBe("/herdr.sock"); sends++; afterSend(); },
    prompt: async (id) => { expect(id).toBe(panes[0]!.pane_id); sends++; afterSend(); },
  };
  const directory = new PaneDirectory({ tmuxSockets: ["/tmux-a.sock", "/tmux-b.sock"], herdrSockets: ["/herdr.sock"] }, deps);
  return { directory, deps, calls, setGeneration: (g: string) => { generation = g; }, setPanes: (p: PaneInfo[]) => { panes = p; }, setAgents: (a: unknown[]) => { agents = a; }, onRead: (fn: () => void) => { afterRead = fn; }, onSend: (fn: () => void) => { afterSend = fn; }, counts: () => ({ reads, sends }) };
}
function pane(terminal_id: string, pane_id: string, workspace_id: string): PaneInfo {
  return { terminal_id, pane_id, workspace_id, tab_id: `${workspace_id}:t1`, agent_status: "unknown", focused: false, revision: 1 };
}
async function herdrTarget(f: ReturnType<typeof fixture>): Promise<TerminalTarget> {
  return (await f.directory.list()).find((p) => p.backend === "herdr")!;
}
test("explicit allowlists; enumerate every workspace; duplicate IDs across sockets/backends remain distinct", async () => {
  const f = fixture();
  f.setPanes([pane("%0", "w1:p1", "w1"), pane("full:native:terminal:id", "w2:p1", "w2")]);
  const targets = await f.directory.list();
  expect(targets).toHaveLength(4);
  expect(new Set(targets.map(terminalKey)).size).toBe(4);
  expect(targets.filter((p) => p.terminalId === "%0")).toHaveLength(3);
  expect(targets.find((p) => p.terminalId === "full:native:terminal:id")!.address.paneId).toBe("w2:p1");
  expect(f.calls.filter((c) => c.method === "pane.list").map((c) => c.params.workspace_id)).toEqual(["w1", "w2"]);
  expect(f.counts()).toEqual({ reads: 0, sends: 0 });
  expect(await new PaneDirectory({ tmuxSockets: [], herdrSockets: [] }, f.deps).list()).toEqual([]);
  expect(() => new PaneDirectory(undefined as never, f.deps)).toThrow("explicit_allowlist_required");
  expect(() => new PaneDirectory({ tmuxSockets: ["relative"], herdrSockets: [] }, f.deps)).toThrow("invalid_socket");
  await expect(f.directory.read({ ...targets[0]!, socket: "/not-approved.sock" })).rejects.toThrow("socket_not_approved");
});
test("resolve moved native terminal before each read/send; no fake herdr %ID", async () => {
  const f = fixture(), target = await herdrTarget(f), key = terminalKey(target);
  f.setPanes([pane(target.terminalId, "w2:p9", "w2")]);
  const fresh = await f.directory.resolve(target);
  expect(fresh.address.paneId).toBe("w2:p9"); expect(terminalKey(fresh)).toBe(key);
  expect(await f.directory.read(target)).toBe("owned output");
  await f.directory.send(target, "literal", { recipientKey: key, mode: "literal" });
  expect(f.counts()).toEqual({ reads: 1, sends: 1 });
});
test("wrong recipient, unknown agent and removed terminal cannot dispatch", async () => {
  const f = fixture(), target = await herdrTarget(f);
  await expect(f.directory.send(target, "message", { recipientKey: "other", mode: "literal" })).rejects.toThrow("wrong_recipient");
  await expect(f.directory.send(target, "message", { recipientKey: terminalKey(target), mode: "agent-prompt" })).rejects.toThrow("agent_unidentified");
  await expect(f.directory.send(target, "execute\n", { recipientKey: terminalKey(target), mode: "literal" })).rejects.toThrow("invalid_literal_text");
  f.setPanes([]);
  await expect(f.directory.send(target, "message", { recipientKey: terminalKey(target), mode: "literal" })).rejects.toThrow("terminal_missing");
  expect(f.counts()).toEqual({ reads: 0, sends: 0 });
});
test("generation replacement before read/send rejects stale target", async () => {
  const f = fixture(), targets = await f.directory.list(); f.setGeneration(H);
  for (const target of targets) {
    await expect(f.directory.read(target)).rejects.toThrow("stale_generation");
    await expect(f.directory.send(target, "message", { recipientKey: terminalKey(target), mode: "literal" })).rejects.toThrow("stale_generation");
  }
  expect(f.counts()).toEqual({ reads: 0, sends: 0 });
});
test("generation or address changes after capture discard uncertain output", async () => {
  const f = fixture(), target = await herdrTarget(f);
  f.onRead(() => f.setGeneration(H));
  await expect(f.directory.read(target)).rejects.toThrow("stale_generation");
  f.setGeneration(G); f.onRead(() => f.setPanes([pane(target.terminalId, "w2:p9", "w2")]));
  await expect(f.directory.read(target)).rejects.toThrow("uncertain_read_discarded");
});
test("uncertain send executes once; native failure never retries", async () => {
  const f = fixture(), target = await herdrTarget(f);
  f.onSend(() => f.setGeneration(H));
  await expect(f.directory.send(target, "message", { recipientKey: terminalKey(target), mode: "literal" })).rejects.toThrow("stale_generation");
  expect(f.counts().sends).toBe(1);
  const failed = new PaneDirectory({ tmuxSockets: [], herdrSockets: ["/herdr.sock"] }, { ...f.deps, literal: async () => { throw new Error("native uncertain"); } });
  f.setGeneration(G);
  await expect(failed.send(target, "message", { recipientKey: terminalKey(target), mode: "literal" })).rejects.toThrow("native uncertain");
  expect(f.counts().sends).toBe(1);
});
test("only metadata-identified pinned agent may use native agentPrompt", async () => {
  const f = fixture();
  const agent = { ...pane("terminal-A", "w1:p1", "w1"), agent: "codex", name: "reviewer", agent_session: { agent: "codex", kind: "id", source: "native", value: "session1" } };
  f.setAgents([agent]);
  const target = await herdrTarget(f);
  await f.directory.send(target, "message", { recipientKey: terminalKey(target), mode: "agent-prompt" });
  f.setAgents([{ ...agent, agent_session: { ...agent.agent_session, value: "session2" } }]);
  await expect(f.directory.send(target, "message", { recipientKey: terminalKey(target), mode: "agent-prompt" })).rejects.toThrow("agent_unidentified_or_changed");
  expect(f.counts().sends).toBe(1);
});
test("ambiguous terminal identities and unstable cross-workspace roster fail closed", async () => {
  const f = fixture(); f.setPanes([pane("same", "w1:p1", "w1"), pane("same", "w2:p1", "w2")]);
  await expect(f.directory.list()).rejects.toThrow("ambiguous_identity");
  f.setPanes([pane("terminal-A", "w1:p1", "w1")]);
  f.setAgents([{ ...pane("terminal-A", "w2:p1", "w2"), agent: "codex" }]);
  await expect(f.directory.list()).rejects.toThrow("unstable_roster");
});
