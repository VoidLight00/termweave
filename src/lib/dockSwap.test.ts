import { expect, it } from "bun:test";
import { group, swapTabs, type Layout } from "./dockLayout.ts";

it("swapTabs trades two panes' dock places and keeps the rest", () => {
  const tree: Layout = { kind: "split", id: "s", axis: "columns", ratio: 0.5, first: { ...group("a", ["p1", "p3"]), active: "p1" }, second: group("b", ["p2"]) } as Layout;
  expect(swapTabs(tree, "p1", "p2")).toEqual({ ...tree, first: { ...group("a", ["p2", "p3"]), active: "p2" }, second: { ...group("b", ["p1"]), active: "p1" } } as Layout);
  expect(swapTabs(tree, "p9", "p8")).toEqual(tree);
});
