import { groups, type Layout } from "./dockLayout.ts";

export const PANE_DRAG_TYPE = "application/x-herdr-pane";
export type DockPreview = { group: string; edge: "center" | "left" | "right" | "top" | "bottom"; index?: number };

/** The MIME alone is not authority: only a title drag started in this mounted workspace is valid. */
export function validDockDrag(tree: Layout, roster: readonly string[], local: string | null, types: readonly string[], payload?: string): local is string {
  return !!local && types.includes(PANE_DRAG_TYPE) && !types.includes("Files") &&
    roster.includes(local) && groups(tree).some(node => node.tabs.includes(local)) &&
    (payload === undefined || payload === local);
}

/** Convert a boundary in the original strip to dock's post-removal insertion index. */
export function dockInsertion(tabs: readonly string[], tab: string, boundary: number): number {
  const source = tabs.indexOf(tab);
  const at = Math.max(0, Math.min(tabs.length, boundary));
  return source >= 0 && source < at ? at - 1 : at;
}
