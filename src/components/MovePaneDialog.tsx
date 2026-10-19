import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PaneInfo, WorkspaceInfo } from "../../shared/protocol.ts";
import { moveTargets } from "../../shared/paneMove.ts";
import { paneNumber } from "../lib/paneNumber.ts";
import { useT } from "../lib/i18n.ts";
import "./SessionColorDialog.css";

/** Pick a folder, the pane to sit beside, and a side. herdr places it; the dock layout is separate. */
export function MovePaneDialog({ source, panes, workspaces, title, onMove, onClose }: {
  source: PaneInfo; panes: readonly PaneInfo[]; workspaces: readonly WorkspaceInfo[]; title: (pane: PaneInfo) => string;
  onMove: (target: PaneInfo, split: "right" | "down") => Promise<void>; onClose: () => void;
}) {
  const t = useT();
  const targets = moveTargets(panes, source);
  const folders = workspaces.filter(workspace => targets.some(pane => pane.workspace_id === workspace.workspace_id));
  const [folder, setFolder] = useState(folders.find(w => w.workspace_id !== source.workspace_id)?.workspace_id ?? folders[0]?.workspace_id ?? "");
  const beside = targets.filter(pane => pane.workspace_id === folder);
  const [targetId, setTargetId] = useState("");
  const target = beside.find(pane => pane.pane_id === targetId) ?? beside[0];
  const [split, setSplit] = useState<"right" | "down">("right");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    surface.current?.querySelector<HTMLElement>("select")?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    window.addEventListener("keydown", escape, true);
    return () => { window.removeEventListener("keydown", escape, true); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, [onClose]);
  const submit = async () => {
    if (!target || busy) return;
    setBusy(true); setError(null);
    try { await onMove(target, split); onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setBusy(false); }
  };
  const name = `${paneNumber(source)} ${title(source)}`;
  return createPortal(<div className="modal-scrim" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={surface} className="modal move-pane-dialog" role="dialog" aria-modal="true" aria-label={t("Move {name}", { name })}>
      <header className="modal-header"><h2 className="modal-title">{t("Move {name}", { name })}</h2></header>
      <div className="modal-body settings-section">
        {!targets.length ? <p>{t("No other destination tab. Open another workspace or native tab first.")}</p> : <>
          <label>{t("Folder")}<select className="input" value={folder} disabled={busy} onChange={event => { setFolder(event.target.value); setTargetId(""); }}>
            {folders.map(w => <option key={w.workspace_id} value={w.workspace_id}>{w.label}</option>)}
          </select></label>
          <label>{t("Place beside")}<select className="input" value={target?.pane_id ?? ""} disabled={busy} onChange={event => setTargetId(event.target.value)}>
            {beside.map(pane => <option key={pane.pane_id} value={pane.pane_id}>{paneNumber(pane)} {title(pane)}</option>)}
          </select></label>
          <div role="radiogroup" aria-label={t("Side")} className="move-pane-side">
            {(["right", "down"] as const).map(side => <label key={side}><input type="radio" name="move-pane-side" checked={split === side}
              disabled={busy} onChange={() => setSplit(side)} />{side === "right" ? t("Right") : t("Below")}</label>)}
          </div>
        </>}
        {error && <p role="alert">{error}</p>}
      </div>
      <footer className="modal-footer">
        <button className="btn" type="button" onClick={onClose}>{t("Cancel")}</button>
        <button className="btn btn-primary" type="button" disabled={busy || !target} onClick={() => void submit()}>{busy ? t("Moving…") : t("Move terminal")}</button>
      </footer>
    </div>
  </div>, document.body);
}
