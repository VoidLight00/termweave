/**
 * GENERATED FILE - DO NOT EDIT.
 *
 * Source: herdr API schema, protocol 22, schema_version 1.
 * Regenerate with: bun run generate:types
 * Verify freshness with: bun run generate:types --check
 */

export interface AgentInfo {
  agent?: string | null;
  agent_session?: AgentSessionInfo | null;
  agent_status: AgentStatus;
  completion_seq?: number | null;
  cwd?: string | null;
  display_agent?: string | null;
  focused: boolean;
  foreground_cwd?: string | null;
  interactive_ready?: boolean;
  launch_pending?: boolean;
  name?: string | null;
  pane_id: string;
  revision: number;
  screen_detection_skipped?: boolean;
  state_change_seq?: number;
  state_labels?: Record<string, unknown>;
  tab_id: string;
  terminal_id: string;
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
  title?: string | null;
  tokens?: Record<string, unknown>;
  workspace_id: string;
}

export interface AgentManifestInfo {
  active_version?: string | null;
  agent: string;
  cached_remote_version?: string | null;
  local_override_shadowing_remote: boolean;
  remote_last_checked_unix?: number | null;
  remote_update_error?: string | null;
  remote_update_result?: string | null;
  source: string;
  source_kind: string;
  warning?: string | null;
}

export interface AgentSessionInfo {
  agent: string;
  kind: AgentSessionRefKind;
  source: string;
  value: string;
}

export type AgentSessionRefKind = "id" | "path" | (string & {});

export interface AgentStartParams {
  args?: string[];
  kind: string;
  name: string;
  pane_id: string;
  timeout_ms?: number | null;
}

export type AgentStatus = "blocked" | "done" | "idle" | "unknown" | "working" | (string & {});

export interface EventsSubscribeParams {
  subscriptions: Subscription[];
}

export type OutputMatch = {
  type: string;
  value: string;
};

export interface PaneInfo {
  agent?: string | null;
  agent_session?: AgentSessionInfo | null;
  agent_status: AgentStatus;
  cwd?: string | null;
  display_agent?: string | null;
  focused: boolean;
  foreground_cwd?: string | null;
  label?: string | null;
  pane_id: string;
  restore_error?: string | null;
  revision: number;
  scroll?: PaneScrollInfo | null;
  state_labels?: Record<string, unknown>;
  tab_id: string;
  terminal_id: string;
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
  title?: string | null;
  tokens?: Record<string, unknown>;
  workspace_id: string;
}

export interface PaneLayoutPane {
  focused: boolean;
  pane_id: string;
  rect: PaneLayoutRect;
}

export interface PaneLayoutRect {
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface PaneLayoutSnapshot {
  area: PaneLayoutRect;
  focused_pane_id: string;
  panes: PaneLayoutPane[];
  splits: PaneLayoutSplit[];
  tab_id: string;
  workspace_id: string;
  zoomed: boolean;
}

export interface PaneLayoutSplit {
  direction: SplitDirection;
  id: string;
  ratio: number;
  rect: PaneLayoutRect;
}

export interface PaneReadParams {
  format?: ReadFormat;
  lines?: number | null;
  pane_id: string;
  source: ReadSource;
  strip_ansi?: boolean;
}

export interface PaneReadResult {
  format: ReadFormat;
  pane_id: string;
  revision: number;
  source: ReadSource;
  tab_id: string;
  text: string;
  truncated: boolean;
  workspace_id: string;
}

export interface PaneScrollInfo {
  max_offset_from_bottom: number;
  offset_from_bottom: number;
  viewport_rows: number;
}

export interface PaneSendKeysParams {
  keys: string[];
  pane_id: string;
}

export interface PaneSendTextParams {
  pane_id: string;
  text: string;
}

export type ReadFormat = "ansi" | "text" | (string & {});

export type ReadSource = "detection" | "recent" | "recent_unwrapped" | "visible" | (string & {});

export interface SessionSnapshot {
  agents: AgentInfo[];
  focused_pane_id?: string | null;
  focused_tab_id?: string | null;
  focused_workspace_id?: string | null;
  layouts: PaneLayoutSnapshot[];
  panes: PaneInfo[];
  protocol: number;
  tabs: TabInfo[];
  version: string;
  workspaces: WorkspaceInfo[];
}

export type SplitDirection = "down" | "right" | (string & {});

export type Subscription = {
  type: string;
} | {
  lines?: number | null;
  match: OutputMatch;
  pane_id: string;
  source: ReadSource;
  strip_ansi?: boolean;
  type: string;
} | {
  agent_status?: AgentStatus | null;
  pane_id: string;
  type: string;
} | {
  pane_id: string;
  type: string;
};

export interface TabInfo {
  agent_status: AgentStatus;
  focused: boolean;
  label: string;
  number: number;
  pane_count: number;
  tab_id: string;
  workspace_id: string;
}

export interface WorkspaceInfo {
  active_tab_id: string;
  agent_status: AgentStatus;
  focused: boolean;
  label: string;
  number: number;
  pane_count: number;
  tab_count: number;
  tokens?: Record<string, unknown>;
  workspace_id: string;
  worktree?: WorkspaceWorktreeInfo | null;
}

export interface WorkspaceWorktreeInfo {
  checkout_path: string;
  is_linked_worktree: boolean;
  repo_key: string;
  repo_name: string;
  repo_root: string;
}
