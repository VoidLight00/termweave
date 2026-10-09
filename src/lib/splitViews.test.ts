import { describe, expect, test } from "bun:test";
import { selectSplitPane, splitLayouts, splitPaneIds } from "./splitViews.ts";

describe("native split selection", () => {
  test("all four layouts retain a single option", () => {
    expect(splitLayouts.map(item => item.count)).toEqual([1, 2, 2, 4]);
  });
  test("existing terminals are distinct", () => {
    expect(splitPaneIds(["a", "b", "c", "d"], "b", [], 4)).toEqual(["b", "a", "c", "d"]);
  });
  test("selection survives polls but closed terminals are replaced", () => {
    expect(splitPaneIds(["a", "b", "c", "d"], "a", ["a", "d", "gone", "b"], 4)).toEqual(["a", "d", "b", "c"]);
  });
  test("too few terminals produce empty slots, not duplicate input targets", () => {
    expect(splitPaneIds(["a"], "a", [], 4)).toEqual(["a", null, null, null]);
  });
  test("duplicate assignment is rejected without mutating saved selection", () => {
    const ids = Object.freeze(["a", "b", "c"]);
    expect(selectSplitPane(ids, 1, "a")).toEqual([...ids]);
    expect(selectSplitPane(ids, 1, "d")).toEqual(["a", "d", "c"]);
    expect(ids).toEqual(["a", "b", "c"]);
  });
  test("machine change and invalid primary cannot attach a stale terminal", () => {
    expect(splitPaneIds(["x", "y"], "old", ["old", "b"], 2)).toEqual([null, "x"]);
  });
});
