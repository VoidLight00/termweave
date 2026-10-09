import { paneStorageId } from "../../shared/machines.ts";
import type { PaneView } from "./actions.ts";
export function initialPaneView(stored: PaneView | null, hasAgent: boolean | null, defaultView: "auto" | "chat" | "terminal"): PaneView {
  if (stored) return stored;
  return defaultView === "chat" && hasAgent !== false ? "chat" : "terminal";
}
// In-memory fallback keeps panes independent when browser storage is unavailable.
const choices = new Map<string, PaneView>();
const key = (machine: string, pane: string) => `termweave:view:${paneStorageId(machine, pane)}`;
export function readPaneView(machine: string, pane: string): PaneView | null {
  const id = key(machine, pane);
  try {
    const stored = window.localStorage.getItem(id);
    if (stored === "chat" || stored === "terminal") return stored;
  } catch {}
  return choices.get(id) ?? null;
}
export function writePaneView(machine: string, pane: string, view: PaneView): void {
  const id = key(machine, pane);
  choices.set(id, view);
  try { window.localStorage.setItem(id, view); } catch {}
}
