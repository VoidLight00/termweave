/**
 * What only a real Windows PC can show: its process table as PowerShell answers it, and a
 * session store on its own file system with its own path rules. Everything else about the
 * Windows branches is tested with rows and paths handed in (gjc-runtime.test.ts); these run
 * on the Windows runner of the remote-bundle workflow and nowhere else (#271).
 */
import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gjcSessionFile, storeRelative } from "./gjc-runtime.ts";
import { descendantArgv, windowsProcessTable } from "./windows-processes.ts";

const onWindows = process.platform === "win32";

it.skipIf(!onWindows)("reads this PC's process table: this process, its parent, when it started and what it runs", async () => {
  const rows = await windowsProcessTable(30_000);
  const self = rows.find((row) => row.pid === process.pid);
  expect(self).toBeDefined();
  expect(self!.parent).toBe(process.ppid);
  // ms since 1970, as Date.now() counts: started before now, and not a day ago
  expect(typeof self!.started).toBe("number");
  expect(self!.started!).toBeLessThanOrEqual(Date.now() + 2000);
  expect(self!.started!).toBeGreaterThan(Date.now() - 24 * 60 * 60 * 1000);
  expect((self!.path ?? "").toLowerCase()).toContain("bun");
  // found from its parent the way a pane's program is found from the pane's shell
  expect(descendantArgv(rows, process.ppid).some((argv) => (argv[0] ?? "").toLowerCase() === (self!.path ?? "").toLowerCase())).toBe(true);
}, 40_000);

it.skipIf(!onWindows)("keeps a session file inside its store on a real Windows file system", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "herdr-gjc-native-")));
  try {
    const root = join(home, ".gjc", "agent", "sessions");
    const store = join(root, "v2-project");
    mkdirSync(join(store, "2026-10-01_session"), { recursive: true });
    const session = join(store, "2026-10-01_session.jsonl");
    writeFileSync(session, "{}\n");
    writeFileSync(join(store, "2026-10-01_session", "task.jsonl"), "{}\n");
    expect(root).toContain("\\");
    expect(gjcSessionFile(root, session)).toBe(session);
    // the drive letter's case is not another place, and a subagent's file stands for its session
    const lower = session[0]!.toLowerCase() + session.slice(1);
    const upper = session[0]!.toUpperCase() + session.slice(1);
    expect(gjcSessionFile(root, lower)).toBe(lower);
    expect(gjcSessionFile(root, upper)).toBe(upper);
    expect(gjcSessionFile(root, join(store, "2026-10-01_session", "task.jsonl"))).toBe(session);
    expect(storeRelative(root, session)).toEqual(["v2-project", "2026-10-01_session.jsonl"]);
    for (const outside of [`${root}-evil\\v2-project\\session.jsonl`, `${root}\\..\\sessions-evil\\v2-project\\session.jsonl`, `\\\\server\\share\\session.jsonl`, root]) {
      expect(storeRelative(root, outside)).toBeNull();
      expect(gjcSessionFile(root, outside)).toBeNull();
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
