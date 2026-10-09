import type { HerdrPane } from "../../shared/protocol.ts";

/** A missing selection is not permission to jump to another workspace. */
export function adjacentWorkspacePane(panes: readonly HerdrPane[], selectedId: string | null, direction: -1 | 1): string | null {
  const selected = panes.find(pane => pane.pane_id === selectedId);
  if (!selected) return null;
  const siblings = panes.filter(pane => pane.workspace_id === selected.workspace_id);
  const index = siblings.findIndex(pane => pane.pane_id === selectedId);
  return siblings[(index + direction + siblings.length) % siblings.length]?.pane_id ?? null;
}
