import type { Machine } from "../../shared/machines.ts";
import type { PaneInfo, WorkspaceInfo } from "../../shared/protocol.ts";

/** Offline rosters are cached: only connected PCs can tell us an agent still needs an answer. */
export function panesNeedingInput(machines: readonly Machine[]): Array<{ machine: Machine; pane: PaneInfo; workspace: WorkspaceInfo }> {
  return machines.flatMap((machine) => {
    if (machine.state !== "connected" || !machine.snapshot) return [];
    const { panes, workspaces } = machine.snapshot;
    return workspaces.flatMap((workspace) => panes
      .filter((pane) => pane.workspace_id === workspace.workspace_id && pane.agent_status === "blocked")
      .map((pane) => ({ machine, pane, workspace })));
  });
}
