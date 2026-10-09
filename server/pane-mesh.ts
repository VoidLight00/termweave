import { autoPaneLabel, autoPaneNumber } from "../shared/pane-label.ts";
import type { CreatedPane } from "./collector.ts";

interface MeshPane { pane_id: string; workspace_id: string; label?: string | null }

/** The smallest "pane N" no pane of the workspace carries yet. */
export function nextLabel(panes: readonly MeshPane[], workspaceId: string): string {
  const used = new Set<number>();
  for (const pane of panes) {
    const number = pane.workspace_id === workspaceId ? autoPaneNumber(pane.label) : null;
    if (number !== null) used.add(number);
  }
  let number = 1;
  while (used.has(number)) number++;
  return autoPaneLabel(number);
}

export interface PaneMeshDeps {
  snapshot: () => Promise<{ panes: readonly MeshPane[] }>;
  rename: (paneId: string, label: string) => Promise<void>;
  /** asked for every pane, so a switch (TERMWEAVE_PANE_MESH=0) takes effect at once */
  enabled: () => boolean;
}

/**
 * Names every new pane that has no label of its own. Panes that already exist are left as
 * they are: only a `pane_created` frame names one. One pane at a time, so two panes opened
 * together get two numbers.
 */
export function createPaneMesh(deps: PaneMeshDeps): { onPaneCreated: (pane: CreatedPane) => Promise<void> } {
  let queue: Promise<void> = Promise.resolve();
  return {
    onPaneCreated(pane) {
      if (pane.label !== null || !deps.enabled()) return queue;
      queue = queue.then(async () => {
        try {
          const { panes } = await deps.snapshot();
          const current = panes.find((candidate) => candidate.pane_id === pane.paneId);
          // closed already, or named by someone while this waited its turn
          if (!current || current.label) return;
          await deps.rename(pane.paneId, nextLabel(panes, pane.workspaceId));
        } catch (error) {
          console.error(`pane mesh: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
      return queue;
    },
  };
}
