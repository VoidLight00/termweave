import { describe, expect, it } from "bun:test";
import { mirrorFrame, mirrorRows } from "../../server/mirror.ts";
import { MIRROR_HOLD_MAX_BYTES, MirrorCompositionBuffer, parseMirrorFrame, utf8Bytes } from "./mirrorCompositionBuffer.ts";

/**
 * A terminal reduced to what the mirror's frames use: SGR, cursor position, erase line/display, CR,
 * LF and printable text. Each cell keeps the SGRs in force when it was drawn (from the last reset on),
 * so a colour a row left on and the row below inherited is part of what is compared.
 */
function screenAfter(writes: string[], gridRows: number) {
  let rows: { ch: string; attrs: string }[][] = [];
  let row = 0, col = 0;
  let attrs: string[] = [];
  const modes: Record<string, string> = {};
  const token = /\x1b\[([0-9;:?]*)([A-Za-z])|\r|\n|[\s\S]/gu;
  for (const data of writes) {
    for (const [whole, params, final] of data.matchAll(token)) {
      if (final === "m") {
        if (/^0*(?:[;:]|$)/.test(params!)) attrs = [whole];
        else attrs.push(whole);
      } else if (final === "H") {
        const [r = "1", c = "1"] = params!.split(";");
        row = Number(r || 1) - 1; col = Number(c || 1) - 1;
      } else if (final === "J" && params === "2") rows = [];
      else if (final === "K" && params === "2") rows[row] = [];
      else if ((final === "h" || final === "l") && params!.startsWith("?")) modes[params!] = final;
      else if (final !== undefined) throw new Error(`unexpected sequence ${JSON.stringify(whole)}`);
      else if (whole === "\r") col = 0;
      else if (whole === "\n") row++;
      else { (rows[row] ??= [])[col++] = { ch: whole, attrs: attrs.join("") }; }
    }
  }
  const cells = Array.from({ length: gridRows }, (_, index) => Array.from(rows[index] ?? [], (cell) => cell ?? null));
  return { cells, row, col, attrs: attrs.join(""), modes };
}

/** what the frames, held and taken, leave on a terminal that showed `before` */
function held(before: string, frames: string[], gridRows: number) {
  const buffer = new MirrorCompositionBuffer("stream");
  for (const frame of frames) expect(buffer.absorb(frame, gridRows)).toEqual({ ok: true });
  const write = buffer.take();
  return { write, screen: screenAfter([before, write], gridRows) };
}

const GRID = 12;
const BEFORE = mirrorFrame(Array.from({ length: GRID }, (_, index) => `before ${index}`).join("\n"), GRID);
// colours, a colour left on at a row's end (the row below draws in it), Korean, CJK, emoji with a skin tone
const S0 = [
  "\x1b[1;31m빨강 bold\x1b[0m plain 한국어",
  "\x1b[44mopen blue background ",
  "inherits the blue 😀 👍🏽",
  "\x1b[38;5;208m주황 256\x1b[0m",
  ...Array.from({ length: 7 }, (_, index) => `row ${index + 4} 中文 \x1b[32mgreen\x1b[0m`),
  "$ prompt 한",
];
// row A: the open-colour row redrawn; the row under it keeps the blue it was drawn in
const S1 = S0.map((text, index) => index === 1 ? "\x1b[45mmagenta 바뀜\x1b[0m" : text);
// row B and more: a row in colour, a row cleared, and the screen two rows shorter (the cursor moves up)
const S2 = S1.slice(0, 10).map((text, index) => index === 5 ? "\x1b[33m노랑 🎉\x1b[0m" : index === 7 ? "" : text);
const screen = (rows: string[]) => rows.join("\n");

describe("parseMirrorFrame", () => {
  it("reads server/mirror.ts's whole screens and changed rows as they are made", () => {
    expect(parseMirrorFrame(mirrorFrame(screen(S0), GRID))).toEqual({ kind: "whole", rows: S0 });
    const rows = parseMirrorFrame(mirrorRows(screen(S1), screen(S2), GRID));
    expect(rows).toEqual({ kind: "rows", rows: new Map([[5, S2[5]!], [7, ""], [10, ""], [11, ""], [9, S2[9]!]]), last: 9 });
    expect(parseMirrorFrame(mirrorFrame("", GRID))).toEqual({ kind: "whole", rows: [""] });
  });

  it("knows no other shape", () => {
    for (const data of ["plain text", "\x1b[2J\x1b[Hraw screen", "\x1b[?25l\x1b[?7l\x1b[0m\x1b[?7h", "\x1b[?25l\x1b[?7lstray\x1b[1;1H\x1b[0m\x1b[2Kx\x1b[0m\x1b[?7h",
      mirrorFrame(screen(S0), GRID).slice(0, -3), mirrorRows(screen(S0), screen(S1), GRID).slice(4), "\x1b[?25l\x1b[?7l\x1b[0;1H\x1b[0m\x1b[2Kx\x1b[0m\x1b[?7h"]) {
      expect(parseMirrorFrame(data)).toBeNull();
    }
  });
});

describe("MirrorCompositionBuffer", () => {
  it("whole screen, row A, row B: one write leaves the screen the three frames written one by one leave", () => {
    const frames = [mirrorFrame(screen(S0), GRID), mirrorRows(screen(S0), screen(S1), GRID), mirrorRows(screen(S1), screen(S2), GRID)];
    const reference = screenAfter([BEFORE, ...frames], GRID);
    const { screen: result } = held(BEFORE, frames, GRID);
    expect(result).toEqual(reference);
    // the blue row 1 left on is still under row 2's text, and row 1 is magenta now
    expect(reference.cells[2]![0]!.attrs).toBe("\x1b[0m\x1b[44m");
    expect(reference.cells[1]![0]!.attrs).toBe("\x1b[0m\x1b[45m");
    // the cursor ends on the shorter screen's last row, rows past it are cleared
    expect([result.row, result.cells[10], result.cells[11], result.cells[7]]).toEqual([9, [], [], []]);
    // only the last raw frame: row A, the whole screen and the rows it did not change are lost
    expect(screenAfter([BEFORE, frames[2]!], GRID)).not.toEqual(reference);
  });

  it("a whole screen drops the rows held before it", () => {
    const buffer = new MirrorCompositionBuffer("stream");
    expect(buffer.absorb(mirrorRows(screen(S0), screen(S1), GRID), GRID).ok).toBe(true);
    expect(buffer.absorb(mirrorFrame(screen(S2), GRID), GRID).ok).toBe(true);
    expect(buffer.take()).toBe(mirrorFrame(screen(S2), GRID));
  });

  it("rows alone: each changed row once, its latest text, over the screen the terminal shows", () => {
    const base = screen(S0);
    const first = S0.map((text, index) => index === 2 ? "first A" : index === 4 ? "only B" : text);
    const second = first.map((text, index) => index === 2 ? "second A" : text);
    const { write, screen: result } = held(mirrorFrame(base, GRID), [mirrorRows(base, screen(first), GRID), mirrorRows(screen(first), screen(second), GRID)], GRID);
    expect(write).toBe(mirrorRows(base, screen(second), GRID));
    expect(write).not.toContain("first A");
    expect(result).toEqual(screenAfter([mirrorFrame(base, GRID), mirrorRows(base, screen(first), GRID), mirrorRows(screen(first), screen(second), GRID)], GRID));
  });

  it("matches frame-by-frame writes over random screens and frame orders", () => {
    let seed = 0x5eed;
    // the high bits: an LCG's low bits repeat after a few steps
    const random = (n: number) => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return (seed >>> 12) % n; };
    const pieces = ["plain", "한글 입력", "中文", "😀", "👍🏽", "\x1b[31mred\x1b[0m", "\x1b[1;4mbold\x1b[0m", "\x1b[42mopen green ", "\x1b[38;2;10;20;30mtrue", "\x1b[0;35mreset-magenta", "\x1b[m", ""];
    const row = () => Array.from({ length: random(4) }, () => pieces[random(pieces.length)]).join(" ");
    const grid = 8;
    for (let run = 0; run < 1000; run++) {
      const next = (from: string[] | null) => {
        const length = 1 + random(grid);
        return Array.from({ length }, (_, index) => from && index < from.length && random(3) > 0 ? from[index]! : row());
      };
      let shown = next(null);
      const before = mirrorFrame(screen(shown), grid);
      const frames: string[] = [];
      for (let count = 1 + random(6); count > 0; count--) {
        const after = next(shown);
        frames.push(random(3) === 0 ? mirrorFrame(screen(after), grid) : mirrorRows(screen(shown), screen(after), grid));
        shown = after;
      }
      const { screen: result } = held(before, frames, grid);
      expect({ run, result }).toEqual({ run, result: screenAfter([before, ...frames], grid) });
    }
  });

  it("holds one screen: rows and bytes stay bounded however long the output goes on", () => {
    const buffer = new MirrorCompositionBuffer("stream");
    let shown = screen(S0);
    let most = 0;
    for (let tick = 0; tick < 5000; tick++) {
      const rows = shown.split("\n").map((text, index) => index === tick % GRID || index === GRID - 1 ? `tick ${tick} 한글 \x1b[3${tick % 8}m😀\x1b[0m` : text);
      const after = rows.join("\n");
      expect(buffer.absorb(tick % 50 === 0 ? mirrorFrame(after, GRID) : mirrorRows(shown, after, GRID), GRID)).toEqual({ ok: true });
      shown = after;
      most = Math.max(most, buffer.bytes);
      expect(buffer.heldRows).toBeLessThanOrEqual(GRID);
    }
    expect(most).toBeLessThan(4096);
    expect(screenAfter([BEFORE, buffer.take()], GRID)).toEqual(screenAfter([BEFORE, mirrorFrame(shown, GRID)], GRID));
    expect(buffer.take()).toBe("");
  });

  it("fails without holding: another shape, more rows than the grid, more than 1 MiB", () => {
    const whole = mirrorFrame(screen(S0), GRID);
    for (const [frame, reason] of [
      ["\x1b[2J\x1b[Hraw screen", "not a mirror frame"],
      [mirrorFrame(screen([...S0, "one more"])), "13 rows on a grid of 12"],
      [mirrorRows(screen(S0), screen([...S0.slice(0, -1), "x", "y"]), GRID + 1), "a row past the grid's 12"],
      [mirrorFrame("x".repeat(MIRROR_HOLD_MAX_BYTES + 1)), "over 1048576"],
      // counted in UTF-8 bytes, not string length: 349,526 syllables are 1,048,578 bytes
      [mirrorFrame("한".repeat(349_526)), "over 1048576"],
    ] as const) {
      const buffer = new MirrorCompositionBuffer("stream");
      expect(buffer.absorb(whole, GRID)).toEqual({ ok: true });
      const result = buffer.absorb(frame, GRID);
      expect(result.ok).toBe(false);
      if (!result.ok) expect([result.reason.includes(reason), result.fresh]).toEqual([true, true]);
      expect(buffer.failed).not.toBeNull();
      // a frame after the failure is held, but not acknowledged: an ACK of it would cover the one that failed
      const later = buffer.absorb(mirrorRows(screen(S0), screen(S1), GRID), GRID);
      expect(later).toEqual({ ok: false, reason: expect.stringContaining("earlier frame failed"), fresh: false });
      expect(screenAfter([BEFORE, buffer.take()], GRID)).toEqual(screenAfter([BEFORE, whole, mirrorRows(screen(S0), screen(S1), GRID)], GRID));
    }
    // exactly at the bound is held
    expect(new MirrorCompositionBuffer(null).absorb(mirrorFrame("x".repeat(MIRROR_HOLD_MAX_BYTES)), 1)).toEqual({ ok: true });
    expect(new MirrorCompositionBuffer(null).absorb(mirrorFrame("한".repeat(349_525)), 1)).toEqual({ ok: true });
  });

  it("has nothing to write when nothing was held", () => {
    expect(new MirrorCompositionBuffer(null).take()).toBe("");
  });
});

describe("utf8Bytes", () => {
  it("counts as the server does", () => {
    for (const text of ["", "ascii", "한글", "😀👍🏽", "é", "\ud800 lone", "end \udc00", "\x1b[31m중\x1b[0m"]) expect(utf8Bytes(text)).toBe(Buffer.byteLength(text));
  });
});
