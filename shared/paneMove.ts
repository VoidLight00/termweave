import type { HerdrPane, SessionSnapshot } from "./protocol.ts";

/** Existing-tab moves only. Both ends belong to the machine selected by the route. */
export interface PaneMoveRequest {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  terminal_id: string;
  target_pane_id: string;
  target_workspace_id: string;
  target_tab_id: string;
}
export interface PaneMoveResult {
  changed: boolean;
  previous_pane_id: string;
  pane: HerdrPane;
  reason?: string | null;
}
const fields = ["pane_id", "workspace_id", "tab_id", "terminal_id", "target_pane_id", "target_workspace_id", "target_tab_id"] as const;
export function isPaneMoveRequest(value: unknown): value is PaneMoveRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === fields.length && fields.every(key => typeof record[key] === "string" && record[key].length > 0);
}
export function moveRequest(source: HerdrPane, target: HerdrPane): PaneMoveRequest {
  return { pane_id: source.pane_id, workspace_id: source.workspace_id, tab_id: source.tab_id, terminal_id: source.terminal_id,
    target_pane_id: target.pane_id, target_workspace_id: target.workspace_id, target_tab_id: target.tab_id };
}
export function moveTargets(panes: readonly HerdrPane[], source: HerdrPane | undefined): HerdrPane[] {
  return source && !source.restore_error ? panes.filter(pane => !pane.restore_error && pane.tab_id !== source.tab_id && !!pane.terminal_id) : [];
}
/** Check the client's placement and identity claims against one current snapshot. */
export function moveSnapshotError(snapshot: SessionSnapshot, request: PaneMoveRequest): string | null {
  const source = snapshot.panes.find(pane => pane.pane_id === request.pane_id);
  const target = snapshot.panes.find(pane => pane.pane_id === request.target_pane_id);
  if (!source || !target) return "pane_not_found";
  if (source.workspace_id !== request.workspace_id || target.workspace_id !== request.target_workspace_id) return "workspace_mismatch";
  if (source.tab_id !== request.tab_id || target.tab_id !== request.target_tab_id || source.terminal_id !== request.terminal_id) return "stale_move";
  if (source.restore_error || target.restore_error || !target.terminal_id || source.tab_id === target.tab_id) return "invalid_target";
  const validPlace = (pane: HerdrPane) => snapshot.workspaces.some(workspace => workspace.workspace_id === pane.workspace_id)
    && snapshot.tabs.some(tab => tab.tab_id === pane.tab_id && tab.workspace_id === pane.workspace_id);
  return validPlace(source) && validPlace(target) ? null : "stale_move";
}
/** A failed or ambiguous reply must never initiate a second move or a new shell. */
export function isMoveResult(value: unknown, request: PaneMoveRequest): value is PaneMoveResult {
  if (!value || typeof value !== "object") return false;
  const result = value as PaneMoveResult;
  const pane = result.pane;
  return typeof result.changed === "boolean" && result.previous_pane_id === request.pane_id && !!pane
    && typeof pane.pane_id === "string" && !!pane.pane_id && pane.terminal_id === request.terminal_id
    && pane.workspace_id === (result.changed ? request.target_workspace_id : request.workspace_id)
    && pane.tab_id === (result.changed ? request.target_tab_id : request.tab_id);
}
