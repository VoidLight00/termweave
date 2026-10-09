import { expect, test } from "bun:test";
import type { HerdrPane } from "../../shared/protocol.ts";
import { adjacentWorkspacePane } from "./workspaceNavigation.ts";
const panes = [
  { pane_id: "a1", workspace_id: "a" },
  { pane_id: "b1", workspace_id: "b" },
  { pane_id: "a2", workspace_id: "a" },
] as HerdrPane[];
test("cycles inside the workspace even when the roster is interleaved", () => {
  expect(adjacentWorkspacePane(panes, "a1", 1)).toBe("a2");
  expect(adjacentWorkspacePane(panes, "a2", 1)).toBe("a1");
  expect(adjacentWorkspacePane(panes, "a1", -1)).toBe("a2");
  expect(adjacentWorkspacePane(panes, "b1", 1)).toBe("b1");
});
test("stale or absent selection never targets an unrelated terminal", () => {
  expect(adjacentWorkspacePane(panes, "closed", 1)).toBeNull();
  expect(adjacentWorkspacePane(panes, null, -1)).toBeNull();
  expect(adjacentWorkspacePane([], "a1", 1)).toBeNull();
});
