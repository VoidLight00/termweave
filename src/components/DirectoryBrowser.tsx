import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, FileText, Folder, FolderPlus, House } from "lucide-react";

import "./DirectoryBrowser.css";

import type { DirectoryListing } from "../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { formatBytes } from "../lib/bridgeProgress.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { useT } from "../lib/i18n.ts";

export interface DirectoryBrowserProps {
  /** where to open: the path typed so far (absolute, `~` or `~/…`); empty or unreadable opens home */
  start: string;
  /** the folder chosen, in the dialog's own syntax (`~/…` inside home); without it there is no "Use this folder" */
  onPick?: (path: string) => void;
  onBusyChange?: (busy: boolean) => void;
  /** lists files too, and opens the one clicked (its absolute path) */
  onOpenFile?: (path: string) => void;
}

/** `~/…` for a path inside home, as the directory field is usually typed. */
export function homeRelative(path: string, home: string): string {
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

function childPath(parent: string, name: string): string {
  return parent.endsWith("/") ? `${parent}${name}` : `${parent}/${name}`;
}

/**
 * A folder browser for the new-session dialog: one directory at a time, fetched from the
 * PC the session starts on. Nothing is kept but the folder shown now.
 */
export function DirectoryBrowser({ start, onPick, onOpenFile, onBusyChange }: DirectoryBrowserProps) {
  const t = useT();
  const { fetchDirectories, createProjectDirectory } = useMachineApi();
  const [creating, setCreating] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [saving, setSaving] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [hidden, setHidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const listRef = useRef<HTMLUListElement>(null);

  const open = useCallback(async (path: string, showHidden: boolean, fallbackHome: boolean) => {
    setCreating(false);
    setCreateError(null);
    const id = ++request.current;
    setLoading(true);
    try {
      const next = await fetchDirectories(path, showHidden, onOpenFile !== undefined);
      if (id !== request.current) return;
      setListing(next);
      setError(null);
      listRef.current?.scrollTo({ top: 0 });
    } catch (reason: unknown) {
      if (id !== request.current) return;
      // a path typed half-way opens home instead of an error
      if (fallbackHome && reason instanceof ApiError && reason.code === "invalid_cwd") return void open("", showHidden, false);
      setError(reason instanceof ApiError && reason.status === 404
        ? t("This PC's bridge cannot browse folders yet. Type the path instead.")
        : reason instanceof ApiError && reason.code === "invalid_cwd" ? t("This folder cannot be opened.") : t("Folders could not be loaded."));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [fetchDirectories]);

  useEffect(() => { void open(start, false, true); }, []);

  const path = listing?.path ?? "";
  const shown = listing ? homeRelative(listing.path, listing.home) : start || "~";

  const createFolder = async () => {
    if (!listing || saving || !folderName.trim()) return;
    setSaving(true);
    onBusyChange?.(true);
    setCreateError(null);
    try {
      const result = await createProjectDirectory(listing.path, folderName.trim());
      onPick?.(homeRelative(result.path, listing.home));
    } catch (reason) {
      const code = reason instanceof ApiError ? reason.code : "";
      setCreateError(t(code === "folder_exists" ? "A folder or file with this name already exists."
        : code === "invalid_folder_name" ? "Enter a folder name without path separators or reserved characters."
        : code === "invalid_cwd" ? "This folder cannot be opened."
        : reason instanceof ApiError && reason.status === 404 ? "Update this PC's bridge to create folders."
        : "The project folder could not be created. Check write permissions."));
    } finally { setSaving(false); onBusyChange?.(false); }
  };

  return (
    <div className="dir-browser" role="group" aria-label={t("Choose a folder")} aria-busy={loading}>
      <div className="dir-browser-bar">
        <button type="button" className="icon-button" aria-label={t("Parent folder")} title={t("Parent folder")} disabled={!listing?.parent || loading || saving} onClick={() => listing?.parent && void open(listing.parent, hidden, false)}>
          <ArrowUp aria-hidden="true" />
        </button>
        <button type="button" className="icon-button" aria-label={t("Home folder")} title={t("Home folder")} disabled={loading || saving || (listing !== null && listing.path === listing.home)} onClick={() => void open("", hidden, false)}>
          <House aria-hidden="true" />
        </button>
        <span className="dir-browser-path" title={path}><span dir="ltr">{shown}</span></span>
        {onPick && <button type="button" className="btn" disabled={!listing || loading || saving} aria-expanded={creating} onClick={() => { setCreating(!creating); setCreateError(null); }}>
          <FolderPlus aria-hidden="true" />{t("New project folder")}
        </button>}
      </div>
      {creating && <div className="dir-browser-create" onKeyDown={(event) => {
        if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); if (!event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) void createFolder(); }
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!saving) setCreating(false); }
      }}>
        <label className="field-label" htmlFor="project-folder-name">{t("Project folder name")}</label>
        <input id="project-folder-name" className="input" autoFocus autoComplete="off" maxLength={255} value={folderName} disabled={saving} onChange={(event) => { setFolderName(event.target.value); setCreateError(null); }} />
        <p className="field-hint">{t("Create an empty folder in {path} and select it.", { path: shown })}</p>
        {createError && <p className="dir-browser-error" role="alert">{createError}</p>}
        <div className="dir-browser-create-actions">
          <button type="button" className="btn" disabled={saving} onClick={() => setCreating(false)}>{t("Cancel")}</button>
          <button type="button" className="btn btn-primary" disabled={saving || loading || !folderName.trim()} onClick={() => void createFolder()}>{t(saving ? "Creating folder…" : "Create and select")}</button>
        </div>
      </div>}
      {error !== null ? <p className="dir-browser-note dir-browser-error" role="alert">{error}</p> : (
        <ul className="dir-browser-list" ref={listRef}>
          {listing === null && <li className="dir-browser-note" role="status">{t("Loading…")}</li>}
          {listing?.directories.map((name) => (
            <li key={name}>
              <button type="button" className="dir-browser-item" disabled={loading || saving} onClick={() => void open(childPath(path, name), hidden, false)}>
                <Folder aria-hidden="true" />
                <span>{name}</span>
              </button>
            </li>
          ))}
          {onOpenFile !== undefined && listing?.files?.map((file) => (
            <li key={`file:${file.name}`}>
              <button type="button" className="dir-browser-item is-file" disabled={loading || saving} onClick={() => onOpenFile(childPath(path, file.name))}>
                <FileText aria-hidden="true" />
                <span>{file.name}</span>
                <span className="dir-browser-size">{formatBytes(file.size)}</span>
              </button>
            </li>
          ))}
          {listing !== null && listing.directories.length === 0 && (listing.files ?? []).length === 0 && <li className="dir-browser-note">{t(onOpenFile ? "Nothing here" : "No folders here")}</li>}
          {listing?.truncated && <li className="dir-browser-note">{t("Showing the first {n} folders; type the rest of the path to go further.", { n: listing.directories.length })}</li>}
        </ul>
      )}
      <div className="dir-browser-footer">
        <label className="dir-browser-hidden">
          <input type="checkbox" checked={hidden} disabled={saving || (loading && listing === null)} onChange={(event) => { setHidden(event.target.checked); if (listing) void open(listing.path, event.target.checked, false); }} />
          {t("Show hidden")}
        </label>
        {onPick && <button type="button" className="btn btn-primary" disabled={listing === null || loading || saving} onClick={() => listing && onPick(homeRelative(listing.path, listing.home))}>
          {t("Use this folder")}
        </button>}
      </div>
    </div>
  );
}
