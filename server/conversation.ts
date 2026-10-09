/**
 * Agent session transcripts -> structured conversation turns.
 *
 * The recognized stores are provider-native and read-only:
 * - Codex: native rollout JSONL, resolved by session metadata/open descriptors
 *   or a unique pane-text match for shared app-server TUIs (codex.ts).
 * - Claude Code: herdr's agent.get names the session id, the transcript lives
 *   at ~/.claude/projects/<project>/<session>.jsonl (claude-store.ts finds it).
 * - omp: herdr's agent.get hands us the session jsonl path outright under
 *   ~/.omp/agent/sessions/<cwd-slug>/ — same shape of truth, one less hop.
 * - omo: herdr knows nothing about its store and its label for the pane flips
 *   between `pi` and `claude` as omo spawns model CLIs, so the pane's process
 *   tree routes it and process/session evidence selects a unique transcript
 *   under <its agent dir>/sessions/<cwd-slug>/ (~/.omo/agent unless the process
 *   moved it with OMO_CODING_AGENT_DIR). It writes omp's session shape, so
 *   parseOmpTranscript (transcript-records.ts) reads it.
 * - gjc: an open session file or fresh native terminal breadcrumb belonging to
 *   its process (gjc-runtime.ts). It writes omp's session shape too.
 * - pi: herdr's agent.get names the session jsonl outright under
 *   ~/.pi/agent/sessions/<cwd-slug>/ (pi.ts). Its records are the session shape
 *   parseOmpTranscript reads, but its file is an entry tree, not a log: /tree
 *   moves the leaf and appends beside the path it left (pi-tree.ts), so the
 *   stream is projected onto the branch the leaf stands on before it is read.
 *
 * This module turns those files into the conversation the chat lens renders;
 * the pty stays the input path. Pure parsing lives in parseClaudeTranscript /
 * parseOmpTranscript (unit-tested); pane/session/file resolution is
 * integration and lives in paneConversation.
 */

import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import nodePath, { type PlatformPath } from "node:path";

import type { ConversationMetadata, ConversationPart, ConversationTurn, HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { herdrRpc, sessionSnapshot } from "./herdr/client.ts";
import { codexHistorySegments, createCodexTranscriptParser, codexOutputText, codexTranscriptPath, defaultCodexHome, parseCodexTranscript, readRange } from "./codex.ts";
import { CODEX_IMAGE_REF, codexTranscriptImage } from "./codex-images.ts";
import { claudeTranscriptFile, forgetClaudeSessions } from "./claude-store.ts";
import { forgetGjcState, gjcTranscriptForPane, storeRelative } from "./gjc-runtime.ts";
import { isOmoProcess, omoSessionForPane } from "./omo.ts";
import { piTranscriptPath } from "./pi.ts";
import { piAbandonedTurns, piBranchSegments } from "./pi-tree.ts";
import { trimOutput } from "./tool-output.ts";
import { parseConversationMetadata } from "./conversation-metadata.ts";

import { invokedSkill } from "./skill-activity.ts";
import { isContextClear, MAX_TURNS, parseOmpTranscript, piImageBlock, piMessage, piResults, toolSummary } from "./transcript-records.ts";

export { isOmoProcess } from "./omo.ts";

/**
 * A transcript is read a page at a time, the newest page re-read on every append
 * while an agent works: Codex rollouts reach hundreds of MB (a 400MB one took 1.1s
 * and 1.7GB of memory to parse whole). 16MB still holds dozens of turns of a
 * tool-heavy session; the chat asks for the pages before it as the reader scrolls up.
 */
export const TRANSCRIPT_WINDOW_BYTES = 16 * 1024 * 1024;

/** A page never holds more prompts than this (each opens a user + assistant pair). */
const MAX_PAGE_PROMPTS = MAX_TURNS / 2;

/** A single turn longer than a window still gets a page of its own, up to this. */
const MAX_PAGE_BYTES = 4 * TRANSCRIPT_WINDOW_BYTES;

/** Settings recorded once at the start (an omp thinking level) sit before a tail window. */
const METADATA_HEAD_BYTES = 64 * 1024;

/** Session ids are uuids; refusing anything else keeps the path traversal-free. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Slash-command and bookkeeping entries Claude logs as user turns — not conversations. */
function isCommandEntry(text: string): boolean {
  return text.startsWith("<command-") || text.startsWith("<local-command") || text.startsWith("<task-");
}

/**
 * Claude Code wraps a long paste in `<pasted_content id="…">` tags so the model can
 * tell it from typed text; its own TUI shows only the text, and so does the chat.
 */
export function unwrapPastes(text: string): string {
  let changed = false;
  const visible = text.replace(/<pasted_content id="([^"\r\n]+)">\r?\n([\s\S]*?)\r?\n<\/pasted_content id="([^"\r\n]+)">/g,
    (whole: string, opening: string, body: string, closing: string) => {
      if (opening !== closing || opening.length > 64 || !/^[\w-]+$/.test(opening)) return whole;
      changed = true;
      return body;
    });
  return changed ? visible.replace(/^\n+|\n+$/g, "") : text;
}

/** A parsed JSONL line's message shape (only the fields we read). */
interface TranscriptEntry {
  type?: string;
  timestamp?: string;
  uuid?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  message?: { role?: string; content?: unknown };
  attachment?: { type?: unknown; prompt?: unknown; commandMode?: unknown; origin?: { kind?: unknown } };
}

function claudeResultText(output: unknown): string {
  return typeof output === "string" ? output
    : Array.isArray(output) ? output.map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text: unknown }).text) : "")).join("")
      : "";
}

/** The image types a chat shows; anything else stays out of the page. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * Splits one transcript file's contents into turns. Adjacent assistant entries
 * merge into a single turn (text parts + tool parts); each tool_use is followed
 * by a user tool_result entry, which is folded into the tool part it answers.
 */
export function parseClaudeTranscript(text: string, maxTurns = MAX_TURNS): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  /** tool parts still waiting for their result, by tool_use id */
  const pending = new Map<string, Extract<ConversationPart, { kind: "tool" }>>();

  const assistantTurn = (ts?: string): ConversationTurn => {
    const last = turns[turns.length - 1];
    if (last !== undefined && last.role === "assistant") return last;
    const turn: ConversationTurn = { role: "assistant", ts: ts ?? null, parts: [] };
    turns.push(turn);
    return turn;
  };

  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue; // a torn tail line while Claude is mid-append
    }
    if (entry === null || typeof entry !== "object" || entry.isMeta) continue;
    if (isContextClear(entry, "claude-transcript")) { turns.length = 0; pending.clear(); continue; }
    const content = entry.message?.content;
    // a compaction's summary marks where the conversation was folded, readable on request
    if (entry.isCompactSummary) {
      const summary = typeof content === "string" ? content
        : Array.isArray(content) ? content.map((block) => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" ? String((block as { text?: unknown }).text ?? "") : "").join("\n") : "";
      turns.push({ role: "user", ts: entry.timestamp ?? null, parts: [{ kind: "compact", text: summary }] });
      continue;
    }

    // A message sent while Claude is working is no `user` entry: it is queued, then recorded
    // as this attachment when the turn takes it in. Background task notices and other agents'
    // messages use the same record, so only a person's prompt counts. The `queue-operation`
    // lines around it repeat the text and are skipped.
    const queued = entry.type === "attachment" ? entry.attachment : undefined;
    if (queued?.type === "queued_command" && queued.commandMode === "prompt" && queued.origin?.kind === "human") {
      if (typeof queued.prompt === "string" && queued.prompt.trim() && !isCommandEntry(queued.prompt.trim())) {
        turns.push({ role: "user", ts: entry.timestamp ?? null, parts: [{ kind: "text", text: unwrapPastes(queued.prompt) }] });
      }
      continue;
    }

    if (entry.type === "user" && typeof content === "string") {
      if (isCommandEntry(content)) continue;
      turns.push({ role: "user", ts: entry.timestamp ?? null, parts: [{ kind: "text", text: unwrapPastes(content) }] });
      continue;
    }

    if (entry.type === "user" && Array.isArray(content)) {
      const prompt = content.flatMap((block: unknown) => {
        if (block === null || typeof block !== "object") return [];
        const part = block as { type?: string; text?: unknown };
        return part.type === "text" && typeof part.text === "string" && !isCommandEntry(part.text.trim()) ? [part.text] : [];
      }).join("\n");
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const result = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: unknown };
        if (result.type !== "tool_result" || typeof result.tool_use_id !== "string") continue;
        const tool = pending.get(result.tool_use_id);
        if (tool === undefined) continue;
        pending.delete(result.tool_use_id);
        trimOutput(tool, claudeResultText(result.content), result.tool_use_id);
        if (result.is_error === true) tool.error = true;
        if (tool.skill) tool.skill.status = result.is_error === true ? "failed" : "loaded";
      }
      // an image pasted into the prompt: named here, fetched only when shown
      const images: ConversationPart[] = typeof entry.uuid !== "string" ? [] : content.flatMap((block: unknown, index: number) => {
        const image = block as { type?: unknown; source?: { type?: unknown; media_type?: unknown } } | null;
        if (image?.type !== "image" || image.source?.type !== "base64" || typeof image.source.media_type !== "string" || !IMAGE_TYPES.has(image.source.media_type)) return [];
        return [{ kind: "image" as const, media_type: image.source.media_type, ref: `${entry.uuid}:${index}` }];
      });
      if (prompt.trim() || images.length > 0) turns.push({ role: "user", ts: entry.timestamp ?? null, parts: [...images, ...(prompt.trim() ? [{ kind: "text" as const, text: unwrapPastes(prompt) }] : [])] });
      continue;
    }

    if (entry.type === "assistant" && Array.isArray(content)) {
      const turn = assistantTurn(entry.timestamp);
      if (entry.timestamp) turn.end_ts = entry.timestamp;
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as { type?: string; text?: unknown; thinking?: unknown; name?: unknown; input?: unknown };
        if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
          turn.parts.push({ kind: "text", text: b.text });
        } else if (b.type === "thinking") {
          const thinking = typeof b.thinking === "string" ? b.thinking : typeof b.text === "string" ? b.text : "";
          if (thinking.length > 0) turn.parts.push({ kind: "thinking", text: thinking });
        } else if (b.type === "tool_use" && typeof b.name === "string") {
          const input = (typeof b.input === "object" && b.input !== null ? b.input : {}) as Record<string, unknown>;
          const part: Extract<ConversationPart, { kind: "tool" }> = {
            kind: "tool",
            name: b.name,
            summary: toolSummary(b.name, input),
            input: JSON.stringify(input, null, 2),
            output: "",
          };
          const skill = invokedSkill(b.name, input);
          if (skill) { part.skill = skill; part.summary = skill.name; }
          turn.parts.push(part);
          pending.set(String((block as { id?: unknown }).id ?? ""), part);
        }
        // unsupported transcript blocks are intentionally ignored
      }
    }
  }

  return turns.filter((turn) => turn.parts.length > 0).slice(-maxTurns);
}

/** Re-parse on file changes, including replacement and same-size rewrites. */
const cache = new Map<string, { signature: string; turns: ConversationTurn[]; metadata: ConversationMetadata; cursor: string | null; abandoned?: { count: number; branches: number; summary: string | null } }>();

export class ConversationUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ConversationUnavailable";
  }
}

/** The pane's agent holds a session it has not written yet: a conversation with no turns, not a missing one. */
export class ConversationNotStarted extends ConversationUnavailable {
  constructor(readonly sessionId: string) {
    super("session_not_written");
    this.name = "ConversationNotStarted";
  }
}

/** A cursor from another transcript: the pane started a new session, or a Codex backtrack replaced the file. */
export class HistoryChanged extends Error {
  constructor() {
    super("the conversation's transcript changed; reload it from its newest turns");
    this.name = "HistoryChanged";
  }
}

/** What paneConversation resolved: which store the turns came from, and where they start. */
export type RecognizedConversation = {
  source: "claude-transcript" | "omp-transcript" | "omo-transcript" | "gjc-transcript" | "pi-transcript" | "codex-transcript";
  turns: ConversationTurn[];
  metadata: ConversationMetadata;
  /** the first turn's position, for the page before it; null at the conversation's beginning */
  cursor: string | null;
  /**
   * Turns the file holds on paths a `/tree` walked away from, which no page of this conversation
   * can reach; absent for every agent that keeps no entry tree. pi moves its leaf without writing
   * anything, so the chat would otherwise drop those turns with no sign they were ever there.
   */
  abandoned?: { count: number; branches: number; summary: string | null };
  history_id: string;
  /** changes whenever the answer could: the route's ETag, so an unchanged poll costs no body */
  version: string;
};

/** A restart may parse the same files differently: its answers never match an earlier ETag. */
const PROCESS_VERSION = randomUUID();

function answerVersion(key: string, signature: string): string {
  return createHash("sha256").update(`${PROCESS_VERSION}\0${key}\0${signature}`).digest("base64url").slice(0, 22);
}

/**
 * Which turns: without `before`, the newest page (with `from`, from that held start
 * while it is still inside the newest page); with `before`, the page ending there,
 * never reaching back past `since`.
 */
export type ConversationPage = { before?: string; since?: string; from?: string };

/**
 * A transcript as one byte stream: for a paginated Codex rollout the history it
 * continues comes first (codexHistorySegments). Transcripts only grow at the end,
 * so a position in it keeps naming the same turn for as long as the file does.
 */
interface TranscriptStream {
  /** the live file's identity: cursors from any other file are refused */
  id: string;
  /** `offset` is where the segment starts in its file: equal to `start` for a whole prefix */
  files: { path: string; start: number; length: number; offset: number }[];
  length: number;
  floor: number;
}

// In-place rewrites keep the inode. Change the cursor generation when observed,
// invalidating settled turns and incremental parsers as well as the response cache.
const transcriptRevisions = new Map<string, { identity: string; size: number; changed: string; generation: string }>();
function transcriptGeneration(path: string, stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): string {
  const identity = `${stat.dev}:${stat.ino}`;
  const changed = `${stat.mtimeMs}:${stat.ctimeMs}`;
  const previous = transcriptRevisions.get(path);
  const rewritten = previous && previous.identity === identity && (stat.size < previous.size || (stat.size === previous.size && changed !== previous.changed));
  const generation = rewritten ? randomUUID() : previous?.identity === identity ? previous.generation : "";
  remember(transcriptRevisions, path, { identity, size: stat.size, changed, generation }, 64);
  return generation ? `-${generation}` : "";
}

function transcriptStream(source: RecognizedConversation["source"], path: string, stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }, codexHome: string): TranscriptStream {
  // (a chain whose parent was archived since comes back shorter: codexHistorySegments;
  // a pi branch skips the side paths a /tree left behind: piBranchSegments)
  const branch = source === "pi-transcript" ? piBranchSegments(path, stat.size) : null;
  if (source === "pi-transcript" && branch === null) throw new ConversationUnavailable("branch_unreadable");
  const segments: { path: string; start: number; end: number }[] = source === "codex-transcript"
    ? codexHistorySegments(path, codexHome).map((segment) => ({ path: segment.path, start: 0, end: segment.end }))
    : branch !== null ? branch.map((segment) => ({ path, start: segment.start, end: segment.end }))
    : [{ path, start: 0, end: stat.size }];
  const files: TranscriptStream["files"] = [];
  let stream = 0;
  for (const segment of segments) {
    // the live file is read to the size it had when it was identified
    const end = segment.path === path ? Math.min(segment.end, stat.size) : segment.end;
    const length = end - segment.start;
    if (length <= 0) continue;
    files.push({ path: segment.path, start: stream, length, offset: segment.start });
    stream += length;
  }
  // Positions count from the start of the whole chain: a cursor names the live file AND
  // the rollouts before it, so one read against another chain (an earlier rollout found
  // later, a parent since archived) answers 409 instead of pointing at other turns.
  // A pi branch is laid out from one file, so its layout stands in for that chain: /tree
  // moves the conversation to other bytes while the file, its inode and its size all stay
  // put. Every range counts by where it starts, and by where it ends too except the last:
  // the last one grows with every append, and history_id must stay stable across appends.
  // Two /tree moves away from the same entry share their head ranges and differ only
  // where their tails begin, so the last range's start is what tells them apart.
  let chain = "";
  if (branch !== null) {
    const layout = files.map((file, at) => (at === files.length - 1 ? `${file.offset}` : `${file.offset}\0${file.length}`)).join("\n");
    chain = `-${createHash("sha256").update(layout).digest("base64url").slice(0, 10)}`;
  } else if (source === "codex-transcript") {
    const earlier = files.slice(0, -1).map((file) => {
      const identity = statSync(file.path, { throwIfNoEntry: false });
      return `${file.path}\0${file.length}\0${identity ? `${identity.dev}:${identity.ino}` : "-"}`;
    });
    chain = earlier.length === 0 ? "" : `-${createHash("sha256").update(earlier.join("\n")).digest("base64url").slice(0, 10)}`;
  }
  return { id: `${stat.dev.toString(36)}-${stat.ino.toString(36)}${chain}${transcriptGeneration(path, stat)}`, files, length: stream, floor: 0 };
}

function readStream(stream: TranscriptStream, from: number, to: number): Buffer {
  const chunks: Buffer[] = [];
  for (const file of stream.files) {
    const low = Math.max(from, file.start);
    const high = Math.min(to, file.start + file.length);
    if (low >= high) continue;
    const fd = openSync(file.path, "r");
    try {
      const buffer = Buffer.alloc(high - low);
      chunks.push(buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, file.offset + (low - file.start))));
    } finally {
      closeSync(fd);
    }
  }
  return Buffer.concat(chunks);
}

/** Reset markers are small native control records. Scan each appended byte once,
 * in bounded chunks; retain offsets, never a session-sized string.
 * The same pass keeps an omp-family transcript's latest model and thinking-level
 * records (small lines): a change between the metadata head and the newest page
 * is otherwise never read, and the chat showed the level the session started at. */
const SETTING_TYPES = ['"model_change"', '"thinking_level_change"'];
const clearScans = new Map<string, { id: string; scanned: number; floor: number; tail: string; settings: Partial<Record<"model_change" | "thinking_level_change", { offset: number; end: number; line: string }>> }>();
function applyHistoryBoundary(path: string, stream: TranscriptStream, source: RecognizedConversation["source"]): void {
  if (source === "codex-transcript") return;
  let scan = clearScans.get(path);
  if (!scan || scan.id !== stream.id || scan.scanned > stream.length || bytesBefore(stream, scan.scanned) !== scan.tail) {
    scan = { id: stream.id, scanned: 0, floor: 0, tail: "", settings: {} };
  }
  let position = scan.scanned;
  let carry = Buffer.alloc(0);
  let skipping = false;
  const isClear = (line: Buffer): boolean => {
    if (!line.includes(source === "claude-transcript" ? "/clear" : "context_clear")) return false;
    try { return isContextClear(JSON.parse(line.toString("utf8")), source); } catch { return false; }
  };
  while (position < stream.length) {
    const end = Math.min(stream.length, position + TRANSCRIPT_WINDOW_BYTES);
    const bytes = Buffer.concat([carry, readStream(stream, position, end)]);
    const base = position - carry.length;
    let offset = 0;
    for (let newline = bytes.indexOf(0x0a); newline !== -1; newline = bytes.indexOf(0x0a, offset)) {
      const line = bytes.subarray(offset, newline);
      if (!skipping && isClear(line)) scan.floor = base + offset;
      else if (!skipping && source !== "claude-transcript" && SETTING_TYPES.some((type) => line.includes(type))) {
        try {
          const type: unknown = JSON.parse(line.toString("utf8"))?.type;
          if (type === "model_change" || type === "thinking_level_change") scan.settings[type] = { offset: base + offset, end: base + newline, line: line.toString("utf8") };
        } catch { /* not a record */ }
      }
      skipping = false;
      offset = newline + 1;
      scan.scanned = base + offset;
    }
    carry = bytes.subarray(offset);
    // An oversized data record cannot be a native clear control envelope.
    if (carry.length > METADATA_HEAD_BYTES) { carry = Buffer.alloc(0); skipping = true; }
    position = end;
  }
  scan.tail = bytesBefore(stream, scan.scanned);
  remember(clearScans, path, scan, 32);
  // A valid final JSON object is visible before its newline; rescan it on append.
  stream.floor = !skipping && carry.length > 0 && isClear(carry) ? stream.length - carry.length : scan.floor;
  if (stream.floor > 0) stream.id += `-clear-${stream.floor.toString(36)}`;
}

/** Bytes that every line opening a turn contains: a cheap filter before JSON.parse. */
const TURN_MARK: Record<RecognizedConversation["source"], Buffer> = {
  "codex-transcript": Buffer.from('"task_started"'),
  "claude-transcript": Buffer.from('"user"'),
  "omp-transcript": Buffer.from('"user"'),
  "omo-transcript": Buffer.from('"user"'),
  "gjc-transcript": Buffer.from('"user"'),
  "pi-transcript": Buffer.from('"user"'),
};

/**
 * Does this line open a turn? Pages start at such lines, so a page never splits
 * a turn: a Codex task (its prompt, duplicate records and tool calls all follow
 * task_started), a Claude or omp prompt (tool results answer the turn before it),
 * and the same for pi, whose prompts are `message` records with a user role.
 */
function opensTurn(source: RecognizedConversation["source"], line: string): boolean {
  let entry: { type?: unknown; isMeta?: unknown; isCompactSummary?: unknown; payload?: { type?: unknown }; message?: { role?: unknown; content?: unknown } };
  try { entry = JSON.parse(line); } catch { return false; }
  if (entry === null || typeof entry !== "object") return false;
  if (source === "codex-transcript") return entry.type === "event_msg" && entry.payload?.type === "task_started";
  if (source !== "claude-transcript") {
    const message = piMessage(entry);
    return message?.role === "user" && (message.content as Record<string, unknown>[]).some((part) => part.type === "text" && typeof part.text === "string" && part.text.length > 0);
  }
  if (entry.type !== "user" || entry.isMeta || entry.isCompactSummary) return false;
  const content = entry.message?.content;
  if (typeof content === "string") return !isCommandEntry(content);
  return Array.isArray(content) && content.some((block: { type?: unknown; text?: unknown } | null) =>
    block?.type === "text" && typeof block.text === "string" && !isCommandEntry(block.text.trim()));
}

function turnStarts(bytes: Buffer, source: RecognizedConversation["source"]): number[] {
  const starts: number[] = [];
  for (let offset = 0; offset < bytes.length;) {
    const newline = bytes.indexOf(0x0a, offset);
    const end = newline === -1 ? bytes.length : newline;
    const line = bytes.subarray(offset, end);
    if (line.includes(TURN_MARK[source]) && opensTurn(source, line.toString("utf8"))) starts.push(offset);
    offset = end + 1;
  }
  return starts;
}

/**
 * The page of turns ending at `to`: at most MAX_PAGE_PROMPTS prompts, starting on a
 * line that opens a turn, at `floor` (a held start) or at the very beginning. An
 * older page is read once, so for a turn longer than a window it reaches further
 * back, a new chunk at a time, up to MAX_PAGE_BYTES. The newest page is read on
 * every append, so it never does: with no turn start in its window it starts
 * mid-turn, at a whole line.
 */
function pageBefore(stream: TranscriptStream, source: RecognizedConversation["source"], to: number, { floor = stream.floor, widen }: { floor?: number; widen: boolean }): { start: number; bytes: Buffer } {
  let from = Math.max(floor, to - TRANSCRIPT_WINDOW_BYTES);
  let bytes = readStream(stream, from, to);
  for (;;) {
    const starts = turnStarts(bytes, source);
    const keep = starts.length > MAX_PAGE_PROMPTS ? starts[starts.length - MAX_PAGE_PROMPTS] : from === floor ? 0 : starts[0];
    if (keep !== undefined) return { start: from + keep, bytes: bytes.subarray(keep) };
    if (!widen || to - from >= MAX_PAGE_BYTES) {
      const firstLine = bytes.indexOf(0x0a) + 1;
      return { start: from + firstLine, bytes: bytes.subarray(firstLine) };
    }
    const next = Math.max(floor, from - TRANSCRIPT_WINDOW_BYTES);
    bytes = Buffer.concat([readStream(stream, next, from), bytes]);
    from = next;
  }
}

/**
 * The newest page is asked for on every poll while an agent works, and between polls its
 * file only grows. Rescanning its whole window (16 MB on a long session) and reparsing
 * the page each time held the event loop 50-110 ms every 2 s, so per live file:
 * - the turn starts found so far are kept, and only the bytes appended since are scanned;
 * - the turns before the page's last turn start are kept (a later append cannot change a
 *   turn that another has followed), and only the last turn is parsed again.
 */
interface LiveScan {
  id: string;
  source: RecognizedConversation["source"];
  /** complete lines up to here are scanned */
  scanned: number;
  /** turn starts in the scanned bytes, ascending, none before the window */
  starts: number[];
  /** the bytes just before `scanned`: a file rewritten rather than appended to no longer has them */
  tail: string;
}
const liveScans = new Map<string, LiveScan>();

interface SettledTurns {
  id: string;
  /** the page start these turns begin at, and the turn start they end at */
  start: number;
  end: number;
  turns: ConversationTurn[];
  metadata: ConversationMetadata;
  /** the bytes just before `end` (see LiveScan.tail) */
  tail: string;
}
const settledTurns = new Map<string, SettledTurns>();

function bytesBefore(stream: TranscriptStream, offset: number): string {
  return readStream(stream, Math.max(0, offset - 64), offset).toString("latin1");
}

function remember<T>(map: Map<string, T>, key: string, value: T, limit: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value!);
}

/** The newest page's start and every turn start in it (pageBefore without widening), or null when it starts mid-turn. */
function newestPage(path: string, stream: TranscriptStream, source: RecognizedConversation["source"]): { start: number; starts: number[] } | null {
  const from = Math.max(stream.floor, stream.length - TRANSCRIPT_WINDOW_BYTES);
  let scan = liveScans.get(path);
  // a window that slid past the scanned bytes starts over at its edge (a line may be cut
  // there, as in pageBefore, and never counts as a start)
  if (!scan || scan.id !== stream.id || scan.source !== source || scan.scanned > stream.length || scan.scanned < from
    || bytesBefore(stream, scan.scanned) !== scan.tail) {
    scan = { id: stream.id, source, scanned: from, starts: [], tail: bytesBefore(stream, from) };
  }
  let pending: number[] = [];
  if (scan.scanned < stream.length) {
    const bytes = readStream(stream, scan.scanned, stream.length);
    const complete = bytes.lastIndexOf(0x0a) + 1;
    for (const offset of turnStarts(bytes.subarray(0, complete), source)) scan.starts.push(scan.scanned + offset);
    // a last line still without its newline counts now, and is scanned again once complete
    pending = turnStarts(bytes.subarray(complete), source).map((offset) => scan!.scanned + complete + offset);
    scan.scanned += complete;
    scan.tail = bytesBefore(stream, scan.scanned);
  }
  const stale = scan.starts.findIndex((offset) => offset >= from);
  if (stale !== 0) scan.starts.splice(0, stale === -1 ? scan.starts.length : stale);
  remember(liveScans, path, scan, 32);
  const starts = pending.length > 0 ? [...scan.starts, ...pending] : scan.starts;
  const start = starts.length > MAX_PAGE_PROMPTS ? starts[starts.length - MAX_PAGE_PROMPTS] : from === stream.floor ? stream.floor : starts[0];
  return start === undefined ? null : { start, starts };
}

function parseTurns(source: RecognizedConversation["source"], text: string): ConversationTurn[] {
  return source === "codex-transcript" ? parseCodexTranscript(text, Infinity)
    // only pi keeps a tool's images in the entry as base64; omp, omo and gjc are read the same
    // way but would carry image refs nothing can answer, so the option stays with pi alone
    : source === "claude-transcript" ? parseClaudeTranscript(text, Infinity)
      : parseOmpTranscript(text, Infinity, { toolImages: source === "pi-transcript" });
}

interface LiveCodexTurn {
  id: string;
  start: number;
  scanned: number;
  boundary: string;
  parser: ReturnType<typeof createCodexTranscriptParser>;
  metadata: ConversationMetadata;
}
const codexTurns = new Map<string, LiveCodexTurn>();

/** Incremental within a long Codex task, including results for tools from earlier polls. */
function codexLiveTurn(path: string, stream: TranscriptStream, start: number, before: ConversationMetadata): { turns: ConversationTurn[]; metadata: ConversationMetadata } {
  let cached = codexTurns.get(path);
  if (!cached || cached.id !== stream.id || cached.start !== start || cached.scanned > stream.length
    || bytesBefore(stream, cached.scanned) !== cached.boundary) {
    cached = { id: stream.id, start, scanned: start, boundary: bytesBefore(stream, start), parser: createCodexTranscriptParser(), metadata: before };
  }
  const bytes = readStream(stream, cached.scanned, stream.length);
  const complete = bytes.lastIndexOf(0x0a) + 1;
  if (complete > 0) {
    const text = bytes.subarray(0, complete).toString("utf8");
    cached.parser.write(text);
    cached.metadata = parseConversationMetadata(text, "codex-transcript", cached.metadata);
    cached.scanned += complete;
    cached.boundary = bytesBefore(stream, cached.scanned);
  }
  const tail = bytes.subarray(complete).toString("utf8");
  // Both record count and retained source bytes are bounded, independent of session length.
  remember(codexTurns, path, cached, 8);
  let retained = [...codexTurns.values()].reduce((sum, turn) => sum + turn.scanned - turn.start, 0);
  for (const [key, turn] of codexTurns) {
    if (retained <= 2 * TRANSCRIPT_WINDOW_BYTES) break;
    codexTurns.delete(key);
    retained -= turn.scanned - turn.start;
  }
  return { turns: cached.parser.snapshot(tail), metadata: parseConversationMetadata(tail, "codex-transcript", cached.metadata) };
}

/** Codex settings belong to the live rollout; native clears bound other stores. A model or
 * thinking-level change after the head and before the page follows the head, in order. */
function metadataHead(path: string, stream: TranscriptStream, source: RecognizedConversation["source"], start: number): string {
  if (source === "codex-transcript") return readRange(path, 0, METADATA_HEAD_BYTES);
  const end = Math.min(start, stream.floor + METADATA_HEAD_BYTES);
  const later = Object.values(clearScans.get(path)?.settings ?? {})
    // a record the head cuts in two is read whole here
    .filter((setting) => setting.end > end && setting.offset < start)
    .sort((a, b) => a.offset - b.offset)
    .map((setting) => setting.line);
  return [readStream(stream, stream.floor, end).toString("utf8"), ...later].join("\n");
}

/**
 * The newest page's turns from `start`: the settled ones (before the last turn start)
 * from memory, extended by any turn that has since been followed, plus the live last turn.
 */
function liveTurns(path: string, stream: TranscriptStream, source: RecognizedConversation["source"], start: number, starts: number[]): { turns: ConversationTurn[]; metadata: ConversationMetadata } {
  // starts ascend: the last one, when it lies past the page start
  const last = Math.max(start, starts[starts.length - 1] ?? start);
  const key = `${path}\0${start}`;
  let settled = settledTurns.get(key);
  if (!settled || settled.id !== stream.id || settled.end > last || bytesBefore(stream, settled.end) !== settled.tail) {
    const head = start > stream.floor ? metadataHead(path, stream, source, start) : "";
    settled = { id: stream.id, start, end: start, turns: [], metadata: parseConversationMetadata(`${head}\n`, source), tail: bytesBefore(stream, start) };
  }
  if (settled.end < last) {
    const text = readStream(stream, settled.end, last).toString("utf8");
    settled = { ...settled, end: last, turns: [...settled.turns, ...parseTurns(source, text)], metadata: parseConversationMetadata(text, source, settled.metadata), tail: bytesBefore(stream, last) };
  }
  remember(settledTurns, key, settled, 8);
  if (source === "codex-transcript") {
    const live = codexLiveTurn(path, stream, last, settled.metadata);
    return { turns: [...settled.turns, ...live.turns], metadata: live.metadata };
  }
  const text = readStream(stream, last, stream.length).toString("utf8");
  return { turns: [...settled.turns, ...parseTurns(source, text)], metadata: parseConversationMetadata(text, source, settled.metadata) };
}

/** Forget every scan and parse kept between polls (tests compare against a cold read). */
export function forgetTranscriptState(): void {
  cache.clear();
  forgetClaudeSessions();
  forgetGjcState();
  liveScans.clear();
  settledTurns.clear();
  codexTurns.clear();
  transcriptRevisions.clear();
  clearScans.clear();
}

function formatCursor(stream: TranscriptStream, offset: number): string | null {
  return offset > stream.floor ? `${stream.id}:${offset}` : null;
}

function parseCursor(stream: TranscriptStream, cursor: string): number {
  const separator = cursor.lastIndexOf(":");
  const offset = Number(cursor.slice(separator + 1));
  if (separator <= 0 || cursor.slice(0, separator) !== stream.id || !Number.isSafeInteger(offset) || offset < stream.floor || offset > stream.length) {
    throw new HistoryChanged();
  }
  return offset;
}

/** gjc's resolver answers null; the chat lens reports why it fell back to scrollback. */
export async function gjcTranscriptPath(paneId: string, cwd: string, home?: string): Promise<string> {
  const path = await gjcTranscriptForPane(paneId, cwd, home);
  if (!path) throw new ConversationUnavailable("no_session_path");
  return path;
}

/**
 * Is omo the agent in this pane, whatever herdr currently labels it? A probe
 * failure answers "no": the caller then reports why the labelled store failed,
 * which is the more useful error.
 */
export async function paneRunsOmo(paneId: string): Promise<boolean> {
  // pane.process_info wants `pane_id`; given `target` herdr answers for the
  // FOCUSED pane instead of erroring (live-verified 2026-09-21).
  const info = await herdrRpc<{ process_info?: { foreground_processes?: { argv?: unknown }[] } }>(
    "pane.process_info",
    { pane_id: paneId },
  ).catch(() => null);
  return (info?.process_info?.foreground_processes ?? []).some((process) =>
    isOmoProcess(Array.isArray(process.argv) ? process.argv.map(String) : []),
  );
}

/**
 * herdr labels an omo pane `pi` while it waits and `claude` while omo's claude-sdk child
 * runs, so the sidebar showed another agent's mark, and one that changed as omo worked.
 * The snapshots the browser gets name such a pane `omo`, decided by its process tree
 * (paneRunsOmo), including panes herdr has not recognized as an agent.
 */
export async function labelOmoPanes(snapshot: SessionSnapshot): Promise<SessionSnapshot> {
  const candidates = snapshot.panes.filter((pane) => !pane.agent || pane.agent === "pi" || pane.agent === "claude");
  const omo = new Set<string>();
  await Promise.all(candidates.map(async (pane) => { if (await paneRunsOmo(pane.pane_id)) omo.add(pane.pane_id); }));
  if (omo.size === 0) return snapshot;
  return {
    ...snapshot,
    panes: snapshot.panes.map((pane) => omo.has(pane.pane_id) ? { ...pane, agent: "omo" } : pane),
    agents: snapshot.agents.map((agent) => omo.has(agent.pane_id) ? { ...agent, agent: "omo" } : agent),
  };
}

/** Claude's transcript for a pane: herdr names the session id, claude-store.ts finds its project. */
async function claudeTranscriptPath(paneId: string, cwds: readonly (string | null | undefined)[]): Promise<string> {
  const info = await herdrRpc<{ agent: { agent_session?: { value?: unknown } } }>("agent.get", { target: paneId });
  const session = info.agent.agent_session?.value;
  if (typeof session !== "string" || !SESSION_ID.test(session)) throw new ConversationUnavailable("no_session_id");
  const path = await claudeTranscriptFile(process.env["HOME"] ?? "", session, cwds);
  if (!path) throw new ConversationUnavailable("transcript_missing");
  return path;
}

/**
 * The path herdr reports for an omp session, or null unless it is a transcript inside the
 * user's own store. A Windows PC reports it in its own form (drive letter, backslashes).
 */
export function ompSessionPath(value: unknown, home: string, paths: PlatformPath = nodePath): string | null {
  if (typeof value !== "string" || !value.endsWith(".jsonl") || !paths.isAbsolute(value) || !paths.isAbsolute(home)) return null;
  return storeRelative(paths.join(home, ".omp", "agent", "sessions"), value, paths) ? value : null;
}

/** omp's transcript: herdr hands over the absolute path, accepted only inside the user's own store. */
async function ompTranscriptPath(paneId: string): Promise<string> {
  const info = await herdrRpc<{ agent: { agent_session?: { kind?: unknown; value?: unknown } } }>("agent.get", { target: paneId });
  const session = info.agent.agent_session;
  // a Windows bridge starts with HOME set to the profile directory (remote-entry.ts)
  const path = ompSessionPath(session?.kind === "path" ? session.value : undefined, process.env["HOME"] ?? "");
  if (!path) throw new ConversationUnavailable("no_session_path");
  return path;
}

/**
 * The store a pane's transcript lives in. herdr's agent label follows the
 * pane's foreground processes, so an omo pane reads as `pi` while it waits and
 * as `claude` while its claude-sdk child runs (live-verified 2026-09-21) — the
 * label alone cannot route omo. Its process tree takes precedence over the child
 * label: omo's own store is read only when omo is really running
 * in that pane, never on a matching cwd alone.
 */
async function resolveTranscript(pane: HerdrPane, cwd: string, codexHome?: string, panes?: HerdrPane[]): Promise<{ source: RecognizedConversation["source"]; path: string }> {
  const paneId = pane.pane_id;
  const agent = pane.agent ?? pane.agent_session?.agent ?? "";
  if ((agent === "omo" || agent === "pi" || agent === "claude") && await paneRunsOmo(paneId)) {
    return { source: "omo-transcript", path: await omoTranscriptPath(paneId, cwd, panes) };
  }
  try {
    if (agent === "codex") {
      const path = await codexTranscriptPath(paneId, cwd, codexHome, panes);
      if (!path) throw new ConversationUnavailable("no_session_path");
      return { source: "codex-transcript", path };
    }
    // Claude's project is the directory it started in, the process's own cwd more often than the pane's
    if (agent === "claude") return { source: "claude-transcript", path: await claudeTranscriptPath(paneId, [cwd, pane.foreground_cwd]) };
    if (agent === "omp") return { source: "omp-transcript", path: await ompTranscriptPath(paneId) };
    if (agent === "gjc") {
      // GJC can change its own cwd without changing the pane's shell directory.
      const sessionCwd = typeof pane.foreground_cwd === "string" && pane.foreground_cwd.length > 0 ? pane.foreground_cwd : cwd;
      return { source: "gjc-transcript", path: await gjcTranscriptPath(paneId, sessionCwd) };
    }
    // pi's own label only routes pi: an omo pane was taken above, by its process tree.
    if (agent === "pi") {
      const path = await piTranscriptPath(paneId);
      if (!path) throw new ConversationUnavailable("no_session_path");
      return { source: "pi-transcript", path };
    }
    throw new ConversationUnavailable("no_recognized_transcript");
  } catch (error) {
    if (!(error instanceof ConversationUnavailable) || !(await paneRunsOmo(paneId))) throw error;
    return { source: "omo-transcript", path: await omoTranscriptPath(paneId, cwd, panes) };
  }
}

async function omoTranscriptPath(paneId: string, cwd: string, panes?: HerdrPane[]): Promise<string> {
  const session = await omoSessionForPane(paneId, cwd, panes ?? (await sessionSnapshot()).panes);
  if (session.pending !== null) throw new ConversationNotStarted(session.pending);
  if (!session.path) throw new ConversationUnavailable("no_session_path");
  return session.path;
}

/**
 * pane -> agent session -> transcript turns. Read-only, same-user files only.
 * Claude sessions are looked up by id under ~/.claude/projects; omp sessions
 * come as an absolute path from herdr, accepted only under the user's own
 * ~/.omp/agent/sessions dir; omo sessions are resolved from its own store by
 * process/session evidence (omoTranscriptForPane). Throws ConversationUnavailable when the pane has
 * no recognized agent store (the caller falls back to the scrollback
 * transcript view, like chatmux).
 *
 * Without `page` this is the newest page. `before` is the page ending at a
 * returned cursor; `from` is every turn after one, for a chat that already
 * shows the pages before it. A cursor from another file throws HistoryChanged.
 */
export async function paneConversation(paneId: string, codexHome?: string, page: ConversationPage = {}): Promise<RecognizedConversation> {
  const snapshot = await sessionSnapshot();
  const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId);
  if (pane === undefined) throw new ConversationUnavailable("pane_not_found");
  if (typeof pane.cwd !== "string" || pane.cwd.length === 0) throw new ConversationUnavailable("no_recognized_transcript");

  let resolved: { source: RecognizedConversation["source"]; path: string };
  try {
    resolved = await resolveTranscript(pane, pane.cwd, codexHome, snapshot.panes);
  } catch (error) {
    if (!(error instanceof ConversationNotStarted)) throw error;
    // nothing comes before a conversation not begun: a cursor for older pages is another one's
    if (page.before !== undefined || page.since !== undefined) throw new HistoryChanged();
    // the chat says there is nothing yet; the session's first prompt writes the file and
    // the next poll's history_id differs, so the chat takes it whole
    const id = `unwritten:${error.sessionId}`;
    return { source: "omo-transcript", turns: [], metadata: { model: null, reasoning_effort: null }, cursor: null, history_id: id, version: answerVersion(id, "") };
  }
  return transcriptPage(resolved.source, resolved.path, page, codexHome);
}

/** One page of a resolved transcript (paneConversation's `page`). */
export function transcriptPage(source: RecognizedConversation["source"], path: string, page: ConversationPage = {}, codexHome?: string): RecognizedConversation {
  let stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
  try {
    stat = statSync(path);
  } catch {
    throw new ConversationUnavailable("transcript_missing");
  }
  let stream: TranscriptStream;
  try {
    stream = transcriptStream(source, path, stat, codexHome ?? defaultCodexHome());
    applyHistoryBoundary(path, stream, source);
  } catch (error) {
    // a branch that cannot be walked says so; a file that went unreadable mid-read has
    // one answer, and an unreadable branch has its own
    if (error instanceof ConversationUnavailable) throw error;
    throw new ConversationUnavailable("transcript_missing");
  }
  // an older page never changes while its file and the rollouts before it stay the same
  // (the stream's id names both); the newest one changes with every append
  const key = page.before !== undefined ? `${path}\0before:${page.before}:${page.since ?? ""}` : `${path}\0from:${page.from ?? ""}`;
  const signature = page.before !== undefined ? stream.id : `${stream.id}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const cached = cache.get(key);
  // the answer is a function of the page asked for and the file's state, so they name it
  const version = answerVersion(key, signature);
  if (cached?.signature === signature) {
    return { source, turns: cached.turns, metadata: cached.metadata, cursor: cached.cursor, abandoned: cached.abandoned, history_id: stream.id, version };
  }

  let start: number;
  let text: string;
  let head = "";
  let cursor: string | null;
  let live: { turns: ConversationTurn[]; metadata: ConversationMetadata } | null = null;
  try {
    if (page.before !== undefined) {
      const before = parseCursor(stream, page.before);
      const floor = page.since === undefined ? stream.floor : parseCursor(stream, page.since);
      if (floor > before) throw new HistoryChanged();
      const older = before === floor ? { start: floor, bytes: Buffer.alloc(0) } : pageBefore(stream, source, before, { floor, widen: true });
      start = older.start;
      text = older.bytes.toString("utf8");
    } else {
      const held = page.from === undefined ? null : parseCursor(stream, page.from);
      const newest = newestPage(path, stream, source);
      // A chat that shows older pages holds the start of its newest turns and keeps
      // every turn after it while they are inside the newest page. Once the newest
      // page has moved past it, the chat gets the newest page and fetches the turns
      // in between with `before` + `since`: no poll reads more than a page.
      if (newest !== null) {
        start = held !== null && held >= newest.start ? held : newest.start;
        live = liveTurns(path, stream, source, start, newest.starts);
        text = "";
      } else {
        // no turn starts in the window: the page begins mid-turn, read whole as before
        const whole = pageBefore(stream, source, stream.length, { widen: false });
        start = held !== null && held >= whole.start ? held : whole.start;
        text = whole.bytes.subarray(start - whole.start).toString("utf8");
      }
    }
    if (live === null && page.before === undefined && start > stream.floor) head = metadataHead(path, stream, source, start);
    cursor = formatCursor(stream, start);
  } catch (error) {
    if (error instanceof HistoryChanged) throw error;
    throw new ConversationUnavailable("transcript_missing");
  }

  // the store decides the parser, not the pane's label: omo writes omp's
  // session shape while herdr may be calling that same pane `claude`. The page
  // bounds the turns, so none are cut: they must meet the next page exactly.
  const turns = live?.turns ?? parseTurns(source, text);
  const metadata = live?.metadata ?? parseConversationMetadata(`${head}\n${text}`, source);
  // Record the stat from BEFORE the read: an append during parsing must cause
  // another read on the next poll, not permanently cache a torn tail.
  cache.delete(key);
  // the abandoned turns live outside the branch's byte ranges, so the page cannot see them: a
  // straight line answers { count: 0 }, which is most sessions and costs the client nothing
  const abandoned = source === "pi-transcript" ? piAbandonedTurns(path, stat.size) ?? undefined : undefined;
  cache.set(key, { signature, turns, metadata, cursor, abandoned });
  if (cache.size > 32) cache.delete(cache.keys().next().value!);
  return { source, turns, metadata, cursor, abandoned, history_id: stream.id, version };
}

/**
 * One image a user pasted into a Claude prompt, by the ref its image part carries
 * (`<entry uuid>:<block index>`): the transcript holds it as base64, so it is decoded
 * here rather than sent with every poll of the conversation. Null when there is no such
 * image. Codex uses a hash of the native attachment and searches only the bound history.
 */
export async function conversationImage(paneId: string, ref: string, codexHome?: string): Promise<{ mediaType: string; bytes: Uint8Array<ArrayBuffer> } | null> {
  if (!IMAGE_REF.test(ref) && !CODEX_IMAGE_REF.test(ref) && !PI_IMAGE_REF.test(ref)) return null;
  const snapshot = await sessionSnapshot();
  const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId);
  if (pane === undefined || typeof pane.cwd !== "string" || pane.cwd.length === 0) return null;
  let resolved: { source: RecognizedConversation["source"]; path: string };
  try { resolved = await resolveTranscript(pane, pane.cwd, codexHome, snapshot.panes); }
  catch (error) { if (error instanceof ConversationUnavailable) return null; throw error; }
  if (resolved.source === "codex-transcript") return codexTranscriptImage(codexHistorySegments(resolved.path, codexHome), ref, pane.cwd);
  if (resolved.source === "pi-transcript") return piTranscriptImage(resolved.path, ref);
  return resolved.source === "claude-transcript" ? transcriptImage(resolved.path, ref) : null;
}

const IMAGE_REF = /^([0-9a-f-]{8,64}):(\d{1,3})$/i;

/** The image an image part's ref names in a Claude transcript file, decoded; null when there is none. */
export function transcriptImage(path: string, ref: string): { mediaType: string; bytes: Uint8Array<ArrayBuffer> } | null {
  const match = IMAGE_REF.exec(ref);
  if (match === null) return null;
  const [, uuid, index] = match;
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return null; }
  text = activeHistoryText(text, "claude-transcript");
  const needle = JSON.stringify(uuid);
  for (const line of text.split("\n")) {
    if (!line.includes(needle)) continue;
    let entry: TranscriptEntry;
    try { entry = JSON.parse(line) as TranscriptEntry; } catch { continue; }
    if (entry.uuid !== uuid || !Array.isArray(entry.message?.content)) continue;
    const block = entry.message.content[Number(index)] as { type?: unknown; source?: { type?: unknown; media_type?: unknown; data?: unknown } } | undefined;
    if (block?.type !== "image" || block.source?.type !== "base64" || typeof block.source.data !== "string") return null;
    const mediaType = String(block.source.media_type);
    if (!IMAGE_TYPES.has(mediaType)) return null;
    return { mediaType, bytes: new Uint8Array(Buffer.from(block.source.data, "base64")) };
  }
  return null;
}

const TOOL_REF = /^[A-Za-z0-9_:.-]{1,128}$/;
/** A whole output is still bounded: a page of it, not a log file. */
const TOOL_OUTPUT_MAX = 2_000_000;

/** The whole output of a tool call whose page output was cut, by its id; null when there is none. */
export async function toolOutput(paneId: string, ref: string, codexHome?: string): Promise<string | null> {
  if (!TOOL_REF.test(ref)) return null;
  const snapshot = await sessionSnapshot();
  const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId);
  if (pane === undefined || typeof pane.cwd !== "string" || pane.cwd.length === 0) return null;
  let resolved: { source: RecognizedConversation["source"]; path: string };
  try { resolved = await resolveTranscript(pane, pane.cwd, codexHome, snapshot.panes); }
  catch (error) { if (error instanceof ConversationUnavailable) return null; throw error; }
  return transcriptToolOutput(resolved.source, resolved.path, ref, codexHome);
}

/** The output a transcript file holds for one tool call id, whole (up to TOOL_OUTPUT_MAX). */
export function transcriptToolOutput(source: RecognizedConversation["source"], path: string, ref: string, codexHome?: string): string | null {
  if (!TOOL_REF.test(ref)) return null;
  if (source === "codex-transcript") {
    let segments: ReturnType<typeof codexHistorySegments>;
    try { segments = codexHistorySegments(path, codexHome); } catch { return null; }
    for (const segment of segments) {
      let text: string;
      // a rollout may have been archived since resolution: the others still hold theirs
      try { text = readRange(segment.path, 0, segment.end); } catch { continue; }
      const output = outputInText(source, text, ref);
      if (output !== null) return output;
    }
    return null;
  }
  if (source === "pi-transcript") return piToolOutput(path, ref);
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return null; }
  return outputInText(source, text, ref);
}

/**
 * One whole tool output by ref. A pi output lives on the active branch only: reading the
 * file whole would answer a ref from a branch a /tree abandoned, whose output the chat
 * never showed, so the branch is read the way the conversation is.
 */
function piToolOutput(path: string, ref: string): string | null {
  let size: number;
  let branch: ReturnType<typeof piBranchSegments>;
  try { size = statSync(path).size; branch = piBranchSegments(path, size); } catch { return null; }
  if (branch === null) return null;
  const fd = openSync(path, "r");
  try {
    for (const segment of branch) {
      const buffer = Buffer.alloc(segment.end - segment.start);
      if (readSync(fd, buffer, 0, buffer.length, segment.start) !== buffer.length) continue;
      const output = outputInText("pi-transcript", buffer.toString("utf8"), ref);
      if (output !== null) return output;
    }
  } finally { closeSync(fd); }
  return null;
}

/**
 * The image a pi tool call returned, by the ref the page gave it (`pi:<call id>:<nth image>`).
 * Like the output, it is read on the active branch only: an image from a branch a /tree
 * abandoned is one the chat never showed, so it is not offered.
 */
export function piTranscriptImage(path: string, ref: string): { mediaType: string; bytes: Uint8Array<ArrayBuffer> } | null {
  const match = PI_IMAGE_REF.exec(ref);
  if (match === null || match[1] === undefined || match[2] === undefined) return null;
  const [, callId, nth] = match;
  let size: number;
  let branch: ReturnType<typeof piBranchSegments>;
  try { size = statSync(path).size; branch = piBranchSegments(path, size); } catch { return null; }
  if (branch === null) return null;
  const fd = openSync(path, "r");
  try {
    for (const segment of branch) {
      const buffer = Buffer.alloc(segment.end - segment.start);
      if (readSync(fd, buffer, 0, buffer.length, segment.start) !== buffer.length) continue;
      for (const line of buffer.toString("utf8").split("\n")) {
        if (!line.includes(callId)) continue;
        let entry: unknown;
        try { entry = JSON.parse(line); } catch { continue; }
        const message = piMessage(entry);
        if (message === null) continue;
        const image = piImageBlock(message, callId, Number(nth));
        if (image !== null) return { mediaType: image.media_type, bytes: new Uint8Array(Buffer.from(image.data, "base64")) };
      }
    }
  } finally { closeSync(fd); }
  return null;
}

const PI_IMAGE_REF = /^pi:([A-Za-z0-9_:.\-]{1,128}):(\d{1,3})$/;

function outputInText(source: RecognizedConversation["source"], text: string, ref: string): string | null {
  text = activeHistoryText(text, source);
  const needle = JSON.stringify(ref);
  for (const line of text.split("\n")) {
    if (!line.includes(needle)) continue;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    let output: string | null = null;
    if (source === "claude-transcript") {
      const content = (entry.message as { content?: unknown } | undefined)?.content;
      const result = Array.isArray(content) ? content.find((block) => (block as { type?: unknown; tool_use_id?: unknown } | null)?.type === "tool_result" && (block as { tool_use_id?: unknown }).tool_use_id === ref) : undefined;
      if (result !== undefined) output = claudeResultText((result as { content?: unknown }).content);
    } else if (source === "codex-transcript") {
      const payload = entry.payload as { type?: unknown; call_id?: unknown; output?: unknown } | undefined;
      if ((payload?.type === "function_call_output" || payload?.type === "custom_tool_call_output") && payload.call_id === ref) output = codexOutputText(payload.output);
    } else {
      const message = piMessage(entry);
      if (message) output = piResults(message).find((result) => result.id === ref)?.text ?? null;
    }
    if (output !== null) return output.length > TOOL_OUTPUT_MAX ? `${output.slice(0, TOOL_OUTPUT_MAX)}\n… trimmed` : output;
  }
  return null;
}

/** Asset reads share the reset boundary even when their ref predates /clear. */
function activeHistoryText(text: string, source: RecognizedConversation["source"]): string {
  if (source === "codex-transcript") return text;
  let start = 0, offset = 0;
  for (const line of text.split("\n")) {
    if (line.includes("context_clear") || line.includes("/clear")) {
      try { if (isContextClear(JSON.parse(line), source)) start = offset + line.length + 1; } catch { /* torn line */ }
    }
    offset += line.length + 1;
  }
  return text.slice(start);
}
