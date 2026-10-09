import { AgentMark } from "./AgentMark.tsx";
import { paneNumber } from "../lib/paneNumber.ts";
import { useCallback, useEffect, useMemo, useState, type DragEvent, type KeyboardEvent } from "react";
import { ChevronRight, Ellipsis, Folder, GripVertical, Layers, Palette, Pencil, Plus, X } from "lucide-react";
import { readCollapsedWorkspaces, workspaceCollapseId, writeCollapsedWorkspaces } from "../lib/workspaceCollapse.ts";

import "./Sidebar.css";

import type { AgentStatus, PaneInfo, SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import { paneTitle } from "../../shared/notify-policy.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import type { AppActions } from "../lib/actions.ts";
import { knownStatus, STATUS_WORD, workspaceStatusSummary } from "../lib/status.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { RowMenu, type RowMenuItem } from "./RowMenu.tsx";
import { SessionColorDialog } from "./SessionColorDialog.tsx";
import { SESSION_COLORS, browserColorStorage, readSessionColor, sessionColorKey, writeSessionColor, type SessionColor } from "../lib/sessionColor.ts";
import { focusWorkspaceListToggle } from "../lib/focus.ts";
import { composeTitle, shortPathTitle } from "../lib/paneName.ts";
import { useT } from "../lib/i18n.ts";
import { TerminalMenu } from "./TerminalMenu.tsx";

const ERROR_NOTE_MS = 5000;

/** shell prompt titles: `user@host:` is chrome, the path after it is the information */
const SHELL_PREFIX = /^[^:@\s]+@[^:@\s]+:/;
/** Herdr's agent glyph and spinner are already represented by the row mark and badge. */
const AGENT_CHROME = /^\u03c0\s*[^\p{L}\p{N}\s]?\s*/u;

function stripPaneChrome(title: string, agent: string | null | undefined): string {
  const shellStripped = title.replace(SHELL_PREFIX, "");
  return agent ? shellStripped.replace(AGENT_CHROME, "") : shellStripped;
}

export { paneTitle };

/**
 * The title a row or the header shows: the user's label, else the live title minus its chrome,
 * a working directory written out shortened to its last folder (lib/paneName.ts).
 */
export function displayPaneTitle(pane: PaneInfo): string {
  return composeTitle(pane.label, shortPathTitle(stripPaneChrome(paneTitle(pane), pane.agent))) || pane.pane_id;
}

/** herdr could not bring this pane back after a restart (0.9.3+ `restore_error`): its reason, on hover. */
export function RestoreErrorBadge({ reason }: { reason: string }) {
  const t = useT();
  return <span className="badge badge-restore-error" title={reason}>{t("NOT RESTORED")}</span>;
}

export function StatusBadge({ status }: { status?: AgentStatus }) {
  const t = useT();
  const value = knownStatus(status);
  return (
    <span className={`badge badge-${value}`} data-status={value} title={t("Agent {status}", { status: t(STATUS_WORD[value]) })}>
      {t(STATUS_WORD[value])}
    </span>
  );
}

/**
 * Background tasks an agent started that still run (OmO's `task` children): the main turn can be
 * done while they work, and they wake the session by themselves. A count beside the state word,
 * not a state of its own: DONE stays the moment the agent answered.
 */
export function BackgroundBadge({ count }: { count?: number }) {
  const t = useT();
  if (!count || count <= 0) return null;
  const label = t("Background tasks running: {count}", { count });
  return (
    <span className="badge badge-background" title={label} aria-label={label} data-testid="background-tasks">
      <Layers aria-hidden="true" />{count}
    </span>
  );
}

interface InlineError {
  paneId?: string;
  message: string;
}

type MenuState = { kind: "workspace"; anchor: HTMLElement; workspace: WorkspaceInfo; scope: string };
interface ConfirmState { title: string; body: string; run: () => Promise<void> }

export interface SidebarProps {
  snapshot: SessionSnapshot | null;
  selectedPaneId: string | null;
  actions: AppActions;
  selectedWorkspaceId?: string | null;
  onSelectWorkspace?: (id: string) => void;
}

export function Sidebar({ snapshot, selectedPaneId, selectedWorkspaceId, onSelectWorkspace, actions }: SidebarProps) {
  const t = useT();
  const machineId = useMachineId();
  // cmux-style session color: per browser, per PC and workspace, shown on the folder mark
  const [colorTarget, setColorTarget] = useState<{ id: string; label: string } | null>(null);
  const [colorVersion, setColorVersion] = useState(0);
  const colorKey = (workspaceId: string): string => sessionColorKey(window.location.origin, machineId, workspaceId);
  const colorOf = (workspaceId: string): SessionColor | null => { void colorVersion; return readSessionColor(browserColorStorage(), colorKey(workspaceId)); };
  const { closeWorkspace, moveWorkspace, renameWorkspace } = useMachineApi();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null);
  const [workspaceLabel, setWorkspaceLabel] = useState("");
  const [workspaceOrder, setWorkspaceOrder] = useState<string[]>([]);
  const [dragWorkspaceId, setDragWorkspaceId] = useState<string | null>(null);
  const [inlineError, setInlineError] = useState<InlineError | null>(null);
  const [collapsed, setCollapsed] = useState(readCollapsedWorkspaces);
  const toggleTerminals = (id: string): void => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id); else next.add(id);
    writeCollapsedWorkspaces(next);
    setCollapsed(next);
  };
  useEffect(() => {
    if (inlineError === null) return;
    const timer = window.setTimeout(() => setInlineError(null), ERROR_NOTE_MS);
    return () => window.clearTimeout(timer);
  }, [inlineError]);

  useEffect(() => {
    if (!snapshot) {
      setWorkspaceOrder([]);
      return;
    }
    const serverOrder = snapshot.workspaces.map((workspace) => workspace.workspace_id);
    setWorkspaceOrder((current) => current.join("\u0000") === serverOrder.join("\u0000") ? current : serverOrder);
  }, [snapshot, machineId]);

  const orderedWorkspaces = useMemo(() => {
    if (!snapshot) return [];
    const byId = new Map(snapshot.workspaces.map((workspace) => [workspace.workspace_id, workspace]));
    return workspaceOrder.map((id) => byId.get(id)).filter((workspace): workspace is WorkspaceInfo => workspace !== undefined);
  }, [snapshot, workspaceOrder]);
  const workspacePaneCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const pane of snapshot?.panes ?? []) counts.set(pane.workspace_id, (counts.get(pane.workspace_id) ?? 0) + 1);
    return counts;
  }, [snapshot?.panes]);

  const noteError = (message: string, paneId?: string): void => setInlineError({ message, paneId });

  const closeMenu = useCallback(() => setMenu(null), []);

  // A close that takes the workspace with it asks first, as herdr's ui.confirm_close does; a
  // pane that leaves its workspace standing closes at once, as herdr's tab menu does. The row is
  // gone afterwards, so focus moves to the header's workspace-list toggle.
  const leave = async (close: () => Promise<void>): Promise<void> => {
    await close();
    setConfirm(null);
    focusWorkspaceListToggle();
  };

  const menuItems = (state: MenuState): RowMenuItem[] => {
    // the roster may have moved on since the menu opened (a sibling closed from another client):
    // what an item does follows the latest snapshot, not what the row showed at the click
    const workspace = snapshot?.workspaces.find((candidate) => candidate.workspace_id === state.workspace.workspace_id) ?? state.workspace;
    const paneCount = workspacePaneCounts.get(workspace.workspace_id) ?? 1;
    const renameWorkspaceItem: RowMenuItem = { id: "rename-workspace", label: t("Rename workspace"), icon: Pencil, run: () => beginWorkspaceRename(workspace, state.scope) };
    const colorItem: RowMenuItem = { id: "session-color", label: t("Session color"), icon: Palette, run: () => setColorTarget({ id: workspace.workspace_id, label: workspace.label }) };
    return [renameWorkspaceItem, colorItem,
      { id: "close", label: t("Close workspace"), icon: X, danger: true, divider: true, run: () => setConfirm({ title: t("Close workspace {name}?", { name: workspace.label }), body: t("{n} panes close with it, and the agents in them stop.", { n: paneCount }), run: () => leave(() => closeWorkspace(workspace.workspace_id)) }) },
    ];
  };

  // the roster moves under an open menu: a row that left takes its menu with it, and focus
  // goes where a closed row's focus goes
  useEffect(() => {
    if (!menu) return;
    const alive = snapshot?.workspaces.some(workspace => workspace.workspace_id === menu.workspace.workspace_id);
    if (alive && menu.anchor.isConnected) return;
    setMenu(null);
    focusWorkspaceListToggle();
  });

  // By folder, one workspace can show under several folders: only the copy that was clicked edits.
  // Two mounted inputs would take the focus from each other, and the blur closes both.
  const beginWorkspaceRename = (workspace: WorkspaceInfo, scope: string): void => {
    setEditingWorkspaceId(`${scope}\u0000${workspace.workspace_id}`);
    setWorkspaceLabel(workspace.label);
  };

  const saveWorkspaceRename = (workspaceId: string): void => {
    const label = workspaceLabel.trim();
    setEditingWorkspaceId(null);
    void renameWorkspace(workspaceId, label).catch((reason: unknown) => {
      noteError(t("Rename failed: {reason}", { reason: reason instanceof Error ? reason.message : String(reason) }));
    });
  };

  const reorderWorkspace = (workspaceId: string, insertIndex: number): void => {
    const sourceIndex = workspaceOrder.indexOf(workspaceId);
    if (sourceIndex < 0) return;
    const boundedIndex = Math.max(0, Math.min(workspaceOrder.length - 1, insertIndex));
    if (sourceIndex === boundedIndex) return;
    const previous = workspaceOrder;
    const remaining = workspaceOrder.filter(id => id !== workspaceId);
    const next = [...remaining.slice(0, boundedIndex), workspaceId, ...remaining.slice(boundedIndex)];
    setWorkspaceOrder(next);
    void moveWorkspace(workspaceId, boundedIndex).catch((reason: unknown) => {
      setWorkspaceOrder(previous);
      noteError(t("Reorder failed: {reason}", { reason: reason instanceof Error ? reason.message : String(reason) }));
    });
  };

  const onDragStart = (event: DragEvent<HTMLElement>, workspaceId: string): void => {
    setDragWorkspaceId(workspaceId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-herdr-workspace", JSON.stringify({ machine_id: machineId, workspace_id: workspaceId }));
  };

  const onDrop = (event: DragEvent<HTMLElement>, targetWorkspaceId: string): void => {
    event.preventDefault();
    let payload: { machine_id?: string; workspace_id?: string };
    try { payload = JSON.parse(event.dataTransfer.getData("application/x-herdr-workspace")); } catch { return; }
    if (payload.machine_id !== machineId || typeof payload.workspace_id !== "string") return;
    const sourceId = dragWorkspaceId ?? payload.workspace_id;
    setDragWorkspaceId(null);
    reorderWorkspace(sourceId, workspaceOrder.indexOf(targetWorkspaceId));
  };

  const onHandleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, workspaceId: string): void => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    const current = workspaceOrder.indexOf(workspaceId);
    reorderWorkspace(workspaceId, current + (event.key === "ArrowUp" ? -1 : 1));
  };

  const dragHandle = (workspace: WorkspaceInfo, draggable: boolean) => (
    <button
      type="button"
      className="sidebar-drag-handle"
      aria-label={t("Reorder workspace {name}", { name: workspace.label })}
      title={t("Drag to reorder · Alt+↑/↓")}
      draggable={draggable}
      onDragStart={(event) => onDragStart(event, workspace.workspace_id)}
      onDragEnd={() => setDragWorkspaceId(null)}
      onKeyDown={(event) => onHandleKeyDown(event, workspace.workspace_id)}
    >
      <GripVertical aria-hidden="true" />
    </button>
  );

  const renderWorkspace = (workspace: WorkspaceInfo, visiblePanes: PaneInfo[], scope = "") => {
    const collapseId = workspaceCollapseId(machineId, workspace.workspace_id);
    const expanded = !collapsed.has(collapseId);
    const terminalsId = `workspace-terminals-${encodeURIComponent(collapseId)}-${encodeURIComponent(scope)}`;
    const selected = workspace.workspace_id === selectedWorkspaceId || visiblePanes.some(p => p.pane_id === selectedPaneId);
    const workspaceMenuOpen = menu?.kind === "workspace" && menu.workspace.workspace_id === workspace.workspace_id;
    const editing = editingWorkspaceId === `${scope}\u0000${workspace.workspace_id}`;
    const summary = workspaceStatusSummary(snapshot?.panes ?? [], workspace.workspace_id);
    const indicators = [
      { key: "needsInput", status: "blocked", label: t("Needs input"), target: summary.needsInput },
      { key: "running", status: "working", label: t("Running"), target: summary.running },
      { key: "done", status: "done", label: t("Done"), target: summary.done },
    ];
    return <section className={`workspace${dragWorkspaceId === workspace.workspace_id ? " is-dragging" : ""}`} key={workspace.workspace_id}
      onDragOver={event => { if (event.dataTransfer.types.includes("application/x-herdr-workspace")) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }}
      onDrop={event => onDrop(event, workspace.workspace_id)}>
      <div className={`pane-item${selected ? " is-selected" : ""}`}><div className="pane-row">
        {dragHandle(workspace, true)}
        <button type="button" className="sidebar-row-action workspace-disclosure"
          aria-label={t(expanded ? "Collapse terminals in {name}" : "Expand terminals in {name}", { name: workspace.label })}
          title={t(expanded ? "Collapse terminals in {name}" : "Expand terminals in {name}", { name: workspace.label })}
          aria-expanded={expanded} aria-controls={terminalsId} onClick={() => toggleTerminals(collapseId)}>
          <ChevronRight aria-hidden="true" />
        </button>
        <div className="pane-select" role="button" tabIndex={0} data-workspace-id={workspace.workspace_id}
          aria-current={selected ? "true" : undefined} title={workspace.label}
          onClick={() => onSelectWorkspace?.(workspace.workspace_id)}
          onKeyDown={event => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); onSelectWorkspace?.(workspace.workspace_id); } }}>
          <span className="agent-mark-holder is-shell" style={{ color: SESSION_COLORS.find(c => c.id === colorOf(workspace.workspace_id))?.value }}><Folder aria-hidden="true" /></span>
          <span className="pane-copy"><span className="pane-primary">
            {editing ? <input className="input workspace-rename-input" aria-label={t("Workspace name")} autoFocus value={workspaceLabel}
              onClick={event => event.stopPropagation()} onChange={event => setWorkspaceLabel(event.target.value)} onBlur={() => setEditingWorkspaceId(null)}
              onKeyDown={event => { event.stopPropagation(); if (event.key === "Enter") saveWorkspaceRename(workspace.workspace_id); if (event.key === "Escape") setEditingWorkspaceId(null); }} />
              : <span className="pane-title" onDoubleClick={() => beginWorkspaceRename(workspace, scope)}>{workspace.label}</span>}
          </span><span className="pane-meta">
            <BackgroundBadge count={summary.backgroundTasks} />
            <span className="pane-subtitle">{t("{n} terminals", { n: visiblePanes.length })}</span>
          </span></span>
        </div>
        <button type="button" className="sidebar-row-action row-menu-toggle" aria-label={t("More for workspace {name}",{name:workspace.label})}
          aria-haspopup="menu" aria-expanded={workspaceMenuOpen} onClick={event => workspaceMenuOpen ? setMenu(null) : setMenu({kind:"workspace",anchor:event.currentTarget,workspace,scope})}><Ellipsis aria-hidden="true" /></button>
      </div>
        <div className="workspace-status-indicators">
          {indicators.map(({ key, status, label, target }) => target.paneId !== null && (
            <button type="button" key={key} className={`badge badge-${status} workspace-status-indicator`}
              data-workspace-status={key}
              aria-label={t("{status}: {count} panes in {name}. Open first pane.", { status: label, count: target.count, name: workspace.label })}
              title={t("{status}: {count} panes in {name}. Open first pane.", { status: label, count: target.count, name: workspace.label })}
              onClick={() => actions.selectPane(target.paneId!)}>
              {label} <span className="workspace-status-count">{target.count}</span>
            </button>
          ))}
        </div>
        <div className="workspace-terminals" id={terminalsId} hidden={!expanded}>
          {visiblePanes.map(pane => <div className="workspace-terminal-row" key={pane.terminal_id || pane.pane_id}><button type="button"
            className="workspace-terminal" data-terminal-pane={pane.pane_id} title={pane.pane_id}
            aria-current={pane.pane_id === selectedPaneId ? "true" : undefined}
            onClick={() => actions.selectPane(pane.pane_id)}>
            <span className="pane-number" data-pane-number={paneNumber(pane)}>{paneNumber(pane)}</span>
            <AgentMark agent={pane.agent || "shell"} size={16} /><span className="workspace-terminal-title">{displayPaneTitle(pane)}</span>
            <StatusBadge status={pane.agent_status} />
          </button><TerminalMenu pane={pane} machineId={machineId} onRefresh={() => actions.refresh()} /></div>)}
        </div>
      </div>
    </section>;
  };

  return (
    <div className="machine-workspaces">
      <nav className="sidebar-list" aria-label={t("Herdr workspaces")}>
        {!snapshot && <p className="tree-state" role="status">{t("Loading workspaces…")}</p>}
        {snapshot && snapshot.workspaces.length === 0 && (
          <div className="tree-state-empty">
            <p className="tree-state" role="status">{t("No workspaces yet")}</p>
            <button type="button" className="btn" onClick={actions.openNewSession}><Plus aria-hidden="true" />{t("New session")}</button>
          </div>
        )}
        {orderedWorkspaces.map(workspace => renderWorkspace(workspace, snapshot?.panes.filter(pane => pane.workspace_id === workspace.workspace_id) ?? []))}
        {inlineError && inlineError.paneId === undefined && (
          <p className="sidebar-inline-error" role="alert">{inlineError.message}</p>
        )}
      </nav>
      {menu && <RowMenu anchor={menu.anchor} title={menu.workspace.label} items={menuItems(menu)} onClose={closeMenu} />}
      {colorTarget && <SessionColorDialog title={t("Session color: {name}", { name: colorTarget.label })} selected={colorOf(colorTarget.id)}
        onSelect={color => { writeSessionColor(browserColorStorage(), colorKey(colorTarget.id), color); setColorVersion(v => v + 1); }}
        onClose={() => setColorTarget(null)} />}
      {confirm && <ConfirmDialog title={confirm.title} body={confirm.body} confirmLabel={t("Close")} onConfirm={confirm.run} onClose={() => setConfirm(null)} />}
    </div>
  );
}
