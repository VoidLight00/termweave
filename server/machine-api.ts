import type { SetupAction, SetupRequest } from "../shared/machines.ts";
import { MachineManager } from "./machines.ts";
import { canSendSecret, sameOrigin } from "./machine-security.ts";
import { isJsonObject, jsonResponse } from "./http.ts";

const fail = (code: string, message: string, status: number) => jsonResponse({ error: { code, message } }, status);
export const MACHINE_PROXY_PATH = /^(?:session|agents|pane\/(?:read|scroll|selection|conversation(?:\/image|\/tool-output)?|commands|files|omo-tasks|prompt|prompt\/answer|input|keys|close|rename|move|image)|workspace\/(?:create|rename|move|close|directories)|fs\/(?:stat|file))$/;

export async function handleMachineRequest(request: Request, manager: MachineManager, onRevoke?: (close: () => void) => () => void): Promise<Response> {
  const url = new URL(request.url);
  if (!sameOrigin(request)) return fail("invalid_origin", "Use PC controls from this app", 403);
  if (!["GET", "HEAD"].includes(request.method) && request.headers.get("x-herdr-machine") !== "1") return fail("invalid_machine_request", "Use PC controls from this app", 403);
  // an empty segment is never a route: dropping it would forward `<id>//fs/file` as `fs/file`
  if (url.pathname.includes("//")) return fail("not_found", "not found", 404);
  const parts = url.pathname.slice("/api/machines".length).split("/").filter(Boolean);
  try {
    if (!parts.length && request.method === "GET") return jsonResponse({ machines: manager.list() });
    if (parts[0] === "events" && parts.length === 1 && request.method === "GET") {
      let stop: (() => void) | undefined;
      let unwatchDevice: (() => void) | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let close = () => {};
      const cleanup = () => {
        stop?.(); unwatchDevice?.(); clearInterval(heartbeat);
        request.signal.removeEventListener("abort", close);
      };
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          let closed = false;
          close = () => { if (closed) return; closed = true; cleanup(); try { controller.close(); } catch {} };
          unwatchDevice = onRevoke?.(close);
          if (closed) return;
          const send = (text: string) => { if (closed) return; if ((controller.desiredSize ?? 0) < -4) { close(); return; } try { controller.enqueue(encoder.encode(text)); } catch { close(); } };
          stop = manager.subscribe((event) => send(`data: ${JSON.stringify(event)}\n\n`));
          if (closed) { cleanup(); return; }
          heartbeat = setInterval(() => send(": heartbeat\n\n"), 15_000);
          request.signal.addEventListener("abort", close, { once: true });
          if (request.signal.aborted) close();
        },
        cancel() { close(); },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" } });
    }
    if (parts[0] === "setup") {
      if (parts.length === 1 && request.method === "POST") return jsonResponse(manager.setup(await request.json() as SetupRequest), 202);
      if (parts.length === 2) {
        const job = manager.job(parts[1]!);
        if (!job) return fail("job_not_found", "Setup job not found", 404);
        if (request.method === "POST") {
          const action = await request.json() as SetupAction;
          if (!isJsonObject(action)) return fail("invalid_body", "Expected a setup action", 400);
          if (action.action === "answer" && job.challenge?.kind === "secret" && !canSendSecret(request)) return fail("https_required", "Passwords and key passphrases require HTTPS or localhost", 403);
          manager.action(parts[1]!, action);
        } else if (request.method === "DELETE") manager.action(parts[1]!, { action: "cancel" });
        else if (request.method !== "GET") return fail("method_not_allowed", "Use GET, POST or DELETE", 405);
        return jsonResponse(manager.job(parts[1]!));
      }
    }
    if (parts[0] === "settings" && parts.length === 1) {
      if (request.method === "GET") return jsonResponse(manager.settings());
      if (request.method !== "PATCH") return fail("method_not_allowed", "Use GET or PATCH", 405);
      const patch = await request.json();
      if (!isJsonObject(patch)) return fail("invalid_body", "Expected PC settings", 400);
      return jsonResponse(manager.updateSettings(patch));
    }
    const id = parts[0]!;
    if (parts.length === 2 && parts[1] === "update-bridge" && request.method === "POST") return jsonResponse(manager.updateBridge(id), 202);
    if (parts.length === 1 && request.method === "PATCH") {
      const patch = await request.json();
      if (!isJsonObject(patch)) return fail("invalid_body", "Expected a PC update", 400);
      manager.patch(id, patch); return jsonResponse({ ok: true });
    }
    if (parts.length === 1 && request.method === "DELETE") { manager.remove(id); return jsonResponse({ ok: true }); }
    const path = parts.slice(1).join("/");
    if (MACHINE_PROXY_PATH.test(path)) {
      const endpoint = manager.endpoint(id);
      if (!endpoint) return fail("machine_offline", "This PC is disconnected", 503);
      // Explicit header allowlist: cookies, browser Authorization, forwarded headers
      // and remote Set-Cookie never cross this boundary. No arbitrary target URLs.
      const headers = new Headers({ authorization: `Bearer ${endpoint.token}` });
      const contentType = request.headers.get("content-type");
      if (contentType) headers.set("content-type", contentType);
      // a remote conversation answers 304 when unchanged, as a local one does
      const ifNoneMatch = request.headers.get("if-none-match");
      if (ifNoneMatch) headers.set("if-none-match", ifNoneMatch);
      const abort = new AbortController();
      if (path === "fs/file") {
        // a file (a video, say) streams through, with its ranges, never held here; it can
        // play for longer than any request timeout
        const range = request.headers.get("range");
        if (range) headers.set("range", range);
        try {
          const response = await fetch(`${endpoint.url}/api/${path}${url.search}`, { method: request.method, headers, redirect: "error", signal: request.signal });
          const passed = new Headers({ "cache-control": "private, no-store" });
          for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "content-disposition", "content-security-policy", "x-content-type-options"]) {
            const value = response.headers.get(name);
            if (value) passed.set(name, value);
          }
          return new Response(response.body, { status: response.status, headers: passed });
        } catch { return fail("machine_unavailable", "The PC connection was interrupted; retry after reconnecting", 502); }
      }
      const untrack = manager.trackTerminal(id, () => abort.abort());
      try {
        const response = await fetch(`${endpoint.url}/api/${path}${url.search}`, { method: request.method, headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body, redirect: "error", signal: AbortSignal.any([request.signal, abort.signal, AbortSignal.timeout(75_000)]) });
        const etag = response.headers.get("etag");
        return new Response(response.status === 304 ? null : await response.arrayBuffer(), { status: response.status, headers: {
          "content-type": response.headers.get("content-type") ?? "application/json", "cache-control": "no-store", ...(etag ? { etag } : {}),
        } });
      } catch { return fail("machine_unavailable", "The PC connection was interrupted; retry after reconnecting", 502); }
      finally { untrack(); }
    }
    return fail("not_found", "Unknown PC endpoint", 404);
  } catch (e) { return fail("machine_request_failed", e instanceof Error ? e.message : String(e), 400); }
}
