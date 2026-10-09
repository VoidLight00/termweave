import { expect, test } from "bun:test";
import { imeEdit, imeSpaces } from "./imeDiff.ts";

test("WebKit Korean IME edits become DEL + text", () => {
  expect(imeEdit("", "ㅎ")).toBe("ㅎ");
  expect(imeEdit("ㅎ", "하")).toBe("\x7f하");
  expect(imeEdit("하", "한")).toBe("\x7f한");
  expect(imeEdit("한", "한")).toBe("");
  expect(imeEdit("한", "한ㄱ")).toBe("ㄱ");
  expect(imeEdit("가난", "가나나")).toBe("\x7f나나"); // a final consonant moves to the next syllable
  expect(imeEdit("한글", "한그")).toBe("\x7f그"); // Backspace inside the syllable
  expect(imeEdit("ab 😀", "ab 😀가")).toBe("가");
});

test("an IME-committed space after Hangul is a plain space", () => {
  expect(imeSpaces("씩\u00a0")).toBe("씩 ");
  expect(imeEdit("씩", "씩\u00a0")).toBe(" ");
  expect(imeSpaces("\u00a0")).toBe("\u00a0"); // Option+Space stays as typed
  expect(imeSpaces("a\u00a0b")).toBe("a\u00a0b"); // no Hangul: untouched
});
