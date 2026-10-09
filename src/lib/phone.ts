import type { RemoteAccess } from "../../shared/protocol.ts";

/** What the page knows about its own address. */
export interface PageLocation {
  protocol: string;
  hostname: string;
  origin: string;
  /** window.isSecureContext */
  secure: boolean;
}

/** What Settings → Phone shows: an address to open, a command to run, or what is in the way. */
export type PhonePlan =
  /** this very page is on an HTTPS address a phone can open */
  | { kind: "here"; url: string }
  /** Tailscale on the PC already proxies this server */
  | { kind: "served"; url: string }
  /** one command on the PC publishes it; `url` is where it will be, when the DNS name is known */
  | { kind: "command"; command: string; url: string | null }
  | { kind: "stopped" }
  | { kind: "missing" }
  /** the server did not say (an older server, or the request failed) */
  | { kind: "unknown" };

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname.startsWith("127.") || hostname === "[::1]" || hostname === "::1";
}

export function phonePlan(page: PageLocation, access: RemoteAccess | null): PhonePlan {
  if (page.protocol === "https:" && page.secure && !isLoopbackHost(page.hostname)) return { kind: "here", url: page.origin };
  if (access === null) return { kind: "unknown" };
  const tailscale = access.tailscale;
  if (tailscale.state !== "running") return { kind: tailscale.state };
  if (tailscale.serving_url !== null) return { kind: "served", url: tailscale.serving_url };
  if (tailscale.serve_command !== null) return { kind: "command", command: tailscale.serve_command, url: tailscale.serve_url };
  return { kind: "unknown" };
}

/** A name for this device to pair under, from its user agent: "iPhone · Safari", "Windows · Chrome". */
export function deviceLabel(userAgent: string, maxTouchPoints = 0): string {
  const ua = userAgent;
  const device = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1) ? "iPad" : /Android/.test(ua) ? "Android" : /Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "Chromebook" : /Linux/.test(ua) ? "Linux" : "Device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\/|Chromium\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : null;
  return browser ? `${device} · ${browser}` : device;
}

/** The `?pair=CODE` a QR code carries, taken off the address at once so it stays out of history and referrers. */
export function takePairCode(): string {
  if (typeof window === "undefined") return "";
  const url = new URL(window.location.href);
  const code = url.searchParams.get("pair") ?? "";
  if (code !== "") {
    url.searchParams.delete("pair");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }
  return code.replace(/\D/g, "").slice(0, 6);
}
