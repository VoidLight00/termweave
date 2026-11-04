/**
 * What a mirrored pane's grid may send. A mirror (HerdrIdentity.terminal_mirror) repaints the pane's
 * screen into xterm, so xterm answers the queries in that screen (DSR, DA) and reports focus and the
 * mouse as if a program had asked: herdr's pane never did, and the answers would arrive there as typed
 * text. Typed input passes unchanged, and an attach grid (a real pty) is never filtered.
 */

/** an IME is still settling its text this long after compositionend */
export const COMPOSITION_SETTLE_MS = 350;

export interface CompositionPhase {
  composing: boolean;
  /** performance.now() at the last compositionend; null once its span settled */
  endedAt: number | null;
}

export const COMPOSITION_IDLE: CompositionPhase = { composing: false, endedAt: null };

/** Whether a blur/focus, reset or clear may run now: not while composing, nor within the settle span after it. */
export function compositionSettled(phase: CompositionPhase, now: number): boolean {
  return !phase.composing && (phase.endedAt === null || now - phase.endedAt >= COMPOSITION_SETTLE_MS);
}

export interface MirrorInputState {
  /** an escape sequence cut off at the end of the last chunk, not sent yet */
  tail: string;
  /** inside a bracketed paste: its text is the user's, whatever it looks like */
  pasting: boolean;
}

export const MIRROR_INPUT_IDLE: MirrorInputState = { tail: "", pasting: false };

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
/** one whole CSI: prefix, parameters, intermediates, final byte */
const CSI = /^\x1b\[[<=>?]?[0-9;:]*[\x20-\x2f]*[\x40-\x7e]/;
/** the start of a CSI (or a lone ESC) that the chunk ended inside */
const CSI_PREFIX = /^\x1b(?:\[[<=>?]?[0-9;:]*[\x20-\x2f]*)?$/;
/**
 * xterm 5.5's own answers: focus in/out (DECSET 1004), DSR status and cursor position (CSI 5n/6n,
 * CSI ?6n), primary and secondary DA, and SGR mouse reports (DECSET 1006, also 1016's pixels).
 */
const REPLY = /^\x1b\[(?:[IO]|[03]n|\??\d+;\d+(?:;\d+)?R|\?[\d;]*c|>[\d;]*c|<\d+;\d+;\d+[Mm])$/;

/** Whether `sequence` (one whole CSI) is an answer xterm made itself. */
export function isTerminalReply(sequence: string): boolean {
  return REPLY.test(sequence);
}

/**
 * Drop xterm's own answers from a mirror's input chunk. A sequence cut off at the chunk's end is held
 * in the returned state and completed by the next chunk (or sent by flushMirrorInput).
 */
export function filterMirrorInput(state: MirrorInputState, chunk: string): { send: string; state: MirrorInputState } {
  const text = state.tail + chunk;
  let pasting = state.pasting;
  let send = "";
  let index = 0;
  while (index < text.length) {
    if (pasting) {
      const end = text.indexOf(PASTE_END, index);
      if (end === -1) {
        // the paste goes on in the next chunk; hold only what may be the start of its end marker
        const rest = text.slice(index);
        let held = Math.min(rest.length, PASTE_END.length - 1);
        while (held > 0 && !PASTE_END.startsWith(rest.slice(rest.length - held))) held--;
        return { send: send + rest.slice(0, rest.length - held), state: { tail: rest.slice(rest.length - held), pasting } };
      }
      send += text.slice(index, end + PASTE_END.length);
      index = end + PASTE_END.length;
      pasting = false;
      continue;
    }
    const escape = text.indexOf("\x1b", index);
    if (escape === -1) {
      send += text.slice(index);
      break;
    }
    send += text.slice(index, escape);
    const rest = text.slice(escape);
    const sequence = CSI.exec(rest)?.[0];
    if (sequence !== undefined) {
      if (!isTerminalReply(sequence)) send += sequence;
      if (sequence === PASTE_START) pasting = true;
      index = escape + sequence.length;
    } else if (CSI_PREFIX.test(rest)) {
      return { send, state: { tail: rest, pasting } };
    } else {
      // ESC with anything else (Alt+key, SS3 keys, a lone Escape mid-chunk) is typed input
      send += "\x1b";
      index = escape + 1;
    }
  }
  return { send, state: { tail: "", pasting } };
}

/** Send a held, unfinished sequence as it is: nothing more is coming to make it an answer. */
export function flushMirrorInput(state: MirrorInputState): { send: string; state: MirrorInputState } {
  return { send: state.tail, state: { tail: "", pasting: state.pasting } };
}
