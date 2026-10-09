import { unmanagedUpdateStatus, type UpdateCommand, type UpdateStatus } from "../shared/update.ts";
import { jsonResponse } from "./http.ts";

export interface UpdateService {
  status(): UpdateStatus;
  request(command: UpdateCommand): void;
}

/** Only the managed entrypoint connects IPC; importing createServer in tests does not. */
export function connectUpdater(): UpdateService {
  let status = unmanagedUpdateStatus();
  if (process.send && process.env["HERDR_WEB_MANAGED"] === "1") {
    process.on("message", (message: unknown) => {
      const value = message as { type?: string; status?: UpdateStatus };
      if (value?.type === "update-status" && value.status) status = value.status;
    });
    process.send({ type: "update-status-request" });
  }
  return {
    status: () => status,
    request: (command) => process.send?.({ type: "update-command", command }),
  };
}

/**
 * Whether an update POST came from this app's own controls. A custom header is not
 * submit-able by an HTML form. Cross-origin preflights are refused (no CORS headers);
 * Sec-Fetch-Site also rejects browser CSRF.
 */
export function updateRequestAllowed(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  const url = new URL(request.url);
  let sameHost = true;
  try { if (origin) sameHost = new URL(origin).host === url.host; } catch { sameHost = false; }
  return request.headers.get("x-herdr-update") === "1" && sameHost && (site === null || site === "same-origin") && !url.search;
}

export function handleUpdateRequest(request: Request, pathname: string, service?: UpdateService): Response {
  const status = service?.status() ?? unmanagedUpdateStatus();
  const reply = (body: unknown, code = 200) => {
    const response = jsonResponse(body, code);
    response.headers.set("cache-control", "no-store");
    return response;
  };
  const fail = (code: string, message: string, http: number) => reply({ error: { code, message } }, http);
  if (pathname === "/api/updates" && request.method === "GET") return reply(status);
  if (request.method !== "POST" || (pathname !== "/api/updates/check" && pathname !== "/api/updates/install")) {
    return fail("method_not_allowed", "Use GET /api/updates or POST /api/updates/check or /install", 405);
  }
  if (!updateRequestAllowed(request)) return fail("invalid_update_request", "Use the update controls from this app.", 403);
  if (!service || !status.managed) return fail("updates_unmanaged", status.blocked_reason ?? "Updates unavailable", 409);
  if (["checking", "building", "restarting"].includes(status.phase)) return fail("update_busy", "An update operation is already running.", 409);
  if (pathname.endsWith("/install") && (status.blocked_reason || !status.available)) {
    return fail("update_unavailable", status.blocked_reason ?? "No update is available. Check again first.", 409);
  }
  service.request(pathname.endsWith("/check") ? "check" : "install");
  return reply({ accepted: true }, 202);
}
