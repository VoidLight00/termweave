import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { TmuxClient, type TmuxRoster, type TmuxTarget } from "./tmux/client.ts";
import { herdrRpc, paneRead, paneSendText, agentPrompt } from "./herdr/client.ts";
import type { AgentInfo, AgentSessionInfo, PaneInfo, WorkspaceInfo } from "../shared/herdr-api.generated.ts";

export type TerminalBackend = "tmux" | "herdr";
export interface TerminalAddress {
  paneId: string;
  workspaceId?: string;
  tabId?: string;
  windowId?: string;
  sessions?: readonly string[];
}
export interface TerminalTarget {
  backend: TerminalBackend;
  socket: string;
  generation: string;
  /** Native %N for tmux; the full opaque terminal_id for herdr. Never synthesized. */
  terminalId: string;
  address: TerminalAddress;
  agent?: { kind: string; name: string | null; session: AgentSessionInfo | null };
}
export interface DirectoryAllowlist { tmuxSockets: readonly string[]; herdrSockets: readonly string[] }
export interface DirectoryDeps {
  tmux: Pick<TmuxClient, "list" | "read" | "send">;
  herdrGeneration: (socket: string) => Promise<string>;
  rpc: typeof herdrRpc;
  read: typeof paneRead;
  literal: typeof paneSendText;
  prompt: typeof agentPrompt;
}
export class DirectoryError extends Error {
  constructor(readonly code: string) { super(`terminal directory: ${code}`); this.name = "DirectoryError"; }
}
function fail(code: string): never { throw new DirectoryError(code); }
const safeId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 4096 && !/[\x00-\x1f\x7f]/.test(id);
const validGeneration = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function socketPath(path: unknown): asserts path is string {
  if (!safeId(path) || !path.startsWith("/") || resolve(path) !== path) fail("invalid_socket");
}
/** Identity key deliberately excludes mutable layout addresses; suitable for task ownership. */
export function terminalKey(target: TerminalTarget): string {
  if (!target || !["tmux", "herdr"].includes(target.backend) || !safeId(target.terminalId) || !validGeneration(target.generation)) fail("invalid_target");
  socketPath(target.socket);
  if (!target.address || !safeId(target.address.paneId)) fail("invalid_target");
  if (target.backend === "tmux" && (!/^%[0-9]+$/.test(target.terminalId) || target.address.paneId !== target.terminalId)) fail("invalid_target");
  return JSON.stringify([target.backend, target.socket, target.generation, target.terminalId]);
}
async function command(binary: string, args: string[]): Promise<string> {
  const child = Bun.spawn([binary, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const [out, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) fail("generation_unverified");
    return out.trim();
  } finally { clearTimeout(timer); }
}
/** Unix-only fail-closed probe: socket inode + sole owning herdr process + native process start. */
export async function herdrServerGeneration(path: string): Promise<string> {
  socketPath(path);
  const canonical = join(await realpath(dirname(path)), basename(path));
  if (canonical !== path) fail("noncanonical_socket");
  const before = await lstat(path);
  if (!before.isSocket() || before.uid !== process.getuid?.()) fail("untrusted_socket");
  const lsof = Bun.which("lsof");
  if (!lsof) fail("generation_unverified");
  const pids = [...new Set((await command(lsof, ["-t", "--", path])).split(/\s+/).filter(Boolean))];
  if (pids.length !== 1 || !/^[1-9][0-9]*$/.test(pids[0]!)) fail("generation_unverified");
  const pid = pids[0]!;
  const name = await command("/bin/ps", ["-p", pid, "-o", "comm="]);
  const start = await command("/bin/ps", ["-p", pid, "-o", "lstart="]);
  if (basename(name) !== "herdr" || !start) fail("generation_unverified");
  const after = await lstat(path);
  if (!after.isSocket() || after.uid !== before.uid || after.dev !== before.dev || after.ino !== before.ino || after.birthtimeMs !== before.birthtimeMs) fail("stale_generation");
  return createHash("sha256").update(JSON.stringify([path, after.dev, after.ino, after.birthtimeMs, pid, start])).digest("hex");
}

/**
 * Explicit local allowlists only. No default socket, environment target, production discovery,
 * output-based identification, shell execution, send retries or implicit Enter.
 * Residual native check-to-use limit: native herdr RPC does not accept generation/terminal CAS.
 * A server replacement or pane/agent move between final metadata check and native dispatch
 * cannot be made atomic here. Reads discard output on uncertainty; failed sends may already
 * have delivered and MUST NOT be retried. tmux has a native pid/start guard, not pane-process CAS.
 */
export class PaneDirectory {
  private readonly allowlist: DirectoryAllowlist;
  private readonly deps: DirectoryDeps;
  constructor(allowlist: DirectoryAllowlist, deps: Partial<DirectoryDeps> = {}) {
    if (!allowlist || !Array.isArray(allowlist.tmuxSockets) || !Array.isArray(allowlist.herdrSockets)) fail("explicit_allowlist_required");
    for (const path of [...allowlist.tmuxSockets, ...allowlist.herdrSockets]) socketPath(path);
    this.allowlist = { tmuxSockets: [...new Set(allowlist.tmuxSockets)], herdrSockets: [...new Set(allowlist.herdrSockets)] };
    // A herdr-only directory must not require tmux to be installed.
    const unavailable = { list: async (): Promise<TmuxRoster> => fail("tmux_not_allowed"), read: async (): Promise<string> => fail("tmux_not_allowed"), send: async (): Promise<void> => fail("tmux_not_allowed") };
    this.deps = {
      tmux: deps.tmux ?? (this.allowlist.tmuxSockets.length ? new TmuxClient({ approvedSockets: this.allowlist.tmuxSockets }) : unavailable),
      herdrGeneration: deps.herdrGeneration ?? herdrServerGeneration,
      rpc: deps.rpc ?? herdrRpc, read: deps.read ?? paneRead,
      literal: deps.literal ?? paneSendText, prompt: deps.prompt ?? agentPrompt,
    };
  }
  private approved(target: TerminalTarget): void {
    terminalKey(target);
    const paths = target.backend === "tmux" ? this.allowlist.tmuxSockets : this.allowlist.herdrSockets;
    if (!paths.includes(target.socket)) fail("socket_not_approved");
  }
  private async generation(socket: string): Promise<string> {
    const value = await this.deps.herdrGeneration(socket);
    if (!validGeneration(value)) fail("generation_unverified");
    return value;
  }
  private async herdrList(socket: string): Promise<TerminalTarget[]> {
    const generation = await this.generation(socket);
    const { workspaces } = await this.deps.rpc<{ workspaces: WorkspaceInfo[] }>("workspace.list", {}, socket);
    if (!Array.isArray(workspaces) || workspaces.some((w) => !safeId(w.workspace_id)) || new Set(workspaces.map((w) => w.workspace_id)).size !== workspaces.length) fail("malformed_roster");
    const groups = await Promise.all(workspaces.map(async (w) => {
      const { panes } = await this.deps.rpc<{ panes: PaneInfo[] }>("pane.list", { workspace_id: w.workspace_id }, socket);
      if (!Array.isArray(panes) || panes.some((p) => p.workspace_id !== w.workspace_id || !safeId(p.pane_id) || !safeId(p.terminal_id) || !safeId(p.tab_id))) fail("malformed_roster");
      return panes;
    }));
    const panes = groups.flat();
    if (new Set(panes.map((p) => p.terminal_id)).size !== panes.length || new Set(panes.map((p) => p.pane_id)).size !== panes.length) fail("ambiguous_identity");
    const { agents } = await this.deps.rpc<{ agents: AgentInfo[] }>("agent.list", {}, socket);
    if (!Array.isArray(agents)) fail("malformed_roster");
    const targets = panes.map((p): TerminalTarget => {
      const matched = agents.filter((a) => a.terminal_id === p.terminal_id);
      if (matched.length > 1) fail("ambiguous_identity");
      const a = matched[0];
      if (a && (a.pane_id !== p.pane_id || a.workspace_id !== p.workspace_id || a.tab_id !== p.tab_id)) fail("unstable_roster");
      return { backend: "herdr", socket, generation, terminalId: p.terminal_id,
        address: { paneId: p.pane_id, workspaceId: p.workspace_id, tabId: p.tab_id },
        ...(a && safeId(a.agent) ? { agent: { kind: a.agent, name: a.name ?? null, session: a.agent_session ?? null } } : {}),
      };
    });
    if (await this.generation(socket) !== generation) fail("stale_generation");
    return targets;
  }
  private async tmuxList(socket: string, expectedGeneration?: string): Promise<TerminalTarget[]> {
    const roster = await this.deps.tmux.list(socket);
    if (roster.socket !== socket || !validGeneration(roster.generation)) fail("generation_unverified");
    if (expectedGeneration !== undefined && roster.generation !== expectedGeneration) fail("stale_generation");
    return roster.panes.map((p) => {
      const target: TerminalTarget = { backend: "tmux", socket, generation: roster.generation, terminalId: p.paneId,
        address: { paneId: p.paneId, windowId: p.windowId, sessions: [...p.sessions] } };
      terminalKey(target);
      return target;
    });
  }
  async list(): Promise<TerminalTarget[]> {
    const groups = await Promise.all([
      ...this.allowlist.tmuxSockets.map((s) => this.tmuxList(s)),
      ...this.allowlist.herdrSockets.map((s) => this.herdrList(s)),
    ]);
    return groups.flat();
  }
  /** Re-resolve stable terminal_id; never trust the caller's stale herdr pane address. */
  async resolve(target: TerminalTarget): Promise<TerminalTarget> {
    this.approved(target);
    if (target.backend === "herdr" && await this.generation(target.socket) !== target.generation) fail("stale_generation");
    const roster = target.backend === "tmux" ? await this.tmuxList(target.socket, target.generation) : await this.herdrList(target.socket);
    if (roster.some((p) => p.generation !== target.generation)) fail("stale_generation");
    if (!roster.length && target.backend === "herdr" && await this.generation(target.socket) !== target.generation) fail("stale_generation");
    const found = roster.filter((p) => terminalKey(p) === terminalKey(target));
    if (found.length !== 1) fail("terminal_missing_or_ambiguous");
    return found[0]!;
  }
  private tmuxTarget(target: TerminalTarget): TmuxTarget {
    return { socket: target.socket, generation: target.generation, paneId: target.terminalId };
  }
  async read(target: TerminalTarget, lines = 80): Promise<string> {
    if (!Number.isInteger(lines) || lines < 1 || lines > 2000) fail("invalid_lines");
    const current = await this.resolve(target);
    const output = current.backend === "tmux" ? await this.deps.tmux.read(this.tmuxTarget(current), lines)
      : await this.deps.read({ paneId: current.address.paneId, lines, source: "recent", format: "text" }, current.socket);
    const after = await this.resolve(current);
    if (after.address.paneId !== current.address.paneId || after.address.tabId !== current.address.tabId || after.address.workspaceId !== current.address.workspaceId) fail("uncertain_read_discarded");
    if (typeof output === "string") return output;
    if (output.pane_id !== current.address.paneId || output.tab_id !== current.address.tabId || output.workspace_id !== current.address.workspaceId || typeof output.text !== "string") fail("uncertain_read_discarded");
    return output.text;
  }
  async send(target: TerminalTarget, text: string, options: { recipientKey: string; mode: "literal" | "agent-prompt" }): Promise<void> {
    this.approved(target);
    if (!options || options.recipientKey !== terminalKey(target)) fail("wrong_recipient");
    if (typeof text !== "string" || !text.length || Buffer.byteLength(text) > 8192 || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(text)) fail("invalid_literal_text");
    if (!["literal", "agent-prompt"].includes(options.mode)) fail("invalid_mode");
    const current = await this.resolve(target);
    if (options.mode === "agent-prompt") {
      const session = current.agent?.session;
      if (current.backend !== "herdr" || !target.agent || !current.agent || !session
        || ![session.agent, session.kind, session.source, session.value].every(safeId)
        || session.agent !== current.agent.kind || JSON.stringify(current.agent) !== JSON.stringify(target.agent)) fail("agent_unidentified_or_changed");
      await this.deps.prompt(current.address.paneId, text, current.socket);
    } else if (current.backend === "tmux") {
      await this.deps.tmux.send(this.tmuxTarget(current), text, false);
    } else {
      await this.deps.literal(current.address.paneId, text, current.socket);
    }
    // A failure here is uncertain delivery, never permission to retry a send.
    const after = await this.resolve(current);
    if (JSON.stringify(after.address) !== JSON.stringify(current.address) || (options.mode === "agent-prompt" && JSON.stringify(after.agent) !== JSON.stringify(current.agent))) fail("uncertain_send_no_retry");
  }
}
