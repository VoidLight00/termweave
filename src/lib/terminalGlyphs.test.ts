import { describe, expect, it } from "bun:test";

import { displayText, glyphFit, iconScale, oversizedIcon, textPresentation } from "./terminalGlyphs.ts";

// iPhone Safari at 13px: Menlo cells are 7.84px, Hangul from Apple SD Gothic Neo 11.24px
const IOS_CELL = 7.8367;
const IOS_HANGUL = 11.245;

describe("glyphFit", () => {
  it("enlarges an iPhone Hangul syllable, capped, and centers what is left", () => {
    const fit = glyphFit(2 * IOS_CELL - IOS_HANGUL, IOS_HANGUL, IOS_CELL);
    expect(fit?.scale).toBe(1.2);
    // the glyph and the spacing after scaling still fill exactly the two cells
    expect(IOS_HANGUL * fit!.scale + fit!.spacing).toBeCloseTo(2 * IOS_CELL, 6);
    expect(fit!.spacing).toBeGreaterThan(0);
  });

  it("enlarges a 1em Han glyph only until it fills 90% of its cells", () => {
    const fit = glyphFit(2 * IOS_CELL - 13, 13, IOS_CELL);
    expect(13 * fit!.scale).toBeCloseTo(0.9 * 2 * IOS_CELL, 6);
    expect(fit!.spacing).toBeCloseTo(0.1 * 2 * IOS_CELL, 6);
  });

  it("leaves a glyph that nearly fills its cells as drawn (CJK on Linux)", () => {
    expect(glyphFit(1.04, 13, 7.02)).toBeNull();
  });

  it("only centers a narrow glyph in one cell, never enlarges it", () => {
    expect(glyphFit(IOS_CELL - 3.25, 3.25, IOS_CELL)).toEqual({ scale: 1, spacing: IOS_CELL - 3.25 });
  });

  it("leaves rounding-level spacing and glyphs wider than their cells alone", () => {
    expect(glyphFit(0.6, 4, 4.6)).toBeNull();
    expect(glyphFit(2 * IOS_CELL - 17, 17, IOS_CELL)).toBeNull();
  });
});

describe("icons fitted to their cells", () => {
  it("takes a Nerd Font icon wider than its cell for one to fit, and nothing else", () => {
    // Symbols Nerd Font Mono advances 1em: 13px against a 6.5px cell
    expect(oversizedIcon("\uf07b", 13, 6.5)).toBe(true);
    expect(oversizedIcon("\u{f0219}", 13, 7.8)).toBe(true);
    expect(oversizedIcon("\uf07b", 7, 6.5)).toBe(false);
    expect(oversizedIcon("👍", 13, 6.5)).toBe(false);
    expect(oversizedIcon("①", 13, 6.5)).toBe(false);
    expect(oversizedIcon("a", 13, 6.5)).toBe(false);
  });

  it("scales a run so its widest icon fills its cell", () => {
    expect(iconScale([13, 13], 6.5)).toBe(0.5);
    expect(iconScale([13, 10], 6.5)).toBe(0.5);
    expect(iconScale([6], 6.5)).toBe(1);
  });
});

describe("textPresentation", () => {
  it("asks a text-default symbol for its text form, so iOS does not draw ⏺ as a two-cell emoji", () => {
    expect(textPresentation("⏺ ✔")).toBe("⏺\ufe0e ✔\ufe0e");
  });

  it("leaves a span alone when it already chooses a presentation anywhere", () => {
    // xterm measured ⏺️ as the emoji it asks to be; respacing it as text would shift X
    expect(textPresentation("⏺\ufe0fX")).toBeNull();
    expect(textPresentation("⏺⏺\ufe0f")).toBeNull();
    expect(textPresentation("⏺\ufe0e")).toBeNull();
  });

  it("leaves emoji and plain text alone", () => {
    expect(textPresentation("😀#1 ●")).toBeNull();
  });
});

describe("displayText", () => {
  it("composes stacked marks iOS Safari would drop", () => {
    expect(displayText("Tie\u0302\u0301ng a\u0306\u0309")).toBe("Tiếng ẳ");
  });

  it("composes decomposed Hangul into its syllables", () => {
    expect(displayText("\u1112\u1161\u11ab\u1100\u1173\u11af")).toBe("한글");
  });

  it("keeps text without marks as it is", () => {
    expect(displayText("한글 ﾊﾝｶｸ ㄱㅏ abc")).toBe("한글 ﾊﾝｶｸ ㄱㅏ abc");
  });
});
