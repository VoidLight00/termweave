import { expect, it } from "bun:test";
import { join, resolve } from "node:path";
import type { HerdrWorktreeEntry } from "./herdr/client.ts";
import { findLinkedWorktree, linkedWorktrees, parseWorktreeCreate, parseWorktreeOpen, parseWorktreeSource } from "./worktree.ts";

const repo = resolve("/work/teamweave");

it("trims the branch and the pane of a valid request", () => {
  expect(parseWorktreeCreate({ pane_id: " w1:p1 ", branch: "  feat-a\t" })).toEqual({ ok: true, value: { pane_id: "w1:p1", branch: "feat-a" } });
  expect(parseWorktreeCreate({ pane_id: "w1:p1", branch: "feat-a", base: " main " })).toEqual({ ok: true, value: { pane_id: "w1:p1", branch: "feat-a", base: "main" } });
});

it("rejects an empty, blank or non-string branch", () => {
  for (const branch of [undefined, "", "   ", 7, null]) {
    expect(parseWorktreeCreate({ pane_id: "w1:p1", branch })).toMatchObject({ ok: false, code: "missing_branch" });
  }
});

it("rejects a missing or blank pane_id", () => {
  for (const pane_id of [undefined, "", "  ", 3]) {
    expect(parseWorktreeCreate({ pane_id, branch: "feat-a" })).toMatchObject({ ok: false, code: "missing_pane_id" });
  }
});

it("drops a null or blank base", () => {
  for (const base of [null, "", "   "]) {
    expect(parseWorktreeCreate({ pane_id: "w1:p1", branch: "feat-a", base })).toEqual({ ok: true, value: { pane_id: "w1:p1", branch: "feat-a" } });
  }
});

it("rejects a base that is not a string", () => {
  for (const base of [1, true, {}, ["main"]]) {
    expect(parseWorktreeCreate({ pane_id: "w1:p1", branch: "feat-a", base })).toMatchObject({ ok: false, code: "invalid_base" });
  }
});

it("reads a main checkout on a branch as its own repo", () => {
  const lines = { toplevel: repo, gitDir: join(repo, ".git"), commonDir: join(repo, ".git"), abbrevRef: "dev", shortHead: "bb75438" };
  expect(parseWorktreeSource("w1:p1", join(repo, "server"), lines)).toEqual({
    pane_id: "w1:p1", cwd: join(repo, "server"), checkout_root: repo, repo_root: repo, repo_name: "teamweave", branch: "dev", head: "bb75438", linked: false,
  });
});

it("has no branch on a detached HEAD", () => {
  const lines = { toplevel: repo, gitDir: join(repo, ".git"), commonDir: join(repo, ".git"), abbrevRef: "HEAD", shortHead: "bb75438" };
  expect(parseWorktreeSource("w1:p1", repo, lines)).toMatchObject({ branch: null, head: "bb75438", linked: false });
});

it("takes a linked worktree's repo from the parent of the common git dir", () => {
  const checkout = resolve("/work/teamweave-feat-a");
  const lines = { toplevel: checkout, gitDir: join(repo, ".git", "worktrees", "teamweave-feat-a"), commonDir: join(repo, ".git"), abbrevRef: "feat-a", shortHead: "1a2b3c4" };
  expect(parseWorktreeSource("w2:p1", checkout, lines)).toEqual({
    pane_id: "w2:p1", cwd: checkout, checkout_root: checkout, repo_root: repo, repo_name: "teamweave", branch: "feat-a", head: "1a2b3c4", linked: true,
  });
});

// git on Windows answers with forward slashes, herdr's cwd has backslashes: both read as the same paths
it.skipIf(process.platform !== "win32")("turns git's forward-slashed Windows paths into the platform's", () => {
  const lines = { toplevel: "D:/work/teamweave-feat-a", gitDir: "D:/work/teamweave/.git/worktrees/teamweave-feat-a", commonDir: "D:/work/teamweave/.git", abbrevRef: "feat-a", shortHead: "1a2b3c4" };
  expect(parseWorktreeSource("w2:p1", "D:\\work\\teamweave-feat-a\\src", lines)).toEqual({
    pane_id: "w2:p1", cwd: "D:\\work\\teamweave-feat-a\\src", checkout_root: "D:\\work\\teamweave-feat-a", repo_root: "D:\\work\\teamweave", repo_name: "teamweave", branch: "feat-a", head: "1a2b3c4", linked: true,
  });
  const main = { ...lines, toplevel: "D:/work/teamweave", gitDir: "D:/work/teamweave/.git", abbrevRef: "dev" };
  expect(parseWorktreeSource("w1:p1", "D:\\work\\teamweave", main)).toMatchObject({ checkout_root: "D:\\work\\teamweave", repo_root: "D:\\work\\teamweave", linked: false });
});

it("rejects a body that is not a JSON object", () => {
  for (const body of [null, "feat-a", ["w1:p1", "feat-a"]]) {
    expect(parseWorktreeCreate(body)).toMatchObject({ ok: false, code: "invalid_body" });
    expect(parseWorktreeOpen(body)).toMatchObject({ ok: false, code: "invalid_body" });
  }
});

it("trims the pane and the path of an open request", () => {
  expect(parseWorktreeOpen({ pane_id: " w1:p1 ", path: " /work/wt/feat-a\t" })).toEqual({ ok: true, value: { pane_id: "w1:p1", path: "/work/wt/feat-a" } });
});

it("rejects an open request without a pane or a path", () => {
  for (const pane_id of [undefined, "", "  ", 3]) {
    expect(parseWorktreeOpen({ pane_id, path: "/work/wt/feat-a" })).toMatchObject({ ok: false, code: "missing_pane_id" });
  }
  for (const path of [undefined, "", "   ", 7, null]) {
    expect(parseWorktreeOpen({ pane_id: "w1:p1", path })).toMatchObject({ ok: false, code: "missing_path" });
  }
});

const listed = (entry: Partial<HerdrWorktreeEntry> & { path: string }): HerdrWorktreeEntry => ({
  is_bare: false, is_detached: false, is_linked_worktree: true, is_prunable: false, label: null, ...entry,
});

it("lists only the linked worktrees, with their branch, workspace and missing folder", () => {
  const featA = resolve("/work/wt/feat-a");
  const orph = resolve("/work/wt/orph");
  const gone = resolve("/work/wt/gone");
  expect(linkedWorktrees([
    listed({ path: repo, branch: "dev", is_linked_worktree: false, open_workspace_id: "w1" }),
    listed({ path: resolve("/work/bare"), is_bare: true }),
    listed({ path: featA, branch: "feat-a", open_workspace_id: "w2" }),
    listed({ path: orph, branch: "orph" }),
    listed({ path: resolve("/work/wt/detached"), branch: null, is_detached: true }),
    listed({ path: gone, branch: "gone", is_prunable: true }),
  ])).toEqual([
    { path: featA, branch: "feat-a", open_workspace_id: "w2", prunable: false },
    { path: orph, branch: "orph", open_workspace_id: null, prunable: false },
    { path: resolve("/work/wt/detached"), branch: null, open_workspace_id: null, prunable: false },
    { path: gone, branch: "gone", open_workspace_id: null, prunable: true },
  ]);
});

it("finds a linked worktree by its path, never the main checkout", () => {
  const orph = listed({ path: resolve("/work/wt/orph"), branch: "orph" });
  const main = listed({ path: repo, branch: "dev", is_linked_worktree: false });
  expect(findLinkedWorktree([main, orph], resolve("/work/wt/orph"))).toBe(orph);
  expect(findLinkedWorktree([main, orph], repo)).toBeUndefined();
  expect(findLinkedWorktree([main, orph], resolve("/work/wt/other"))).toBeUndefined();
});

// herdr lists `C:/…`, the client sends back the backslashed path it was shown
it.skipIf(process.platform !== "win32")("reads herdr's forward-slashed Windows paths as the platform's", () => {
  const orph = listed({ path: "C:/Users/x/.herdr/worktrees/wt-p/orph", branch: "orph" });
  expect(linkedWorktrees([orph])).toEqual([{ path: "C:\\Users\\x\\.herdr\\worktrees\\wt-p\\orph", branch: "orph", open_workspace_id: null, prunable: false }]);
  expect(findLinkedWorktree([orph], "C:\\Users\\x\\.herdr\\worktrees\\wt-p\\orph")).toBe(orph);
});
