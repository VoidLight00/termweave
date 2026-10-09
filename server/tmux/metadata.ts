import {metadataProcess} from "./metadata-process.ts";

export interface GitMetadata { branch: string | null; dirty: boolean; ahead: number; behind: number }

/** Do not run repository-provided fsmonitor hooks or refresh its index. No network access. */
export async function gitMetadata(cwd: string): Promise<GitMetadata | null> {
  const git = Bun.which("git");
  if (!git || !cwd.startsWith("/") || /[\x00-\x1f\x7f]/.test(cwd)) return null;
  try {
    const result = await metadataProcess([
      git, "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-C", cwd,
      "status", "--porcelain=v2", "--branch", "--untracked-files=normal",
    ], {...process.env, GIT_OPTIONAL_LOCKS:"0", GIT_DIR:undefined, GIT_WORK_TREE:undefined, GIT_INDEX_FILE:undefined, GIT_COMMON_DIR:undefined});
    if (!result || result.code) return null;
    const lines = result.out.split("\n");
    const branch = lines.find(line => line.startsWith("# branch.head "))?.slice(14) ?? null;
    const counts = /^# branch\.ab \+(\d+) -(\d+)$/m.exec(result.out);
    return {branch:branch === "(detached)" ? null : branch, dirty:lines.some(line => /^[12u?] /.test(line)), ahead:Number(counts?.[1] ?? 0), behind:Number(counts?.[2] ?? 0)};
  } catch { return null; }
}
