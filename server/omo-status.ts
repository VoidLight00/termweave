/**
 * The status of an OmO pane, read from OmO's own records.
 *
 * herdr reports nothing for one: OmO runs its claude child without the user's settings, so
 * herdr's hook never runs in it, and the pane reads `claude/idle` through a whole turn with no
 * status event (#286: three panes watched for three minutes, no frame). The sidebar never said
 * RUN, a message sent meanwhile was not held, and no done alert came.
 *
 * OmO appends to the session file of the session the pane holds (omo.ts finds it) as a turn
 * goes: a turn is running after a user message, a tool result, an assistant message that
 * stopped for a tool, or one of the runtime's own messages that start a turn (a finished
 * background task, a monitor, a goal continuation); it is over after an assistant message that
 * stopped for good. Measured over 40 session files: each of 492 such runtime messages written at
 * rest was followed by an assistant message, a median of 5 s later, so the message itself is the
 * start. An answer that ended in an error ends the turn like any other: OmO may retry (the next
 * answer followed 2, 4, 8 and 16 s later), but nothing it writes tells a retry from giving up.
 * Its `senpi.hooks.stop-state` record follows 2 ms after an error either way (350 of them were
 * followed by a retry), and is held back while a background task runs, so waiting for it kept a
 * pane at RUN for good. A retry that gets an answer shows as RUN again from that answer. Nothing
 * of OmO's or Claude's is installed or changed for this: files are read.
 *
 * The status replaces herdr's for the pane before CompletionTracker sees it, in status events and
 * in snapshots alike, under the one identity `omo`: herdr has named such a pane `pi` and `claude`
 * by turns, and a finish is matched by identity. A pane whose session cannot be told keeps
 * herdr's status, under the same identity.
 */
import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { basename, join } from "node:path";

import type { AgentStatus, HerdrPane, SessionSnapshot } from "../shared/protocol.ts";

/** runtime messages that start a turn nobody typed; one not named here shows as RUN from its first answer on */
const TURN_STARTS = new Set([
  "goal-continuation", "omo-senpi:wake", "senpi-monitor:notification", "senpi-terminal:notification",
  "senpi-codemode:notification", "senpi.todo-owed", "omo-init-deep-advisor:run", "omo-onboarding:bootstrap", "ttsr-injection",
]);

/** what herdr has called an OmO pane: by its engine, or by the claude child it runs */
export const OMO_ALIASES: readonly string[] = ["claude", "pi"];

export interface OmoTurn {
  status: "working" | "idle" | null;
  /** when the entry that decided the status was written */
  at: number | null;
}

export const noTurn = (): OmoTurn => ({ status: null, at: null });

/** A record too long to hold is read by its ends: its role and time are in the first bytes, its stop reason in the last. */
export type OmoLine = { text: string } | { head: string; tail: string };

/** One session record, applied to the turn so far. */
export function omoTurnAfter(turn: OmoTurn, line: OmoLine): OmoTurn {
  const head = "text" in line ? line.text : line.head;
  const custom = head.startsWith('{"type":"custom_message"');
  if (!custom && !head.startsWith('{"type":"message"')) return turn;
  let role: unknown, stopReason: unknown, customType: unknown, timestamp: unknown;
  if ("text" in line) {
    try {
      const entry = JSON.parse(line.text) as { customType?: unknown; timestamp?: unknown; message?: { role?: unknown; stopReason?: unknown } };
      ({ customType, timestamp } = entry);
      role = entry.message?.role;
      stopReason = entry.message?.stopReason;
    } catch { return turn; }
  } else {
    role = line.head.match(/"role":"(\w+)"/)?.[1];
    stopReason = (line.tail.match(/"stopReason":"(\w+)"/g)?.at(-1) ?? line.head.match(/"stopReason":"(\w+)"/)?.[0])?.match(/:"(\w+)"/)?.[1];
    customType = line.head.match(/"customType":"([^"]+)"/)?.[1];
    timestamp = line.head.match(/"timestamp":"([^"]+)"/)?.[1];
  }
  const parsed = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
  const at = Number.isFinite(parsed) ? parsed : turn.at;
  if (custom) return typeof customType === "string" && TURN_STARTS.has(customType) ? { status: "working", at } : turn;
  if (role === "assistant") return { status: stopReason === "toolUse" ? "working" : "idle", at };
  return role === "user" || role === "toolResult" ? { status: "working", at } : turn;
}

/** The turn at the end of a session text. */
export function omoTurnStatus(text: string): "working" | "idle" | null {
  let turn = noTurn();
  for (const line of text.split("\n")) turn = omoTurnAfter(turn, { text: line });
  return turn.status;
}

const CHUNK_BYTES = 256 * 1024;
/** a line longer than this is kept by its ends only */
const LONG_LINE_BYTES = 64 * 1024;
const LINE_END_BYTES = 4096;
/** how far back the first read of a session file starts, and how far when that held nothing that tells */
const FIRST_READ_BYTES = 1024 * 1024;
const DEEP_READ_BYTES = 16 * 1024 * 1024;

/**
 * Reads the whole lines of a file from `from` on and hands each to `each`; the offset of the
 * first byte not read (a last line still being written waits for its newline). A long line is
 * handed over by its ends, so no record is held whole however large.
 */
export function readLines(fd: number, from: number, size: number, each: (line: OmoLine) => void, read: typeof readSync = readSync): number {
  let offset = from;
  let position = from;
  let parts: Buffer[] = [];
  let held = 0;
  let head: Buffer | null = null;
  let tail = Buffer.alloc(0);
  const keepEnd = (more: Buffer) => { tail = Buffer.concat([tail, more]).subarray(-LINE_END_BYTES); };
  while (position < size) {
    const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, size - position));
    const got = read(fd, chunk, 0, chunk.length, position);
    if (got <= 0) break;
    const bytes = chunk.subarray(0, got);
    let start = 0;
    for (let newline = bytes.indexOf(0x0a, start); newline !== -1; newline = bytes.indexOf(0x0a, start)) {
      const piece = bytes.subarray(start, newline);
      if (head !== null) {
        keepEnd(piece);
        each({ head: head.toString("utf8"), tail: tail.toString("utf8") });
        head = null;
        tail = Buffer.alloc(0);
      } else {
        each({ text: Buffer.concat([...parts, piece]).toString("utf8") });
      }
      parts = [];
      held = 0;
      start = newline + 1;
      offset = position + start;
    }
    const rest = bytes.subarray(start);
    if (head !== null) keepEnd(rest);
    else {
      parts.push(rest);
      held += rest.length;
      if (held > LONG_LINE_BYTES) {
        const all = Buffer.concat(parts);
        head = all.subarray(0, LINE_END_BYTES);
        tail = all.subarray(-LINE_END_BYTES);
        parts = [];
        held = 0;
      }
    }
    position += got;
  }
  return offset;
}

/** `<timestamp>_<session id>.jsonl` */
export function omoSessionId(path: string): string | null {
  return basename(path).match(/_([A-Za-z0-9-]{8,128})\.jsonl$/)?.[1] ?? null;
}

/**
 * How many background tasks each session of a folder has running: OmO keeps one record per
 * `task` child in `<cwd>/.omo/senpi-task/tasks/`, with the session that started it. A record
 * left `running` by a host process that is gone is not counted.
 */
export function omoBackgroundTasks(cwd: string, alive: (pid: number) => boolean = processAlive): Map<string, number> {
  const running = new Map<string, number>();
  const dir = join(cwd, ".omo", "senpi-task", "tasks");
  let names: string[];
  try { names = readdirSync(dir); } catch { return running; }
  for (const name of names.slice(0, 2048)) {
    if (!name.startsWith("st_") || !name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(readFileSync(join(dir, name), "utf8")) as { status?: unknown; parent_session_id?: unknown; host_pid?: unknown };
      if (record.status !== "running" || typeof record.parent_session_id !== "string") continue;
      if (typeof record.host_pid === "number" && !alive(record.host_pid)) continue;
      running.set(record.parent_session_id, (running.get(record.parent_session_id) ?? 0) + 1);
    } catch { /* being written, or not a record */ }
  }
  return running;
}

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** An OmO pane: the session file it holds (null when it cannot be told) and when its OmO process started. */
export interface OmoPane { path: string | null; startedAt: number | null }

export interface OmoFile {
  /** its size, and what tells the file from one put in its place (a session file can be rewritten whole) */
  stat: (path: string) => { size: number; id: string } | null;
  /** the lines from `from` to `size`, and the offset read to */
  lines: (path: string, from: number, size: number, each: (line: OmoLine) => void) => number;
}

export interface OmoStatusDeps {
  /** the panes of a snapshot that run OmO, whatever herdr calls them: one process lookup per pane */
  discover: (panes: HerdrPane[]) => Promise<Map<string, OmoPane>>;
  snapshot: () => Promise<SessionSnapshot>;
  /** `turn`: the pane's turn started or ended; otherwise only its background tasks changed */
  onChange: (paneId: string, status: AgentStatus, background: number, turn: boolean) => void;
  /** a pane was found to run OmO: what herdr called it until now is the same agent */
  onFound?: (paneId: string) => void;
  file?: OmoFile;
  background?: (cwd: string) => Map<string, number>;
  /** how often the session files are looked at, and the panes found anew */
  pollMs?: number;
  refreshMs?: number;
  now?: () => number;
}

interface Tracked extends OmoPane { cwd: string; offset: number; size: number; id: string; /** found again after a while herdr's status stood for it: a turn still running is told anew */ retell: boolean; turn: OmoTurn; status: "working" | "idle"; background: number }

const FILES: OmoFile = {
  stat: (path) => { try { const fd = openSync(path, "r"); try { const stat = fstatSync(fd); return { size: stat.size, id: `${stat.dev}:${stat.ino}` }; } finally { closeSync(fd); } } catch { return null; } },
  lines: (path, from, size, each) => {
    let fd: number;
    try { fd = openSync(path, "r"); } catch { return from; }
    try { return readLines(fd, from, size, each); } catch { return from; } finally { closeSync(fd); }
  },
};

/** A turn older than the process that holds the session now was another process's: it did not finish, and is not running. */
const STALE_TURN_MS = 2000;

export class OmoStatus {
  /** every pane that runs OmO; those whose session is known carry a status */
  private readonly panes = new Map<string, Tracked>();
  /** what a pane read when its OmO was last told from it, while the pane itself is still there: found again, it goes on from that */
  private readonly last = new Map<string, { status: "working" | "idle"; background: number; path: string; startedAt: number | null }>();
  private refreshedAt = -Infinity;
  private refreshedFor = "";
  private refreshing: Promise<void> | null = null;
  /** counts the panes taken from OmO by an event: a lookup started before one says nothing of them */
  private generation = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticks = 0;
  private readonly file: OmoFile;
  private readonly background: NonNullable<OmoStatusDeps["background"]>;
  private readonly now: () => number;
  private readonly refreshMs: number;

  constructor(private readonly deps: OmoStatusDeps) {
    this.file = deps.file ?? FILES;
    this.background = deps.background ?? omoBackgroundTasks;
    this.now = deps.now ?? Date.now;
    this.refreshMs = deps.refreshMs ?? 5000;
  }

  /** Watches with no browser connected too: web push depends on it. */
  start(): void {
    if (this.timer !== null) return;
    const pollMs = this.deps.pollMs ?? 1000;
    const every = Math.max(1, Math.round(this.refreshMs / pollMs));
    this.timer = setInterval(() => {
      this.poll();
      if (++this.ticks % every === 0) void this.deps.snapshot().then((snapshot) => this.refresh(snapshot.panes)).catch(() => undefined);
    }, pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** herdr's status for this pane is replaced: its events say nothing true. */
  tracks(paneId: string): boolean {
    return this.panes.get(paneId)?.path != null;
  }

  /** The pane runs OmO, its session known or not: its identity is `omo` whatever herdr calls it. */
  runs(paneId: string): boolean {
    return this.panes.has(paneId);
  }

  backgroundOf(paneId: string): number {
    return this.panes.get(paneId)?.background ?? 0;
  }

  /** The folder and session id of the OmO session the pane holds, once its file is known. */
  sessionOf(paneId: string): { cwd: string; sessionId: string } | null {
    const tracked = this.panes.get(paneId);
    const sessionId = tracked?.path == null ? null : omoSessionId(tracked.path);
    return tracked && sessionId !== null && tracked.cwd !== "" ? { cwd: tracked.cwd, sessionId } : null;
  }

  /**
   * Finds the OmO panes of a snapshot and their session files. Asked of herdr at most once per
   * `refreshMs` while the panes stay the same: each pane costs a process lookup.
   */
  async refresh(panes: HerdrPane[]): Promise<void> {
    const key = panes.map((pane) => `${pane.pane_id}\0${pane.agent ?? ""}\0${pane.cwd ?? ""}`).join("\n");
    if (key === this.refreshedFor && this.now() - this.refreshedAt < this.refreshMs) return;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const generation = this.generation;
      const found = await this.deps.discover(panes);
      if (generation !== this.generation) return;
      const cwds = new Map(panes.map((pane) => [pane.pane_id, pane.cwd ?? ""]));
      for (const [paneId, gone] of this.panes) {
        if (found.has(paneId)) continue;
        this.remember(paneId, gone);
        this.panes.delete(paneId);
      }
      for (const paneId of [...this.last.keys()]) if (!cwds.has(paneId)) this.last.delete(paneId);
      for (const [paneId, pane] of found) {
        const before = this.panes.get(paneId);
        if (!before) this.deps.onFound?.(paneId);
        // the same session goes on being read from where it was: what happened meanwhile is told.
        // A start that cannot be read this time is the one read before
        if (before && before.path === pane.path) before.startedAt = pane.startedAt ?? before.startedAt;
        else {
          // another session, or the pane's OmO or its session found again: a turn that ended
          // meanwhile is told against what the pane read before, and the same session's process
          // started when it was last known to
          if (before) this.remember(paneId, before);
          const prior = this.last.get(paneId);
          const startedAt = pane.startedAt ?? before?.startedAt ?? (prior?.path === pane.path ? prior.startedAt : null);
          this.panes.set(paneId, { ...pane, startedAt, cwd: cwds.get(paneId) ?? "", offset: -1, size: -1, id: "", retell: prior !== undefined, turn: noTurn(), status: prior?.status ?? "idle", background: prior?.background ?? 0 });
        }
        if (pane.path !== null) this.last.delete(paneId);
      }
      this.refreshedFor = key;
      this.refreshedAt = this.now();
      this.poll();
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private remember(paneId: string, tracked: Tracked): void {
    if (tracked.path !== null) this.last.set(paneId, { status: tracked.status, background: tracked.background, path: tracked.path, startedAt: tracked.startedAt });
  }

  /**
   * herdr named the pane's agent in a status event. Another agent than the names it gives OmO
   * (Codex started where OmO ran) ends OmO's hold on the pane at once, not at the next lookup:
   * that agent's events are its own, a question it asks among them. True when the pane was
   * OmO's until now: what OmO did there is then no part of the other agent's status.
   */
  named(paneId: string, agent: string | null): boolean {
    if (agent === null || agent === "omo" || OMO_ALIASES.includes(agent)) return false;
    const held = this.panes.delete(paneId);
    const remembered = this.last.delete(paneId);
    if (!held && !remembered) return false;
    this.generation += 1;
    this.refreshedFor = "";
    return true;
  }

  /**
   * Reads what the session files gained; a turn that started or ended is told. A pane found at
   * rest tells nobody; one found in a turn tells it, so that its end is a finish.
   */
  poll(): void {
    const counts = new Map<string, Map<string, number>>();
    for (const [paneId, tracked] of this.panes) {
      if (tracked.path === null) continue;
      const stat = this.file.stat(tracked.path);
      if (stat === null) continue;
      const { size } = stat;
      if (tracked.offset === -1 || size < tracked.offset || stat.id !== tracked.id) this.readFrom(tracked, tracked.path, size, Math.max(0, size - FIRST_READ_BYTES));
      // also what a read that failed left unread
      else if (size !== tracked.size || tracked.offset < size) tracked.offset = this.file.lines(tracked.path, tracked.offset, size, (line) => { tracked.turn = omoTurnAfter(tracked.turn, line); });
      tracked.size = size;
      tracked.id = stat.id;
      // nothing could be read of it (a read that failed): what the pane read before stands until one succeeds
      if (tracked.turn.status === null && tracked.offset < size) continue;
      const stale = tracked.turn.status === "working" && tracked.turn.at !== null && tracked.startedAt !== null && tracked.turn.at < tracked.startedAt - STALE_TURN_MS;
      const status = tracked.turn.status === "working" && !stale ? "working" : "idle";
      const sessionId = omoSessionId(tracked.path);
      if (!counts.has(tracked.cwd)) counts.set(tracked.cwd, tracked.cwd ? this.background(tracked.cwd) : new Map());
      const background = sessionId ? counts.get(tracked.cwd)!.get(sessionId) ?? 0 : 0;
      const turn = status !== tracked.status || (tracked.retell && status === "working");
      tracked.retell = false;
      const changed = turn || background !== tracked.background;
      tracked.status = status;
      tracked.background = background;
      if (changed) this.deps.onChange(paneId, status, background, turn);
    }
  }

  /** The first read of a file: its end, and further back when that end holds nothing that tells (one long record). */
  private readFrom(tracked: Tracked, path: string, size: number, from: number): void {
    const read = (start: number): void => {
      tracked.turn = noTurn();
      let skip = start > 0;
      tracked.offset = this.file.lines(path, start, size, (line) => {
        // the first line of a read that starts inside the file is the rest of a record
        if (skip) { skip = false; return; }
        tracked.turn = omoTurnAfter(tracked.turn, line);
      });
    };
    read(from);
    if (tracked.turn.status === null && from > 0) read(Math.max(0, size - DEEP_READ_BYTES));
  }

  /**
   * A snapshot with OmO's own status in place of herdr's for the panes whose session is known,
   * and every OmO pane under the identity `omo`. This is what CompletionTracker settles.
   */
  apply<T extends { panes: HerdrPane[]; agents?: SessionSnapshot["agents"] }>(snapshot: T): T {
    if (!snapshot.panes.some((pane) => this.panes.has(pane.pane_id))) return snapshot;
    const own = <P extends { pane_id: string; agent_status: AgentStatus }>(entry: P): P => {
      const tracked = this.panes.get(entry.pane_id);
      if (!tracked) return entry;
      return { ...entry, agent: "omo", ...(tracked.path !== null ? { agent_status: tracked.status } : {}) };
    };
    return { ...snapshot, panes: snapshot.panes.map(own), ...(snapshot.agents ? { agents: snapshot.agents.map(own) } : {}) };
  }
}
