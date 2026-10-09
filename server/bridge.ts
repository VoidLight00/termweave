import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BRIDGE_PROTOCOL, REMOTE_BUNDLE_VERSION, type BridgeIdentity } from "../shared/machines.ts";
import { HerdrError, herdrSocketPath, ping } from "./herdr/client.ts";
import { attachableIdentity, sidecarAvailable } from "./pty/sidecar.ts";

export interface BridgeDescriptor { managed_remote?: boolean; port: number; token: string; pid: number; socket_path: string; bridge_protocol: number; bundle_version: string }
export function bridgeRegistry(): string { return join(homedir(), ".config/termweave/bridges"); }
export function socketPath(): string {
  const path = resolve(herdrSocketPath());
  try { return realpathSync(path); } catch { return path; }
}
export function descriptorPath(socket = socketPath()): string { return join(bridgeRegistry(), createHash("sha256").update(socket).digest("hex") + ".json"); }
/** `sidecar`: whether this bridge can run the PTY sidecar; the PC list reads its terminal lens from the herdr told here. */
export async function bridgeIdentity(sidecar = sidecarAvailable()): Promise<BridgeIdentity> {
  const socket = socketPath();
  let stat;
  try { stat = statSync(socket); } catch (error) {
    // A herdr that is not running leaves no socket (on Windows, no marker). Said by code and
    // without the path: the server that asked shows this to whoever is adding the PC.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HerdrError("socket_missing", "herdr's socket is missing; herdr is not running for this session");
    throw error;
  }
  const info = attachableIdentity(await ping(), sidecar);
  return { pid: process.pid, managed_remote: process.env["HERDR_WEB_REMOTE"] === "1", bridge_protocol: BRIDGE_PROTOCOL, bundle_version: REMOTE_BUNDLE_VERSION, socket_path: socket, socket_id: `${stat.dev}:${stat.ino}`, herdr: info };
}
export function registerBridge(port: number, token = randomBytes(32).toString("hex")): { token: string; close(): void } {
  const dir = bridgeRegistry();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = descriptorPath();
  // Registration never overwrites a live bridge. Its credential remains reusable.
  if (existsSync(path)) {
    try {
      const old = JSON.parse(readFileSync(path, "utf8")) as BridgeDescriptor;
      process.kill(old.pid, 0);
      return { token, close() {} };
    } catch { /* stale descriptor */ }
  }
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ managed_remote: process.env["HERDR_WEB_REMOTE"] === "1", port, token, pid: process.pid, socket_path: socketPath(), bridge_protocol: BRIDGE_PROTOCOL, bundle_version: REMOTE_BUNDLE_VERSION } satisfies BridgeDescriptor), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return { token, close() { try { if (JSON.parse(readFileSync(path, "utf8")).pid === process.pid) unlinkSync(path); } catch {} } };
}
