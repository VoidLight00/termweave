import { expect, it } from "bun:test";
import type { WorkspaceInfo, WorkspaceWorktreeInfo } from "../../shared/herdr-api.generated.ts";
import { worktreeParents } from "./worktreeTree.ts";

/** a main checkout of repository `app` unless told otherwise; `null` is a folder outside git */
const workspace = (workspace_id: string, worktree: Partial<WorkspaceWorktreeInfo> | null = {}): WorkspaceInfo => ({
  workspace_id, label: workspace_id, number: 1, focused: false, active_tab_id: `${workspace_id}:t1`, agent_status: "idle", pane_count: 1, tab_count: 1,
  worktree: worktree && { checkout_path: `C:/work/${workspace_id}`, is_linked_worktree: false, repo_key: "app", repo_name: "app", repo_root: "C:/work/app", ...worktree },
});

it("hangs every linked worktree under the main checkout of its repository", () => {
  const parents = worktreeParents([
    workspace("main", { is_linked_worktree: false }),
    workspace("feat-a", { is_linked_worktree: true }),
    workspace("feat-b", { is_linked_worktree: true }),
  ]);
  expect([...parents]).toEqual([["feat-a", "main"], ["feat-b", "main"]]);
});

it("finds the main checkout even when it is listed after its worktree", () => {
  expect([...worktreeParents([workspace("feat-a", { is_linked_worktree: true }), workspace("main")])]).toEqual([["feat-a", "main"]]);
});

it("takes the first main checkout when one repository is open twice", () => {
  expect(worktreeParents([workspace("main"), workspace("again"), workspace("feat-a", { is_linked_worktree: true })]).get("feat-a")).toBe("main");
});

it("leaves out a linked worktree whose main checkout is not open", () => {
  expect(worktreeParents([workspace("feat-a", { is_linked_worktree: true }), workspace("other", { repo_key: "other" })]).size).toBe(0);
});

it("keeps two repositories apart", () => {
  const parents = worktreeParents([
    workspace("app"),
    workspace("lib", { repo_key: "lib" }),
    workspace("lib-fix", { is_linked_worktree: true, repo_key: "lib" }),
    workspace("app-fix", { is_linked_worktree: true }),
  ]);
  expect([...parents]).toEqual([["lib-fix", "lib"], ["app-fix", "app"]]);
});

it("ignores workspaces outside git", () => {
  const { worktree: _, ...older } = workspace("older");
  expect(worktreeParents([workspace("plain", null), older, workspace("feat-a", { is_linked_worktree: true })]).size).toBe(0);
  expect(worktreeParents([workspace("plain", null), older, workspace("main"), workspace("feat-a", { is_linked_worktree: true })]).get("feat-a")).toBe("main");
});
