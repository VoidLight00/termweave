export const WORKSPACE_COLLAPSE_KEY = "termweave:workspace-collapsed:v1";

export const workspaceCollapseId = (machineId: string, workspaceId: string): string =>
  JSON.stringify([machineId, workspaceId]);

/** Store presentation preferences only. Never change a native workspace or pane. */
export function readCollapsedWorkspaces(): Set<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(WORKSPACE_COLLAPSE_KEY) ?? "[]");
    if (!Array.isArray(value)) return new Set();
    return new Set(value.filter((id): id is string => typeof id === "string").slice(-1000));
  } catch { return new Set(); }
}

export function writeCollapsedWorkspaces(value: Set<string>): void {
  try { localStorage.setItem(WORKSPACE_COLLAPSE_KEY, JSON.stringify([...value].slice(-1000))); }
  catch { /* A blocked/full store must not prevent a local expand/collapse. */ }
}
