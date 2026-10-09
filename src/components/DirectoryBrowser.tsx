import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, FileText, Folder, House } from "lucide-react";

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
export function DirectoryBrowser({ start, onPick, onOpenFile }: DirectoryBrowserProps) {
  const t = useT();
  const { fetchDirectories } = useMachineApi();
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [hidden, setHidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const listRef = useRef<HTMLUListElement>(null);

  const open = useCallback(async (path: string, showHidden: boolean, fallbackHome: boolean) => {
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

  return (
    <div className="dir-browser" role="group" aria-label={t("Choose a folder")} aria-busy={loading}>
      <div className="dir-browser-bar">
        <button type="button" className="icon-button" aria-label={t("Parent folder")} title={t("Parent folder")} disabled={!listing?.parent || loading} onClick={() => listing?.parent && void open(listing.parent, hidden, false)}>
          <ArrowUp aria-hidden="true" />
        </button>
        <button type="button" className="icon-button" aria-label={t("Home folder")} title={t("Home folder")} disabled={loading || (listing !== null && listing.path === listing.home)} onClick={() => void open("", hidden, false)}>
          <House aria-hidden="true" />
        </button>
        <span className="dir-browser-path" title={path}><span dir="ltr">{shown}</span></span>
      </div>
      {error !== null ? <p className="dir-browser-note dir-browser-error" role="alert">{error}</p> : (
        <ul className="dir-browser-list" ref={listRef}>
          {listing === null && <li className="dir-browser-note" role="status">{t("Loading…")}</li>}
          {listing?.directories.map((name) => (
            <li key={name}>
              <button type="button" className="dir-browser-item" disabled={loading} onClick={() => void open(childPath(path, name), hidden, false)}>
                <Folder aria-hidden="true" />
                <span>{name}</span>
              </button>
            </li>
          ))}
          {onOpenFile !== undefined && listing?.files?.map((file) => (
            <li key={`file:${file.name}`}>
              <button type="button" className="dir-browser-item is-file" disabled={loading} onClick={() => onOpenFile(childPath(path, file.name))}>
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
          <input type="checkbox" checked={hidden} disabled={loading && listing === null} onChange={(event) => { setHidden(event.target.checked); if (listing) void open(listing.path, event.target.checked, false); }} />
          {t("Show hidden")}
        </label>
        {onPick && <button type="button" className="btn btn-primary" disabled={listing === null || loading} onClick={() => listing && onPick(homeRelative(listing.path, listing.home))}>
          {t("Use this folder")}
        </button>}
      </div>
    </div>
  );
}
