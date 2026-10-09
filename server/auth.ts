/**
 * Optional shared-token gate for herdr-web-ui.
 *
 * There is no user database here: the token is the whole authorization decision,
 * and whoever holds it can type into live terminals. Hence constant-time compares
 * (a length-leaking `===` is enough to guess a token over a LAN), an HttpOnly +
 * SameSite=Strict cookie so page JavaScript can never read it back, and a `Secure`
 * flag whenever the request arrived over TLS or through a TLS-terminating proxy.
 *
 * An empty token disables this gate; server/access.ts then decides by where a request comes
 * from, what Tailscale says about it, and whether it holds a paired device's cookie (the
 * helpers for that cookie live here too), and index.ts warns when a public bind address is
 * combined with neither.
 */

import { timingSafeEqual } from "node:crypto";

import { badRequest, jsonResponse } from "./http.ts";

const COOKIE_NAME = "termweave_token";
/** a paired device's own credential; the same flags as the token cookie */
export const DEVICE_COOKIE = "termweave_device";
const COOKIE_MAX_AGE_SECONDS = 31536000;
const BEARER_PREFIX = "bearer ";
const encoder = new TextEncoder();

/** Malformed pairs are skipped: a junk cookie from another app must not deny the user. */
export function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    if (!name) continue;
    try {
      cookies.set(name, decodeURIComponent(pair.slice(separator + 1).trim()));
    } catch (error) {
      if (error instanceof URIError) continue;
      throw error;
    }
  }
  return cookies;
}

function matches(candidate: string, token: string): boolean {
  const left = encoder.encode(candidate);
  const right = encoder.encode(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function isAuthenticated(request: Request, token: string): boolean {
  if (token === "") return true;
  const cookie = parseCookies(request.headers.get("cookie")).get(COOKIE_NAME);
  if (cookie !== undefined && matches(cookie, token)) return true;
  const authorization = request.headers.get("authorization") ?? "";
  if (authorization.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX) return false;
  return matches(authorization.slice(BEARER_PREFIX.length), token);
}

/** /api/health, /api/auth and /api/devices/pair stay open so a client can discover the gate and pass it. */
export function requiresAuth(pathname: string): boolean {
  if (pathname === "/ws") return true;
  if (!pathname.startsWith("/api/")) return false;
  return pathname !== "/api/health" && pathname !== "/api/auth" && pathname !== "/api/devices/pair";
}

export function unauthorizedJson(reason: "other_user" | "pairing_required" | "token_required" = "token_required"): Response {
  if (reason === "other_user") return jsonResponse({ error: { code: "other_user", message: "this PC belongs to another Tailscale user" } }, 403);
  return jsonResponse({ error: { code: "unauthorized", message: reason === "pairing_required" ? "pair this device, or use the token" : "token required" } }, 401);
}

export function isSecureRequest(request: Request): boolean {
  if (request.headers.get("x-forwarded-proto") === "https") return true;
  return new URL(request.url).protocol === "https:";
}

function sessionCookie(token: string, secure: boolean): string {
  const attributes = `Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_SECONDS}`;
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; ${attributes}${secure ? "; Secure" : ""}`;
}

export function deviceCookie(token: string, secure: boolean): string {
  return `${DEVICE_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_SECONDS}${secure ? "; Secure" : ""}`;
}

export function noContent(...setCookies: string[]): Response {
  const headers = new Headers();
  for (const cookie of setCookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 204, headers });
}

export async function handleAuthRequest(request: Request, token: string): Promise<Response> {
  if (request.method === "DELETE") {
    // signing out drops both credentials this browser may hold
    return noContent(`${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`, `${DEVICE_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  }
  if (request.method !== "POST") return badRequest("method_not_allowed", "use POST or DELETE");
  // Gate off: answering 204 without a cookie lets one client flow work either way.
  if (token === "") return noContent();

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return badRequest("invalid_json", "request body must be JSON");
  }
  if (typeof payload !== "object" || payload === null || !("token" in payload)) {
    return badRequest("missing_token", "token is required");
  }
  const offered = payload.token;
  if (typeof offered !== "string") return badRequest("missing_token", "token is required");
  if (!matches(offered, token)) {
    return jsonResponse({ error: { code: "invalid_token", message: "token does not match" } }, 401);
  }
  return noContent(sessionCookie(token, isSecureRequest(request)));
}
