import type { PaneInfo, WorkspaceInfo } from "../../shared/protocol.ts";

export interface DirectoryGroup {
  key: string;
  path: string | null;
  workspaces: Array<{ workspace: WorkspaceInfo; panes: PaneInfo[] }>;
  paneCount: number;
}

/** Lexical paths only: the browser cannot resolve a remote PC's symlinks or filesystem case. */
export function directoryPath(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const path = /^[A-Za-z]:[\\/]|^\\\\/u.test(cwd) ? cwd.replace(/\\/g, "/") : cwd;
  if (/^[A-Za-z]:\/+$/u.test(path)) return `${path.slice(0, 2)}/`;
  return path.replace(/\/+$/, "") || "/";
}

/** Called separately for each PC; unknown directories stay with their own workspace. */
export function groupDirectories(workspaces: WorkspaceInfo[], panes: PaneInfo[]): DirectoryGroup[] {
  const byWorkspace = new Map<string, PaneInfo[]>();
  for (const pane of panes) {
    const siblings = byWorkspace.get(pane.workspace_id) ?? [];
    siblings.push(pane);
    byWorkspace.set(pane.workspace_id, siblings);
  }
  const groups = new Map<string, DirectoryGroup>();
  for (const workspace of workspaces) {
    for (const pane of byWorkspace.get(workspace.workspace_id) ?? []) {
      const path = directoryPath(pane.cwd);
      const key = path === null ? `workspace:${workspace.workspace_id}` : `directory:${path}`;
      let group = groups.get(key);
      if (!group) {
        group = { key, path, workspaces: [], paneCount: 0 };
        groups.set(key, group);
      }
      let entry = group.workspaces.find((entry) => entry.workspace.workspace_id === workspace.workspace_id);
      if (!entry) {
        entry = { workspace, panes: [] };
        group.workspaces.push(entry);
      }
      entry.panes.push(pane);
      group.paneCount++;
    }
  }
  return [...groups.values()];
}
