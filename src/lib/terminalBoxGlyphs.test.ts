import { describe, expect, it } from "bun:test";

import { BOX_GLYPHS, boxBackground, boxDrawing, boxRun, boxStrokes, isBoxGlyph, pixelPlacement } from "./terminalBoxGlyphs.ts";

// a cell as an iPhone draws it at 13px: 8 wide, 20 high, a light line 1px and a heavy one 3px
const draw = (char: string) => boxDrawing(char, 8, 20, 13)!;
const rects = (char: string) => draw(char).rects.map((r) => [r.x, r.y, r.w, r.h]);

describe("box-drawing characters as painted cells", () => {
  it("draws every line and block character but the diagonals", () => {
    for (let code = 0x2500; code <= 0x259f; code++) {
      const char = String.fromCodePoint(code);
      const diagonal = code >= 0x2571 && code <= 0x2573;
      expect([char, isBoxGlyph(char)]).toEqual([char, !diagonal]);
      expect([char, boxDrawing(char, 8, 20, 13) !== null]).toEqual([char, !diagonal]);
      expect(BOX_GLYPHS.test(char)).toBe(true);
    }
    for (const other of ["a", "한", "→", "●", " "]) {
      expect(isBoxGlyph(other)).toBe(false);
      expect(boxDrawing(other, 8, 20, 13)).toBeNull();
    }
    expect([boxStrokes(13), boxStrokes(26)]).toEqual([{ light: 1, heavy: 3 }, { light: 2, heavy: 6 }]);
  });

  it("runs a line from edge to edge, so the cell beside or below continues it", () => {
    expect(rects("─")).toEqual([[0, 9.5, 8, 1]]);
    expect(rects("│")).toEqual([[3.5, 0, 1, 20]]);
    expect(rects("━")).toEqual([[0, 8.5, 8, 3]]);
    // half lines stop at the centre
    expect(rects("╴")).toEqual([[0, 9.5, 4, 1]]);
    expect(rects("╻")).toEqual([[2.5, 10, 3, 10]]);
  });

  it("closes a corner: each line reaches past the centre by half of the one it meets", () => {
    expect(rects("┌")).toEqual([[3.5, 9.5, 4.5, 1], [3.5, 9.5, 1, 10.5]]);
    expect(rects("┘")).toEqual([[0, 9.5, 4.5, 1], [3.5, 0, 1, 10.5]]);
    // a heavy line down from a light one across: the light one covers the heavy one's width
    expect(rects("┎")).toEqual([[2.5, 9.5, 5.5, 1], [2.5, 9.5, 3, 10.5]]);
    expect(rects("┼")).toEqual([[0, 9.5, 8, 1], [3.5, 0, 1, 20]]);
  });

  it("draws a double line as two, turning each at its own corner", () => {
    expect(rects("═")).toEqual([[0, 8.5, 8, 1], [0, 10.5, 8, 1]]);
    // ╔: the outer line starts at the far upright, the inner one at the near upright
    expect(rects("╔")).toEqual([[2.5, 8.5, 5.5, 1], [4.5, 10.5, 3.5, 1], [2.5, 8.5, 1, 11.5], [4.5, 10.5, 1, 9.5]]);
    // ╤: the single line hangs from the lower of the two
    expect(rects("╤").at(-1)).toEqual([3.5, 10.5, 1, 9.5]);
    // ╒: at a corner it starts from the upper one
    expect(rects("╒").at(-1)).toEqual([3.5, 8.5, 1, 11.5]);
  });

  it("splits a dashed line into its dashes and rounds a corner with an arc", () => {
    const dashes = rects("┄");
    expect(dashes).toHaveLength(3);
    expect(dashes.every(([, y, , h]) => y === 9.5 && h === 1)).toBe(true);
    expect(dashes.map(([x]) => x)).toEqual([...dashes.map(([x]) => x)].sort((a, b) => a! - b!));
    expect(rects("┋")).toHaveLength(4);
    const corner = draw("╭");
    // the arc leaves the lines' corner to the right and down; what is left of the upright runs on to the bottom edge
    expect(corner.arcs).toEqual([{ x: 3.5, y: 9.5, r: 4, t: 1, right: true, down: true }]);
    expect(corner.rects.map((r) => [r.x, r.y, r.w, r.h])).toEqual([[3.5, 13, 1, 7]]);
    expect(draw("╯").arcs[0]).toMatchObject({ right: false, down: false });
    expect(draw("╯").rects.map((r) => [r.x, r.y, r.w, r.h])).toEqual([[3.5, 0, 1, 7]]);
  });

  it("fills block characters by their share of the cell, and shades by how dark they are", () => {
    expect(rects("█")).toEqual([[0, 0, 8, 20]]);
    expect(rects("▀")).toEqual([[0, 0, 8, 10]]);
    expect(rects("▄")).toEqual([[0, 10, 8, 10]]);
    expect(rects("▁")).toEqual([[0, 17.5, 8, 2.5]]);
    expect(rects("▌")).toEqual([[0, 0, 4, 20]]);
    expect(rects("▐")).toEqual([[4, 0, 4, 20]]);
    expect(rects("▏")).toEqual([[0, 0, 1, 20]]);
    expect(draw("░").rects[0]!.alpha).toBe(0.25);
    expect(draw("▓").rects[0]!.alpha).toBe(0.75);
    expect(rects("▚")).toEqual([[0, 0, 4, 10], [4, 10, 4, 10]]);
    expect(rects("▟")).toEqual([[4, 0, 4, 10], [0, 10, 4, 10], [4, 10, 4, 10]]);
  });

  it("joins the pieces of a line across a run of cells into one rectangle", () => {
    // ┌─┬: the top line is one piece from the corner's start to the right edge; the uprights stay their own
    const run = boxRun([draw("┌"), draw("─"), draw("┬")], 8);
    expect(run.rects.map((r) => [r.x, r.y, r.w, r.h])).toEqual([[3.5, 9.5, 20.5, 1], [3.5, 9.5, 1, 10.5], [19.5, 9.5, 1, 10.5]]);
    // a shade beside a full block is another colour: not joined
    expect(boxRun([draw("█"), draw("░"), draw("█")], 8).rects).toHaveLength(3);
    expect(boxRun([draw("█"), draw("█")], 8).rects.map((r) => [r.x, r.w])).toEqual([[0, 16]]);
    // a row as wide as the widest grid: every line joined, in one pass over its pieces
    const wide = boxRun(Array.from({ length: 1000 }, () => draw("┼")), 8);
    expect(wide.rects).toHaveLength(1001);
    expect(wide.rects[0]).toEqual({ x: 0, y: 9.5, w: 8000, h: 1 });
    // an arc moves with its cell
    expect(boxRun([draw("─"), draw("╮")], 8).arcs[0]).toMatchObject({ x: 11.5, right: false, down: true });
  });

  it("lands a column's line on the same device pixel whether its cell stands alone or in a run", () => {
    // column 14 of a 6.50279px grid at 2x: alone in an element at 91.06, and as the 15th cell of a run at 0.03
    const cell = 6.50279;
    const alone = pixelPlacement(14 * cell, 0, Math.round(91.06 * 2) / 2, 0, 2);
    const inRun = pixelPlacement(0, 0, 0, 0, 2);
    const upright = 2.75;
    expect(Math.round(91.06 * 2) / 2 + alone.x(upright)).toBe(inRun.x(14 * cell + upright));
    // and both edges snap, so a 1px line is 2 device pixels wide wherever it falls
    expect(alone.x(upright + 1) - alone.x(upright)).toBe(1);
    expect(pixelPlacement(0, 0, 0, 0, 1).y(9.5)).toBe(10);
    expect(boxBackground(draw("│"), pixelPlacement(0, 0, 0, 0, 1))).toBe("linear-gradient(currentColor,currentColor) 4px 0px/1px 20px no-repeat");
  });

  it("draws Powerline's separators to the cell, from the top of the row to the bottom", () => {
    for (let code = 0xe0b0; code <= 0xe0b7; code++) {
      const char = String.fromCodePoint(code);
      expect(isBoxGlyph(char)).toBe(true);
      expect(BOX_GLYPHS.test(char)).toBe(true);
      const shapes = draw(char).shapes!;
      // every shape together covers the whole cell, top to bottom
      expect(Math.min(...shapes.map((s) => s.y))).toBe(0);
      expect(Math.max(...shapes.map((s) => s.y + s.h))).toBe(20);
      expect(shapes.every((s) => s.x === 0 && s.w === 8)).toBe(true);
    }
    // a filled arrow: the two halves of a triangle pointing right
    expect(draw("\ue0b0").shapes!.map((s) => s.image)).toEqual(["linear-gradient(to top right,currentColor 50%,transparent 50%)", "linear-gradient(to bottom right,currentColor 50%,transparent 50%)"]);
    expect(draw("\ue0b6").shapes![0]!.image.startsWith("radial-gradient(100% 50% at 100% 50%,currentColor")).toBe(true);
    // other private use characters are icons, left to the font
    expect(isBoxGlyph("\ue0a0")).toBe(false);
    expect(isBoxGlyph("\ue0b8")).toBe(false);
    expect(boxDrawing("\uf07b", 8, 20, 13)).toBeNull();
    // in a run, a shape moves with its cell
    expect(boxRun([draw("─"), draw("\ue0b0")], 8).shapes!.map((s) => s.x)).toEqual([8, 8]);
  });

  it("paints in the text colour, one background layer per rectangle", () => {
    expect(boxBackground(draw("┐"))).toBe("linear-gradient(currentColor,currentColor) 0px 9.5px/4.5px 1px no-repeat,linear-gradient(currentColor,currentColor) 3.5px 9.5px/1px 10.5px no-repeat");
    expect(boxBackground(draw("▒"))).toBe("linear-gradient(color-mix(in srgb,currentColor 50%,transparent),color-mix(in srgb,currentColor 50%,transparent)) 0px 0px/8px 20px no-repeat");
    expect(boxBackground(draw("╭")).startsWith("radial-gradient(circle at 4.5px 4.5px,transparent 3px,currentColor 3.5px,currentColor 4.5px,transparent 5px) 3.5px 9.5px/4.5px 4.5px no-repeat,")).toBe(true);
    // ╯: the square sits up and left of the lines' corner, the circle's centre at its own top left
    expect(boxBackground(draw("╯")).startsWith("radial-gradient(circle at 0px 0px,transparent 3px,currentColor 3.5px,currentColor 4.5px,transparent 5px) 0px 6px/4.5px 4.5px no-repeat,")).toBe(true);
  });
});
