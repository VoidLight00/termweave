import { realpath, lstat as stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, basename, join, resolve } from "node:path";
import type { TmuxAction, TmuxState } from "../../shared/tmux.ts";
import { actionCommand } from "./actions.ts";
import { TmuxError } from "./errors.ts";
import { gitMetadata } from "./metadata.ts";
import { listeningPorts } from "./ports.ts";
export { TmuxError } from "./errors.ts";

export interface TmuxTarget { socket: string; generation: string; paneId: string; sessionId?: string }
export interface TmuxPane extends TmuxTarget { sessions: readonly string[]; windowId: string }
export interface TmuxRoster { socket: string; generation: string; panes: readonly TmuxPane[] }
export interface TmuxOptions { approvedSockets?: readonly string[]; binary?: string; env?: Record<string, string | undefined>; timeoutMs?: number }

const queues = new Map<string, Promise<unknown>>();
const ID = /^%[0-9]+$/;

/** No shell, no inherited target, no automatic retry after an uncertain write. */
export class TmuxClient {
  private readonly binary: string;
  private readonly env: Record<string, string | undefined>;
  private readonly timeoutMs: number;
  private readonly approved: ReadonlySet<string>;
  constructor(options: TmuxOptions = {}) {
    const binary = options.binary ?? Bun.which("tmux");
    if (!binary) throw new TmuxError("tmux_missing");
    this.binary = binary;
    this.env = { ...process.env, ...options.env, TMUX: undefined, TMUX_PANE: undefined };
    this.timeoutMs = options.timeoutMs ?? 5000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30000) throw new TmuxError("invalid_timeout");
    this.approved = new Set(options.approvedSockets ?? []);
  }

  private async run(socket: string, args: readonly string[]): Promise<string> {
    const proc = Bun.spawn([this.binary, "-S", socket, ...args], {
      env: this.env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill("SIGKILL"), this.timeoutMs);
    try {
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
      ]);
      if (code !== 0) {
        if (/no server running on|error connecting to .*\((?:No such file or directory|Connection refused)\)/.test(err)) throw new TmuxError("server_unavailable");
        throw new TmuxError("command_failed_or_uncertain");
      }
      return out;
    } finally { clearTimeout(timer); }
  }

  private async identity(path: string): Promise<{ socket: string; generation: string; pid: string; startTime: string }> {
    if (!path.startsWith("/") || /[\x00-\x1f\x7f]/.test(path)) throw new TmuxError("invalid_socket");
    if (!this.approved.has(path)) throw new TmuxError("socket_not_approved");
    // Bun/macOS realpath(socket) returns EOPNOTSUPP: canonicalize its directory,
    // then require the final component itself to be a socket (never a symlink).
    const socket = join(await realpath(dirname(path)).catch(() => { throw new TmuxError("missing_socket"); }), basename(path));
    if (resolve(path) !== socket) throw new TmuxError("noncanonical_socket");
    const before = await stat(socket).catch(() => { throw new TmuxError("missing_socket"); });
    if (!before.isSocket() || before.uid !== process.getuid?.()) throw new TmuxError("untrusted_socket");
    const [pid, startTime] = (await this.run(socket, ["display-message", "-p", "#{pid}\t#{start_time}"])).trim().split("\t");
    if (!pid || !startTime || !/^[1-9][0-9]*$/.test(pid) || !/^[0-9]+$/.test(startTime)) throw new TmuxError("ambiguous_identity");
    const ps = Bun.spawn(["/bin/ps", "-p", pid, "-o", "lstart="], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => ps.kill("SIGKILL"), this.timeoutMs);
    const [started, , code] = await Promise.all([new Response(ps.stdout).text(), new Response(ps.stderr).text(), ps.exited]).finally(() => clearTimeout(timer));
    const after = await stat(socket);
    if (code !== 0 || !started.trim() || before.ino !== after.ino || before.birthtimeMs !== after.birthtimeMs)
      throw new TmuxError("ambiguous_identity");
    const generation = createHash("sha256").update(JSON.stringify([socket, after.dev, after.ino, after.birthtimeMs, pid, startTime, started.trim()])).digest("hex");
    return { socket, generation, pid, startTime };
  }

  async list(socketPath: string): Promise<TmuxRoster> {
    const identity = await this.identity(socketPath);
    // IDs only: no title, cwd, terminal content or agent identity is inspected.
    const text = await this.run(identity.socket, ["list-panes", "-a", "-F", "#{pane_id}\t#{session_id}\t#{window_id}"]);
    const panes = text.trim().split("\n").filter(Boolean).reduce<readonly TmuxPane[]>((all, line) => {
      const [paneId, session, windowId, extra] = line.split("\t");
      if (!paneId || !ID.test(paneId) || !session || !/^\$[0-9]+$/.test(session) || !windowId || !/^@[0-9]+$/.test(windowId) || extra !== undefined)
        throw new TmuxError("malformed_roster");
      const old = all.find((p) => p.paneId === paneId);
      if (old && old.windowId !== windowId) throw new TmuxError("ambiguous_identity");
      return old ? all.map((p) => p === old ? { ...p, sessions: [...new Set([...p.sessions, session])] } : p)
        : [...all, { ...identity, paneId, sessions: [session], windowId }];
    }, []);
    if ((await this.identity(identity.socket)).generation !== identity.generation) throw new TmuxError("stale_generation");
    return { ...identity, panes };
  }

  private async validate(target: TmuxTarget): Promise<TmuxPane> {
    if (!target || typeof target.socket !== "string" || typeof target.paneId !== "string" || !ID.test(target.paneId)
      || typeof target.generation !== "string" || !/^[a-f0-9]{64}$/.test(target.generation)) throw new TmuxError("invalid_target");
    const roster = await this.list(target.socket);
    if (roster.socket !== target.socket) throw new TmuxError("noncanonical_socket");
    if (roster.generation !== target.generation) throw new TmuxError("stale_generation");
    const pane = roster.panes.find((p) => p.paneId === target.paneId);
    if (!pane) throw new TmuxError("pane_missing");
    if (target.sessionId !== undefined && !pane.sessions.includes(target.sessionId)) throw new TmuxError("session_missing");
    return pane;
  }

  async read(target: TmuxTarget, lines = 80): Promise<string> {
    if (!Number.isInteger(lines) || lines < 1 || lines > 2000) throw new TmuxError("invalid_lines");
    await this.validate(target);
    const output = await this.run(target.socket, ["capture-pane", "-p", "-t", target.paneId, "-S", String(-lines)]);
    if ((await this.identity(target.socket)).generation !== target.generation) throw new TmuxError("stale_generation");
    return output;
  }

  async snapshot(socketPath: string): Promise<TmuxState> {
    const identity = await this.identity(socketPath);
    const fields = ["session_id", "window_id", "pane_id", "window_index", "pane_index", "pane_width", "pane_height", "pane_left", "pane_top", "pane_active", "window_active", "window_zoomed_flag", "pane_dead", "synchronize-panes"];
    // Replace control characters before framing labels; names never become command targets.
    const format = [...fields.map(f => `#{${f}}`), ...["session_name", "window_name"].map(f => `#{=80:#{s|[\x01-\x1f\x7f]| |:${f}}}`)].join("\t");
    const text = await this.run(identity.socket, ["list-panes", "-a", "-F", format]);
    const panes = text.replace(/\n$/, "").split("\n").filter(Boolean).map(line => {
      const [sessionId, windowId, paneId, ...tail] = line.split("\t");
      const values = tail.slice(0, 11);
      const [sessionName, windowName] = tail.slice(11);
      if (!sessionId || !/^\$[0-9]+$/.test(sessionId) || !windowId || !/^@[0-9]+$/.test(windowId) || !paneId || !ID.test(paneId)
        || tail.length !== 13 || sessionName === undefined || windowName === undefined || values.some(v => !/^[0-9]+$/.test(v) || !Number.isSafeInteger(Number(v)))) throw new TmuxError("malformed_roster");
      const [windowIndex, paneIndex, width, height, left, top, active, windowActive, zoomed, dead, synchronized] = values.map(Number) as [number, number, number, number, number, number, number, number, number, number, number];
      return { socket: identity.socket, generation: identity.generation, sessionId, sessionName, windowName, windowId, paneId, windowIndex, paneIndex, width, height, left, top,
        active: active === 1, windowActive: windowActive === 1, zoomed: zoomed === 1, dead: dead === 1, synchronized: synchronized === 1 };
    });
    if ((await this.identity(identity.socket)).generation !== identity.generation) throw new TmuxError("stale_generation");
    return { socket: identity.socket, generation: identity.generation, panes };
  }

  async metadata(target: TmuxTarget): Promise<{ cwd: string; git: Awaited<ReturnType<typeof gitMetadata>>; ports: number[] | null }> {
    await this.validate(target);
    const fields = (await this.run(target.socket, ["display-message", "-p", "-t", target.paneId, "#{pane_pid}\n#{pane_current_path}"])).replace(/\n$/, "").split("\n");
    const [pid,cwd] = fields;
    if (fields.length !== 2 || !pid || !/^[1-9][0-9]*$/.test(pid) || !cwd) throw new TmuxError("invalid_cwd");
    if (!cwd.startsWith("/") || /[\x00-\x1f\x7f]/.test(cwd)) throw new TmuxError("invalid_cwd");
    if ((await this.identity(target.socket)).generation !== target.generation) throw new TmuxError("stale_generation");
    const [git,ports] = await Promise.all([gitMetadata(cwd),listeningPorts(Number(pid))]);
    if ((await this.identity(target.socket)).generation !== target.generation) throw new TmuxError("stale_generation");
    const current = await this.run(target.socket, ["display-message", "-p", "-t", target.paneId, "#{pane_pid}\n#{pane_current_path}"]);
    if (current.replace(/\n$/, "") !== fields.join("\n")) throw new TmuxError("metadata_changed");
    return { cwd, git, ports };
  }

  async control(target: TmuxTarget, action: TmuxAction): Promise<void> {
    actionCommand(target?.paneId, action); // Reject malformed actions before touching the server.
    const key = target.socket;
    const run = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const pane = await this.validate(target);
      if (action.type === "join" || action.type === "swap") await this.validate({ ...target, sessionId: undefined, paneId: action.otherPaneId });
      const command = actionCommand(target.paneId, action, target.sessionId ?? pane.sessions[0]!, pane.windowId);
      const identity = await this.identity(target.socket);
      if (identity.generation !== target.generation) throw new TmuxError("stale_generation");
      const result = await this.run(target.socket, ["if-shell", "-F", this.condition(identity), `${command} ; display-message -p TW_DONE`, "display-message -p TW_STALE"]);
      if (result.trim() !== "TW_DONE") throw new TmuxError("stale_generation");
    });
    queues.set(key, run);
    try { await run; } finally { if (queues.get(key) === run) queues.delete(key); }
  }

  private condition(identity: { pid: string; startTime: string }): string {
    return `#{&&:#{==:#{pid},${identity.pid}},#{==:#{start_time},${identity.startTime}}}`;
  }

  /** Attach the selected session through tmux itself; its key tables, copy mode and command prompt stay native. */
  async attachment(target: TmuxTarget, sessionId: string, readOnly: boolean): Promise<{ command: string; args: string[] }> {
    await this.validate(target);
    if (!/^\$[0-9]+$/.test(sessionId)) throw new TmuxError("invalid_session");
    const roster = await this.list(target.socket);
    if (!roster.panes.some(p => p.paneId === target.paneId && p.sessions.includes(sessionId))) throw new TmuxError("session_missing");
    const identity = await this.identity(target.socket);
    if (identity.generation !== target.generation) throw new TmuxError("stale_generation");
    return { command: this.binary, args: ["-S", target.socket, "if-shell", "-F", this.condition(identity),
      `attach-session ${readOnly ? "-r " : ""}-t '${sessionId}'`, "display-message -p TW_STALE"] };
  }

  async send(target: TmuxTarget, text: string, submit = false): Promise<void> {
    if (typeof text !== "string" || !text.length || Buffer.byteLength(text) > 8192 || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(text))
      throw new TmuxError("invalid_literal_text");
    if (typeof submit !== "boolean") throw new TmuxError("invalid_submit");
    const key = target?.socket;
    const run = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      await this.validate(target);
      // Hex literals prevent tmux's command parser from interpreting a payload ';'.
      // One CLI command queue contains both text and the explicitly requested Enter.
      const bytes = Array.from(Buffer.from(text, "utf8"), (b) => b.toString(16).padStart(2, "0"));
      const identity = await this.identity(target.socket);
      if (identity.generation !== target.generation) throw new TmuxError("stale_generation");
      const condition = `#{&&:#{==:#{pid},${identity.pid}},#{==:#{start_time},${identity.startTime}}}`;
      // The command string contains only validated %ID and generated hex bytes.
      const commands = `send-keys -t ${target.paneId} -l -H ${bytes.join(" ")}${submit ? ` ; send-keys -t ${target.paneId} Enter` : ""} ; display-message -p TW_SENT`;
      const result = await this.run(target.socket, ["if-shell", "-F", condition, commands, "display-message -p TW_STALE"]);
      if (result.trim() !== "TW_SENT") throw new TmuxError("stale_generation");
    });
    queues.set(key, run);
    try { await run; } finally { if (queues.get(key) === run) queues.delete(key); }
  }
}
