import { herdrRpc, HerdrError, sessionSnapshot } from "./herdr/client.ts";
import { badRequest, errorResponse, isJsonObject, jsonResponse } from "./http.ts";

/** Authentication, role and same-origin guards run in index.ts before this handler. */
export async function handlePaneSplit(request: Request): Promise<Response> {
  if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
  let payload: unknown;
  try { payload = await request.json(); } catch { return badRequest("invalid_json", "request body must be JSON"); }
  if (!isJsonObject(payload) || typeof payload.pane_id !== "string" || typeof payload.workspace_id !== "string"
    || !payload.pane_id || !payload.workspace_id) return badRequest("invalid_target", "pane_id and workspace_id are required");
  // The browser cannot choose an arbitrary cwd, command, environment, or focused pane.
  if (Object.keys(payload).some(key => !["pane_id", "workspace_id"].includes(key))) return badRequest("invalid_body", "unexpected field");
  try {
    const snapshot = await sessionSnapshot();
    const source = snapshot.panes.find(pane => pane.pane_id === payload.pane_id);
    if (!source) throw new HerdrError("pane_not_found", "source pane no longer exists");
    if (source.workspace_id !== payload.workspace_id || !snapshot.workspaces.some(workspace => workspace.workspace_id === payload.workspace_id)) {
      return badRequest("workspace_mismatch", "pane must belong to the requested workspace");
    }
    const cwd = source.foreground_cwd ?? source.cwd;
    if (!cwd || source.restore_error) return badRequest("invalid_cwd", "source terminal has no available working directory");
    const result = await herdrRpc<{ pane: { pane_id: string; workspace_id: string; tab_id?: string | null; cwd?: string | null } }>("pane.split", {
      target_pane_id: source.pane_id, workspace_id: source.workspace_id, direction: "right", cwd, focus: false,
    });
    return jsonResponse({ pane_id: result.pane.pane_id, workspace_id: source.workspace_id, tab_id: result.pane.tab_id ?? null, cwd });
  } catch (error) { return errorResponse(error); }
}
