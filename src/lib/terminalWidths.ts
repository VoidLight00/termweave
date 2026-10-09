/**
 * herdr lays out its screen with current Unicode widths: an emoji takes two cells, and so
 * does a whole emoji sequence (ZWJ family, skin tone, flag, keycap, an emoji-presentation
 * selector after a text symbol like ⚠️). Its attach stream counts on the browser's xterm
 * advancing the cursor exactly as far. xterm defaults to Unicode 6 widths, where most emoji
 * take one cell and a ZWJ sequence takes one per emoji, so the rest of the line shifted:
 * emoji overlapped the next letter, and parts of a sequence were overwritten (👨‍👩‍👧 lost the
 * 👧) or left behind as stale characters.
 *
 * xterm's grapheme addon brings Unicode 15 widths and emoji sequences, and it agrees with
 * herdr in all but three places, each corrected here:
 * - it joins a spacing mark (Thai SARA AM in น้ำ, a Devanagari vowel sign) to the letter
 *   before it as one cell, where herdr gives the mark its own cell, so a spacing mark starts
 *   a cell of its own;
 * - its tables predate Unicode 14 emoji (🫠), which it counts as one cell, so an emoji the
 *   browser knows as emoji-presentation takes two cells, and joins like any other emoji;
 * - it gives invisible format characters (zero-width space, direction marks, word joiner,
 *   Hangul filler) a cell, where herdr gives them none, so they join the cell before them.
 *   Characters that build emoji sequences (ZWJ, variation selectors, tags) and the Hangul
 *   jamo stay with the addon.
 */
import type { IUnicodeVersionProvider, Terminal } from "@xterm/xterm";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";

export const HERDR_UNICODE_VERSION = "15-herdr";

const SPACING_MARK = /[\p{Mc}\u0e33\u0eb3]/u;
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
const INVISIBLE = /(?![\u00ad\u1100-\u11ff\u200d\ufe00-\ufe0f\u{e0000}-\u{e0fff}])\p{Default_Ignorable_Code_Point}/u;
/** Below these, the tests above cannot match. */
const FIRST_INVISIBLE = 0x034f;
const FIRST_SPACING_MARK = 0x0903;
const FIRST_EMOJI_PRESENTATION = 0x231a;
/** Regional indicators are emoji-presentation one at a time, but only a pair is a (two-cell) flag. */
const REGIONAL_INDICATORS = [0x1f1e6, 0x1f1ff] as const;
/** A two-cell emoji the addon's tables know, standing in for a newer one with the same joining. */
const KNOWN_WIDE_EMOJI = 0x1f600;
/** A zero-width character the addon joins to the cell before it, standing in for one it does not. */
const KNOWN_INVISIBLE = 0x200c;

/** Which correction a code point needs, if any. */
type Kind = "plain" | "newer-emoji" | "spacing-mark" | "invisible";

/** The width provider that matches herdr's grid, built on the grapheme addon's. */
export function herdrWidthProvider(): IUnicodeVersionProvider {
  // the addon hands its providers only to terminal.unicode.register, so it registers into this
  let graphemes: IUnicodeVersionProvider | undefined;
  const collector = {
    unicode: {
      register: (provider: IUnicodeVersionProvider) => {
        if (provider.version === "15-graphemes") graphemes = provider;
      },
      activeVersion: "",
    },
  };
  // the addon reads nothing but `unicode` off the terminal it activates on
  const registrar = collector as unknown as Terminal;
  new UnicodeGraphemesAddon().activate(registrar);
  if (!graphemes) throw new Error("the grapheme addon registered no 15-graphemes provider");
  const inner = graphemes;
  // per code point above FIRST_INVISIBLE, which correction it needs
  const kinds = new Map<number, Kind>();
  const kindOf = (codepoint: number): Kind => {
    if (codepoint < FIRST_INVISIBLE) return "plain";
    let kind = kinds.get(codepoint);
    if (kind === undefined) {
      const char = String.fromCodePoint(codepoint);
      if (INVISIBLE.test(char)) kind = "invisible";
      else if (codepoint >= FIRST_SPACING_MARK && SPACING_MARK.test(char)) kind = "spacing-mark";
      else if (
        codepoint >= FIRST_EMOJI_PRESENTATION
        && (codepoint < REGIONAL_INDICATORS[0] || codepoint > REGIONAL_INDICATORS[1])
        && inner.wcwidth(codepoint) === 1
        && EMOJI_PRESENTATION.test(char)
      ) kind = "newer-emoji";
      else kind = "plain";
      kinds.set(codepoint, kind);
    }
    return kind;
  };

  return {
    version: HERDR_UNICODE_VERSION,
    wcwidth: (codepoint) => {
      const kind = kindOf(codepoint);
      return kind === "newer-emoji" ? 2 : kind === "invisible" ? 0 : inner.wcwidth(codepoint);
    },
    charProperties: (codepoint, preceding) => {
      switch (kindOf(codepoint)) {
        case "newer-emoji":
          return inner.charProperties(KNOWN_WIDE_EMOJI, preceding);
        case "spacing-mark":
          return inner.charProperties(codepoint, 0);
        case "invisible":
          // at the start of a line there is no cell to join; the addon's answer stands there
          return inner.charProperties(preceding === 0 ? codepoint : KNOWN_INVISIBLE, preceding);
        case "plain":
          return inner.charProperties(codepoint, preceding);
      }
    },
  };
}

/** Makes `term` count cells as herdr does. */
export function matchHerdrWidths(term: Terminal): void {
  term.unicode.register(herdrWidthProvider());
  term.unicode.activeVersion = HERDR_UNICODE_VERSION;
}
