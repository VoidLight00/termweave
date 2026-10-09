/**
 * The `{ error: { code, message } }` envelope every herdr-web-ui route answers with.
 *
 * It lives outside index.ts because the auth routes must fail in exactly the shape
 * the pane routes fail in: a second copy of this envelope is how one API ends up
 * with two error formats and a client that only handles one of them.
 */

import { HerdrError } from "./herdr/client.ts";

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A non-negative integer: a row, a column or a scroll offset. */
export function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HerdrError) {
    const status = error.code === "connect_failed" || error.code === "timeout" ? 502 : 404;
    return jsonResponse({ error: { code: error.code, message: error.message } }, status);
  }
  const message = error instanceof Error ? error.message : String(error);
  return jsonResponse({ error: { code: "internal_error", message } }, 500);
}

export function badRequest(code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, 400);
}
