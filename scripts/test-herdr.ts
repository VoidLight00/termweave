/**
 * Tests talk to their own herdr: a headless server for the named session
 * `herdr-web-ui-test` (HERDR_TEST_SESSION overrides), started on first use and stopped when its owning process exits. The workspaces, panes and agents the tests create never
 * show in the herdr the user works in.
 *
 * `bun test` loads this first (bunfig.toml); the browser and SSH scripts import it.
 * HERDR_TEST_LIVE=1 is forbidden. Without a herdr binary nothing changes,
 * so CI runs as before.
 */
import { assertIsolatedSocket, isolateTestEnvironment } from './test-isolation.ts';
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ping, sessionSnapshot, workspaceCreate } from "../server/herdr/client.ts";

if (process.env.HERDR_TEST_LIVE === '1') throw new Error('Production/live tests are forbidden');
if (process.env.HERDR_TEST_MODE !== 'unit') isolateTestEnvironment();
export const TEST_SESSION = process.env["HERDR_TEST_SESSION"] || "qa";

/** Where herdr puts a named session's socket (it follows XDG_CONFIG_HOME, as remote-entry.ts does). */
export function testSocketPath(): string {
  const config = join(process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "herdr");
  return join(config, "sessions", TEST_SESSION, "herdr.sock");
}

function herdrBinary(): string | null {
  const configured = process.env["HERDR_WEB_HERDR_BIN"];
  if (configured) return configured;
  const found = Bun.which("herdr");
  return found ?? null;
}

async function answers(socket: string): Promise<boolean> {
  try { await ping(socket); return true; } catch { return false; }
}

/** Point this process (and what it spawns) at the test session, starting its server if needed. */
export async function useTestHerdr(): Promise<string | null> {
  // Unit tests must not discover or start herdr, even on a developer's PC.
  if (process.env["HERDR_TEST_MODE"] === "unit") return null;
  if (process.env["HERDR_TEST_LIVE"] === "1") throw new Error('Production/live tests are forbidden');
  const herdr = herdrBinary();
  if (!herdr) return null;
  const socket = testSocketPath();
  if (!(await answers(socket))) {
    mkdirSync(dirname(socket), { recursive: true });
    assertIsolatedSocket(socket);
    const ownedServer = Bun.spawn([herdr, "--session", TEST_SESSION, "server"], {
      stdin: "ignore",
      stdout: Bun.file(join(dirname(socket), "test-server.log")),
      stderr: Bun.file(join(dirname(socket), "test-server.log")),
      // run from inside a herdr pane, this process carries that pane's HERDR_* variables
      env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("HERDR_"))),
    });
    // Capture ownership before any test can replace process.env. Reused servers never
    // register a handler; only this child and this private socket may be stopped.
    const ownedEnv = Object.freeze({
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("HERDR_"))),
      HERDR_SOCKET: socket,
    });
    const ownedSession = TEST_SESSION;
    let cleaned = false;
    const cleanupOwnedServer = () => {
      if (cleaned) return;
      cleaned = true;
      // Do not address a socket after our original child has already exited.
      if (ownedServer.exitCode != null || ownedServer.signalCode != null) return;
      try {
        const stopped = spawnSync(herdr, ["--session", ownedSession, "server", "stop"], {
          env: ownedEnv, stdio: "ignore", timeout: 3_000,
        });
        if (stopped.status !== 0) ownedServer.kill("SIGTERM");
      } catch {
        // The process handle is the fallback, never a PID discovered from a file.
        try { ownedServer.kill("SIGTERM"); } catch {}
      }
    };
    // Bun test does not emit the normal exit event after a successful suite.
    // afterAll is unavailable to standalone Bun scripts, which use exit instead.
    try { afterAll(cleanupOwnedServer); } catch { /* not running under bun test */ }
    process.once("exit", cleanupOwnedServer);
    for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
      process.once(signal, () => { cleanupOwnedServer(); process.exit(exitCode); });
    }
    writeFileSync(join(dirname(socket), 'test-owned.pid'), String(ownedServer.pid));
    ownedServer.unref();
    const deadline = Date.now() + 15_000;
    while (!(existsSync(socket) && await answers(socket))) {
      if (Date.now() > deadline) throw new Error(`The test herdr session "${TEST_SESSION}" did not start; see ${join(dirname(socket), "test-server.log")}`);
      await Bun.sleep(100);
    }
  }
  // some tests read "a live workspace" without owning one: keep one resident, as a
  // session in use always has
  if ((await sessionSnapshot(socket)).workspaces.length === 0) {
    await workspaceCreate({ cwd: homedir(), label: "herdr-web-ui-test-resident" }, socket);
  }
  process.env["HERDR_SOCKET"] = socket;
  return socket;
}

await useTestHerdr();
