import { useEffect } from "react";
import { X } from "lucide-react";

import { DirectoryBrowser } from "./DirectoryBrowser.tsx";
import { useT } from "../lib/i18n.ts";

export interface FilesDialogProps {
  /** the folder to open at: the pane's own */
  start: string;
  /** a file is open above this dialog: Escape belongs to the viewer, which closes first */
  viewing: boolean;
  onOpenFile: (path: string) => void;
  onClose: () => void;
}

/** The files of the pane's folder (and any other), each opened in the file viewer. */
export function FilesDialog({ start, viewing, onOpenFile, onClose }: FilesDialogProps) {
  const t = useT();
  useEffect(() => {
    if (viewing) return;
    const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, viewing]);
  return (
    <div className="modal-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal files-dialog" role="dialog" aria-modal="true" aria-labelledby="files-dialog-title">
        <header className="modal-header">
          <h2 className="modal-title" id="files-dialog-title">{t("Files")}</h2>
          <button type="button" className="icon-button" aria-label={t("Close files")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body">
          <DirectoryBrowser start={start} onOpenFile={onOpenFile} />
        </div>
      </section>
    </div>
  );
}
