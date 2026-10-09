import { describe, expect, it } from "bun:test";
import { Terminal } from "@xterm/xterm";

import { matchHerdrWidths } from "./terminalWidths.ts";

/** Where the cursor stands after `text`, as xterm counts it with herdr's widths. */
async function columnsAfter(text: string): Promise<number> {
  const term = new Terminal({ allowProposedApi: true, cols: 40, rows: 2 });
  matchHerdrWidths(term);
  await new Promise<void>((resolve) => term.write(text, resolve));
  const column = term.buffer.active.cursorX;
  term.dispose();
  return column;
}

// herdr's own answers: each text printed in a herdr 0.9 pane, then the cursor position
// read back with a DSR query (ESC [ 6 n)
const HERDR_COLUMNS: [string, string, number][] = [
  ["Unicode 9 emoji", "🤖", 2],
  ["emoji presentation selector on a text symbol", "⚠️", 2],
  ["the same symbol without one", "⚠", 1],
  ["ZWJ family", "👨‍👩‍👧", 2],
  ["skin tone", "👍🏽", 2],
  ["flag", "🇰🇷", 2],
  ["keycap", "1️⃣", 2],
  ["Unicode 14 emoji", "🫡", 2],
  ["Unicode 15 emoji", "🫨", 2],
  ["Thai SARA AM after a tone mark", "น้ำ", 2],
  ["Devanagari vowel sign", "का", 2],
  ["zero-width space", "a\u200bb", 2],
  ["left-to-right mark", "a\u200eb", 2],
  ["decomposed Hangul", "\u1112\u1161\u11ab", 2],
  ["Hangul and Han", "한漢", 4],
  ["ambiguous-width circle", "●", 1],
];

describe("matchHerdrWidths", () => {
  for (const [name, text, columns] of HERDR_COLUMNS) {
    it(`advances as herdr does: ${name}`, async () => {
      expect(await columnsAfter(text)).toBe(columns);
    });
  }

  it("keeps a ZWJ sequence whole in one cell, so the next character cannot overwrite part of it", async () => {
    const term = new Terminal({ allowProposedApi: true, cols: 40, rows: 2 });
    matchHerdrWidths(term);
    await new Promise<void>((resolve) => term.write("👨‍👩‍👧x", resolve));
    const line = term.buffer.active.getLine(0);
    expect(line?.getCell(0)?.getChars()).toBe("👨‍👩‍👧");
    expect(line?.getCell(2)?.getChars()).toBe("x");
    term.dispose();
  });
});
