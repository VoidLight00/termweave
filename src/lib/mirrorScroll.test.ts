import { describe, expect, test } from "bun:test";
import { DELTA_LINE, DELTA_PAGE, DELTA_PIXEL, historyOffset, wheelStep } from "./mirrorScroll.ts";

/** deltas in order, as the wheel sends them: the lines each moved, and the pixels left over */
function run(deltas: number[], mode = DELTA_PIXEL, lineHeight = 20, speed = 1): { moved: number[]; carried: number } {
  let carried = 0;
  const moved: number[] = [];
  for (const delta of deltas) {
    const step = wheelStep(carried, delta, mode, lineHeight, 24, speed);
    carried = step.carried;
    moved.push(step.older);
  }
  return { moved, carried };
}

describe("a mirrored pane's wheel in history lines", () => {
  test("a wheel up shows older text, a wheel down newer, a line per row height", () => {
    expect(run([-60])).toEqual({ moved: [3], carried: 0 });
    expect(run([60])).toEqual({ moved: [-3], carried: 0 });
  });

  test("pixels short of a line carry into the next delta, both ways", () => {
    // a trackpad's small deltas: 7 + 7 + 7 = 21 pixels make one line, one pixel left
    expect(run([-7, -7, -7])).toEqual({ moved: [0, 0, 1], carried: -1 });
    expect(run([7, 7, 7])).toEqual({ moved: [0, 0, -1], carried: 1 });
    // 30 pixels: one line, half a line carried, which the next 10 complete
    expect(run([-30, -10])).toEqual({ moved: [1, 1], carried: 0 });
    // a turn back spends the carried pixels first
    expect(run([-30, 15])).toEqual({ moved: [1, 0], carried: 5 });
  });

  test("a line delta counts rows and a page delta whole screens", () => {
    expect(run([-3, 3], DELTA_LINE)).toEqual({ moved: [3, -3], carried: 0 });
    expect(wheelStep(0, -1, DELTA_PAGE, 20, 24)).toEqual({ older: 24, carried: 0 });
    expect(wheelStep(0, 1, DELTA_PAGE, 20, 24)).toEqual({ older: -24, carried: 0 });
  });

  test("the wheel speed moves that many lines per line, the carried pixels unchanged by it", () => {
    expect(run([-50], DELTA_PIXEL, 20, 3)).toEqual({ moved: [6], carried: -10 });
    expect(run([1], DELTA_LINE, 20, 4)).toEqual({ moved: [-4], carried: 0 });
    // a speed under one is one
    expect(run([-20], DELTA_PIXEL, 20, 0)).toEqual({ moved: [1], carried: 0 });
  });

  test("a screen whose row height is not known yet moves nothing and keeps what it carried", () => {
    expect(wheelStep(5, -100, DELTA_PIXEL, 0, 24)).toEqual({ older: 0, carried: 5 });
  });
});

describe("a mirrored pane's history offset", () => {
  test("moves by the lines asked, within the bottom and the top of the history", () => {
    expect(historyOffset(10, 3, 262)).toBe(13);
    expect(historyOffset(10, -3, 262)).toBe(7);
    expect(historyOffset(2, -5, 262)).toBe(0);
    expect(historyOffset(260, 5, 262)).toBe(262);
    expect(historyOffset(0, 5, 0)).toBe(0);
  });
});
