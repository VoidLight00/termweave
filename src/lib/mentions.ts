export type ActiveTrigger = {
  kind: "slash" | "file";
  /** `$`: a skill named the way Codex takes it (`$name`), anywhere a word starts; absent for `/` */
  prefix?: "$";
  query: string;
  /** Inclusive index of the trigger character. */
  start: number;
  /** Exclusive end of the token being completed. */
  end: number;
};

const SLASH_QUERY = /^[\p{L}\p{N}_-]*$/u;
const FILE_QUERY = /^\S+$/u;

function tokenEnd(text: string, from: number): number {
  let end = from;
  while (end < text.length && !/\s/u.test(text[end] ?? "")) end += 1;
  return end;
}

/**
 * Finds the completion token at the caret. Slash commands only begin a line; file mentions
 * may begin anywhere; with `skills`, so may a `$skill` (Codex's own way to name one).
 */
export function activeTrigger(text: string, caret: number, options: { skills?: boolean } = {}): ActiveTrigger | null {
  if (!Number.isInteger(caret) || caret < 0 || caret > text.length) return null;

  const lineStart = text.lastIndexOf("\n", Math.max(0, caret - 1)) + 1;
  if (options.skills) {
    const dollar = text.lastIndexOf("$", Math.max(0, caret - 1));
    const query = dollar >= lineStart ? text.slice(dollar + 1, caret) : "";
    if (dollar >= lineStart && (dollar === 0 || /\s/u.test(text[dollar - 1] ?? "")) && SLASH_QUERY.test(query)) {
      return { kind: "slash", prefix: "$", query, start: dollar, end: tokenEnd(text, caret) };
    }
  }
  if (text[lineStart] === "/") {
    const query = text.slice(lineStart + 1, caret);
    if (SLASH_QUERY.test(query)) {
      return { kind: "slash", query, start: lineStart, end: tokenEnd(text, caret) };
    }
  }

  const at = text.lastIndexOf("@", Math.max(0, caret - 1));
  if (at < lineStart) return null;
  const query = text.slice(at + 1, caret);
  if (query.length === 0 || !FILE_QUERY.test(query)) return null;
  return { kind: "file", query, start: at, end: tokenEnd(text, caret) };
}

/** Replaces exactly the active token and returns the caret position after the inserted completion. */
export function applyCompletion(
  text: string,
  trigger: ActiveTrigger,
  replacement: string,
): { text: string; caret: number } {
  const next = text.slice(0, trigger.start) + replacement + text.slice(trigger.end);
  return { text: next, caret: trigger.start + replacement.length };
}
