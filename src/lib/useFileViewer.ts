import { useCallback, useEffect, useRef, useState } from "react";

interface FilePreview {
  path: string;
  paneId: string | null;
  machineId: string;
}
const HISTORY_KEY = "termweave:file-preview";

function previewFromState(state: unknown): FilePreview | null {
  if (state === null || typeof state !== "object") return null;
  const preview = (state as Record<string, unknown>)[HISTORY_KEY];
  if (preview === null || typeof preview !== "object") return null;
  const value = preview as Record<string, unknown>;
  return typeof value.path === "string" && typeof value.machineId === "string" &&
    (value.paneId === null || typeof value.paneId === "string") ? { path: value.path, machineId: value.machineId, paneId: value.paneId } : null;
}

/** Android Back traverses history: a preview must be an entry above the chat, not just a modal. */
export function useFileViewer() {
  const [viewing, setViewing] = useState(() => previewFromState(window.history.state));
  const closing = useRef(false);

  useEffect(() => {
    const onPop = (event: PopStateEvent): void => {
      closing.current = false;
      // Forward restores the preview with its original PC/pane, including after reload.
      setViewing(previewFromState(event.state));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const openFile = useCallback((preview: FilePreview) => {
    if (closing.current) return;
    const state = { ...window.history.state, [HISTORY_KEY]: preview };
    // Choosing a different file inside an open preview must not add another Back step.
    if (previewFromState(window.history.state)) window.history.replaceState(state, "");
    else window.history.pushState(state, "");
    setViewing(preview);
  }, []);

  const closeFile = useCallback(() => {
    if (closing.current) return;
    if (previewFromState(window.history.state)) {
      closing.current = true;
      // X, Escape and scrim clicks consume the same entry as the system Back button.
      window.history.back();
    } else setViewing(null);
  }, []);

  return { viewing, openFile, closeFile };
}
