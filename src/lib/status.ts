import type { AgentStatus, HerdrPane } from "../../shared/protocol.ts";

export interface WorkspaceStatusTarget { count: number; paneId: string | null }
export interface WorkspaceStatusSummary {
  needsInput: WorkspaceStatusTarget;
  running: WorkspaceStatusTarget;
  done: WorkspaceStatusTarget;
  backgroundTasks: number;
}

/** Full roster, never active-tab layout or workspace.agent_status. A pane can need input or
 * have answered while its children run, so these are independent counts, not one priority state.
 * The first matching pane in snapshot order is the indicator's deterministic navigation target. */
export function workspaceStatusSummary(panes: readonly HerdrPane[], workspaceId: string): WorkspaceStatusSummary {
  const members = panes.filter(pane => pane.workspace_id === workspaceId);
  const target = (matches: readonly HerdrPane[]): WorkspaceStatusTarget => ({
    count: matches.length, paneId: matches[0]?.pane_id ?? null,
  });
  return {
    needsInput: target(members.filter(pane => pane.agent_status === "blocked")),
    running: target(members.filter(pane => pane.agent_status === "working" || (pane.background_tasks ?? 0) > 0)),
    done: target(members.filter(pane => pane.agent_status === "done")),
    backgroundTasks: members.reduce((sum, pane) => sum + Math.max(0, pane.background_tasks ?? 0), 0),
  };
}

export type KnownStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/** The one word every surface (sidebar, palette, composer) uses for an agent state. */
export const STATUS_WORD: Readonly<Record<KnownStatus, string>> = {
  idle: "READY",
  working: "RUN",
  blocked: "INPUT",
  done: "DONE",
  unknown: "—",
};

const KNOWN: Readonly<Record<string, KnownStatus>> = { idle: "idle", working: "working", blocked: "blocked", done: "done" };

/** herdr's AgentStatus is open-ended; the UI knows four states and files the rest under unknown. */
export function knownStatus(status?: AgentStatus): KnownStatus {
  return (status !== undefined && KNOWN[status]) || "unknown";
}

/**
 * Whether a pushed status change should read the conversation now instead of at the next poll:
 * a turn starts or ends when the pane enters or leaves `working`, and the chat's last block
 * follows the status while the transcript it holds is up to POLL_MS old.
 */
export function statusEdgeRead(previous: AgentStatus | undefined, next: AgentStatus | undefined): boolean {
  return previous !== next && (previous === "working" || next === "working");
}
