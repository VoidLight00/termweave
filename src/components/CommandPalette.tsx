import { paneNumber } from "../lib/paneNumber.ts";
import { useMachineId } from "../lib/machineContext.tsx";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { Bell, FolderOpen, LockKeyhole, MessageSquarePlus, Monitor, PanelLeft, RefreshCw, Settings, SunMoon, SwitchCamera, X } from "lucide-react";

import "./CommandPalette.css";

import type { PaneInfo, SessionSnapshot } from "../../shared/protocol.ts";
import type { AppActions, PaneView } from "../lib/actions.ts";
import { rankPanes } from "../lib/paletteSearch.ts";
import { SHORTCUTS, formatKeys, type ShortcutId } from "../lib/shortcuts.ts";
import { AgentMark } from "./AgentMark.tsx";
import { displayPaneTitle, StatusBadge } from "./Sidebar.tsx";
import { placeLine } from "../lib/paneName.ts";
import { useT } from "../lib/i18n.ts";

const RECENT_KEY = "termweave:recent-panes";
const RECENT_LIMIT = 8;

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  snapshot: SessionSnapshot | null;
  selectedPaneId: string | null;
  view: PaneView;
  actions: AppActions;
}

interface PaletteAction {
  id: string;
  label: string;
  icon: ComponentType;
  shortcut?: ShortcutId;
  run: () => void;
}

function loadRecentPanes(machineId: string): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(machineId === "local" ? RECENT_KEY : `${RECENT_KEY}:${machineId}`) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

function rememberPane(paneId: string, current: readonly string[], machineId: string): string[] {
  const recent = [paneId, ...current.filter((id) => id !== paneId)].slice(0, RECENT_LIMIT);
  try {
    window.localStorage.setItem(machineId === "local" ? RECENT_KEY : `${RECENT_KEY}:${machineId}`, JSON.stringify(recent));
  } catch {
    /* private mode: recent ordering remains available for this page */
  }
  return recent;
}

function cwdBasename(path: string | null | undefined): string {
  if (!path) return "";
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

function ShortcutHint({ shortcutId }: { shortcutId?: ShortcutId }) {
  if (!shortcutId) return null;
  const shortcut = SHORTCUTS.find((item) => item.id === shortcutId);
  if (!shortcut) return null;
  return <span className="palette-shortcut" aria-label={formatKeys(shortcut.keys).join(" + ")}>{formatKeys(shortcut.keys).map((key) => <kbd className="kbd" key={key}>{key}</kbd>)}</span>;
}

export function CommandPalette({ open, onClose, snapshot, selectedPaneId, view, actions }: CommandPaletteProps) {
  const t = useT();
  const machineId = useMachineId();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [recentPaneIds, setRecentPaneIds] = useState<string[]>(() => loadRecentPanes(machineId));
  const inputRef = useRef<HTMLInputElement>(null);

  // Terminal attachment can move focus after the palette opens. Escape belongs to
  // this modal even then, and must not leak through to the underlying terminal.
  useLayoutEffect(() => {
    if (!open) return;
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", dismiss, true);
    return () => window.removeEventListener("keydown", dismiss, true);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    setRecentPaneIds(loadRecentPanes(machineId));
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (selectedPaneId === null) return;
    setRecentPaneIds((current) => rememberPane(selectedPaneId, current, machineId));
  }, [selectedPaneId]);

  const paletteActions = useMemo<PaletteAction[]>(() => [
    { id: "new", label: t("New session"), icon: MessageSquarePlus, shortcut: "new-session", run: actions.openNewSession },
    { id: "view", label: t(view === "chat" ? "Switch to terminal" : "Switch to chat"), icon: SwitchCamera, shortcut: "toggle-view", run: actions.toggleView },
    { id: "sidebar", label: t("Toggle sidebar"), icon: PanelLeft, shortcut: "toggle-sidebar", run: actions.toggleSidebar },
    { id: "theme", label: t("Toggle theme"), icon: SunMoon, run: actions.toggleTheme },
    { id: "settings", label: t("Settings"), icon: Settings, shortcut: "settings", run: actions.openSettings },
    { id: "add-pc", label: t("Add PC"), icon: Monitor, run: actions.openAddPc },
    ...(actions.enableNotifications ? [{ id: "notifications", label: t("Enable notifications"), icon: Bell, run: actions.enableNotifications }] : []),
    ...(actions.lock ? [{ id: "lock", label: t("Sign out"), icon: LockKeyhole, run: actions.lock }] : []),
    ...(actions.openFiles ? [{ id: "files", label: t("Browse files"), icon: FolderOpen, run: actions.openFiles }] : []),
    { id: "refresh", label: t("Refresh"), icon: RefreshCw, run: actions.refresh },
  ], [actions, view, t]);

  const panes = useMemo(() => {
    const allPanes = snapshot?.panes ?? [];
    if (query.trim()) return rankPanes(query, allPanes, snapshot?.workspaces ?? []);
    const recentOrder = new Map(recentPaneIds.map((id, index) => [id, index]));
    return allPanes
      .map((pane, index) => ({ pane, index, recent: recentOrder.get(pane.pane_id) }))
      .sort((a, b) => (a.recent ?? RECENT_LIMIT + a.index) - (b.recent ?? RECENT_LIMIT + b.index))
      .map(({ pane }) => pane);
  }, [query, recentPaneIds, snapshot]);

  const visibleActions = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle ? paletteActions.filter((action) => action.label.toLocaleLowerCase().includes(needle)) : paletteActions;
  }, [paletteActions, query]);
  const itemCount = panes.length + visibleActions.length;

  useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(0, itemCount - 1)));
  }, [itemCount]);

  if (!open) return null;

  const runPane = (pane: PaneInfo): void => {
    setRecentPaneIds((current) => rememberPane(pane.pane_id, current, machineId));
    actions.selectPane(pane.pane_id);
    onClose();
  };
  const runAction = (action: PaletteAction): void => {
    action.run();
    onClose();
  };
  const activate = (index: number): void => {
    if (index < panes.length) {
      const pane = panes[index];
      if (pane) runPane(pane);
      return;
    }
    const action = visibleActions[index - panes.length];
    if (action) runAction(action);
  };
  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === "ArrowDown" && itemCount > 0) {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % itemCount);
    } else if (event.key === "ArrowUp" && itemCount > 0) {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + itemCount) % itemCount);
    } else if (event.key === "Enter" && itemCount > 0) {
      event.preventDefault();
      activate(activeIndex);
    }
  };

  return (
    <div className="modal-scrim palette-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="menu command-palette" role="dialog" aria-modal="true" aria-label={t("Command palette")} onKeyDown={onKeyDown}>
        <div className="palette-search">
          <input ref={inputRef} className="input" type="search" value={query} placeholder={t("Search panes and actions…")} aria-label={t("Search panes and actions")} aria-controls="palette-results" aria-activedescendant={itemCount ? `palette-item-${activeIndex}` : undefined} onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }} />
          <button type="button" className="icon-button" aria-label={t("Close command palette")} onClick={onClose}><X /></button>
        </div>
        <div className="palette-results" id="palette-results" role="listbox">
          {panes.length > 0 && <div className="menu-heading">{t("Panes")}</div>}
          {panes.map((pane, index) => {
            const workspace = snapshot?.workspaces.find((item) => item.workspace_id === pane.workspace_id);
            const selected = pane.pane_id === selectedPaneId;
            return (
              <button key={pane.pane_id} id={`palette-item-${index}`} type="button" role="option" className="menu-item palette-pane" aria-selected={activeIndex === index} onMouseEnter={() => setActiveIndex(index)} onClick={() => runPane(pane)}>
                <span className="palette-mark"><AgentMark agent={pane.agent ?? "shell"} /></span>
                <span className="menu-item-main"><span className="palette-row-title"><span className="pane-number">{paneNumber(pane)}</span> {displayPaneTitle(pane)}{selected && <span className="palette-selected">{t("Selected")}</span>}</span><span className="palette-row-subtitle">{placeLine(workspace?.label ?? t("Unknown workspace"), cwdBasename(pane.foreground_cwd ?? pane.cwd) || t("Unknown working directory"))}</span></span>
                <StatusBadge status={pane.agent_status} />
              </button>
            );
          })}
          {visibleActions.length > 0 && <div className="menu-heading">{t("Actions")}</div>}
          {visibleActions.map((action, actionIndex) => {
            const index = panes.length + actionIndex;
            const Icon = action.icon;
            return <button key={action.id} id={`palette-item-${index}`} type="button" role="option" className="menu-item" aria-selected={activeIndex === index} onMouseEnter={() => setActiveIndex(index)} onClick={() => runAction(action)}><Icon /><span className="menu-item-main">{action.label}</span><ShortcutHint shortcutId={action.shortcut} /></button>;
          })}
          {itemCount === 0 && <p className="palette-empty" role="status">{t("No matching panes or actions")}</p>}
        </div>
      </section>
    </div>
  );
}
