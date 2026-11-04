import { describe, expect, test } from "bun:test";
import {
  COMPOSITION_IDLE, COMPOSITION_SETTLE_MS, MIRROR_INPUT_IDLE, compositionSettled, filterMirrorInput, flushMirrorInput, isTerminalReply,
  type MirrorInputState,
} from "./mirrorInputPolicy.ts";

/** feed chunks in order, as onData would, and flush at the end */
function run(chunks: string[], start: MirrorInputState = MIRROR_INPUT_IDLE): { sent: string[]; state: MirrorInputState } {
  let state = start;
  const sent: string[] = [];
  for (const chunk of chunks) {
    const out = filterMirrorInput(state, chunk);
    state = out.state;
    sent.push(out.send);
  }
  const flushed = flushMirrorInput(state);
  sent.push(flushed.send);
  return { sent, state: flushed.state };
}

// exactly what xterm 5.5 sends (InputHandler, Terminal, CoreMouseService)
const REPLIES = {
  focusIn: "\x1b[I",
  focusOut: "\x1b[O",
  status: "\x1b[0n",
  cursor: "\x1b[12;40R",
  privateCursor: "\x1b[?12;40R",
  primaryDa: "\x1b[?1;2c",
  secondaryDa: "\x1b[>0;276;0c",
  mousePress: "\x1b[<0;5;7M",
  mouseRelease: "\x1b[<0;5;7m",
  wheel: "\x1b[<65;120;45M",
};

// typed input whose bytes look most like the replies above
const TYPED = {
  hangul: "안녕하세요 한국어",
  up: "\x1b[A",
  appUp: "\x1bOA",
  ctrlUp: "\x1b[1;5A",
  shiftTab: "\x1b[Z",
  f5: "\x1b[15~",
  delete: "\x1b[3~",
  enter: "\r",
  altEnter: "\x1b\r",
  ctrlC: "\x03",
  escape: "\x1b",
  altA: "\x1ba",
  altBracket: "\x1b[",
  backspace: "\x7f",
  plainPaste: "line one\rline two",
  bracketedPaste: "\x1b[200~붙여넣기 text\x1b[201~",
};

describe("mirror input", () => {
  test("every reply xterm makes is dropped", () => {
    for (const [name, reply] of Object.entries(REPLIES)) {
      expect(isTerminalReply(reply), name).toBe(true);
      expect(run([reply]).sent.join(""), name).toBe("");
    }
  });

  test("typed input passes unchanged", () => {
    for (const [name, typed] of Object.entries(TYPED)) expect(run([typed]).sent.join(""), name).toBe(typed);
    const all = Object.values(TYPED).join("");
    expect(run([all]).sent.join("")).toBe(all);
  });

  test("replies mixed into typed input leave the input in order", () => {
    const chunk = `가${REPLIES.cursor}나${TYPED.up}${REPLIES.focusIn}${REPLIES.mousePress}\r${REPLIES.secondaryDa}${TYPED.ctrlC}`;
    expect(run([chunk]).sent.join("")).toBe(`가나${TYPED.up}\r${TYPED.ctrlC}`);
  });

  test("a reply split at every point is still dropped, and typed input around it kept", () => {
    for (const reply of Object.values(REPLIES)) {
      const whole = `a${reply}b`;
      for (let cut = 1; cut < whole.length; cut++) {
        expect(run([whole.slice(0, cut), whole.slice(cut)]).sent.join(""), JSON.stringify([reply, cut])).toBe("ab");
      }
      expect(run([...whole]).sent.join(""), JSON.stringify(reply)).toBe("ab");
    }
  });

  test("typed sequences split at every point arrive whole", () => {
    for (const typed of [TYPED.ctrlUp, TYPED.f5, TYPED.bracketedPaste, `${TYPED.escape}x`, TYPED.altA]) {
      for (let cut = 1; cut < typed.length; cut++) {
        expect(run([typed.slice(0, cut), typed.slice(cut)]).sent.join(""), JSON.stringify([typed, cut])).toBe(typed);
      }
    }
  });

  test("an unfinished sequence is held only until the next chunk or a flush", () => {
    const held = filterMirrorInput(MIRROR_INPUT_IDLE, "x\x1b[12;4");
    expect(held.send).toBe("x");
    expect(held.state.tail).toBe("\x1b[12;4");
    expect(filterMirrorInput(held.state, "0R").send).toBe("");
    expect(filterMirrorInput(held.state, "y").send).toBe("\x1b[12;4y");
    expect(flushMirrorInput(held.state)).toEqual({ send: "\x1b[12;4", state: MIRROR_INPUT_IDLE });
    // a lone Escape key is held only until the flush that follows it
    const escape = filterMirrorInput(MIRROR_INPUT_IDLE, "\x1b");
    expect(escape.send).toBe("");
    expect(flushMirrorInput(escape.state).send).toBe("\x1b");
  });

  test("a bracketed paste is the user's text, even where it looks like a reply", () => {
    const paste = `\x1b[200~${REPLIES.cursor}${REPLIES.focusIn}한글\x1b[201~`;
    expect(run([paste]).sent.join("")).toBe(paste);
    const split = run([paste.slice(0, 9), paste.slice(9, 25), paste.slice(25)]);
    expect(split.sent.join("")).toBe(paste);
    expect(split.state).toEqual(MIRROR_INPUT_IDLE);
    // a paste still open after its chunk: its text goes out, only a possible end marker waits
    const open = filterMirrorInput(MIRROR_INPUT_IDLE, "\x1b[200~abc\x1b[20");
    expect(open.send).toBe("\x1b[200~abc");
    expect(open.state).toEqual({ tail: "\x1b[20", pasting: true });
    const closed = filterMirrorInput(open.state, `1~${REPLIES.focusOut}z`);
    expect(closed.send).toBe("\x1b[201~z");
    expect(closed.state).toEqual(MIRROR_INPUT_IDLE);
  });

  test("near-replies typed or answered by other sequences are kept", () => {
    for (const kept of ["\x1b[1;2P", "\x1b[2I", "\x1b[c", "\x1b[6n", "\x1b[M", "\x1b[<0;5M"]) {
      expect(run([kept]).sent.join(""), JSON.stringify(kept)).toBe(kept);
    }
  });
});

describe("composition settle span", () => {
  test("composing, and up to the span after compositionend, is not settled", () => {
    expect(compositionSettled(COMPOSITION_IDLE, 0)).toBe(true);
    expect(compositionSettled({ composing: true, endedAt: null }, 10_000)).toBe(false);
    const ended = { composing: false, endedAt: 1_000 };
    expect(compositionSettled(ended, 1_000)).toBe(false);
    expect(compositionSettled(ended, 1_000 + COMPOSITION_SETTLE_MS - 1)).toBe(false);
    expect(compositionSettled(ended, 1_000 + COMPOSITION_SETTLE_MS)).toBe(true);
    expect(COMPOSITION_SETTLE_MS).toBe(350);
  });
});
