/**
 * /api/worktree/*: a terminal's "new terminal in a worktree" and its removal. herdr makes the
 * git worktree from the repo of the pane's folder; a branch and pane are required, a base is
 * optional (null or blank: the branch, or the commit, the pane's checkout is on).
 */
import { basename, dirname, resolve } from "node:path";
import type { WorktreeEntry, WorktreeOpenRequest, WorktreeSource } from "../shared/protocol.ts";
import { type HerdrWorktreeEntry, HerdrError } from "./herdr/client.ts";
import { errorResponse, isJsonObject, jsonResponse } from "./http.ts";

const GIT_TIMEOUT_MS = 5_000;

/** What `git rev-parse` answers in the pane's folder, one line per question. */
export interface WorktreeGitLines {
  /** --show-toplevel */
  toplevel: string;
  /** --path-format=absolute --git-dir */
  gitDir: string;
  /** --path-format=absolute --git-common-dir */
  commonDir: string;
  /** --abbrev-ref HEAD: the branch, or `HEAD` when detached */
  abbrevRef: string;
  /** --short HEAD */
  shortHead: string;
}

/**
 * The checkout a pane's folder sits in. A linked worktree has a git dir of its own under the
 * common one, whose parent is the main checkout: herdr only makes worktrees from there.
 */
export function parseWorktreeSource(paneId: string, cwd: string, lines: WorktreeGitLines): WorktreeSource {
  const checkoutRoot = resolve(lines.toplevel);
  const commonDir = resolve(lines.commonDir);
  const linked = resolve(lines.gitDir) !== commonDir;
  const repoRoot = linked ? dirname(commonDir) : checkoutRoot;
  return {
    pane_id: paneId,
    cwd: resolve(cwd),
    checkout_root: checkoutRoot,
    repo_root: repoRoot,
    repo_name: basename(repoRoot),
    branch: lines.abbrevRef === "HEAD" ? null : lines.abbrevRef,
    head: lines.shortHead,
    linked,
  };
}

/** `git rev-parse <args>` in `cwd`, its output lines; a failure (no repo there) is HerdrError `not_a_git_repository`. */
async function revParse(cwd: string, args: string[]): Promise<string[]> {
  const proc = Bun.spawn(["git", "-C", cwd, "rev-parse", ...args], {
    windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  const [output, errors, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) throw new HerdrError("not_a_git_repository", errors.trim() || `${cwd} is not in a git repository`);
  return output.trimEnd().split(/\r?\n/);
}

export async function resolveWorktreeSource(paneId: string, cwd: string): Promise<WorktreeSource> {
  const [[toplevel, gitDir, commonDir], [abbrevRef], [shortHead]] = await Promise.all([
    revParse(cwd, ["--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"]),
    revParse(cwd, ["--abbrev-ref", "HEAD"]),
    revParse(cwd, ["--short", "HEAD"]),
  ]);
  if (!toplevel || !gitDir || !commonDir || !abbrevRef || !shortHead) throw new HerdrError("not_a_git_repository", `git found no checkout at ${cwd}`);
  return parseWorktreeSource(paneId, cwd, { toplevel, gitDir, commonDir, abbrevRef, shortHead });
}

export interface WorktreeCreateInput {
  pane_id: string;
  branch: string;
  base?: string;
}

export type WorktreeCreateParse = { ok: true; value: WorktreeCreateInput } | { ok: false; code: string; message: string };

export function parseWorktreeCreate(payload: unknown): WorktreeCreateParse {
  if (!isJsonObject(payload)) return { ok: false, code: "invalid_body", message: "request body must be a JSON object" };
  const paneId = typeof payload.pane_id === "string" ? payload.pane_id.trim() : "";
  if (paneId === "") return { ok: false, code: "missing_pane_id", message: "pane_id is required" };
  const branch = typeof payload.branch === "string" ? payload.branch.trim() : "";
  if (branch === "") return { ok: false, code: "missing_branch", message: "branch is required" };
  if (payload.base !== undefined && payload.base !== null && typeof payload.base !== "string") {
    return { ok: false, code: "invalid_base", message: "base must be a string" };
  }
  const base = typeof payload.base === "string" ? payload.base.trim() : "";
  return { ok: true, value: { pane_id: paneId, branch, ...(base === "" ? {} : { base }) } };
}

export type WorktreeOpenParse = { ok: true; value: WorktreeOpenRequest } | { ok: false; code: string; message: string };

export function parseWorktreeOpen(payload: unknown): WorktreeOpenParse {
  if (!isJsonObject(payload)) return { ok: false, code: "invalid_body", message: "request body must be a JSON object" };
  const paneId = typeof payload.pane_id === "string" ? payload.pane_id.trim() : "";
  if (paneId === "") return { ok: false, code: "missing_pane_id", message: "pane_id is required" };
  const path = typeof payload.path === "string" ? payload.path.trim() : "";
  if (path === "") return { ok: false, code: "missing_path", message: "path is required" };
  return { ok: true, value: { pane_id: paneId, path } };
}

/**
 * The linked worktrees of `worktree.list`, the main checkout and a bare repo left out; herdr's
 * forward-slashed Windows paths become the platform's, as the pane folders are.
 */
export function linkedWorktrees(worktrees: readonly HerdrWorktreeEntry[]): WorktreeEntry[] {
  return worktrees.filter((entry) => entry.is_linked_worktree && !entry.is_bare).map((entry) => ({
    path: resolve(entry.path),
    branch: entry.is_detached || !entry.branch ? null : entry.branch,
    open_workspace_id: entry.open_workspace_id ?? null,
    prunable: entry.is_prunable,
  }));
}

/** The linked worktree of `worktree.list` at `path` (in either slash form), as herdr spells it; undefined when the repo has none there. */
export function findLinkedWorktree(worktrees: readonly HerdrWorktreeEntry[], path: string): HerdrWorktreeEntry | undefined {
  const wanted = resolve(path);
  return worktrees.find((entry) => entry.is_linked_worktree && !entry.is_bare && resolve(entry.path) === wanted);
}

/**
 * herdr refusing a worktree (the branch or folder exists, a dirty checkout without force) is a
 * 409 carrying herdr's code unchanged: the client asks again with force on `dirty_worktree_requires_force`.
 */
export function worktreeFailure(error: unknown): Response {
  if (error instanceof HerdrError) return jsonResponse({ error: { code: error.code, message: error.message } }, 409);
  return errorResponse(error);
}
