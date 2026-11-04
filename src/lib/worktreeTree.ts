import type { WorkspaceInfo } from "../../shared/herdr-api.generated.ts";

/**
 * Each linked git worktree workspace and the workspace of its main checkout (the first one of the
 * same repository that is not a linked worktree). A worktree whose main checkout is not open in
 * herdr has no parent and stays out of the map.
 */
export function worktreeParents(workspaces: readonly WorkspaceInfo[]): Map<string, string> {
  const sources = new Map<string, string>();
  for (const workspace of workspaces) {
    const worktree = workspace.worktree;
    if (worktree && !worktree.is_linked_worktree && !sources.has(worktree.repo_key)) sources.set(worktree.repo_key, workspace.workspace_id);
  }
  const parents = new Map<string, string>();
  for (const workspace of workspaces) {
    const worktree = workspace.worktree;
    const source = worktree?.is_linked_worktree === true ? sources.get(worktree.repo_key) : undefined;
    if (source !== undefined) parents.set(workspace.workspace_id, source);
  }
  return parents;
}
