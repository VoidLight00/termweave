import { processOpenFiles } from "./process-files.ts";
/**
 * gjc sessions: the process identity GJC keys its terminal breadcrumb by, and the
 * resolver from a pane to the one transcript that process writes. It answers null
 * rather than guessing; conversation.ts turns that into the chat lens's fallback.
 */

import { execFileSync } from "node:child_process";
import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, statSync } from "node:fs";
import nodePath, { join, type PlatformPath } from "node:path";

import { readRange } from "./codex.ts";
import { herdrRpc, paneRead } from "./herdr/client.ts";
import { processStartedAt } from "./process-start.ts";
import { parseOmpTranscript } from "./transcript-records.ts";
import { descendantArgv, windowsProcessTable, type ProcessRow } from "./windows-processes.ts";

export interface GjcTerminal { id: string; startedAt: number }

/** Native gjc and interpreter-launched gjc scripts both occur in process_info. */
export function isGjcProcess(argv: readonly string[]): boolean {
  // a Windows process comes with backslashes and `.exe`
  const executable = /(^|[\\/])gjc(?:\.exe|\.[cm]?js)?$/i;
  return executable.test(argv[0] ?? "") ||
    (/(^|[\\/])(?:bun|node)(?:\.exe)?$/i.test(argv[0] ?? "") && executable.test(argv[1] ?? ""));
}

const PROCESS_TABLE_MS = 5000;
let processTable: { at: number; rows: Promise<ProcessRow[]> } | null = null;

/**
 * The Windows process table, read at most once per PROCESS_TABLE_MS. The chat polls a pane
 * every 2 s and each read starts a PowerShell (about 1.3 s on a real PC), so the polls of a
 * few seconds share one; a gjc that left its pane can still count as running for that long.
 */
export function recentProcessTable(read: () => Promise<ProcessRow[]> = windowsProcessTable, now = Date.now()): Promise<ProcessRow[]> {
  if (processTable && now - processTable.at < PROCESS_TABLE_MS) return processTable.rows;
  const entry = { at: now, rows: read() };
  processTable = entry;
  // an empty table is a read that failed: the next poll asks again
  void entry.rows.then((rows) => { if (rows.length === 0 && processTable === entry) processTable = null; });
  return entry.rows;
}

/** A gjc process by its number and when it started: a number alone comes back for another process. */
export type GjcProcess = { pid: number; started: number | null };

/**
 * The gjc process below a pane's shell on a Windows PC, or null. herdr names only the shell
 * there (windows-processes.ts), so the PC's process table answers; elsewhere herdr's
 * foreground processes are the answer and the table is never asked. undefined: the table could
 * not be read (a query that timed out answers no rows), which says nothing about gjc.
 */
export async function gjcPidUnderShell(
  shellPid: unknown,
  platform: string = process.platform,
  table: () => Promise<ProcessRow[]> = recentProcessTable,
): Promise<GjcProcess | null | undefined> {
  if (platform !== "win32" || typeof shellPid !== "number") return null;
  const rows = await table();
  if (rows.length === 0) return undefined;
  const seen = new Set<number>([shellPid]);
  let level = [shellPid];
  while (level.length > 0) {
    const next: number[] = [];
    for (const row of rows) {
      if (!level.includes(row.parent) || seen.has(row.pid)) continue;
      // nearest first: the session's own process, not the helper gjc starts below itself
      if (descendantArgv([row], row.parent).some(isGjcProcess)) return { pid: row.pid, started: row.started ?? null };
      seen.add(row.pid);
      next.push(row.pid);
    }
    level = next;
  }
  return null;
}

/** `title`: what gjc's status line showed when the pane was bound (null: none yet) */
const windowsBindings = new Map<string, { process: GjcProcess; path: string; title: string | null | undefined }>();

/**
 * What a pane's screen says: the session an answer on it matches, the title gjc's status line
 * shows (null: a session with no title yet, as one is right after /new; undefined: no status
 * line, or one too narrow to hold the title whole), the title of every session file of the
 * folder (undefined: not read to its end yet), how many carry the screen's title (-1 while one
 * is still unread) and, when it is one, that file.
 */
export type GjcScreen = {
  path: string | null; title: string | null | undefined; titled: string | null; titledCount: number; titles: ReadonlyMap<string, string | null | undefined>;
  /** an answer on screen is of more than one session that may be running, or of one not read yet: it names none, and the one bound may not be it */
  shared?: boolean;
};

/**
 * The title in gjc's status line (gjc 0.16.4 on a Windows PC):
 * `⬢ sonnet-5 · ◒ med · 1.8% / 📁 ~\\dir ──── Simple Ok Reply / ⤴ 0.3/s / $0.04 (sub) / v0.16.4`,
 * and `──── (sub) / v0.16.4` for a session with no title yet. Only the line right over the
 * message box at the bottom of the screen counts: the same lines printed in an answer are text,
 * and while a menu stands where the box does (/resume) there is no status to read. Read from
 * the right, since a title may hold ` / ` and parentheses itself: the version, gjc's cost and
 * plan, its speed, each once, and what is left is the title.
 */
export function gjcStatusTitle(screen: string): string | null | undefined {
  const lines = screen.split(/\r?\n/);
  let at = lines.length - 1;
  while (at >= 0 && lines[at]!.trim() === "") at -= 1;
  if (at < 0 || !/^\s*\u2570\u2500/.test(lines[at]!)) return undefined;
  at -= 1;
  while (at >= 0 && /^\s*\u2502/.test(lines[at]!)) at -= 1;
  if (at < 1 || !/^\s*\u256d\u2500/.test(lines[at]!)) return undefined;
  const status = lines[at - 1]!;
  if (!/^\s*\u2b22\s/.test(status) || !status.includes("\u{1F4C1}")) return undefined;
  const version = status.match(/\s\/\s+v\d+\.\d+\.\d+\s*$/);
  // one rule between the folder and the title: with two, the folder or the title holds one and neither can be told
  const rules = [...status.matchAll(/\u2500{3,}\s/g)];
  const rule = rules[0];
  if (!version || rules.length !== 1 || !rule || rule.index + rule[0].length > version.index!) return undefined;
  const parts = status.slice(rule.index + rule[0].length, version.index).split(" / ").map((part) => part.trim());
  // `$0.04 (sub)`, or `(sub)` alone before anything was spent; then `⤴ 0.3/s`
  if (/^(?:\$[\d.]+\s+)?\(sub\)$|^\$[\d.]+$/.test(parts.at(-1) ?? "")) parts.pop();
  if (/^\u2934\s*[\d.]+\/s$/u.test(parts.at(-1) ?? "")) parts.pop();
  const title = parts.join(" / ").trim();
  if (title === "") return null;
  return title.endsWith("\u2026") ? undefined : title;
}

const TITLE_CHUNK_BYTES = 256 * 1024;
/** bytes of session files one look at a pane may read for titles; what is left is read by the next looks */
export const TITLE_BUDGET_BYTES = 2 * 1024 * 1024;
interface TitleScan { file: string; size: number; modified: number; head: string; scanned: number; title: string | null; skipping: boolean }
/** kept per file while panes look at it: 64 candidates a folder, and more panes than a few */
const titleScans = new Map<string, TitleScan>();

/**
 * A session file's title: its header's, or the last one gjc patched in later (`header_patch`).
 * undefined while the file is not read to its end: a file is scanned in chunks, within `budget`,
 * and the scan goes on from where it stopped at the next call, as files only grow. Another file
 * in its place, one that shrank, or one changed without growing is read anew.
 */
export function gjcSessionTitle(path: string, budget: { bytes: number } = { bytes: TITLE_BUDGET_BYTES }): string | null | undefined {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return null; }
  try {
    const stat = fstatSync(fd);
    const size = stat.size;
    const file = `${stat.dev}:${stat.ino}`;
    const first = Buffer.alloc(Math.min(256, size));
    readSync(fd, first, 0, first.length, 0);
    const head = first.toString("latin1");
    let scan = titleScans.get(path);
    if (!scan || scan.file !== file || size < scan.size || (size === scan.size && stat.mtimeMs !== scan.modified)
      || !head.startsWith(scan.head.slice(0, head.length)) || head.length < scan.head.length) {
      scan = { file, size, modified: stat.mtimeMs, head, scanned: 0, title: null, skipping: false };
    }
    scan.head = head; scan.size = size; scan.modified = stat.mtimeMs;
    while (scan.scanned < size && budget.bytes > 0) {
      const chunk = Buffer.alloc(Math.min(TITLE_CHUNK_BYTES, size - scan.scanned, budget.bytes));
      const got = readSync(fd, chunk, 0, chunk.length, scan.scanned);
      if (got <= 0) break;
      budget.bytes -= got;
      const bytes = chunk.subarray(0, got);
      const lastBreak = bytes.lastIndexOf(0x0a);
      if (lastBreak === -1) {
        // a record longer than a chunk (a picture) is no title record: pass over it
        if (got < TITLE_CHUNK_BYTES) break;
        scan.skipping = true;
        scan.scanned += got;
        continue;
      }
      let from = 0;
      if (scan.skipping) { from = bytes.indexOf(0x0a) + 1; scan.skipping = false; }
      for (const line of bytes.subarray(from, lastBreak).toString("utf8").split("\n")) {
        if (!line.includes('"title"')) continue;
        try {
          const record = JSON.parse(line) as { type?: unknown; title?: unknown; patch?: { title?: unknown } };
          const title = record.type === "session" ? record.title : record.type === "header_patch" ? record.patch?.title : undefined;
          if (typeof title === "string" && title.trim()) scan.title = title.trim();
        } catch { /* not a record */ }
      }
      scan.scanned += lastBreak + 1;
    }
    titleScans.delete(path);
    titleScans.set(path, scan);
    if (titleScans.size > 8192) titleScans.delete(titleScans.keys().next().value!);
    // a last line still being written is not waited for: it is read once it has its newline
    return size - scan.scanned > TITLE_CHUNK_BYTES || (scan.scanned < size && budget.bytes <= 0) ? undefined : scan.title;
  } catch { return null; }
  finally { closeSync(fd); }
}

/**
 * What one look at a pane reads from its folder's session files: each file's title within the
 * budget, and the files an answer on screen may be matched among. An answer counts only for a
 * session that can be the one running: one carrying the status line's title, or, while no file
 * carries it yet, one without a title.
 */
export function gjcTitles(
  paths: readonly string[], title: string | null | undefined,
  titleOf: (path: string, budget: { bytes: number }) => string | null | undefined = gjcSessionTitle,
  sizeOf: (path: string) => number = fileSize,
): Pick<GjcScreen, "titled" | "titledCount" | "titles"> & { among: string[]; unread: string[] } {
  const titles = new Map<string, string | null | undefined>();
  if (typeof title !== "string" && title !== null) return { titled: null, titledCount: 0, titles, among: [...paths], unread: [] };
  const budget = { bytes: TITLE_BUDGET_BYTES };
  // the small ones first: one long history must not use up the look before a short session is read
  const sizes = new Map(paths.map((path) => [path, sizeOf(path)]));
  for (const path of [...paths].sort((a, b) => sizes.get(a)! - sizes.get(b)!)) titles.set(path, titleOf(path, budget));
  // a file not read to its end may carry any title: it is no untitled session to match an answer in
  const untitled = paths.filter((path) => titles.get(path) === null);
  // and it cannot be chosen by an answer either, yet an answer it shares is not one session's alone
  const unread = paths.filter((path) => titles.get(path) === undefined);
  if (title === null) return { titled: null, titledCount: 0, titles, among: untitled, unread };
  const carrying = paths.filter((path) => titles.get(path) === title);
  return {
    titled: carrying.length === 1 && unread.length === 0 ? carrying[0]! : null,
    // two that carry it are two, whatever the unread ones turn out to carry
    titledCount: carrying.length > 1 ? carrying.length : unread.length > 0 ? -1 : carrying.length,
    titles,
    among: carrying.length > 0 ? carrying : untitled,
    unread,
  };
}

function fileSize(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

/** The start time decides only when both reads have it: a column that failed once is not another process. */
const sameProcess = (a: GjcProcess, b: GjcProcess) => a.pid === b.pid && (a.started === null || b.started === null || a.started === b.started);

/**
 * A Windows pane's session. The screen is the only evidence there, and it is gone whenever no
 * recent answer's tail is visible (a long list, tool output; live-verified: the lens fell back
 * for the whole of such an answer). So what the screen once showed is kept for the pane while
 * the same gjc process runs in it, and a pane is never bound without the screen.
 *
 * gjc's status line names the session the process runs now, and the session file carries the
 * same title. After /new or /resume the same process runs another session, and a one-word answer
 * never matched (measured on a real PC: the chat stayed on the old conversation). So the title
 * decides when it can: one file with it is the session; several leave only an answer of one of
 * them to tell, and without one the chat shows none rather than the last session; a title other
 * than the one the pane was bound under, or none where the bound session has one, ends the
 * binding. A process table that could not be read (`undefined`) leaves the binding as it was.
 */
export async function boundGjcTranscript(paneId: string, gjc: GjcProcess | null | undefined, look: () => Promise<GjcScreen | null>): Promise<string | null> {
  let bound = windowsBindings.get(paneId);
  if (gjc === null || gjc && bound && !sameProcess(bound.process, gjc)) {
    windowsBindings.delete(paneId);
    bound = undefined;
  }
  if (gjc === null) return null;
  // a start time once known is kept: a later read without it must not hide a reused number
  if (bound && gjc && gjc.started !== null) bound.process = gjc;
  const screen = await look();
  const process = gjc && bound && gjc.started === null ? bound.process : gjc ?? bound?.process;
  const title = screen?.title;
  const known = (path: string) => screen?.titles.get(path);
  const found = typeof title === "string" && screen!.titledCount === 1 ? screen!.titled : screen?.path ?? null;
  if (found && process) {
    // matched again with no status line to read: what the pane was bound under still stands
    windowsBindings.set(paneId, { process, path: found, title: title === undefined && bound?.path === found ? bound.title : title });
    return found;
  }
  if (!bound) return null;
  const own = typeof bound.title === "string" ? bound.title : known(bound.path);
  // an answer on screen that several sessions hold, the one bound perhaps among them, tells it is
  // not known which runs. Not while the status line cannot be read (a narrow pane): every session
  // of the folder is then asked, and two that say the same thing are no sign of a switch
  const other = (screen?.shared === true && title !== undefined) || (title === null ? typeof own === "string"
    : typeof title === "string" && (screen!.titledCount > 1 || typeof own === "string" && own !== title));
  if (other) {
    windowsBindings.delete(paneId);
    return null;
  }
  // gjc titled the session after the pane was bound to it
  if (typeof title === "string" && known(bound.path) === title) bound.title = title;
  return bound.path;
}

/** Forget the bindings and the process table kept between polls. */
export function forgetGjcState(): void {
  windowsBindings.clear();
  titleScans.clear();
  processTable = null;
}

/**
 * Where `file` sits inside `root`, as path segments, or null when it is not inside. The
 * platform's own rules decide: a Windows path comes with backslashes and a drive letter whose
 * case means nothing, and a prefix test would take `sessions-evil` or a `..` for the store.
 */
export function storeRelative(root: string, file: string, paths: PlatformPath = nodePath): string[] | null {
  const relative = paths.relative(root, file);
  // another drive or share comes back absolute
  if (relative === "" || paths.isAbsolute(relative)) return null;
  const parts = relative.split(paths.sep);
  return parts[0] === ".." ? null : parts;
}

/** GJC's native terminal-sessions key, not the most recently written cwd session. */
export function gjcTerminal(pid: number): GjcTerminal | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") {
      const startedAt = processStartedAt(pid);
      if (startedAt === null) return null;
      const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
      const tmux = env.find((word) => word.startsWith("TMUX="))?.slice(5);
      const pane = env.find((word) => word.startsWith("TMUX_PANE="))?.slice(10);
      if (tmux && pane && /^%\d+$/.test(pane)) return { id: `tmux-${pane}`, startedAt };
      const tty = readlinkSync(`/proc/${pid}/fd/0`);
      if (!/^\/dev\/(?:pts\/\d+|tty[\w-]+)$/.test(tty)) return null;
      return { id: tty.slice(5).replaceAll("/", "-"), startedAt };
    }
    if (process.platform === "darwin") {
      const output = execFileSync("ps", ["-p", String(pid), "-o", "tty=", "-o", "lstart="], {
        encoding: "utf8", timeout: 1500, maxBuffer: 4096, env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, stdio: ["ignore", "pipe", "ignore"],
      });
      return parseGjcPs(output);
    }
  } catch { /* process exited or its terminal metadata is unavailable */ }
  return null;
}

export function parseGjcPs(output: string): GjcTerminal | null {
  const match = output.trim().match(/^(?:\/dev\/)?(ttys\d+)\s+(.+)$/);
  if (!match) return null;
  const startedAt = Date.parse(`${match[2]!} UTC`);
  return Number.isFinite(startedAt) ? { id: match[1]!, startedAt } : null;
}

/**
 * The cwd a gjc transcript names in its first line (`{"type":"session",...}`),
 * or null when the file is not one. Read bounded: only the header decides, and
 * a rejected candidate can be megabytes.
 */
function transcriptCwd(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null; // the file vanished between the listing and this read
  }
  try {
    const buffer = Buffer.alloc(4096);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    const header = JSON.parse(buffer.subarray(0, size).toString("utf8").split("\n")[0] ?? "") as { type?: string; cwd?: unknown };
    return header.type === "session" && typeof header.cwd === "string" ? header.cwd : null;
  } catch {
    return null; // not a gjc transcript, or a header longer than the read
  } finally {
    closeSync(fd);
  }
}

/** Unique visible transcript evidence; timestamps never choose a winner. */
export function matchGjcTranscript(screen: string, candidates: { path: string; text: string }[]): string | null {
  const normalize = (value: string) => value.normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "");
  const visible = normalize(screen);
  const matches = new Set<string>();
  for (const file of candidates) {
    const turns = parseOmpTranscript(file.text, Infinity).filter(turn => turn.role === "assistant").slice(-8);
    if (turns.some(turn => turn.parts.some(part => {
      if (part.kind !== "text") return false;
      const anchor = normalize(part.text).slice(-160);
      return anchor.length >= 64 && visible.includes(anchor);
    }))) matches.add(file.path);
  }
  return matches.size === 1 ? [...matches][0]! : null;
}

/**
 * The one session among `among` an answer on screen is of. A file whose title is not read yet
 * is matched too, so that an answer it shares with another (a fork holds its parent's) is
 * nobody's; alone it is not chosen.
 */
export function gjcAnswerAmong(screen: string, files: { path: string; text: string }[], among: readonly string[], unread: readonly string[]): { path: string | null; shared: boolean } {
  const hits = files.filter((file) => (among.includes(file.path) || unread.includes(file.path)) && matchGjcTranscript(screen, [file]) === file.path).map((file) => file.path);
  const only = hits.length === 1 && among.includes(hits[0]!) ? hits[0]! : null;
  return { path: only, shared: hits.length > 0 && only === null };
}

/** Bound both directory enumeration and content reads; never match an arbitrary subset. */
export function gjcDisplayCandidates(root: string, cwd: string): { path: string; text: string }[] {
  try {
    const dirs = readdirSync(root, { withFileTypes: true });
    if (dirs.length > 512) return [];
    const paths = new Set<string>();
    let inspected = 0;
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const entries = readdirSync(join(root, dir.name));
      inspected += entries.length;
      if (inspected > 4096) return [];
      for (const name of entries) {
        if (!name.endsWith(".jsonl")) continue;
        const path = realpathSync(join(root, dir.name, name));
        if (storeRelative(root, path) && statSync(path).isFile() && transcriptCwd(path) === cwd) paths.add(path);
      }
    }
    if (paths.size > 64) return [];
    return [...paths].map(path => {
      const size = statSync(path).size;
      // readRange drops through the first newline; starting one byte early keeps a record
      // the 64 KiB window starts exactly on, and still drops one it cuts
      return { path, text: readRange(path, Math.max(0, size - 65536 - 1), size) };
    });
  } catch { return []; }
}

/**
 * The session a transcript belongs to. GJC keeps a session's subagents beside it, as
 * `<store>/<session>/<task>.jsonl` next to `<store>/<session>.jsonl`, and they run inside the
 * session's own process. That process points the terminal breadcrumb at a subagent's file while it
 * runs, and leaves it there; a subagent's file can be the one it holds open. Either way the pane
 * shows the session, so a subagent's file stands for its session's, and anything else is refused.
 */
export function gjcSessionFile(root: string, path: string, paths: PlatformPath = nodePath): string | null {
  const parts = path.endsWith(".jsonl") ? storeRelative(root, path, paths) : null;
  if (!parts) return null;
  if (parts.length === 2) return path;
  if (parts.length !== 3) return null;
  const session = paths.join(root, parts[0]!, `${parts[1]!}.jsonl`);
  try { return statSync(session).isFile() ? session : null; } catch { return null; }
}

/** Validate the native two-line terminal breadcrumb and reject reused-terminal leftovers. */
export function gjcBreadcrumbPath(home: string, cwd: string, terminalId: string, startedAt: number): string | null {
  if (!/^(?:pts-\d+|tty[\w-]+|tmux-%\d+)$/.test(terminalId) || !Number.isFinite(startedAt)) return null;
  try {
    const marker = join(home, ".gjc", "agent", "terminal-sessions", terminalId);
    const stat = statSync(marker);
    if (!stat.isFile() || stat.size > 8192 || stat.mtimeMs < startedAt - 1000) return null;
    const [savedCwd, savedPath] = readFileSync(marker, "utf8").split("\n");
    if (!savedCwd || !savedPath || realpathSync(savedCwd) !== realpathSync(cwd)) return null;
    const root = realpathSync(join(home, ".gjc", "agent", "sessions"));
    const saved = realpathSync(savedPath);
    if (!statSync(saved).isFile()) return null;
    const path = gjcSessionFile(root, saved);
    if (!path) return null;
    const headerCwd = transcriptCwd(path);
    return headerCwd && realpathSync(headerCwd) === realpathSync(cwd) ? path : null;
  } catch { return null; }
}

/**
 * A directory descriptor or cwd proves only the store, not the active session.
 * Prefer an exact open transcript, then GJC's terminal-scoped breadcrumb written
 * during this process lifetime. Never infer ownership from cwd or session recency.
 */
export async function gjcTranscriptForPane(paneId: string, cwd: string, home = process.env["HOME"] ?? ""): Promise<string | null> {
  let root: string;
  try { root = realpathSync(join(home, ".gjc", "agent", "sessions")); }
  catch { return null; }
  const info = await herdrRpc<{ process_info?: { shell_pid?: unknown; foreground_processes?: { pid?: unknown; argv?: unknown }[] } }>(
    "pane.process_info",
    { pane_id: paneId },
  ).catch(() => null);
  const paths = new Set<string>();
  const breadcrumbs = new Set<string>();
  let running = false;
  for (const process of info?.process_info?.foreground_processes ?? []) {
    const argv = Array.isArray(process.argv) ? process.argv.map(String) : [];
    if (typeof process.pid !== "number" || !isGjcProcess(argv)) continue;
    running = true;
    const terminal = gjcTerminal(process.pid);
    if (terminal) {
      const path = gjcBreadcrumbPath(home, cwd, terminal.id, terminal.startedAt);
      if (path) breadcrumbs.add(path);
    }
    for (const path of processOpenFiles(process.pid)) {
      try {
        const open = realpathSync(path);
        const target = statSync(open).isFile() ? gjcSessionFile(root, open) : null;
        if (target && transcriptCwd(target) === cwd) paths.add(target);
      } catch { /* closed, deleted or unreadable descriptor */ }
    }
  }
  const candidates = paths.size > 0 ? paths : breadcrumbs;
  if (candidates.size === 1) return [...candidates][0]!;
  if (candidates.size > 1) return null;
  // Some GJC builds publish neither a file descriptor nor a terminal breadcrumb.
  // Match substantial assistant text in this pane against every same-cwd candidate.
  const look = async (): Promise<GjcScreen | null> => {
    const files = gjcDisplayCandidates(root, cwd);
    const screen = await paneRead({ paneId, source: "visible", lines: 1000 }).catch(() => null);
    if (!screen) return null;
    const title = gjcStatusTitle(screen.text);
    const { among, unread, ...titles } = gjcTitles(files.map((file) => file.path), title);
    return { ...gjcAnswerAmong(screen.text, files, among, unread), title, ...titles };
  };
  if (running) return (await look())?.path ?? null;
  // a Windows pane has neither descriptors nor a breadcrumb to read: gjc under its shell, then the screen
  return boundGjcTranscript(paneId, await gjcPidUnderShell(info?.process_info?.shell_pid), look);
}
