/**
 * Box-drawing and block characters, drawn instead of taken from a font.
 *
 * xterm's DOM renderer writes them as text, and a font's glyph is not the cell: the row is
 * taller than the font's box, so a vertical line stops short of the row below and every frame
 * an agent's TUI draws came out as dashes down its sides; a corner did not meet its lines;
 * and a phone's font draws the heavy forms `━ ┃ ╋` like the light ones, or as `- | +` (#289).
 * xterm's own fix for this (custom glyphs) exists only in its canvas and WebGL renderers.
 *
 * So each such character becomes a cell-sized box whose lines are painted as backgrounds in
 * the text colour, edge to edge: a line is a rectangle from the cell's edge to its centre,
 * and what a junction joins decides how far past the centre it reaches. The character stays
 * in the DOM, unpainted, and copy reads xterm's buffer as before.
 *
 * Covered: U+2500-257F but the three diagonals, which no rectangle draws, and the block
 * elements U+2580-259F.
 */

/** One painted rectangle, in px from the cell's top left; `alpha` below 1 is a shade. */
export interface BoxRect { x: number; y: number; w: number; h: number; alpha?: number }
/**
 * A quarter circle joining two half lines (the rounded corners): `x` is the left edge of
 * the upright it runs into, `y` the top edge of the line across, `right` and `down` which
 * way those lines leave.
 */
export interface BoxArc { x: number; y: number; r: number; t: number; right: boolean; down: boolean }
/** A shape painted by a gradient of its own over the box `x`,`y`,`w`,`h` (Powerline's arrows and half circles). */
export interface BoxShape { x: number; y: number; w: number; h: number; image: string }
export interface BoxDrawing { rects: BoxRect[]; arcs: BoxArc[]; shapes?: BoxShape[] }

/** 0 none, 1 light, 2 heavy, 3 double */
type Weight = 0 | 1 | 2 | 3;
/** left, right, up, down */
type Arms = readonly [Weight, Weight, Weight, Weight];

/**
 * U+2500-257F as `LRUD` arm weights; `h`/`v` + dashes + weight for the dashed lines, `a` +
 * the two arms of a rounded corner, `x` for the diagonals (left to the font).
 */
const LINES = (
  "1100 2200 0011 0022 h31 h32 v31 v32 h41 h42 v41 v42 0101 0201 0102 0202 " + // 2500
  "1001 2001 1002 2002 0110 0210 0120 0220 1010 2010 1020 2020 0111 0211 0121 0112 " + // 2510
  "0122 0221 0212 0222 1011 2011 1021 1012 1022 2021 2012 2022 1101 2101 1201 2201 " + // 2520
  "1102 2102 1202 2202 1110 2110 1210 2210 1120 2120 1220 2220 1111 2111 1211 2211 " + // 2530
  "1121 1112 1122 2121 1221 2112 1212 2221 2212 2122 1222 2222 h21 h22 v21 v22 " + // 2540
  "3300 0033 0301 0103 0303 3001 1003 3003 0310 0130 0330 3010 1030 3030 0311 0133 " + // 2550
  "0333 3011 1033 3033 3301 1103 3303 3310 1130 3330 3311 1133 3333 aRD aLD aLU aRU " + // 2560
  "x x x 1000 0010 0100 0001 2000 0020 0200 0002 1200 0012 2100 0021" // 2570
).split(" ");

/** U+2596-259F as quadrants: upper left 1, upper right 2, lower left 4, lower right 8 */
const QUADRANTS = [4, 8, 1, 13, 9, 7, 11, 2, 6, 14];

/**
 * Powerline's separators, U+E0B0-E0B7: filled and outlined arrows, filled and outlined half
 * circles. They join a prompt's segments from the top of the row to the bottom, and a font
 * draws them no taller than its own box, nor one cell wide when its icons advance 1em.
 */
const POWERLINE_FIRST = 0xe0b0;
const POWERLINE_LAST = 0xe0b7;
/** half the width of an outlined arrow's or half circle's line */
const OUTLINE = 0.75;

function powerlineShapes(code: number, w: number, h: number): BoxShape[] {
  const fill = (to: string) => `linear-gradient(to ${to},currentColor 50%,transparent 50%)`;
  // a band along the line between the two corners the 50% line of the gradient joins
  const line = (to: string) => `linear-gradient(to ${to},transparent calc(50% - ${OUTLINE}px),currentColor calc(50% - ${OUTLINE}px),currentColor calc(50% + ${OUTLINE}px),transparent calc(50% + ${OUTLINE}px))`;
  const half = (image: (to: string) => string, top: string, bottom: string): BoxShape[] => [
    { x: 0, y: 0, w, h: h / 2, image: image(top) },
    { x: 0, y: h / 2, w, h: h / 2, image: image(bottom) },
  ];
  const round = (at: string, outlined: boolean): BoxShape[] => [{
    x: 0, y: 0, w, h,
    image: outlined
      ? `radial-gradient(100% 50% at ${at} 50%,transparent calc(100% - ${2 * OUTLINE + 0.5}px),currentColor calc(100% - ${2 * OUTLINE}px),currentColor calc(100% - 0.5px),transparent 100%)`
      : `radial-gradient(100% 50% at ${at} 50%,currentColor calc(100% - 0.5px),transparent 100%)`,
  }];
  switch (code) {
    case 0xe0b0: return half(fill, "top right", "bottom right");
    case 0xe0b1: return half(line, "top right", "bottom right");
    case 0xe0b2: return half(fill, "top left", "bottom left");
    case 0xe0b3: return half(line, "top left", "bottom left");
    case 0xe0b4: return round("0%", false);
    case 0xe0b5: return round("0%", true);
    case 0xe0b6: return round("100%", false);
    default: return round("100%", true);
  }
}

export function isBoxGlyph(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  if (code >= POWERLINE_FIRST && code <= POWERLINE_LAST) return true;
  if (code >= 0x2580 && code <= 0x259f) return true;
  return code >= 0x2500 && code <= 0x257f && LINES[code - 0x2500] !== "x";
}

export const BOX_GLYPHS = /[\u2500-\u259f\ue0b0-\ue0b7]/;

/** Line widths for a font size: a light line is a pixel at 13px, a heavy one three. */
export function boxStrokes(fontSize: number): { light: number; heavy: number } {
  const light = Math.max(1, Math.round(fontSize / 13));
  return { light, heavy: light * 3 };
}

/**
 * What to paint for `char` in a cell of `w` by `h` px; null for a character that is not
 * drawn here.
 */
export function boxDrawing(char: string, w: number, h: number, fontSize: number): BoxDrawing | null {
  const code = char.codePointAt(0) ?? 0;
  const { light, heavy } = boxStrokes(fontSize);
  if (code >= POWERLINE_FIRST && code <= POWERLINE_LAST) return { rects: [], arcs: [], shapes: powerlineShapes(code, w, h) };
  if (code >= 0x2580 && code <= 0x259f) return { rects: blockRects(code, w, h), arcs: [] };
  if (code < 0x2500 || code > 0x257f) return null;
  const spec = LINES[code - 0x2500]!;
  if (spec === "x") return null;
  if (spec[0] === "h" || spec[0] === "v") {
    const dashes = Number(spec[1]);
    const t = spec[2] === "2" ? heavy : light;
    const across = spec[0] === "h";
    const length = across ? w : h;
    // each dash leaves a quarter of its share as the gap after it, a pixel at least
    const share = length / dashes;
    const gap = Math.max(1, share / 4);
    const rects: BoxRect[] = [];
    for (let i = 0; i < dashes; i++) {
      const from = i * share + gap / 2;
      rects.push(across ? { x: from, y: (h - t) / 2, w: share - gap, h: t } : { x: (w - t) / 2, y: from, w: t, h: share - gap });
    }
    return { rects, arcs: [] };
  }
  if (spec[0] === "a") {
    const right = spec[1] === "R";
    const down = spec[2] === "D";
    const t = light;
    const r = Math.min(w, h) / 2;
    const rects: BoxRect[] = [];
    // what the arc leaves of each half line, a pixel into the arc's straight end so no gap opens between them
    const lap = Math.min(1, r);
    if (w / 2 > r) rects.push({ x: right ? w / 2 + r - lap : 0, y: (h - t) / 2, w: w / 2 - r + lap, h: t });
    if (h / 2 > r) rects.push({ x: (w - t) / 2, y: down ? h / 2 + r - lap : 0, w: t, h: h / 2 - r + lap });
    return { rects, arcs: [{ x: (w - t) / 2, y: (h - t) / 2, r, t, right, down }] };
  }
  const arms = [...spec].map(Number) as unknown as Arms;
  return { rects: lineRects(arms, w, h, light, heavy), arcs: [] };
}

function blockRects(code: number, w: number, h: number): BoxRect[] {
  if (code === 0x2580) return [{ x: 0, y: 0, w, h: h / 2 }];
  if (code <= 0x2588) { const part = (h * (code - 0x2580)) / 8; return [{ x: 0, y: h - part, w, h: part }]; }
  if (code <= 0x258f) return [{ x: 0, y: 0, w: (w * (0x2590 - code)) / 8, h }];
  if (code === 0x2590) return [{ x: w / 2, y: 0, w: w / 2, h }];
  if (code <= 0x2593) return [{ x: 0, y: 0, w, h, alpha: (code - 0x2590) / 4 }];
  if (code === 0x2594) return [{ x: 0, y: 0, w, h: h / 8 }];
  if (code === 0x2595) return [{ x: w - w / 8, y: 0, w: w / 8, h }];
  const quadrants = QUADRANTS[code - 0x2596]!;
  const rects: BoxRect[] = [];
  for (const [bit, x, y] of [[1, 0, 0], [2, w / 2, 0], [4, 0, h / 2], [8, w / 2, h / 2]] as const) {
    if (quadrants & bit) rects.push({ x, y, w: w / 2, h: h / 2 });
  }
  return rects;
}

/**
 * The rectangles of a junction. Each arm runs from its edge towards the centre and `reach`es
 * past it by what it joins: half the width of a line it crosses, the far line of a double
 * corner, or short of the centre where a double line turns away from it.
 */
function lineRects(arms: Arms, w: number, h: number, light: number, heavy: number): BoxRect[] {
  const [left, right, up, down] = arms;
  // a double line is two light ones, their centres this far from the cell's
  const offset = light;
  const width = (weight: Weight): number => (weight === 2 ? heavy : weight === 0 ? 0 : light);
  const rects: BoxRect[] = [];
  /** one arm: `along` its direction the cell is `length` long, `across` it `breadth` wide */
  const arm = (weight: Weight, opposite: Weight, before: Weight, after: Weight, length: number, breadth: number, toStart: boolean, place: (from: number, to: number, at: number, t: number) => BoxRect): void => {
    if (weight === 0) return;
    const crossed = Math.max(before === 3 ? 0 : width(before), after === 3 ? 0 : width(after));
    const span = (reach: number, at: number, t: number): void => {
      rects.push(toStart ? place(0, length / 2 + reach, at, t) : place(length / 2 - reach, length, at, t));
    };
    if (weight !== 3) {
      const t = width(weight);
      const reach = opposite ? 0
        : before === 3 && after === 3 ? -offset + light / 2
          : before === 3 || after === 3 ? offset + light / 2
            : crossed / 2;
      span(reach, (breadth - t) / 2, t);
      return;
    }
    for (const side of [-1, 1] as const) {
      const near = side < 0 ? before : after;
      const far = side < 0 ? after : before;
      const reach = near === 3 ? -offset + light / 2 : far === 3 ? offset + light / 2 : crossed / 2;
      span(reach, breadth / 2 + side * offset - light / 2, light);
    }
  };
  const across = (from: number, to: number, at: number, t: number): BoxRect => ({ x: from, y: at, w: to - from, h: t });
  const upright = (from: number, to: number, at: number, t: number): BoxRect => ({ x: at, y: from, w: t, h: to - from });
  arm(left, right, up, down, w, h, true, across);
  arm(right, left, up, down, w, h, false, across);
  arm(up, down, left, right, h, w, true, upright);
  arm(down, up, left, right, h, w, false, upright);
  return joined(rects);
}

/**
 * Rectangles that continue each other end to end, as one. Two that meet at half a pixel (the
 * middle of a 19px row, the edge of a 7.8px cell) are each painted with a soft edge there,
 * and the line showed a notch. Pieces across first, then pieces down; each pass sorts the
 * pieces of one line, so a row of a thousand cells costs no more per cell than a short one.
 */
function joined(rects: readonly BoxRect[]): BoxRect[] {
  const pass = (list: readonly BoxRect[], across: boolean): BoxRect[] => {
    const lines = new Map<string, BoxRect[]>();
    for (const rect of list) {
      const key = across ? `${rect.alpha}|${rect.y}|${rect.h}` : `${rect.alpha}|${rect.x}|${rect.w}`;
      const line = lines.get(key);
      if (line) line.push({ ...rect });
      else lines.set(key, [{ ...rect }]);
    }
    const out: BoxRect[] = [];
    for (const line of lines.values()) {
      line.sort((a, b) => (across ? a.x - b.x : a.y - b.y));
      let last: BoxRect | undefined;
      for (const rect of line) {
        const from = across ? rect.x : rect.y;
        const end = last === undefined ? 0 : across ? last.x + last.w : last.y + last.h;
        if (last !== undefined && from <= end + 0.01) {
          const to = Math.max(end, from + (across ? rect.w : rect.h));
          if (across) last.w = to - last.x;
          else last.h = to - last.y;
        } else {
          out.push(rect);
          last = rect;
        }
      }
    }
    return out;
  };
  return pass(pass(rects, true), false);
}

/**
 * A run of drawn characters side by side as one drawing, `w` apart. Cells are a fraction of a
 * pixel wide, so a line painted cell by cell showed a seam at every cell; here the pieces of a
 * line that touch end to end become one rectangle.
 */
export function boxRun(drawings: readonly BoxDrawing[], w: number): BoxDrawing {
  const rects: BoxRect[] = [];
  const arcs: BoxArc[] = [];
  const shapes: BoxShape[] = [];
  drawings.forEach((drawing, index) => {
    const shift = index * w;
    for (const arc of drawing.arcs) arcs.push({ ...arc, x: arc.x + shift });
    for (const shape of drawing.shapes ?? []) shapes.push({ ...shape, x: shape.x + shift });
    for (const rect of drawing.rects) rects.push({ ...rect, x: rect.x + shift });
  });
  return { rects: joined(rects), arcs, ...(shapes.length > 0 ? { shapes } : {}) };
}

const px = (value: number): string => `${Math.round(value * 1000) / 1000}px`;

/** Where a drawing's coordinates land in the element: the identity, or a snap to the screen's pixels. */
export interface BoxPlacement { x: (value: number) => number; y: (value: number) => number }
const AS_DRAWN: BoxPlacement = { x: (value) => value, y: (value) => value };

/**
 * Edges on whole device pixels, counted from the grid and not from the element. The browser
 * paints each element from its own pixel-snapped corner, so the same column's line fell on
 * one device pixel in a row where it was a cell of its own and on the next in a row where it
 * was the fifteenth cell of a run, and an upright jogged from row to row. `left` and `top` are
 * where the run's first cell starts in the grid, `origin` where its painted layer starts.
 * All of it is counted inside the grid, so a row drawn after the grid was panned lands on
 * the same pixels of the grid as the rows drawn before.
 */
export function pixelPlacement(left: number, top: number, originX: number, originY: number, ratio: number): BoxPlacement {
  return {
    x: (value) => Math.round((left + value) * ratio) / ratio - originX,
    y: (value) => Math.round((top + value) * ratio) / ratio - originY,
  };
}

/** The drawing as one CSS `background`, painted in the element's own text colour. */
export function boxBackground(drawing: BoxDrawing, place: BoxPlacement = AS_DRAWN): string {
  const layers: string[] = [];
  for (const arc of drawing.arcs) {
    const inner = arc.r - arc.t / 2;
    const outer = arc.r + arc.t / 2;
    // from the lines as placed, so the arc ends on them: its centre is a radius from each line's middle,
    // and the layer is the square between that centre and the corner the lines would have made
    const side = arc.r + arc.t / 2;
    const x = place.x(arc.x) + (arc.right ? 0 : arc.t - side);
    const y = place.y(arc.y) + (arc.down ? 0 : arc.t - side);
    layers.push(`radial-gradient(circle at ${arc.right ? px(side) : "0px"} ${arc.down ? px(side) : "0px"},transparent ${px(inner - 0.5)},currentColor ${px(inner)},currentColor ${px(outer)},transparent ${px(outer + 0.5)}) ${px(x)} ${px(y)}/${px(side)} ${px(side)} no-repeat`);
  }
  for (const shape of drawing.shapes ?? []) {
    const x = place.x(shape.x);
    const y = place.y(shape.y);
    layers.push(`${shape.image} ${px(x)} ${px(y)}/${px(place.x(shape.x + shape.w) - x)} ${px(place.y(shape.y + shape.h) - y)} no-repeat`);
  }
  for (const rect of drawing.rects) {
    const colour = rect.alpha === undefined ? "currentColor" : `color-mix(in srgb,currentColor ${Math.round(rect.alpha * 100)}%,transparent)`;
    const x = place.x(rect.x);
    const y = place.y(rect.y);
    // both edges are placed, so a line keeps one width wherever it falls
    layers.push(`linear-gradient(${colour},${colour}) ${px(x)} ${px(y)}/${px(place.x(rect.x + rect.w) - x)} ${px(place.y(rect.y + rect.h) - y)} no-repeat`);
  }
  return layers.join(",");
}
