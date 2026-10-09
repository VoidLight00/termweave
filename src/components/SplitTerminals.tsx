import { paneNumber } from "../lib/paneNumber.ts";
import { TerminalAddress } from "./TerminalAddress.tsx";
import { TerminatePaneButton } from "./TerminatePaneButton.tsx";
import { RenamePaneButton } from "./RenamePaneButton.tsx";
import { useT } from "../lib/i18n.ts";
import { useEffect, useRef, useState } from "react";
import type { HerdrPane } from "../../shared/protocol.ts";
import { OpenFileContext } from "../lib/filePaths.ts";
import { initialWorkspaceLayout, readWorkspaceLayout, saveWorkspaceLayout } from "../lib/sessionLayout.ts";
import { createShellPane, fetchSession, movePane } from "../lib/api.ts";
import { moveRequest, type PaneMoveResult } from "../../shared/paneMove.ts";
import { NativePaneMove } from "./NativePaneMove.tsx";
import { BrowserPanel } from "./BrowserPanel.tsx";
import { dockInsertion, validDockDrag, type DockPreview } from "../lib/dockDrag.ts";
import { spatialChord, spatialNeighbor } from "../lib/spatialFocus.ts";
import { dock, group, groups, removeTab, resizeSplit, sanitize, updateGroup, type Edge, type Layout } from "../lib/dockLayout.ts";
import { PaneTerminal, type PaneTerminalProps } from "./PaneTerminal.tsx";
import { DockGroup } from "./DockGroup.tsx";
import { DockDivider } from "./DockDivider.tsx";
import { TerminalSearch } from "./TerminalSearch.tsx";
import "./SplitTerminals.css";
import "./DockLayout.css";

function paneInput(node: HTMLElement | null | undefined): HTMLTextAreaElement | null {
  if (!node) return null;
  // Prefer the visible chat composer. The terminal stays mounted behind it.
  if (node.querySelector(".terminal-stack.is-chat")) return node.querySelector<HTMLTextAreaElement>(".composer-text:not(:disabled)");
  return node.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
}
interface Props {
  viewForPane?: (pane: HerdrPane) => PaneTerminalProps["view"];
  onPaneView?: (id: string, view: "chat" | "terminal") => void;
  machineId: string; panes: readonly HerdrPane[]; primaryId: string | null; ownerId?: string | null; terminal: PaneTerminalProps;
  onSelectPrimary: (id: string) => void; onOpenFile: (path: string, paneId: string) => void; onRefresh: () => Promise<void>;
  mutationBusy: boolean;
  onMoved: (result: PaneMoveResult, machineId: string, workspaceId: string) => Promise<void>;
  onMovePending: (pending: boolean) => boolean;
}
export function SplitTerminals({ machineId, panes, primaryId, ownerId, terminal, onSelectPrimary, onOpenFile, onRefresh, onMoved, onMovePending, mutationBusy, viewForPane, onPaneView }: Props) {
  const t = useT();
  const selected = panes.find(pane => pane.pane_id === primaryId);
  const workspace = selected?.workspace_id ?? ownerId ?? "pending";
  if (workspace === "pending") return <div className="split-empty" role="status">{t("Connecting…")}</div>;
  return <DockWorkspace key={`${machineId}:${workspace}`} {...{ machineId, panes, primaryId, terminal, onSelectPrimary, onOpenFile, onRefresh, onMoved, onMovePending, mutationBusy, viewForPane, onPaneView }} ownerId={workspace} workspace={workspace} />;
}
function DockWorkspace({ machineId, panes, primaryId, ownerId, terminal, onSelectPrimary, onOpenFile, onRefresh, onMoved, onMovePending, mutationBusy, workspace, viewForPane, onPaneView }: Props & { workspace: string }) {
  const t = useT();
  const roster = panes.filter(pane => pane.workspace_id === workspace);
  const detached = new URLSearchParams(window.location.search).has("detached");
  const [tree, setTree] = useState<Layout>(() => (detached ? null : initialWorkspaceLayout(machineId, workspace, roster.map(p => p.pane_id), primaryId).tree) ?? group("main", primaryId ? [primaryId] : []));
  const treeRef = useRef(tree); treeRef.current = tree;
  useEffect(() => {
    const completed = (event: Event) => {
      const target = (event as CustomEvent).detail;
      if (!ownerId || target?.machine !== machineId || target?.owner !== ownerId) return;
      const saved = readWorkspaceLayout(machineId, ownerId);
      if (!saved) return;
      setTree(saved.tree);
      if (saved.primary) { onSelectPrimary(saved.primary); setFocusCreated(saved.primary); }
    };
    window.addEventListener('herdr-session-shell-created', completed);
    return () => window.removeEventListener('herdr-session-shell-created', completed);
  }, [machineId, ownerId, onSelectPrimary]);
  const [zoom, setZoom] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string[]>([]);
  const [focusCreated, setFocusCreated] = useState<string | null>(null);
  const [selectCreated, setSelectCreated] = useState<string | null>(null);
  useEffect(() => {
    if (selectCreated && panes.some(pane => pane.pane_id === selectCreated && pane.workspace_id === workspace)) {
      onSelectPrimary(selectCreated);
      setFocusCreated(selectCreated);
      setSelectCreated(null);
    }
  }, [panes, selectCreated, workspace, onSelectPrimary]);
  const [phone, setPhone] = useState(() => matchMedia("(max-width: 760px)").matches);
  const previousPrimary = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [focusSpatial, setFocusSpatial] = useState<string | null>(null);
  const dragRef = useRef<string | null>(null);
  const [preview, setPreview] = useState<DockPreview | null>(null);
  const [focusDropped, setFocusDropped] = useState<string | null>(ownerId ? primaryId : null);
  const cancelDrag = () => { dragRef.current = null; setPreview(null); };
  useEffect(() => {
    const cancel = () => cancelDrag();
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") cancel(); };
    window.addEventListener("dragend", cancel);
    window.addEventListener("drop", cancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", escape, true);
    return () => {
      dragRef.current = null;
      window.removeEventListener("dragend", cancel);
      window.removeEventListener("drop", cancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", escape, true);
    };
  }, []);
  useEffect(() => {
    if (!focusDropped) return;
    let frame = 0;
    const deadline = performance.now() + 10000;
    const focus = () => {
      const node = Array.from(rootRef.current?.querySelectorAll<HTMLElement>(".dock-group") ?? [])
        .find(value => value.dataset.paneId === focusDropped);
      const input = paneInput(node);
      // xterm deliberately gives unfocused input a zero-sized rectangle.
      // The visible terminal group, not its hidden textarea, determines readiness.
      const bounds = node?.getBoundingClientRect();
      const ready = input && bounds && bounds.width > 0 && bounds.height > 0 && !node?.querySelector(".terminal-banner");
      if (ready) { input.focus({ preventScroll: true }); setFocusDropped(null); }
      else if (performance.now() < deadline) frame = requestAnimationFrame(focus);
      else setFocusDropped(null);
    };
    frame = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(frame);
  }, [focusDropped, tree]);
  useEffect(() => {
    if (dragRef.current && !validDockDrag(tree, roster.map(pane => pane.pane_id), dragRef.current, ["application/x-herdr-pane"])) cancelDrag();
  }, [tree, panes]);
  const acceptsDrag = (event: React.DragEvent, payload = false) => validDockDrag(tree, roster.map(pane => pane.pane_id),
    dragRef.current, Array.from(event.dataTransfer.types), payload ? event.dataTransfer.getData("application/x-herdr-pane") : undefined);
  const dragDrop = (event: React.DragEvent, target: string, edge: Edge, boundary?: number) => {
    if (!acceptsDrag(event, true)) { cancelDrag(); return; }
    const tab = dragRef.current!;
    const destination = groups(tree).find(node => node.id === target);
    if (!destination) { cancelDrag(); return; }
    event.preventDefault(); event.stopPropagation();
    if (edge === "center" && boundary !== undefined && destination.tabs.includes(tab) &&
      (boundary === destination.tabs.indexOf(tab) || boundary === destination.tabs.indexOf(tab) + 1)) { cancelDrag(); return; }
    const index = boundary === undefined ? undefined : dockInsertion(destination.tabs, tab, boundary);
    const next = dock(tree, tab, target, edge, crypto.randomUUID(), index);
    cancelDrag();
    if (JSON.stringify(next) === JSON.stringify(tree)) return;
    setTree(next); onSelectPrimary(tab); setFocusDropped(tab);
  };
  useEffect(() => {
    if (!focusSpatial) return;
    rootRef.current?.querySelectorAll<HTMLElement>(".dock-group").forEach(node => {
      if (node.dataset.paneId === focusSpatial) paneInput(node)?.focus({ preventScroll: true });
    });
    setFocusSpatial(null);
  }, [focusSpatial, tree, panes]);
  const terminalTarget = (target: EventTarget | null): HTMLElement | null => {
    if (!(target instanceof HTMLElement) || target.closest('[role="dialog"], dialog, .browser-preview, .dock-search, [data-shortcut-recorder]')) return null;
    return target.matches('.xterm-helper-textarea, .composer-text, [role="tab"][data-tab-id]') ? target.closest<HTMLElement>('.dock-group') : null;
  };
  const spatialKey = (event: React.KeyboardEvent) => {
    // The window shortcut handler may already have scheduled a pane focus.
    // Do not cancel it while the same handled key propagates into the dock.
    if (!event.defaultPrevented) setFocusDropped(null);
    const direction = spatialChord(event.nativeEvent); if (!direction) return;
    const source = terminalTarget(event.target); if (!source || !rootRef.current) return;
    event.preventDefault(); event.stopPropagation(); event.nativeEvent.stopImmediatePropagation();
    const nodes = Array.from(rootRef.current.querySelectorAll<HTMLElement>('.dock-group')).filter(node => {
      const r=node.getBoundingClientRect(); return r.width>0 && r.height>0 && !!node.dataset.paneId;
    });
    const rects=nodes.map(node => ({id:node.dataset.groupId!,...Object.fromEntries(['left','right','top','bottom'].map(k=>[k,node.getBoundingClientRect()[k as 'left']]))})) as import('../lib/spatialFocus.ts').SpatialRect[];
    const from=rects.find(rect=>rect.id===source.dataset.groupId); if(!from) return;
    const neighbor=spatialNeighbor(from,rects,direction);
    const destination=nodes.find(node=>node.dataset.groupId===neighbor);
    if(destination?.dataset.paneId){onSelectPrimary(destination.dataset.paneId);setFocusSpatial(destination.dataset.paneId);}
  };
  const busyRef = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (zoom && !groups(tree).some(node => node.id === zoom)) setZoom(null);
  }, [tree, zoom]);
  const unique = () => crypto.randomUUID();
  useEffect(() => {
    if (!focusCreated || matchMedia("(pointer: coarse)").matches || window.innerWidth <= 760) return;
    const target = Array.from(document.querySelectorAll<HTMLElement>(".dock-group"))
      .find(node => node.dataset.paneId === focusCreated)?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    target?.focus({ preventScroll: true });
    setFocusCreated(null);
  }, [focusCreated, tree, panes]);
  useEffect(() => {
    const media = matchMedia("(max-width: 760px)"); const change = () => setPhone(media.matches);
    media.addEventListener("change", change); return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (workspace === "pending" || detached) return;
    saveWorkspaceLayout(machineId, workspace, { tree, primary: primaryId, workspace });
  }, [tree, workspace, machineId, ownerId, primaryId]);
  useEffect(() => {
    const reconcile = (available: string[]) => {
      setTree(current => sanitize(current, [...available, ...pending]) ?? group("main"));
      setPending(current => current.filter(id => !available.includes(id)));
    };
    const available = roster.map(pane => pane.pane_id);
    // Combined SSE/poll rosters may be stale. A missing ID is not evidence of removal.
    const missing = groups(tree).flatMap(g => g.tabs).some(id => !available.includes(id) && !pending.includes(id));
    if (!missing) { reconcile(available); return; }
    let cancelled = false;
    void fetchSession(machineId).then(current => {
      if (!cancelled) reconcile(current.panes.filter(p => p.workspace_id === workspace).map(p => p.pane_id));
    }).catch(() => { /* retain layout while offline */ });
    return () => { cancelled = true; };
  }, [panes, workspace]);
  useEffect(() => {
    if (previousPrimary.current === primaryId || !primaryId || !roster.some(p => p.pane_id === primaryId)) return;
    previousPrimary.current = primaryId;
    // Keyboard navigation must move the actual terminal input, not only sidebar selection.
    // Keep address/search fields available for ordinary text selection and copying.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && (rootRef.current?.contains(focused) || focused.closest(".workspace-terminal"))
      && !focused.closest('input:not(.xterm-helper-textarea), textarea:not(.xterm-helper-textarea):not(.composer-text), select, [contenteditable="true"]')) {
      setFocusDropped(primaryId);
    }
    setTree(current => {
      const owner = groups(current).find(node => node.tabs.includes(primaryId));
      if (owner) return updateGroup(current, owner.id, value => ({ ...value, active: primaryId }));
      const first = groups(current)[0]!;
      return updateGroup(current, first.id, value => ({ ...value, tabs: [...value.tabs, primaryId], active: primaryId }));
    });
  }, [primaryId, panes]);
  const move = (tab: string, target: string, edge: Edge, index?: number) => {
    if (!groups(tree).some(node => node.tabs.includes(tab)) || !groups(tree).some(node => node.id === target)) return;
    setTree(current => dock(current, tab, target, edge, unique(), index));
    onSelectPrimary(tab);
  };
  const add = async (id: string, edge: "right" | "bottom" | "center" = "center") => {
    const source = panes.find(pane => pane.pane_id === id);
    if (!source || source.restore_error || busyRef.current || selectCreated || mutationBusy) return;
    busyRef.current = true;
    setBusy(true); setError(null);
    try {
      const created = await createShellPane(id, source.workspace_id, machineId);
      if (!alive.current && ownerId) {
        // Navigation does not cancel a successful native creation. Persist to its source
        // owner, never to the newly selected sidebar session, and do not issue another RPC.
        const saved = readWorkspaceLayout(machineId, ownerId)?.tree ?? treeRef.current;
        const target = groups(saved).find(g => g.tabs.includes(id)) ?? groups(saved)[0];
        if (target && !groups(saved).some(g => g.tabs.includes(created.pane_id))) {
          const staged = updateGroup(saved, target.id, g => ({ ...g, tabs: [...g.tabs, created.pane_id], active: created.pane_id }));
          saveWorkspaceLayout(machineId, ownerId, { tree: edge === 'center' ? staged : dock(staged, created.pane_id, target.id, edge, unique()), primary: created.pane_id, workspace: source.workspace_id });
          window.dispatchEvent(new CustomEvent('herdr-session-shell-created', { detail: { machine: machineId, owner: ownerId } }));
        }
      }
      if (alive.current) {
        setPending(current => [...new Set([...current, created.pane_id])]);
        setTree(current => {
          const nodes = groups(current);
          // The source can be hidden or moved while creation is in flight. The shell
          // already exists: keep its returned ID visible without repeating the RPC.
          const owner = nodes.find(node => node.tabs.includes(id)) ?? nodes[0];
          if (!owner) return group("main", [created.pane_id]);
          if (nodes.some(node => node.tabs.includes(created.pane_id))) return current;
          const staged = updateGroup(current, owner.id, node => ({ ...node, tabs: [...node.tabs, created.pane_id], active: created.pane_id }));
          return edge === "center" ? staged : dock(staged, created.pane_id, owner.id, edge, unique());
        });
        setZoom(null);
      }
      try { await onRefresh(); }
      catch { if (alive.current) setError(t("Terminal created; roster refresh failed. Do not create it again.")); return; }
      // Refresh schedules App's new roster asynchronously. Selecting the returned
      // ID before that roster commits would briefly unmount this workspace and
      // discard the in-flight split tree. Select only once the ID is authoritative.
      if (alive.current) setSelectCreated(created.pane_id);
    } catch { if (alive.current) setError(t("Terminal creation failed. Check connection and permissions; no automatic retry.")); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  };
  const nativeMove = async (source: HerdrPane, target: HerdrPane) => {
    if (busyRef.current || selectCreated || terminal.role === "observe" || source.workspace_id !== workspace) return;
    if (!onMovePending(true)) return;
    busyRef.current = true; setBusy(true); setError(null);
    let moved: PaneMoveResult | null = null;
    try {
      const result = await movePane(moveRequest(source, target), machineId);
      if (!result.changed) { if (alive.current) setError(t("No native move occurred. Check zoom and destination.")); return; }
      moved = result;
      // App owns reconciliation across workspace remounts. Keep the returned identity
      // even if this group disappeared while the mutation was in flight.
      await onMoved(result, machineId, workspace);
    } catch {
      if (alive.current) setError(moved
        ? t("Moved {id}; refresh failed. Verify roster; no automatic retry.", { id: moved.pane.pane_id })
        : t("Move result uncertain. Verify roster; no retry or new shell."));
      if (!moved) { try { await onRefresh(); } catch { /* uncertain outcome: read only */ } }
    } finally { busyRef.current = false; onMovePending(false); if (alive.current) setBusy(false); }
  };
  const detach = (id: string) => {
    const url = new URL(window.location.href); url.search = new URLSearchParams({ pane: id, machine: machineId, detached: "1" }).toString();
    const opened = window.open(url, "_blank");
    if (!opened) { setError(t("Popup blocked. Allow popups and try explicitly.")); return; }
    opened.opener = null;
    // Detach this view only after the new browser has taken its explicit URL target.
    setTree(current => removeTab(current, id) ?? group("main"));
  };
  const render = (node: Layout): React.ReactNode => {
    if (node.kind === "split") return <div key={node.id} className={`dock-split dock-${node.axis}`} data-split-id={node.id}
      style={node.axis === "columns" ? { gridTemplateColumns: `${node.ratio}fr 1px ${1 - node.ratio}fr` } : { gridTemplateRows: `${node.ratio}fr 1px ${1 - node.ratio}fr` }}>
      {render(node.first)}<DockDivider node={node} onResize={(id, ratio) => setTree(current => resizeSplit(current, id, ratio))} />{render(node.second)}
    </div>;
    const pane = panes.find(item => item.pane_id === node.active);
    const paneView = pane && viewForPane ? viewForPane(pane) : terminal.view;
    return <DockGroup key={node.id} node={node} panes={roster} busy={busy || !!selectCreated || mutationBusy} zoomed={zoom === node.id} groupIds={groups(tree).map(item => item.id)}
      preview={preview?.group === node.id ? preview : null} acceptsDrag={acceptsDrag} dragDrop={dragDrop}
      beginDrag={id => { setFocusDropped(null); dragRef.current = id; setPreview(null); }} previewDrag={setPreview}
      activate={id => { setFocusDropped(null); setTree(current => updateGroup(current, node.id, value => ({ ...value, active: id }))); onSelectPrimary(id); }} drop={move}
      add={() => { const source = node.active ?? primaryId ?? roster[0]?.pane_id; if (source) void add(source); }}
      split={edge => { const source = node.active ?? primaryId ?? roster[0]?.pane_id; if (source) void add(source, edge); }}
      canAdd={!!(node.active ?? primaryId ?? roster[0]?.pane_id) && terminal.role !== "observe"}
      zoom={() => setZoom(current => current === node.id ? null : node.id)} detach={detach}
      viewControls={pane && onPaneView && <div className="dock-view-controls" role="group" aria-label={t("Pane")}>
        {(["chat", "terminal"] as const).map(mode => <button key={mode} type="button" aria-pressed={paneView === mode}
          onClick={() => { onPaneView(pane.pane_id, mode); onSelectPrimary(pane.pane_id); setFocusDropped(pane.pane_id); }}>
          {mode === "chat" ? t("Chat") : t("Terminal")}</button>)}
      </div>}
      terminate={pane && <TerminatePaneButton toolbar pane={pane} machineId={machineId} disabled={busy || mutationBusy || terminal.role === "observe"} onTerminated={onRefresh} />}
      rename={pane && <RenamePaneButton pane={pane} machineId={machineId} disabled={busy || mutationBusy || terminal.role === "observe"} onRenamed={onRefresh} />}
      address={pane && <TerminalAddress key={`${machineId}:${pane.terminal_id}:${pane.pane_id}`} pane={pane} machineId={machineId} />}
      nativeMove={<NativePaneMove source={terminal.role === "observe" ? undefined : pane} panes={panes} busy={busy || !!selectCreated || mutationBusy} move={(source, target) => void nativeMove(source, target)} />}
      search={<TerminalSearch key={node.active} paneId={node.active} machineId={machineId} />}>
      <OpenFileContext.Provider value={node.active ? path => onOpenFile(path, node.active!) : null}>
        <PaneTerminal {...terminal} paneId={pane?.restore_error ? null : node.active} restoreError={pane?.restore_error ?? null}
          agent={pane?.agent ?? null} agentStatus={pane?.agent_status} backgroundTasks={pane?.background_tasks ?? 0}
          view={paneView} autoSelected={true}
          onConnectionChange={node.id === groups(tree)[0]?.id ? terminal.onConnectionChange : undefined}
          onRoleAck={node.id === groups(tree)[0]?.id ? terminal.onRoleAck : undefined} />
      </OpenFileContext.Provider>
    </DockGroup>;
  };
  const visible = zoom ? groups(tree).find(node => node.id === zoom) ?? tree : phone ? groups(tree).find(node => node.active === primaryId) ?? groups(tree)[0] ?? tree : tree;
  return <div className="split-workspace" ref={rootRef} onKeyDownCapture={spatialKey}
    onFocusCapture={event => { const node=terminalTarget(event.target); if (node) setFocusDropped(null); if(node?.dataset.paneId && node.dataset.paneId!==primaryId) onSelectPrimary(node.dataset.paneId); }}
    onPointerDownCapture={event => { setFocusDropped(null); const target=event.target; if(target instanceof HTMLElement && target.closest('.dock-drop-body') && !target.closest('input,button,select,[contenteditable="true"]')) {const id=target.closest<HTMLElement>('.dock-group')?.dataset.paneId; if(id && id!==primaryId) onSelectPrimary(id);} }}>
    <label className="dock-existing">{t("Existing terminals")} <select aria-label={t("Existing terminals")} value="" onChange={event => {
      const id = event.target.value; if (!id) return;
      setTree(current => {
        const target = groups(current).find(g => g.tabs.includes(id)) ?? groups(current)[0];
        return target ? updateGroup(current, target.id, g => ({ ...g, tabs: g.tabs.includes(id) ? g.tabs : [...g.tabs, id], active: id })) : group('main', [id]);
      });
      onSelectPrimary(id); setFocusDropped(id);
    }}><option value="">{t("Choose terminal ({n})", { n: roster.length })}</option>{roster.map(p => <option key={p.pane_id} value={p.pane_id}>{paneNumber(p)} · {p.label || p.title || p.pane_id} · {p.tab_id} · {p.pane_id}</option>)}</select></label>
    <BrowserPanel key={machineId} machineId={machineId} />
    {phone && groups(tree).length > 1 && <div className="dock-phone-nav">
      <label>{t("Pane")}<select aria-label={t("Mobile pane selection")} value={zoom ?? groups(tree).find(node => node.active === primaryId)?.id ?? groups(tree)[0]!.id} onChange={event => { setZoom(event.target.value); const id = groups(tree).find(node => node.id === event.target.value)?.active; if (id) onSelectPrimary(id); }}>{groups(tree).map(node => <option key={node.id} value={node.id}>{node.active ? paneNumber(panes.find(p => p.pane_id === node.active)) : "—"}</option>)}</select></label>
    </div>}
    {error && <p className="split-empty" role="alert">{error}</p>}
    <div className="dock-root">{render(visible)}</div>
  </div>;
}
