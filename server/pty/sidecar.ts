import type { HerdrIdentity } from "../../shared/machines.ts";

/**
 * A terminal attach runs on the PTY sidecar: `node pty-host.mjs`, which imports
 * @lydell/node-pty. A runtime without either (the win32 remote bundle ships Bun alone)
 * cannot start it, whatever herdr itself can do, so its panes stay mirrored.
 */
export interface SidecarRuntime {
  node: () => boolean;
  pty: () => boolean;
}

/** a node that hangs must not hold the server: no answer in this long counts as no Node */
const PROBE_TIMEOUT_MS = 3000;

/**
 * `bun run` puts a `node` that is Bun itself first on PATH when the PC has none, and
 * node-pty must not load in Bun (oven-sh/bun#18546): only a `node` that is Node counts.
 * The probe is written for any Node, however old (no `??`).
 */
export function isRealNode(executable: string, env: Record<string, string | undefined> = process.env, timeoutMs = PROBE_TIMEOUT_MS): boolean {
  try {
    const asked = Bun.spawnSync([executable, "-p", "process.versions.bun || ''"], { env, windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: timeoutMs });
    return asked.success && asked.stdout.toString().trim() === "";
  } catch {
    return false;
  }
}

/**
 * Looked up on the PATH the sidecar's spawn inherits (PtySession passes process.env), not the
 * one this process was launched with: a remote bundle adds its own bin/ at runtime
 * (server/remote-entry.ts), and a bare Bun.which() would not see the Node shipped there.
 */
function nodeOnPath(): boolean {
  const found = Bun.which("node", { PATH: process.env["PATH"] ?? "" });
  return found !== null && isRealNode(found);
}

const here: SidecarRuntime = {
  node: nodeOnPath,
  pty: () => {
    try {
      Bun.resolveSync("@lydell/node-pty", import.meta.dir);
      return true;
    } catch {
      return false;
    }
  },
};

let known: boolean | null = null;

/** This runtime's answer is taken once: every caller (attach, /api/health, /api/bridge) gets the same one. */
export function sidecarAvailable(runtime?: SidecarRuntime): boolean {
  if (runtime) return runtime.pty() && runtime.node();
  if (known === null) known = here.pty() && here.node();
  return known;
}

/** herdr's identity as this bridge can serve it: without the sidecar, told the way a herdr that cannot attach tells it. */
export function attachableIdentity(identity: HerdrIdentity, sidecar: boolean): HerdrIdentity {
  if (sidecar || identity.terminal_attach === false) return identity;
  return { ...identity, terminal_attach: false, terminal_mirror: true };
}
