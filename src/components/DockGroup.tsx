import { Plus, Settings2, X } from "lucide-react";
import { AgentMark } from "./AgentMark.tsx";
import { paneNumber } from "../lib/paneNumber.ts";
import { useT } from "../lib/i18n.ts";
import { useState } from "react";
import type { HerdrPane } from "../../shared/protocol.ts";
import type { Edge, Group } from "../lib/dockLayout.ts";
import { PANE_DRAG_TYPE, type DockPreview } from "../lib/dockDrag.ts";
import { displayPaneTitle } from "./Sidebar.tsx";

interface Props {
  node: Group; panes: readonly HerdrPane[]; busy: boolean; zoomed: boolean; groupIds: string[];
  activate: (id: string) => void; drop: (tab: string, target: string, edge: Edge, index?: number) => void;
  add: () => void; split: (edge: "right" | "bottom") => void; canAdd: boolean; zoom: () => void; detach: (id: string) => void;
  preview: DockPreview | null; acceptsDrag: (event: React.DragEvent) => boolean;
  beginDrag: (id: string) => void; previewDrag: (preview: DockPreview | null) => void;
  dragDrop: (event: React.DragEvent, target: string, edge: Edge, boundary?: number) => void;
  rename?: React.ReactNode; terminate?: React.ReactNode; viewControls?: React.ReactNode; children: React.ReactNode; search?: React.ReactNode; nativeMove?: React.ReactNode; address?: React.ReactNode;
}
export function DockGroup({ node, panes, busy, zoomed, groupIds, activate, drop, add, split, canAdd, zoom, detach, children, search, nativeMove, address, terminate, rename, viewControls, preview, acceptsDrag, beginDrag, previewDrag, dragDrop }: Props) {
  const t = useT();
  const edge = preview?.index === undefined ? preview?.edge : null;
  const boundary = (event: React.DragEvent, index: number) => index + (event.clientX > event.currentTarget.getBoundingClientRect().left + event.currentTarget.getBoundingClientRect().width / 2 ? 1 : 0);
  const over = (event: React.DragEvent, edge: Edge, index?: number) => {
    if (!acceptsDrag(event)) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move";
    previewDrag({ group: node.id, edge, index });
  };
  const leave = (event: React.DragEvent) => {
    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) previewDrag(null);
  };
  const [toolsOpen, setToolsOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [position, setPosition] = useState<Edge>("center");
  const locate = (event: React.DragEvent): Edge => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width, y = (event.clientY - box.top) / box.height;
    return x < 0.22 ? "left" : x > 0.78 ? "right" : y < 0.22 ? "top" : y > 0.78 ? "bottom" : "center";
  };
  return <section className="split-pane dock-group" data-group-id={node.id} data-pane-id={node.active ?? ""} aria-label={t("Terminal group {id}", { id: node.id })}>
    <div className="dock-tabs">
      <div className="dock-tab-strip" role="tablist" aria-label={t("Terminal tabs")}
        onDragOver={event => over(event, "center", node.tabs.length)} onDragLeave={leave}
        onDrop={event => dragDrop(event, node.id, "center", node.tabs.length)}>
      {node.tabs.map((id, index) => <button key={id} type="button" role="tab" aria-selected={node.active === id}
        data-insert={preview?.index === index ? "before" : preview?.index === index + 1 ? "after" : undefined}
        draggable onDragStart={event => { beginDrag(id); event.dataTransfer.setData(PANE_DRAG_TYPE, id); event.dataTransfer.effectAllowed = "move"; }}
        onDragOver={event => over(event, "center", boundary(event, index))}
        onDrop={event => dragDrop(event, node.id, "center", boundary(event, index))}
        data-tab-id={id} title={id} onClick={() => activate(id)}><span className="pane-number" data-pane-number={paneNumber(panes.find(p => p.pane_id === id))}>{paneNumber(panes.find(p => p.pane_id === id))}</span> <AgentMark agent={panes.find(p => p.pane_id === id)?.agent || "shell"} size={14} /> {displayPaneTitle(panes.find(pane => pane.pane_id === id) ?? { pane_id: id } as HerdrPane)}</button>)}
      <span className={`dock-strip-end${preview?.index === node.tabs.length ? " dock-insert-end" : ""}`} aria-hidden="true" />
      </div>
      <div className="dock-tab-actions">
      {viewControls}
      <button type="button" className="dock-add" disabled={busy || !canAdd} aria-label={t("New terminal tab")} title={t("New terminal tab")} onClick={add}><Plus size={16} aria-hidden="true" />{t("Add terminal")}</button>
      {node.active && terminate}
      <button type="button" className="dock-tools-toggle" aria-label={t("Terminal tools")} aria-expanded={toolsOpen} onClick={() => setToolsOpen(value => !value)}><Settings2 size={16} aria-hidden="true" /></button>
      </div>
      {toolsOpen && <div className="dock-tools-panel" role="region" aria-label={t("Terminal tools")} onKeyDown={event => { if (event.key === "Escape") { setToolsOpen(false); event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(".dock-tools-toggle")?.focus(); } }}>
        <div className="dock-tools-heading"><strong>{t("Terminal tools")}</strong><button type="button" aria-label={t("Close")} onClick={() => setToolsOpen(false)}><X size={16} /></button></div>
        <div className="dock-secondary-actions">
          {rename}
          <button type="button" disabled={busy || !canAdd} onClick={() => split("right")}>{t("Split terminal right")}</button>
          <button type="button" disabled={busy || !canAdd} onClick={() => split("bottom")}>{t("Split terminal below")}</button>
          <button type="button" onClick={zoom}>{zoomed ? t("Restore layout") : t("Zoom")}</button>
          {node.active && <button type="button" onClick={() => detach(node.active!)}>{t("Open separate browser view")}</button>}
        </div>
    <details className="dock-keyboard"><summary>{t("Keyboard layout")}</summary>
      <label>{t("Destination group")}<select aria-label={t("Destination group")} value={target} onChange={event => setTarget(event.target.value)}>
        <option value="">{t("Select group")}</option>
        {groupIds.map(id => <option key={id} value={id}>{id}</option>)}
      </select></label>
      <label>{t("Dock position")}<select aria-label={t("Dock position")} value={position} onChange={event => setPosition(event.target.value as Edge)}>
        {["center", "left", "right", "top", "bottom"].map((value, index) => <option key={value} value={value}>{[t("Merge tabs"), t("Left"), t("Right"), t("Top"), t("Bottom")][index]}</option>)}
      </select></label>
      <button type="button" disabled={!target || !node.active} onClick={() => drop(node.active!, target, position)}>{t("Move")}</button>
      <button type="button" disabled={!node.active} onClick={() => drop(node.active!, node.id, "center", Math.max(0, node.tabs.indexOf(node.active!) - 1))}>{t("Move tab earlier")}</button>
      <button type="button" disabled={!node.active} onClick={() => drop(node.active!, node.id, "center", node.tabs.indexOf(node.active!) + 1)}>{t("Move tab later")}</button>
    </details>
    {address}
    {nativeMove}
    {search}
      </div>}
    </div>
    <div className={`dock-drop-body${edge ? ` dock-drop-${edge}` : ""}`} onDragOverCapture={event => over(event, locate(event))}
      onDragLeave={leave}
      onDropCapture={event => dragDrop(event, node.id, locate(event))}>
      {edge && <span className="dock-drop-hint">{edge === "center" ? t("Merge tabs") : t("Split view")}</span>}{children}
    </div>
  </section>;
}
