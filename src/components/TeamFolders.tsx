import { useState, type ReactNode } from "react";
import { ChevronRight, Folder, Pencil, Plus, X } from "lucide-react";
import type { PaneInfo } from "../../shared/protocol.ts";
import { browserColorStorage } from "../lib/sessionColor.ts";
import { useT } from "../lib/i18n.ts";
import { addTeamFolder, assignTeamPane, readTeamFolders, removeTeamFolder, teamFolderPath, teamFoldersKey, writeTeamFolders, type TeamFolders as FolderState } from "../lib/teamFolders.ts";
import "./TeamFolders.css";

interface Props {
  machineId: string;
  workspaceId: string;
  panes: PaneInfo[];
  renderPane: (pane: PaneInfo) => ReactNode;
  paneTitle: (pane: PaneInfo) => string;
}

/** Browser-local organization, scoped to the PC and native workspace, not filesystem folders. */
export function TeamFolders({ machineId, workspaceId, panes, renderPane, paneTitle }: Props) {
  const t = useT();
  const key = teamFoldersKey(machineId, workspaceId);
  const [state, setState] = useState(() => readTeamFolders(browserColorStorage(), key));
  const [editor, setEditor] = useState<{ id?: string; parentId: string | null; name: string } | null>(null);
  const [storageError, setStorageError] = useState(false);
  const save = (next: FolderState): void => {
    setStorageError(!writeTeamFolders(browserColorStorage(), key, next));
    setState(next);
  };
  const submit = (): void => {
    if (!editor?.name.trim()) return;
    save(editor.id ? { ...state, folders: state.folders.map(f => f.id === editor.id ? { ...f, name: editor.name.trim() } : f) }
      : addTeamFolder(state, crypto.randomUUID(), editor.name, editor.parentId));
    setEditor(null);
  };
  const paneRows = (folderId: string | null): ReactNode => panes.filter(pane =>
    (pane.terminal_id ? state.assignments[pane.terminal_id] ?? null : null) === folderId).map(pane => (
    <div className="team-pane" key={pane.terminal_id || pane.pane_id}>
      {renderPane(pane)}
      {state.folders.length > 0 && pane.terminal_id && <label className="team-assignment">
        <select aria-label={t("Team folder for {name}", { name: paneTitle(pane) })} value={state.assignments[pane.terminal_id] ?? ""} onChange={event => save(assignTeamPane(state, pane.terminal_id!, event.target.value || null))}>
          <option value="">{t("No team folder")}</option>
          {state.folders.map(folder => <option key={folder.id} value={folder.id}>{teamFolderPath(state, folder.id)}</option>)}
        </select>
      </label>}
    </div>
  ));
  const folders = (parentId: string | null): ReactNode => state.folders.filter(f => f.parentId === parentId).map(folder => {
    const contentsId = `team-folder-${encodeURIComponent(key)}-${encodeURIComponent(folder.id)}`;
    return <section className="team-folder" key={folder.id} aria-label={folder.name}>
      <div className="team-folder-header">
        <button type="button" className="team-folder-toggle" aria-expanded={!folder.collapsed} aria-controls={contentsId}
          onClick={() => save({ ...state, folders: state.folders.map(f => f.id === folder.id ? { ...f, collapsed: !f.collapsed } : f) })}>
          <ChevronRight aria-hidden="true" /><Folder aria-hidden="true" /><span>{folder.name}</span>
        </button>
        <button type="button" className="sidebar-row-action" aria-label={t("Add team folder in {name}", { name: folder.name })}
          onClick={() => setEditor({ parentId: folder.id, name: "" })}><Plus aria-hidden="true" /></button>
        <button type="button" className="sidebar-row-action" aria-label={t("Rename team folder {name}", { name: folder.name })}
          onClick={() => setEditor({ id: folder.id, parentId: folder.parentId, name: folder.name })}><Pencil aria-hidden="true" /></button>
        <button type="button" className="sidebar-row-action" aria-label={t("Remove team folder {name} without closing terminals", { name: folder.name })}
          onClick={() => save(removeTeamFolder(state, folder.id))}><X aria-hidden="true" /></button>
      </div>
      <div className="team-folder-contents" id={contentsId} hidden={folder.collapsed}>
        {paneRows(folder.id)}{folders(folder.id)}
      </div>
    </section>;
  });
  return <div className="team-folders">
    <button type="button" className="team-folder-add" onClick={() => setEditor({ parentId: null, name: "" })}>
      <Plus aria-hidden="true" />{t("Add team folder")}
    </button>
    {editor && <form className="team-folder-editor" onSubmit={event => { event.preventDefault(); submit(); }}>
      <label>{t("Team folder name")}<input className="input" autoFocus value={editor.name} required maxLength={120}
        onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); setEditor(null); } }}
        onChange={event => setEditor({ ...editor, name: event.target.value })} /></label>
      <button type="submit" className="btn">{t("Save")}</button>
      <button type="button" className="btn" onClick={() => setEditor(null)}>{t("Cancel")}</button>
    </form>}
    {storageError && <p className="sidebar-inline-error" role="alert">{t("Team folders are not saved. Browser storage is unavailable.")}</p>}
    {paneRows(null)}{folders(null)}
  </div>;
}
