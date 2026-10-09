/**
 * xterm's DOM renderer sizes every cell from the Latin font and gives each glyph the
 * difference to its cells as letter-spacing, which lands after the glyph: a narrower glyph
 * sits at the left edge of its cells. With a 1em CJK fallback beside a 0.54em Latin cell
 * (Linux) that leftover is a pixel. Apple's Menlo cell is 0.6em, though, and no font on
 * iPhone draws Hangul wider than 0.87em, so every syllable trailed a 4px gap and Korean read
 * as falling apart (kana and Han too, at 0.87em to 1em).
 *
 * So each span the renderer draws with extra spacing is adjusted after the fact:
 * - a glyph in two cells that fills less than FILL of them is drawn larger, up to
 *   MAX_SCALE, the way a CJK coding font sizes it against its Latin;
 * - the glyph is centered in its cells: padding moves the text right by half the spacing
 *   left over, a negative margin takes it back after the span so the next span keeps its
 *   column, and a clip trims the trailing half so a background or block cursor stays on its
 *   own cells.
 * A glyph wider than its cells is left to run over, as in a native terminal.
 *
 * The renderer also hands the browser each cell's text as written, and two kinds of text
 * draw wrong on iPhone:
 * - iOS Safari draws only the first of two stacked marks on a decomposed letter (`e` +
 *   U+0302 + U+0301, as in a Vietnamese file name from a Mac), so such text is shown composed
 *   (NFC), and decomposed Hangul with it, which then measures as the syllable it is;
 * - iOS draws a symbol that is text by default, such as ⏺ (the bullet before every Claude
 *   Code message), as a color emoji two cells wide in its one cell, so a symbol that
 *   overflows its cell is asked for its text form (U+FE0E).
 * Copy reads xterm's buffer, not the DOM, and still returns what the pane wrote.
 *
 * Box-drawing and block characters are not text to fit at all: each is replaced by a
 * cell-sized box with its lines painted in (terminalBoxGlyphs.ts).
 */
import type { Terminal } from "@xterm/xterm";

import { BOX_GLYPHS, boxBackground, boxDrawing, boxRun, pixelPlacement, type BoxDrawing } from "./terminalBoxGlyphs.ts";

/** Spacing up to this is rounding between the font and the cell grid, not a misfit glyph. */
const MIN_SPACING_PX = 1;
/**
 * A glyph filling this much of its cells is left as drawn (a 1em CJK glyph on Linux fills
 * 93%); a narrower one is centered, and a two-cell one enlarged to fill this much.
 */
const FILL = 0.9;
/** The most a wide glyph is enlarged, so it never towers over the Latin beside it. */
const MAX_SCALE = 1.2;

/** marks a cell this module drew itself, so the observer does not take it for a span to adjust */
const BOX_CLASS = "herdr-box-glyph";

/** Combining marks, and the Hangul vowel and final jamo a decomposed syllable continues with. */
const DECOMPOSED = /[\p{M}\u1160-\u11ff]/u;
/** A pictograph that is text by default. */
const TEXT_DEFAULT_PICTOGRAPH = /(?!\p{Emoji_Presentation})\p{Extended_Pictographic}/gu;
const PRESENTATION_SELECTOR = /[\ufe0e\ufe0f]/u;
const TEXT_PRESENTATION = "\ufe0e";

export interface GlyphFit {
  /** font-size multiplier for the span; 1 keeps it */
  scale: number;
  /** the letter-spacing left after scaling; its half goes before each glyph */
  spacing: number;
}

/**
 * How to draw a span whose glyphs advance `glyphWidth` and get `spacing` added by xterm, in
 * a grid of `cellWidth` columns; null when the span is already right.
 */
export function glyphFit(spacing: number, glyphWidth: number, cellWidth: number): GlyphFit | null {
  if (!(spacing > MIN_SPACING_PX) || !(glyphWidth > 0) || !(cellWidth > 0)) return null;
  const slot = glyphWidth + spacing;
  if (glyphWidth >= FILL * slot) return null;
  const wide = Math.round(slot / cellWidth) >= 2;
  const scale = wide ? Math.min(MAX_SCALE, (FILL * slot) / glyphWidth) : 1;
  return { scale, spacing: slot - glyphWidth * scale };
}

/** Nerd Font icons and the like: the private use areas, where a font's glyph is meant to fill one cell. */
const PRIVATE_USE = /^[\ue000-\uf8ff\u{f0000}-\u{ffffd}\u{100000}-\u{10fffd}]/u;
const ANY_PRIVATE_USE = /[\ue000-\uf8ff\u{f0000}-\u{ffffd}\u{100000}-\u{10fffd}]/u;
/** Powerline's other separators (flames, trapezoids, pixels): shapes that run from the top of the row to the bottom */
const POWERLINE_EXTRA = /^[\ue0b8-\ue0d7]/u;

/** a character that joins the one before it: a variation selector, a zero-width joiner, a combining mark */
const JOINS = /[\p{M}\u200d\ufe00-\ufe0f]/u;
/** the app's own icon font (PaneTerminal.css), whose late arrival makes every width measured before it wrong */
export const ICON_FAMILY = "Symbols Nerd Font Mono";

/**
 * Whether a character is an icon drawn wider than its one cell. Symbols Nerd Font Mono advances
 * 1em, two of the app's 0.5-0.6em cells, so each icon covered the cell after it (`ls` with icons,
 * a prompt's branch symbol). Only the private use areas: an emoji wider than its one cell is left
 * to run over, as xterm's Unicode 6 widths give most emoji one cell and they came out tiny.
 */
export function oversizedIcon(char: string, width: number, cellWidth: number): boolean {
  return PRIVATE_USE.test(char) && width > cellWidth + MIN_SPACING_PX;
}

/** The font-size multiplier that fits every icon of a run into its cell. */
export function iconScale(widths: readonly number[], cellWidth: number): number {
  return Math.min(1, ...widths.map((width) => cellWidth / width));
}

/** The text to draw for a cell span: composed when it carries marks or decomposed Hangul. */
export function displayText(text: string): string {
  return DECOMPOSED.test(text) ? text.normalize("NFC") : text;
}

/**
 * `text` with every text-default pictograph asking for its text form, or null when there is
 * none or the text already chooses a presentation somewhere. A span is fitted as a whole, so
 * its glyphs either all switch to text or all stay as xterm measured them.
 */
export function textPresentation(text: string): string | null {
  if (PRESENTATION_SELECTOR.test(text)) return null;
  const textForm = text.replace(TEXT_DEFAULT_PICTOGRAPH, `$&${TEXT_PRESENTATION}`);
  return textForm === text ? null : textForm;
}

/**
 * Keeps every row the DOM renderer draws adjusted. The renderer rebuilds a row's spans on
 * each render (and on link hover, which fires no render event), so a MutationObserver
 * catches them all; it runs before the frame paints. Returns the stop function.
 */
export function adjustTerminalGlyphs(term: Terminal): () => void {
  const rows = term.element?.querySelector<HTMLElement>(".xterm-rows");
  const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
  const measure = document.createElement("canvas").getContext("2d");
  if (!rows || !screen || !measure) return () => {};
  // glyph advances by "<bold><italic><text>", for the font they were measured in
  const widths = new Map<string, number>();
  let measuredFont = "";
  // a box character's drawing, for the cell size it was drawn in
  const boxes = new Map<string, BoxDrawing | null>();
  let boxCell = "";
  // the boxes one pass made: painted together once every span is written, when their places are known
  let placed: { box: HTMLSpanElement; drawing: BoxDrawing; cells: number; rowHeight: number }[] = [];

  /**
   * Rebuilds a span as runs: box characters drawn to their cells (terminalBoxGlyphs.ts), icons too
   * wide for their cells drawn smaller inside them, the way a terminal fits a Nerd Font's icons
   * (Symbols Nerd Font Mono advances 1em, two of the app's cells, and each icon covered the cell
   * after it), and the rest with xterm's spacing in a span of its own: xterm merges cells that share
   * a spacing (an icon with a Powerline arrow, or with a 1em CJK symbol), and their fits differ.
   * False when the span holds nothing to draw or fit.
   */
  const rebuild = (span: HTMLSpanElement, text: string, cellWidth: number, rowHeight: number, fontSize: number, widthOf: (glyph: string) => number): boolean => {
    const cell = `${cellWidth}x${rowHeight}@${fontSize}`;
    if (cell !== boxCell) {
      boxes.clear();
      boxCell = cell;
    }
    const drawingOf = (char: string): BoxDrawing | null => {
      let drawing = boxes.get(char);
      if (drawing === undefined) {
        drawing = BOX_GLYPHS.test(char) ? boxDrawing(char, cellWidth, rowHeight, fontSize) : null;
        boxes.set(char, drawing);
      }
      return drawing;
    };
    // a character that joins the one before it makes one cell of two characters, or two cells of one
    // (an icon with VS16): the runs below count a character a cell, so such a span is left as drawn
    if (JOINS.test(text)) return false;
    const chars = [...text];
    // a separator is its own kind: beside an icon it shares the icon's spacing, not its fit
    const kinds = chars.map((char) => drawingOf(char) !== null ? "box"
      : !oversizedIcon(char, widthOf(char), cellWidth) ? "text" : POWERLINE_EXTRA.test(char) ? "shape" : "icon");
    if (!kinds.some((kind) => kind !== "text")) return false;
    const spacing = span.style.letterSpacing || "0px";
    const parts: HTMLSpanElement[] = [];
    for (let start = 0; start < chars.length;) {
      let end = start;
      // an icon is a run of its own: two icons of different widths each get their own size and centring
      while (end < chars.length && kinds[end] === kinds[start] && (kinds[start] !== "icon" || end === start)) end += 1;
      const run = chars.slice(start, end);
      const part = document.createElement("span");
      part.className = BOX_CLASS;
      if (kinds[start] === "text") {
        part.style.cssText = `display:inline;letter-spacing:${spacing};font-weight:inherit`;
        part.textContent = run.join("");
      } else {
        // an inline-block takes no underline, strikethrough or overline from the span around it: it asks for them
        part.style.cssText = `display:inline-block;position:relative;width:${cellWidth * run.length}px;height:${rowHeight}px;vertical-align:top;white-space:pre;letter-spacing:0;text-decoration:inherit;font-weight:inherit`;
        const glyphs = document.createElement("span");
        glyphs.className = BOX_CLASS;
        glyphs.textContent = run.join("");
        if (kinds[start] === "box") {
          // the characters stay for the DOM's sake, unpainted, in a block the box's decoration reaches into
          // (xterm makes every span of a row an inline-block, which it does not), cut to the cells
          glyphs.style.cssText = "display:block;width:100%;height:100%;overflow:hidden;color:transparent";
          placed.push({ box: part, drawing: boxRun(run.map((char) => drawingOf(char)!), cellWidth), cells: run.length, rowHeight });
        } else if (kinds[start] === "shape") {
          // a separator takes the height of the row (its outline is as tall as the font's em) and is narrowed
          // to its cell, the glyph alone transformed: the box around it keeps the cell and its background
          const size = rowHeight;
          const squeeze = cellWidth / (widthOf(run[0]!) * (size / fontSize));
          glyphs.style.cssText = `display:block;width:${100 / squeeze}%;height:100%;font-size:${size}px;line-height:${rowHeight}px;letter-spacing:0;font-weight:inherit;transform:scaleX(${squeeze});transform-origin:0 0`;
          part.style.overflow = "hidden";
        } else {
          // each icon centred in its cell: what its smaller glyph leaves is split before and after it
          const scale = iconScale(run.map(widthOf), cellWidth);
          const left = cellWidth - widthOf(run[0]!) * scale;
          glyphs.style.cssText = `display:block;width:100%;height:100%;overflow:hidden;font-size:${fontSize * scale}px;line-height:${rowHeight}px;letter-spacing:${left}px;padding-left:${left / 2}px;font-weight:inherit`;
        }
        part.append(glyphs);
      }
      parts.push(part);
      start = end;
    }
    span.style.letterSpacing = "0px";
    span.replaceChildren(...parts);
    return true;
  };

  const adjustAll = (spans: Iterable<Node>): void => {
    const { fontFamily, fontSize, fontWeight, fontWeightBold } = term.options;
    if (fontSize === undefined) return;
    const font = `${fontSize}px ${fontFamily}`;
    if (font !== measuredFont) {
      widths.clear();
      measuredFont = font;
    }
    const cellWidth = Number.parseFloat(screen.style.width) / term.cols;
    const rowHeight = Number.parseFloat(screen.style.height) / term.rows;
    for (const span of spans) {
      if (!(span instanceof HTMLSpanElement) || span.classList.contains(BOX_CLASS)) continue;
      const text = span.textContent ?? "";
      let shown = displayText(text);
      const bold = span.classList.contains("xterm-bold");
      const italic = span.classList.contains("xterm-italic");
      const widthOf = (glyph: string): number => {
        const key = `${bold ? 1 : 0}${italic ? 1 : 0}${glyph}`;
        let width = widths.get(key);
        if (width === undefined) {
          measure.font = `${italic ? "italic " : ""}${bold ? fontWeightBold : fontWeight} ${font}`;
          width = measure.measureText(glyph).width;
          widths.set(key, width);
        }
        return width;
      };
      // boxes drawn and icons fitted to their cells. The cell under the cursor keeps the font's glyph:
      // xterm draws an underline or bar cursor as the span's own border and shadow, which they would cover
      if ((BOX_GLYPHS.test(shown) || ANY_PRIVATE_USE.test(shown)) && !span.classList.contains("xterm-cursor") && cellWidth > 0 && rowHeight > 0
        && rebuild(span, shown, cellWidth, rowHeight, fontSize, widthOf)) continue;
      // under the cursor an icon is fitted in the cursor's own span, which keeps its background and border
      if (span.classList.contains("xterm-cursor") && [...shown].length === 1 && oversizedIcon(shown, widthOf(shown), cellWidth)) {
        span.style.cssText += `;font-size:${fontSize * iconScale([widthOf(shown)], cellWidth)}px;letter-spacing:0px`;
        continue;
      }
      const xtermSpacing = Number.parseFloat(span.style.letterSpacing);
      if (!(Math.abs(xtermSpacing) > MIN_SPACING_PX)) {
        if (shown !== text) span.textContent = shown;
        continue;
      }
      // a span merges only cells drawn with the same spacing, so its first glyph speaks for all
      const first = String.fromCodePoint(shown.codePointAt(0) ?? 0x20);
      let glyphWidth = widthOf(first);
      let spacing = xtermSpacing;
      // the spacing is re-measured from the first glyph, so that glyph must be one that switches
      const textForm = spacing < 0 ? textPresentation(shown) : null;
      if (textForm?.startsWith(first + TEXT_PRESENTATION)) {
        const slot = glyphWidth + spacing;
        shown = textForm;
        glyphWidth = widthOf(first + TEXT_PRESENTATION);
        spacing = slot - glyphWidth;
      }
      if (shown !== text) span.textContent = shown;
      let fit = glyphFit(spacing, glyphWidth, cellWidth);
      if (!fit) {
        if (spacing !== xtermSpacing) span.style.letterSpacing = `${spacing}px`;
        continue;
      }
      // An enlarged glyph never outgrows its row: at small sizes a 1.2x Hangul syllable (12px in an
      // 11px row) ran into the row above and lost its top at the screen's edge.
      const scale = Math.min(fit.scale, Math.max(1, rowHeight / fontSize));
      if (scale !== fit.scale) fit = { scale, spacing: fit.spacing + glyphWidth * (fit.scale - scale) };
      const half = fit.spacing / 2;
      // appended in one write: later declarations win over xterm's letter-spacing
      span.style.cssText += `;${fit.scale !== 1 ? `font-size:${fontSize * fit.scale}px;` : ""}letter-spacing:${fit.spacing}px;padding-left:${half}px;margin-right:${-half}px;clip-path:inset(0 ${half}px 0 0)`;
    }
  };

  /**
   * Paints the boxes of a pass. Text and boxes each round their width to the layout's own
   * unit, so a box sits a fraction of a pixel off its column, differently in every row, and
   * the browser rounds each element's corner its own way before painting (measured at 2x:
   * the same column's line fell a device pixel apart in a row where its cell stood alone and
   * in one where it was the fifteenth of a run). So the lines go on a layer inside the box
   * that is put on a whole device pixel of the grid at the column the box stands in, and are
   * placed from there (pixelPlacement). Everything is counted inside the grid (a grid shown
   * scaled or panned is measured back to its own pixels), so every row lands alike whenever
   * it was drawn. All boxes are measured first and painted after: one layout, however many.
   */
  const placeBoxes = (): void => {
    const made = placed;
    placed = [];
    if (made.length === 0) return;
    const cellWidth = Number.parseFloat(screen.style.width) / term.cols;
    if (!(cellWidth > 0)) return;
    const frame = rows.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const scale = rows.offsetWidth > 0 && frame.width > 0 ? frame.width / rows.offsetWidth : 1;
    const corners = made.map(({ box }) => box.getBoundingClientRect());
    const snap = (value: number): number => Math.round(value * ratio) / ratio;
    made.forEach(({ box, drawing, cells, rowHeight }, index) => {
      const corner = corners[index]!;
      // where the box sits in the grid's own pixels, and where its column and row start there
      const left = (corner.left - frame.left) / scale;
      const top = (corner.top - frame.top) / scale;
      const column = Math.round(left / cellWidth) * cellWidth;
      const row = Math.round(top / rowHeight) * rowHeight;
      const layer = document.createElement("span");
      layer.className = BOX_CLASS;
      layer.style.cssText = `position:absolute;left:${snap(column) - left}px;top:${snap(row) - top}px;width:${cells * cellWidth + 1}px;height:${rowHeight}px;background:${boxBackground(drawing, pixelPlacement(column, row, snap(column), snap(row), ratio))}`;
      box.append(layer);
    });
  };

  /**
   * The icon font is fetched only once a pane prints an icon (unicode-range), after xterm and
   * this module measured that icon with whatever stood in for it, and both keep what they
   * measured. When it arrives, the font family is set again in a form that reads differently and
   * means the same: xterm measures and draws every row anew, and the widths here start over.
   */
  const fontsArrived = (event: Event): void => {
    const faces = (event as FontFaceSetLoadEvent).fontfaces ?? [];
    if (!faces.some((face) => face.family.replace(/["']/g, "") === ICON_FAMILY)) return;
    const family = term.options.fontFamily ?? "";
    const double = `"${ICON_FAMILY}"`;
    const single = `'${ICON_FAMILY}'`;
    if (family.includes(double)) term.options.fontFamily = family.replace(double, single);
    else if (family.includes(single)) term.options.fontFamily = family.replace(single, double);
  };
  document.fonts?.addEventListener("loadingdone", fontsArrived);

  adjustAll(rows.querySelectorAll("span"));
  placeBoxes();
  const observer = new MutationObserver((records) => {
    for (const record of records) adjustAll(record.addedNodes);
    placeBoxes();
  });
  observer.observe(rows, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    document.fonts?.removeEventListener("loadingdone", fontsArrived);
  };
}
