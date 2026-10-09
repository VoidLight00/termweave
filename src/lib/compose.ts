/**
 * Composer -> pty byte shaping. The composer sends "one message", but the pane's
 * program defines what a safe submission is, so the payload follows the pane's own
 * bracketed-paste mode (term.modes.bracketedPasteMode):
 * - mode on (agent TUIs): the text goes out as ONE bracketed paste - newlines stay
 *   literal inside the message - and a bare CR submits it, exactly like paste+Enter.
 * - mode off (plain shell): classic paste semantics - every newline submits its own
 *   line, and the trailing CR runs the last one.
 * Pure logic, DOM-free, so the policy is unit-testable (see compose.test.ts).
 */

import type { AgentStatus, SlashCommand } from "../../shared/protocol.ts";
import { knownStatus, STATUS_WORD } from "./status.ts";
import { t } from "./i18n.ts";

/** This cap keeps one composer message inside a single WS frame. */
export const MAX_COMPOSER_CHARS = 20_000;

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

/** A composer message as written: trailing newlines are the composer's, not the text's; CRLF reads as one newline. */
export function composerMessage(text: string): string {
  return text.replace(/[\r\n]+$/, "").replace(/\r\n?/g, "\n");
}

/** The text a composer message types, without its submit (HerdrSocket.submit adds the Enter). */
export function composerPayload(text: string, bracketedPaste: boolean): string {
  const body = composerMessage(text).replace(/\n/g, "\r");
  return bracketedPaste ? PASTE_START + body + PASTE_END : body;
}

/** Why a composer message did not go (SubmitResult's code): the composer keeps the text and says this. */
export function submitNote(code: string, message: string): string {
  if (code === "agent_blocked") return t("Not sent: the agent is waiting for an answer in the terminal. Answer it first.");
  if (code === "read_only") return t("Not sent: this view only watches the pane.");
  if (code === "submit_timeout") return t("Not sent: it waited too long behind an earlier message, and nothing was typed. Send it again.");
  if (code === "disconnected" || code === "timeout") return t("Not confirmed: the pane did not confirm this message. Check the terminal before sending it again.");
  return t("Not sent: {message}", { message });
}

/**
 * How a stored image is referenced in the prompt: the agent TUI reads the file from
 * its path, so the mention is plain text the user can still edit before sending.
 */
export function imageMention(path: string): string {
  return `@${path} `;
}

/**
 * Puts a mention over the selection [start, end) as its own token: a space goes in
 * front when the text before it does not already end in whitespace, because the chat
 * and the agent only read `@path` after whitespace or at the start. The insertion is
 * cut to what still fits under MAX_COMPOSER_CHARS.
 */
export function insertMention(
  text: string,
  start: number,
  end: number,
  mention: string,
): { text: string; caret: number } {
  const before = text.slice(0, start);
  const snippet = before.length > 0 && !/\s$/u.test(before) ? ` ${mention}` : mention;
  const room = Math.max(0, MAX_COMPOSER_CHARS - text.length + end - start);
  const inserted = snippet.slice(0, room);
  return { text: before + inserted + text.slice(end), caret: start + inserted.length };
}

/** Ready states affect the held-message hint only; sending always requires a user action. */
export const QUEUE_READY_STATUS: Readonly<Partial<Record<string, true>>> = { done: true, idle: true };

/**
 * Commands an agent runs that the chat can start but cannot finish, by the agents that have them.
 *
 * `/tree` opens pi's tree browser, and omp documents the same command, the same navigator and the
 * same three branch-summary choices — it moves the session's branch, and no entry names where the
 * leaf was left, so the browser that opens reads as nothing at all through the chat: no card (its
 * hint says "up/down move", not the hint a live dialog is read from), and the pane still reports
 * itself done while the terminal waits for arrow keys a phone cannot send. The chat keeps its half
 * honest — it says where a /tree left the conversation — and leaves navigating to the terminal.
 *
 * Deliberately not a block: the composer sends text as written and nothing filters it, so typing
 * these still reaches the agent. The point is that the chat no longer points at them and says why
 * when they are typed anyway. claude and codex are absent because there is no evidence they have
 * the command, and telling a reader about a browser their agent does not have is its own wrong; omo
 * and gjc are absent for the same reason, unverified rather than found wanting.
 */
const TERMINAL_ONLY_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  tree: ["pi", "omp"],
};

/** The command `text` types, if it is one of those: its name, or null. Case and arguments aside,
 * a message only has to *be* the command — prose that merely mentions it, or a word that only
 * begins like it (`/treemap`), is not one. */
export function terminalOnlyCommand(agent: string | null, text: string): string | null {
  if (agent === null) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return null;
  const [word] = trimmed.slice(1).toLowerCase().split(/\s+/);
  const agents = TERMINAL_ONLY_COMMANDS[word ?? ""];
  return agents !== undefined && agents.includes(agent) ? (word ?? null) : null;
}

/** The composer's status word: the shared vocabulary, with a blank state reading as READY (a shell is always ready). */
export function composerStatusWord(status?: AgentStatus): string {
  const known = knownStatus(status);
  return known === "unknown" ? "READY" : STATUS_WORD[known];
}

/** Herdr agent ids are machine-friendly; the composer presents a short human label. */
export function agentDisplayLabel(agent: string | null): string {
  if (!agent) return "Shell";
  return agent
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Filter by command prefix and prefer commands the user has selected most often. */
export function rankSlashCommands(
  commands: readonly SlashCommand[],
  query: string,
  usage: Readonly<Partial<Record<string, number>>>,
): SlashCommand[] {
  const needle = query.toLocaleLowerCase();
  return commands
    .filter((command) => command.name.toLocaleLowerCase().startsWith(needle))
    .sort((left, right) => {
      const frequency = (usage[right.name] ?? 0) - (usage[left.name] ?? 0);
      return frequency || left.name.localeCompare(right.name);
    });
}

/** A token count the way a status line reads it: 950, 68k, 1.2M. */
export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** What is left of the context, as the agents' own status lines put it; null when the window is unknown. */
export function contextLeftPercent(context: { used: number; window: number | null }): number | null {
  if (context.window === null || context.window <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((1 - context.used / context.window) * 100)));
}
