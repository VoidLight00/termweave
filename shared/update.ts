/** App updates are independent of the herdr daemon and its terminal sessions. */
export interface UpdateStatus {
  managed: boolean;
  auto_update: boolean;
  phase: "idle" | "checking" | "building" | "restarting" | "error";
  /** Commit ids: what is running and what the latest release tag points at. */
  current_revision: string | null;
  latest_revision: string | null;
  /** Human versions: the running build's package.json and the latest `vX.Y.Z` tag, without the v. */
  current_version: string | null;
  latest_version: string | null;
  available: boolean;
  checked_at: string | null;
  blocked_reason: string | null;
  error: string | null;
}

export type UpdateCommand = "check" | "install";

export function unmanagedUpdateStatus(): UpdateStatus {
  return {
    managed: false, auto_update: false, phase: "idle", current_revision: null,
    latest_revision: null, current_version: null, latest_version: null, available: false, checked_at: null, error: null,
    blocked_reason: "Start with bun run start or the herdr plugin to enable updates.",
  };
}

/**
 * herdr itself, updated from the app (server/herdr-update.ts): the server runs
 * `herdr update --handoff` for the herdr it talks to, on its own PC.
 */
export interface HerdrUpdateStatus {
  /** false where the server offers no herdr update (Windows, a herdr that does not answer): the controls stay hidden */
  supported: boolean;
  phase: "idle" | "updating" | "error";
  /** the running herdr server, and the herdr binary installed beside it */
  server_version: string | null;
  binary_version: string | null;
  /** the installed binary is newer than the running server: an update moves the panes onto it */
  stale: boolean;
  /** what herdr printed on the last run, its tail; null before any run and while one runs */
  output: string | null;
  finished_at: string | null;
}
