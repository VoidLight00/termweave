import { herdrRpc, sessionSnapshot } from "./herdr/client.ts";
import { badRequest, errorResponse, jsonResponse } from "./http.ts";
import { isMoveResult, isPaneMoveRequest, moveSnapshotError, type PaneMoveResult } from "../shared/paneMove.ts";

/** index.ts owns auth, origin, watch-role and machine routing. No fallback or retry. */
export async function handlePaneMove(request: Request): Promise<Response> {
  if (request.method !== "POST") return jsonResponse({ error: { code: "method_not_allowed", message: "use POST" } }, 405);
  let payload: unknown;
  try { payload = await request.json(); } catch { return badRequest("invalid_json", "request body must be JSON"); }
  if (!isPaneMoveRequest(payload)) return badRequest("invalid_body", "source and destination placement and terminal identity are required");
  try {
    const snapshot = await sessionSnapshot();
    const code = moveSnapshotError(snapshot, payload);
    if (code) return jsonResponse({ error: { code, message: "Pane placement changed or destination is unavailable. Refresh before another move." } }, 409);
    const result = await herdrRpc<{ move_result: PaneMoveResult }>("pane.move", {
      pane_id: payload.pane_id,
      destination: { type: "tab", tab_id: payload.target_tab_id, target_pane_id: payload.target_pane_id, split: "right" },
      focus: false,
    });
    if (!isMoveResult(result?.move_result, payload)) return jsonResponse({ error: {
      code: "move_outcome_unknown", message: "The move reply was unexpected. Refresh the panes. Do not repeat the move automatically.",
    } }, 502);
    return jsonResponse(result.move_result);
  } catch (error) { return errorResponse(error); }
}
