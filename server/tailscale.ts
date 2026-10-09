/**
 * What Tailscale on this PC can already do for a phone, read-only: `tailscale status --json` and
 * `tailscale serve status --json`, never `serve`, `up` or anything else that changes the tailnet.
 * The Settings → Phone panel turns the answer into the address that already works, or the one
 * command the user still has to run on this PC.
 */
import { existsSync } from "node:fs";
import type { RemoteAccess, TailscaleAccess } from "../shared/protocol.ts";

const TIMEOUT_MS = 2500;
/** the macOS App Store build puts no `tailscale` on the PATH; its CLI lives in the app bundle */
const MAC_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
/** HTTPS ports to suggest, the conventional one first; a port another service already uses is skipped */
const HTTPS_PORTS = [443, 8443, 7317, 17317];
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** stdout of the two commands; null where the command failed, timed out or is not installed */
export interface TailscaleOutput {
  status: string | null;
  serve: string | null;
}

interface StatusJson { BackendState?: string; Self?: { DNSName?: string; UserID?: number | string; TailscaleIPs?: string[]; Tags?: string[] }; User?: Record<string, { LoginName?: string }> }
interface ServeJson {
  TCP?: Record<string, { HTTPS?: boolean; HTTP?: boolean }>;
  /** "host:port" -> handlers by path */
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
}

const NONE: TailscaleAccess = { state: "missing", dns_name: null, serving_url: null, serve_command: null, serve_url: null };

function parseJson<T>(text: string | null): T | null {
  if (text === null) return null;
  try { return JSON.parse(text) as T; } catch { return null; }
}

/** Does this `serve` proxy target point at the web ui on this machine, at its root? */
function proxiesTo(target: string | undefined, port: number): boolean {
  if (!target) return false;
  try {
    const url = new URL(target);
    const targetPort = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    return LOOPBACK.has(url.hostname) && targetPort === port && (url.pathname === "" || url.pathname === "/");
  } catch { return false; }
}

function httpsUrl(host: string, port: number): string {
  return `https://${host}${port === 443 ? "" : `:${port}`}`;
}

/** Pure: the two commands' output (or their absence) to what the phone panel needs. */
export function parseTailscale(output: TailscaleOutput | null, port: number): TailscaleAccess {
  if (output === null) return NONE;
  const status = parseJson<StatusJson>(output.status);
  if (status === null || status.BackendState !== "Running") return { ...NONE, state: "stopped" };
  const dns = status.Self?.DNSName?.replace(/\.$/, "") || null;
  const serve = parseJson<ServeJson>(output.serve);
  const taken = new Set(Object.keys(serve?.TCP ?? {}).map(Number).filter(Number.isFinite));
  let servingUrl: string | null = null;
  for (const [hostPort, site] of Object.entries(serve?.Web ?? {})) {
    const separator = hostPort.lastIndexOf(":");
    const host = hostPort.slice(0, separator);
    const webPort = Number(hostPort.slice(separator + 1));
    // an HTTP listener is no use to a phone: it can neither install the app nor receive alerts
    if (!serve?.TCP?.[String(webPort)]?.HTTPS) continue;
    if (proxiesTo(site.Handlers?.["/"]?.Proxy, port)) { servingUrl = httpsUrl(host, webPort); break; }
  }
  const free = servingUrl === null ? HTTPS_PORTS.find((candidate) => !taken.has(candidate)) ?? null : null;
  return {
    state: "running",
    dns_name: dns,
    serving_url: servingUrl,
    serve_command: free === null ? null : `tailscale serve --bg --https=${free} http://127.0.0.1:${port}`,
    serve_url: free === null || dns === null ? null : httpsUrl(dns, free),
  };
}

export function tailscaleBinary(): string | null {
  return Bun.which("tailscale") ?? (existsSync(MAC_APP_CLI) ? MAC_APP_CLI : null);
}

async function run(binary: string, args: string[]): Promise<string | null> {
  const proc = Bun.spawn([binary, ...args], { windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
  try {
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function readTailscale(binary: string | null = tailscaleBinary()): Promise<TailscaleOutput | null> {
  if (binary === null) return null;
  const [status, serve] = await Promise.all([run(binary, ["status", "--json"]), run(binary, ["serve", "status", "--json"])]);
  return { status, serve };
}

export async function remoteAccess(port: number): Promise<RemoteAccess> {
  return { port, tailscale: parseTailscale(await readTailscale(), port) };
}

/** A tagged node belongs to no person: its `User` entry is the node itself, named by its MagicDNS name. */
export function isTaggedNode(status: string | null): boolean {
  return (parseJson<StatusJson>(status)?.Self?.Tags?.length ?? 0) > 0;
}

/** The login this PC's Tailscale node belongs to, from `tailscale status --json`; null when it does not say, or the node is tagged. */
export function parseTailscaleOwner(status: string | null): string | null {
  const parsed = parseJson<StatusJson>(status);
  const id = parsed?.Self?.UserID;
  if (id === undefined || id === null || isTaggedNode(status)) return null;
  return parsed?.User?.[String(id)]?.LoginName || null;
}

/** This PC's IPv4 address on the tailnet (100.x.y.z), from `tailscale status --json`; null when it has none. */
export function parseTailscaleIp(status: string | null): string | null {
  return parseJson<StatusJson>(status)?.Self?.TailscaleIPs?.find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip)) ?? null;
}

const OWNER_TTL_MS = 5 * 60_000;
let ownerCache: { owner: string | null; tagged: boolean; at: number } | null = null;
let ownerRefresh: Promise<void> | null = null;

/**
 * The PC's own Tailscale login, or that its node is tagged and has none, cached five minutes.
 * A stale value is answered at once and refreshed in the background, so a request never waits
 * on the tailscale CLI; the first lookup is what `createServer` starts, so the answer is
 * usually there before any request.
 */
export function tailscaleIdentity(): { owner: string | null; tagged: boolean } {
  const now = Date.now();
  if ((ownerCache === null || now - ownerCache.at >= OWNER_TTL_MS) && ownerRefresh === null) {
    ownerRefresh = (async () => {
      const binary = tailscaleBinary();
      const status = binary === null ? null : await run(binary, ["status", "--json"]);
      // a CLI that failed this once says nothing new: what it last said stands, so the owner is not
      // taken for a stranger, nor a stranger let in, for the five minutes until it is asked again
      ownerCache = binary !== null && status === null && ownerCache !== null ? { ...ownerCache, at: Date.now() }
        : { owner: parseTailscaleOwner(status), tagged: isTaggedNode(status), at: Date.now() };
    })().finally(() => { ownerRefresh = null; });
  }
  return { owner: ownerCache?.owner ?? null, tagged: ownerCache?.tagged ?? false };
}
