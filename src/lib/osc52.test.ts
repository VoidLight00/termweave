import { describe, expect, it } from "bun:test";

import { MAX_OSC52_BYTES, parseOsc52 } from "./osc52.ts";

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

describe("parseOsc52", () => {
  it("decodes a system-clipboard payload (selection c)", () => {
    expect(parseOsc52(`c;${b64("hello")}`)).toBe("hello");
  });

  it("accepts the other selection names - one browser clipboard serves them all", () => {
    expect(parseOsc52(`p;${b64("hello")}`)).toBe("hello");
    expect(parseOsc52(`s;${b64("hello")}`)).toBe("hello");
  });

  it("decodes multibyte text through UTF-8", () => {
    expect(parseOsc52(`c;${b64("한글 paste 📋")}`)).toBe("한글 paste 📋");
  });

  it("ignores clipboard queries (empty or ? payload)", () => {
    expect(parseOsc52("c;?")).toBeNull();
    expect(parseOsc52("c;")).toBeNull();
  });

  it("returns null for malformed payloads", () => {
    expect(parseOsc52("no-semicolon")).toBeNull();
    expect(parseOsc52("")).toBeNull();
    expect(parseOsc52("c;!!!not-base64!!!")).toBeNull();
  });

  it("drops oversized payloads instead of wedging the clipboard", () => {
    const big = "x".repeat(MAX_OSC52_BYTES + 1);
    expect(parseOsc52(`c;${b64(big)}`)).toBeNull();
    // exactly at the cap still decodes
    expect(parseOsc52(`c;${b64("y".repeat(MAX_OSC52_BYTES))}`)).toBe("y".repeat(MAX_OSC52_BYTES));
  });
});
