/** Where app state and managed-update state live. Dependency-free on purpose: the launcher
 * (server/managed.ts) imports it and must stay small and stable across releases. */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function defaultStateDir(): string {
  const override = process.env["HERDR_WEB_STATE_DIR"];
  if (override) return override;
  return join(process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "termweave");
}

/** One update state per source checkout and port, so two checkouts or ports never share builds. */
export function updateStateDir(root: string, port: number, stateDir = defaultStateDir()): string {
  return join(resolve(stateDir), "updates",
    createHash("sha256").update(`${resolve(root)}:${port}`).digest("hex").slice(0, 16));
}

/** A supervisor exits with this after an install: "start the supervisor of the release now active"
 * (EX_TEMPFAIL, never a crash code). */
export const HANDOVER_EXIT = 75;
