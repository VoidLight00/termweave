import type { TmuxAction, TmuxAddress } from "../../shared/tmux.ts";
import { TmuxError } from "./client.ts";
import { TmuxRuntime } from "./runtime.ts";

const response = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
export async function handleTmuxRequest(request: Request, runtime: TmuxRuntime, readOnly = false): Promise<Response> {
  const path = new URL(request.url).pathname;
  try {
    if (path === "/api/tmux" && request.method === "GET") {
      return response({ available: Boolean(runtime.binary), readOnly, state: runtime.binary ? await runtime.state() : null });
    }
    if (path === "/api/tmux/metadata" && request.method === "GET") {
      const query = new URL(request.url).searchParams;
      const target = {socket:query.get("socket")??"",generation:query.get("generation")??"",paneId:query.get("paneId")??""};
      return response(await (await runtime.client(target.socket)).metadata(target));
    }
    if (request.method !== "POST") return response({ error: "method_not_allowed" }, 405);
    if (readOnly) return response({ error: "read_only" }, 403);
    // Read at most 16 KiB. Content-Length alone does not bound chunked bodies.
    const reader = request.body?.getReader();
    if (!reader) throw new TmuxError("invalid_body");
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 16384) { void reader.cancel(); throw new TmuxError("body_too_large"); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    let payload: { name: string; target: TmuxAddress; action: TmuxAction };
    try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new TmuxError("invalid_body"); }
    if (!payload || typeof payload !== "object") throw new TmuxError("invalid_body");
    if (path === "/api/tmux/session") return response({ state: await runtime.create(payload.name) });
    if (path === "/api/tmux/action") {
      if (!payload.target || typeof payload.target.socket !== "string") throw new TmuxError("invalid_target");
      await (await runtime.client(payload.target.socket)).control(payload.target, payload.action);
      return response({ state: await runtime.state() });
    }
    return response({ error: "not_found" }, 404);
  } catch (error) {
    return response({ error: error instanceof TmuxError ? error.code : "tmux_failed" }, error instanceof TmuxError ? 400 : 500);
  }
}
