import type { SshTarget } from "../shared/machines.ts";

export function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

export function validateTarget(value: unknown): SshTarget {
  if (!value || typeof value !== "object") throw new Error("SSH target is required");
  const v = value as Record<string, unknown>;
  // Pass a single destination argv, never options or shell syntax. IPv6 is allowed.
  if (typeof v.destination !== "string" || !/^[a-zA-Z0-9_][a-zA-Z0-9_.@:[\]-]{0,254}$/.test(v.destination)) throw new Error("Enter an SSH alias or user@hostname");
  if (v.port !== undefined && (!Number.isInteger(v.port) || Number(v.port) < 1 || Number(v.port) > 65535)) throw new Error("SSH port must be 1–65535");
  if (v.identity_file !== undefined && (typeof v.identity_file !== "string" || !/^(\/|~\/)[^\r\n\0]{1,1024}$/.test(v.identity_file))) throw new Error("Key path must be absolute or start with ~/");
  if (v.session !== undefined && (typeof v.session !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(v.session))) throw new Error("Session names use letters, numbers, underscores and hyphens");
  return { destination: v.destination, ...(v.port === undefined ? {} : { port: Number(v.port) }), ...(v.identity_file ? { identity_file: String(v.identity_file) } : {}), ...(v.session ? { session: String(v.session) } : {}) };
}

export function sameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.get("origin");
  if (!origin) return true; // CLI clients still need the custom mutation header + token.
  try {
    const expected = new URL(request.url);
    // Reverse proxies commonly terminate HTTPS; do not trust arbitrary forwarded hosts.
    if (request.headers.get("x-forwarded-proto") === "https") expected.protocol = "https:";
    return new URL(origin).origin === expected.origin;
  } catch { return false; }
}
export function canSendSecret(request: Request): boolean {
  const url = new URL(request.url);
  return url.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}
