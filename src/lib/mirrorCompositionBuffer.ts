/**
 * A mirrored pane's screen while the IME's span is open (compositionstart until COMPOSITION_SETTLE_MS
 * after compositionend). A write into xterm inside that span commits, drops or doubles the syllable
 * being built, so the mirror's frames are taken in here instead and the latest screen they make is
 * written once, when the span settles. The frames are the two server/mirror.ts makes, and only those:
 * a whole screen (mirrorFrame) and its changed rows (mirrorRows). No frame history is kept: a whole
 * screen replaces everything held, a row replaces that row, and the held rows never outnumber the grid.
 */

/** the most a held screen may weigh in UTF-8 bytes: the server's hard output budget (OUTPUT_HARD_BYTES) */
export const MIRROR_HOLD_MAX_BYTES = 1024 * 1024;

const WHOLE_START = "\x1b[?25l\x1b[0m\x1b[H\x1b[2J\x1b[?7l";
const ROWS_START = "\x1b[?25l\x1b[?7l";
const FRAME_END = "\x1b[0m\x1b[?7h";
const RESET = "\x1b[0m";
/** where mirrorRows draws a row: home on it, plain attributes, the row cleared */
const ROW_AT = /\x1b\[(\d+);1H\x1b\[0m\x1b\[2K/;
const SGR = /\x1b\[[0-9;:]*m/g;
/** an SGR whose first parameter is 0 (or none): every attribute before it is gone */
const SGR_RESETS = /^\x1b\[0*(?:[;:]|m)/;

export type MirrorFrame =
  | { kind: "whole"; rows: string[] }
  /** rows by index from 0; `last` is the row drawn last, where the (hidden) cursor stays */
  | { kind: "rows"; rows: Map<number, string>; last: number };

/** A frame as server/mirror.ts made it, or null for anything else. */
export function parseMirrorFrame(data: string): MirrorFrame | null {
  if (data.startsWith(WHOLE_START) && data.endsWith(FRAME_END) && data.length >= WHOLE_START.length + FRAME_END.length) {
    return { kind: "whole", rows: data.slice(WHOLE_START.length, data.length - FRAME_END.length).split("\r\n") };
  }
  if (!data.startsWith(ROWS_START) || !data.endsWith(FRAME_END) || data.length < ROWS_START.length + FRAME_END.length) return null;
  const parts = data.slice(ROWS_START.length, data.length - FRAME_END.length).split(ROW_AT);
  // [before the first row, row number, its text, row number, its text, ...]: nothing comes before the first row
  if (parts.length < 3 || parts[0] !== "") return null;
  const rows = new Map<number, string>();
  let last = -1;
  for (let index = 1; index < parts.length; index += 2) {
    const row = Number(parts[index]) - 1;
    if (!Number.isSafeInteger(row) || row < 0) return null;
    rows.set(row, parts[index + 1]!);
    last = row;
  }
  return { kind: "rows", rows, last };
}

/** UTF-8 bytes of `text`, as the server counts output (a lone surrogate is U+FFFD's three) */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00) { bytes += 4; index++; }
    else bytes += 3;
  }
  return bytes;
}

/**
 * A row of a held whole screen, as it is drawn in a whole frame. `inherits`: drawn straight after the
 * row above, so it starts with the attributes that row left on (only the whole frame's own rows do).
 */
interface HeldRow { text: string; bytes: number; inherits: boolean }

const heldRow = (text: string, inherits: boolean): HeldRow => ({ text, bytes: utf8Bytes(text), inherits });

/** The attributes the rows up to and including `index` leave on, as the SGRs that set them. */
function carriedAttributes(rows: readonly HeldRow[], index: number): string {
  let start = index;
  while (start > 0 && rows[start]!.inherits) start--;
  // a whole frame resets before its first row; every row that does not inherit starts with a reset
  const sequences = [RESET, ...rows.slice(start, index + 1).flatMap((row) => row.text.match(SGR) ?? [])];
  let from = 0;
  sequences.forEach((sequence, at) => { if (SGR_RESETS.test(sequence)) from = at; });
  return sequences.slice(from).join("");
}

export type MirrorHoldResult = { ok: true } | { ok: false; reason: string; fresh: boolean };

export class MirrorCompositionBuffer {
  /** the latest whole screen with the rows drawn over it since, or null while only rows were held */
  private whole: HeldRow[] | null = null;
  /** rows drawn over the screen the terminal already shows, when no whole screen came */
  private rows = new Map<number, HeldRow>();
  /** the row the latest frame drew last */
  private last = -1;
  private failure: string | null = null;

  /** the output stream whose frames these are: a frame of another stream starts a new buffer */
  constructor(readonly streamId: string | null) {}

  /** why a frame could not be held; every frame after it is held unacknowledged too, since an ACK is cumulative */
  get failed(): string | null {
    return this.failure;
  }

  get bytes(): number {
    let bytes = 0;
    for (const row of this.whole ?? this.rows.values()) bytes += row.bytes;
    return bytes;
  }

  /** rows held: never more than the grid has */
  get heldRows(): number {
    return this.whole?.length ?? this.rows.size;
  }

  /**
   * Takes a frame in. ok: it is part of the held screen and may be acknowledged now. A frame of
   * another shape, one for more rows than `gridRows` or one that would make the held screen
   * heavier than MIRROR_HOLD_MAX_BYTES is not held: the held screen stays as it was.
   */
  absorb(data: string, gridRows: number): MirrorHoldResult {
    const frame = parseMirrorFrame(data);
    if (frame === null) return this.fail("not a mirror frame: server/mirror.ts makes whole screens and changed rows only");
    if (frame.kind === "whole" && frame.rows.length > gridRows) return this.fail(`a whole screen of ${frame.rows.length} rows on a grid of ${gridRows}`);
    if (frame.kind === "rows" && [...frame.rows.keys()].some((row) => row >= gridRows)) return this.fail(`a row past the grid's ${gridRows}`);
    let whole = this.whole;
    let rows = this.rows;
    if (frame.kind === "whole") {
      whole = frame.rows.map((text, index) => heldRow(text, index > 0));
      rows = new Map();
    } else if (whole !== null) {
      whole = [...whole];
      for (const [index, text] of frame.rows) {
        while (whole.length <= index) whole.push(heldRow(RESET, false));
        // the row below was drawn with the attributes this row left on: it keeps them, as the terminal did
        const below = whole[index + 1];
        if (below?.inherits) whole[index + 1] = heldRow(RESET + carriedAttributes(whole, index) + below.text, false);
        whole[index] = heldRow(RESET + text, false);
      }
    } else {
      rows = new Map(rows);
      for (const [index, text] of frame.rows) rows.set(index, heldRow(text, false));
    }
    let bytes = 0;
    for (const row of whole ?? rows.values()) bytes += row.bytes;
    if (bytes > MIRROR_HOLD_MAX_BYTES) return this.fail(`a held screen of ${bytes} bytes, over ${MIRROR_HOLD_MAX_BYTES}`);
    this.whole = whole;
    this.rows = rows;
    this.last = frame.kind === "whole" ? frame.rows.length - 1 : frame.last;
    return this.failure === null ? { ok: true } : { ok: false, reason: `held after an earlier frame failed: ${this.failure}`, fresh: false };
  }

  private fail(reason: string): MirrorHoldResult {
    const fresh = this.failure === null;
    this.failure ??= reason;
    return { ok: false, reason, fresh };
  }

  /**
   * The one write that brings the terminal from the screen it showed before the span to the latest
   * held one, as the frames written one by one would have left it; "" when nothing was held. The
   * buffer is empty afterwards.
   */
  take(): string {
    const { whole, rows, last } = this;
    this.whole = null;
    this.rows = new Map();
    this.last = -1;
    if (last < 0) return "";
    const lastRow = (text: string) => `${ROWS_START}\x1b[${last + 1};1H${RESET}\x1b[2K${text}${FRAME_END}`;
    if (whole !== null) {
      const screen = `${WHOLE_START}${whole.map((row) => row.text).join("\r\n")}${FRAME_END}`;
      if (last === whole.length - 1) return screen;
      // the latest rows ended above the held screen's bottom (it got shorter): the cursor ends there, as theirs did
      const row = whole[last]!;
      return screen + lastRow(row.inherits ? carriedAttributes(whole, last - 1) + row.text : row.text);
    }
    // each changed row once, in its place, as mirrorRows draws them: the last one last
    let drawn = "";
    for (const index of [...rows.keys()].sort((a, b) => a - b)) {
      if (index !== last) drawn += `\x1b[${index + 1};1H${RESET}\x1b[2K${rows.get(index)!.text}`;
    }
    return ROWS_START + drawn + lastRow(rows.get(last)?.text ?? "").slice(ROWS_START.length);
  }
}
