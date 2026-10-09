import { describe, expect, test } from "bun:test";
import { dock, group, groups, parseLayout, preset, removeTab, resizeSplit, sanitize } from "./dockLayout.ts";

describe("immutable visual docking", () => {
  for (const edge of ["left", "right", "top", "bottom"] as const) test(`${edge} creates correct axis and order`, () => {
    const tree = preset(["a", "b"], "columns", "test");
    const result = dock(tree, "b", "test-0", edge, "new");
    expect(result.kind).toBe("split");
    if (result.kind !== "split") throw Error("split required");
    expect(result.axis).toBe(edge === "left" || edge === "right" ? "columns" : "rows");
    expect(groups(result).map(item => item.tabs[0])).toEqual(edge === "left" || edge === "top" ? ["b", "a"] : ["a", "b"]);
    expect(groups(tree).map(item => item.tabs[0])).toEqual(["a", "b"]);
  });
  test("center merge collapses source and reorder keeps identity", () => {
    const joined = dock(preset(["a", "b"], "columns", "test"), "b", "test-0", "center", "new");
    expect(groups(joined)).toHaveLength(1);
    expect(groups(joined)[0]!.tabs).toEqual(["a", "b"]);
    expect(groups(dock(joined, "b", "test-0", "center", "new", 0))[0]!.tabs).toEqual(["b", "a"]);
    expect(groups(dock(joined, "b", "test-0", "center", "new", 0))[0]!.active).toBe("b");
  });
  test("self edge is no-op unless group has sibling tabs", () => {
    const a = group("g", ["a"]); expect(dock(a, "a", "g", "right", "x")).toBe(a);
    expect(groups(dock(group("g", ["a", "b"]), "b", "g", "bottom", "x"))).toHaveLength(2);
  });
  test("foreign tab and invalid target cannot move", () => {
    const a = group("g", ["a"]); expect(dock(a, "foreign", "g", "center", "x")).toBe(a);
    expect(dock(a, "a", "foreign", "center", "x")).toBe(a);
  });
  test("ratios bounded, nested resize and reload preserve tree", () => {
    let tree = preset(["a", "b", "c", "d"], "grid", "test");
    tree = resizeSplit(tree, "test-top", 0.999);
    expect(parseLayout(JSON.parse(JSON.stringify(tree)))).toEqual(tree);
    if (tree.kind !== "split" || tree.first.kind !== "split") throw Error("nested required");
    expect(tree.first.ratio).toBe(0.85);
    expect(resizeSplit(tree, "test-root", -2).kind).toBe("split");
  });
  test("stale pane sanitation and removal never kill processes", () => {
    const tree = preset(["a", "b", "c", "d"], "grid", "test");
    expect(groups(sanitize(tree, ["a", "c"])!).flatMap(item => item.tabs)).toEqual(["a", "c"]);
    expect(removeTab(group("g", ["a"]), "a")).toBeNull();
  });
  test("100 deterministic moves never duplicate or orphan live tabs", () => {
    let tree = preset(["a", "b", "c", "d"], "grid", "test");
    for (let i = 0; i < 100; i++) {
      const list = groups(tree); const tab = ["a", "b", "c", "d"][i % 4]!;
      tree = dock(tree, tab, list[(i * 3) % list.length]!.id, i % 3 ? "center" : "right", `s${i}`);
      const tabs = groups(tree).flatMap(item => item.tabs);
      expect([...tabs].sort()).toEqual(["a", "b", "c", "d"]);
      expect(new Set(tabs).size).toBe(4);
    }
  });
  test("invalid storage rejects malformed and nonfinite ratios", () => {
    expect(parseLayout({ kind: "split", id: "x", axis: "columns", ratio: NaN })).toBeNull();
    expect(parseLayout({ kind: "group", id: "x", tabs: [123] })).toBeNull();
  });
});
