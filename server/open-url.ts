/**
 * Opening a terminal's web link in the Aside browser of this PC. Only the PC the person sits
 * at opens anything: the route answers a request from this PC itself, and no other PC's link
 * is ever forwarded here (see machine-api.ts).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";

/** a link longer than this is no address anyone clicked */
export const OPEN_URL_MAX_CHARS = 8192;

export class OpenUrlError extends Error {
  constructor(readonly code: "invalid_url", message: string) { super(message); }
}

/** The absolute http(s) address the body names, normalized; anything else throws OpenUrlError. */
export function parseOpenUrl(body: unknown): string {
  if (typeof body !== "string" || body === "") throw new OpenUrlError("invalid_url", "url must be a non-empty string");
  if (body.length > OPEN_URL_MAX_CHARS) throw new OpenUrlError("invalid_url", `url is longer than ${OPEN_URL_MAX_CHARS} characters`);
  let url: URL;
  try { url = new URL(body); } catch { throw new OpenUrlError("invalid_url", "url must be absolute"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new OpenUrlError("invalid_url", "only http and https addresses open");
  if (url.href.length > OPEN_URL_MAX_CHARS) throw new OpenUrlError("invalid_url", `url is longer than ${OPEN_URL_MAX_CHARS} characters`);
  return url.href;
}

/** Aside.exe of a per-machine or per-user install; null off Windows or when it is not installed. */
export function asideExecutable(env: Record<string, string | undefined> = process.env, exists: (path: string) => boolean = existsSync, platform: string = process.platform): string | null {
  if (platform !== "win32") return null;
  const roots = [env["ProgramFiles"], env["ProgramFiles(x86)"], env["LOCALAPPDATA"]];
  for (const root of roots) {
    if (!root) continue;
    const exe = win32.join(root, "Aside", "Application", "Aside.exe");
    if (exists(exe)) return exe;
  }
  return null;
}

/**
 * Hands the address to Aside the way its registered open command does: a running Aside opens it
 * as a new tab, otherwise it starts. Detached, so the browser outlives this server; resolves once
 * the process started, never waits for the browser.
 */
export function openInAside(exe: string, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ["--single-argument", url], { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}
