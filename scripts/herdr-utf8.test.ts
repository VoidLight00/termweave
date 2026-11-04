import { expect, it } from "bun:test";
import { makeLineReader } from "../server/herdr/client.ts";

/**
 * herdr's frames reach the client in whatever chunks the socket hands over, and a chunk can
 * end inside a character. No socket here: the bytes are cut by hand at every point.
 */
const encoder = new TextEncoder();
const REPLACEMENT = "\uFFFD";

function reader() {
  const lines: string[] = [];
  const lineReader = makeLineReader((line) => lines.push(line));
  return { lines, push: (bytes: Uint8Array) => lineReader.push(bytes), end: () => lineReader.end() };
}

/** a pane.read answer as herdr frames it: one JSON line */
const frame = (text: string) => `${JSON.stringify({ id: "br-1", result: { read: { pane_id: "w1-1", text } } })}\n`;
const textOf = (line: string) => (JSON.parse(line) as { result: { read: { text: string } } }).result.read.text;

const SCREEN = "한글 입력 확인 🎉👍🏽 é ✓ 끝";

it("decodes Korean and emoji cut at every byte into the same frame, without U+FFFD", () => {
  const bytes = encoder.encode(frame(SCREEN));
  for (let cut = 0; cut <= bytes.length; cut++) {
    const { lines, push } = reader();
    push(bytes.subarray(0, cut));
    push(bytes.subarray(cut));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(REPLACEMENT);
    expect(textOf(lines[0]!)).toBe(SCREEN);
  }
});

it("decodes a frame cut twice anywhere, and one byte at a time", () => {
  const bytes = encoder.encode(frame("가😀나"));
  for (let first = 0; first <= bytes.length; first++) {
    for (let second = first; second <= bytes.length; second++) {
      const { lines, push } = reader();
      push(bytes.subarray(0, first));
      push(bytes.subarray(first, second));
      push(bytes.subarray(second));
      expect(lines.map(textOf)).toEqual(["가😀나"]);
    }
  }
  const { lines, push } = reader();
  for (const byte of encoder.encode(frame(SCREEN))) push(Uint8Array.of(byte));
  expect(lines.map(textOf)).toEqual([SCREEN]);
});

it("holds the first 1 to 3 bytes of a character until the rest of it comes", () => {
  // 2, 3 and 4 bytes, and a grapheme of two 4-byte code points
  for (const char of ["é", "한", "🎉", "👍🏽"]) {
    const bytes = encoder.encode(char);
    for (let held = 1; held < Math.min(bytes.length, 4); held++) {
      const { lines, push } = reader();
      push(encoder.encode(`${frame("before")}{"id":"br-2","result":{"read":{"text":"`));
      push(bytes.subarray(0, held));
      expect(lines.map(textOf)).toEqual(["before"]);
      push(bytes.subarray(held));
      push(encoder.encode(`"}}}\n`));
      expect(lines.map(textOf)).toEqual(["before", char]);
      expect(lines[1]).not.toContain(REPLACEMENT);
    }
  }
});

it("frames lines split across chunks, several in one chunk, and skips blank ones", () => {
  const { lines, push } = reader();
  const both = encoder.encode(`${frame("하나")}\n\n${frame("둘")}`);
  push(both.subarray(0, 7));
  push(both.subarray(7));
  expect(lines.map(textOf)).toEqual(["하나", "둘"]);
});

it("ends with the cut character as one U+FFFD and the unfinished line returned, not passed on", () => {
  for (const char of ["é", "한", "🎉"]) {
    const bytes = encoder.encode(char);
    for (let held = 1; held < bytes.length; held++) {
      const { lines, push, end } = reader();
      push(encoder.encode(`{"id":"br-3","result":{"read":{"text":"`));
      push(bytes.subarray(0, held));
      expect(end()).toBe(`{"id":"br-3","result":{"read":{"text":"${REPLACEMENT}`);
      expect(lines).toEqual([]);
    }
  }
  // a whole frame that lost its newline is not one either
  const { lines, push, end } = reader();
  push(encoder.encode(frame("done").trimEnd()));
  expect(end()).toBe(frame("done").trimEnd());
  expect(lines).toEqual([]);
  // nothing held: nothing left
  const empty = reader();
  empty.push(encoder.encode(frame("done")));
  expect(empty.end()).toBe("");
  expect(empty.lines.map(textOf)).toEqual(["done"]);
});

it("keeps replacing bytes that are no UTF-8 with U+FFFD, and the frame still parses", () => {
  const [head, tail] = frame("a|b").split("|") as [string, string];
  // a byte UTF-8 never uses, a stray continuation byte, an overlong '/', a lead byte cut by the next character
  const bad = [[0xff], [0x80], [0xc0, 0xaf], [0xed, 0x41]];
  for (const bytes of bad) {
    const whole = new Uint8Array([...encoder.encode(head), ...bytes, ...encoder.encode(tail)]);
    for (let cut = 0; cut <= whole.length; cut++) {
      const { lines, push } = reader();
      push(whole.subarray(0, cut));
      push(whole.subarray(cut));
      expect(lines).toHaveLength(1);
      const text = textOf(lines[0]!);
      expect(text.startsWith("a")).toBe(true);
      expect(text.endsWith("b")).toBe(true);
      expect(text).toContain(REPLACEMENT);
    }
  }
});
