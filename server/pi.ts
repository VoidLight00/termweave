import { constants, closeSync, fstatSync, openSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

import { herdrRpc } from "./herdr/client.ts";
import { piAgentDir } from "./pi-models.ts";

/**
 * pi's session store. `PI_CODING_AGENT_SESSION_DIR` moves it, exactly as CODEX_HOME
 * moves Codex's, and `PI_CODING_AGENT_DIR` moves the agent directory it sits in (seen on
 * pi 0.87.1: the store is `<agent dir>/sessions`); pi's `--session-dir` flag and its
 * `sessionDir` setting move it too, but this process cannot see either, so a pane started
 * that way keeps the terminal.
 */
export const defaultPiSessionDir = (): string =>
  process.env["PI_CODING_AGENT_SESSION_DIR"] || join(piAgentDir(), "sessions");

/**
 * The canonical file inside the store, or null. pi names an absolute path itself, so
 * the store is checked rather than trusted: a path elsewhere, a link out of it or a
 * non-session file is no evidence, and an unreadable store holds nothing readable.
 */
export function piTranscriptInStore(path: string, sessionDir: string): string | null {
  let canonical: string;
  let root: string;
  try {
    canonical = realpathSync(path);
    root = realpathSync(sessionDir);
  } catch { return null; }
  const inside = relative(root, canonical);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return null;
  if (!canonical.endsWith(".jsonl")) return null;
  // A directory wearing the extension answers no transcript read later: refuse it here.
  let fd: number | undefined;
  try {
    fd = openSync(canonical, constants.O_RDONLY | constants.O_NONBLOCK);
    return fstatSync(fd).isFile() ? canonical : null;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * pi's transcript for a pane. herdr's integration re-reports the session file on every
 * `session_start`, so `/new`, `/resume`, `/fork` and `/clone` need no inference here:
 * the next read names the file that replaced the old one.
 */
export async function piTranscriptPath(paneId: string, sessionDir = defaultPiSessionDir()): Promise<string | null> {
  const info = await herdrRpc<{ agent: { agent_session?: { agent?: unknown; kind?: unknown; value?: unknown } } }>(
    "agent.get",
    { target: paneId },
  ).catch(() => null);
  const session = info?.agent?.agent_session;
  // pi reports an absolute path; the id-only form belongs to agents with no store of ours.
  if (session?.kind !== "path" || typeof session.value !== "string") return null;
  return piTranscriptInStore(session.value, sessionDir);
}
