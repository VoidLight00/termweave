import { test, expect } from "bun:test";
import { dockInsertion, validDockDrag, PANE_DRAG_TYPE } from "./dockDrag.ts";
import { dock, group, groups } from "./dockLayout.ts";

test("only this workspace's live title lifecycle is authority", () => {
  const tree = group("g", ["a", "b"]);
  expect(validDockDrag(tree, ["a"], "a", [PANE_DRAG_TYPE], "a")).toBe(true);
  for (const [local, types, payload, roster] of [
    [null, [PANE_DRAG_TYPE], "a", ["a"]], ["a", ["text/plain"], "a", ["a"]],
    ["a", [PANE_DRAG_TYPE], "foreign", ["a"]], ["a", [PANE_DRAG_TYPE, "Files"], "a", ["a"]],
    ["a", [PANE_DRAG_TYPE], "a", []], ["foreign", [PANE_DRAG_TYPE], "foreign", ["foreign"]],
  ] as const) expect(validDockDrag(tree, roster, local, types, payload)).toBe(false);
});
test("strip boundaries convert after source removal in both directions", () => {
  const tabs = ["a", "b", "c", "d"];
  for (const [tab, boundary, expected] of [["a", 3, ["b", "c", "a", "d"]], ["c", 0, ["c", "a", "b", "d"]],
    ["b", 4, ["a", "c", "d", "b"]], ["d", 1, ["a", "d", "b", "c"]]] as const) {
    const next = dock(group("g", tabs), tab, "g", "center", "n", dockInsertion(tabs, tab, boundary));
    expect(groups(next)[0]!.tabs).toEqual([...expected]);
  }
  expect(dockInsertion(tabs, "foreign", 3)).toBe(3);
  expect(dockInsertion(tabs, "a", 99)).toBe(3);
});
