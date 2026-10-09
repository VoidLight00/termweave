import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { updateStateDir } from "../server/update-state.ts";

/** The plugin checkout survives updates; pane entrypoints must follow its active release. */
export function activePluginScript(root: string, port: number, stateDir: string): string {
  const own = join(resolve(root), "scripts", "plugin.ts");
  try {
    const updates = updateStateDir(root, port, stateDir);
    const saved = JSON.parse(readFileSync(join(updates, "current.json"), "utf8"));
    const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, windowsHide: true, encoding: "utf8", timeout: 3000 });
    if (revision.status !== 0 || saved.source_revision !== revision.stdout.trim() || typeof saved.directory !== "string") return own;
    const directory = realpathSync(saved.directory);
    if (dirname(directory) !== realpathSync(updates) || !basename(directory).startsWith("release-")) return own;
    const file = join(directory, "scripts", "plugin.ts");
    return existsSync(file) && realpathSync(file).startsWith(directory + sep) ? file : own;
  } catch { return own; }
}
