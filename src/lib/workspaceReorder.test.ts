import { describe, expect, test } from "bun:test";
import { workspaceInsertion, workspaceSlots, type WorkspaceBox } from "./workspaceReorder.ts";

const boxes: WorkspaceBox[] = [{ id: "a", top: 8, height: 80, gap: 8 },
  { id: "b", top: 96, height: 200, gap: 8 }, { id: "c", top: 304, height: 40, gap: 8 }];
describe("measured workspace preview", () => {
  test("variable heights displace exactly one lifted footprint", () => {
    expect([...workspaceSlots(boxes, "a", 2)]).toEqual([["b", 8], ["c", 216], ["a", 264]]);
    expect([...workspaceSlots(boxes, "c", 0)]).toEqual([["c", 8], ["a", 56], ["b", 144]]);
    expect(boxes[0]!.top).toBe(8);
  });
  test("midpoints resist jitter within the eight-pixel reversal band", () => {
    expect(workspaceInsertion(boxes, "a", 115, 0)).toBe(0);
    expect(workspaceInsertion(boxes, "a", 117, 0)).toBe(1);
    expect(workspaceInsertion(boxes, "a", 101, 1)).toBe(1);
    expect(workspaceInsertion(boxes, "a", 99, 1)).toBe(0);
    expect(workspaceInsertion(boxes, "a", 1000, 0)).toBe(2);
    expect(workspaceInsertion(boxes, "a", -100, 2)).toBe(0);
  });
});
