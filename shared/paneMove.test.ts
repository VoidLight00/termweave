import { describe, expect, it } from "bun:test";
import type { HerdrPane, SessionSnapshot } from "./protocol.ts";
import { isMoveResult, isPaneMoveRequest, isPaneSwapRequest, moveRequest, moveSnapshotError, moveTargets, swapSnapshotError } from "./paneMove.ts";

const source = { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", terminal_id: "term1" } as HerdrPane;
const target = { pane_id: "w2:p1", workspace_id: "w2", tab_id: "w2:t1", terminal_id: "term2" } as HerdrPane;
const snapshot = { panes: [source, target], workspaces: [{ workspace_id: "w1" }, { workspace_id: "w2" }],
  tabs: [{ workspace_id: "w1", tab_id: "w1:t1" }, { workspace_id: "w2", tab_id: "w2:t1" }] } as SessionSnapshot;
const request = moveRequest(source, target);
describe("native pane move model", () => {
  it("requires exact placement and rejects machine fields or malformed bodies", () => {
    expect(isPaneMoveRequest(request)).toBe(true);
    for (const value of [null, [], {}, { ...request, terminal_id: "" }, { ...request, machine_id: "other" }]) expect(isPaneMoveRequest(value)).toBe(false);
    expect(isPaneMoveRequest(moveRequest(source, target, "down"))).toBe(true);
    expect(isPaneMoveRequest({ ...request, split: "left" })).toBe(false);
  });
  it("checks both workspaces, tabs, source identity and restored terminal availability", () => {
    expect(moveSnapshotError(snapshot, request)).toBeNull();
    expect(moveSnapshotError(snapshot, { ...request, pane_id: "gone" })).toBe("pane_not_found");
    for (const key of ["workspace_id", "target_workspace_id"] as const) expect(moveSnapshotError(snapshot, { ...request, [key]: "stale" })).toBe("workspace_mismatch");
    for (const key of ["tab_id", "target_tab_id", "terminal_id"] as const) expect(moveSnapshotError(snapshot, { ...request, [key]: "stale" })).toBe("stale_move");
    expect(moveSnapshotError({ ...snapshot, tabs: [] }, request)).toBe("stale_move");
    expect(moveSnapshotError({ ...snapshot, panes: [source, { ...target, restore_error: "failed" }] }, request)).toBe("invalid_target");
  });
  it("supports different tabs in the same workspace but excludes display-only groups", () => {
    const sibling = { ...target, workspace_id: source.workspace_id };
    expect(moveTargets([source, sibling, { ...target, tab_id: source.tab_id }], source)).toEqual([sibling]);
    expect(moveTargets([target], { ...source, restore_error: "failed" })).toEqual([]);
  });
  it("consumes changed pane IDs only when terminal identity and placement match", () => {
    const result = { changed: true, previous_pane_id: source.pane_id, pane: { ...source, pane_id: "w2:p3", workspace_id: target.workspace_id, tab_id: target.tab_id } };
    expect(isMoveResult(result, request)).toBe(true);
    for (const altered of [{ ...result, previous_pane_id: "wrong" }, { ...result, pane: { ...result.pane, terminal_id: "new-shell" } }, { ...result, pane: { ...result.pane, workspace_id: "wrong" } }]) expect(isMoveResult(altered, request)).toBe(false);
    expect(isMoveResult({ changed: false, previous_pane_id: source.pane_id, pane: source, reason: "zoomed_tab" }, request)).toBe(true);
  });
});

describe("same-tab swap model", () => {
  const near = { ...target, workspace_id: "w1", tab_id: "w1:t1" } as HerdrPane;
  const swap = { pane_id: source.pane_id, terminal_id: "term1", target_pane_id: near.pane_id, target_terminal_id: "term2" };
  it("needs two different panes with terminal identities", () => {
    expect(isPaneSwapRequest(swap)).toBe(true);
    for (const value of [null, {}, { ...swap, target_pane_id: swap.pane_id }, { ...swap, extra: "x" }, { ...swap, terminal_id: "" }]) expect(isPaneSwapRequest(value)).toBe(false);
  });
  it("swaps only within one tab and only the claimed terminals", () => {
    expect(swapSnapshotError({ ...snapshot, panes: [source, near] }, swap)).toBeNull();
    expect(swapSnapshotError(snapshot, swap)).toBe("invalid_target");
    expect(swapSnapshotError({ ...snapshot, panes: [source, { ...near, terminal_id: "other" }] }, swap)).toBe("stale_move");
    expect(swapSnapshotError({ ...snapshot, panes: [source] }, swap)).toBe("pane_not_found");
  });
});
