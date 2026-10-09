/**
 * Stable entry for `bun run start` and the herdr plugin (whose PID file records this process).
 * It runs the supervisor from the active release when that release has one, so an update
 * replaces the supervisor too, and falls back to the previous supervisor, then to this
 * checkout's, if a new one exits before it is ready. Keep this file small: it is the one piece
 * an update cannot replace while it runs; only a restart from the source checkout does.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_PORT } from "../shared/protocol.ts";
import { HANDOVER_EXIT, updateStateDir } from "./update-state.ts";

/** The active release's supervisor, when it is still the build of this checkout's revision. */
function releaseSupervisor(root: string, stateDir: string): string | null {
  try {
    const saved = JSON.parse(readFileSync(join(stateDir, "current.json"), "utf8")) as { directory?: unknown; source_revision?: unknown };
    if (typeof saved.directory !== "string" || !saved.directory.startsWith(join(stateDir, "release-"))) return null;
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, windowsHide: true, encoding: "utf8" }).stdout.trim();
    if (saved.source_revision !== head) return null;
    const file = join(saved.directory, "server", "supervisor.ts");
    return existsSync(file) ? file : null;
  } catch { return null; }
}

export async function runManaged(root = resolve(import.meta.dir, "..")) {
  root = resolve(root);
  const stateDir = updateStateDir(root, Number(process.env["PORT"] ?? DEFAULT_PORT));
  const own = join(import.meta.dir, "supervisor.ts");
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let stopping = false;
  const stop = (signal: NodeJS.Signals) => { stopping = true; child?.kill(signal); };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  let previous: string | null = null; // the last supervisor that reached ready
  let fallback = false;
  for (;;) {
    const file: string = fallback ? previous ?? own : releaseSupervisor(root, stateDir) ?? own;
    let ready = false;
    child = Bun.spawn([process.execPath, file], {
      cwd: root, windowsHide: true, stdin: "ignore", stdout: "inherit", stderr: "inherit",
      env: { ...process.env, HERDR_WEB_SOURCE_ROOT: root, ...(fallback ? { HERDR_WEB_SUPERVISOR_FALLBACK: "1" } : {}) },
      ipc(message) { if (message?.type === "supervisor-ready") ready = true; },
    });
    const code = await child.exited;
    if (stopping) process.exit(0);
    if (code === HANDOVER_EXIT) { previous = file; fallback = false; continue; }
    const rescue = previous ?? own;
    if (!ready && !fallback && rescue !== file) {
      console.error(`Supervisor ${file} exited (${code}) before it was ready; falling back to ${rescue}.`);
      fallback = true;
      continue;
    }
    process.exit(code ?? 1);
  }
}

if (import.meta.main) await runManaged();
