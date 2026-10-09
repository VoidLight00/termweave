import { describe, expect, it } from "bun:test";

import { activeTrigger, applyCompletion } from "./mentions.ts";

describe("activeTrigger", () => {
  it("opens slash completion at the start of the text, including an empty query", () => {
    expect(activeTrigger("/", 1)).toEqual({ kind: "slash", query: "", start: 0, end: 1 });
    expect(activeTrigger("/sta", 4)).toEqual({ kind: "slash", query: "sta", start: 0, end: 4 });
  });

  it("opens slash completion at later line starts but not in mid-line", () => {
    expect(activeTrigger("hello\n/res", 10)).toEqual({ kind: "slash", query: "res", start: 6, end: 10 });
    expect(activeTrigger("hello /res", 10)).toBeNull();
  });

  it("does not keep a slash trigger open after whitespace", () => {
    expect(activeTrigger("/review this", 12)).toBeNull();
  });

  it("finds file mentions with at least one query character anywhere on a line", () => {
    expect(activeTrigger("see @src/com", 12)).toEqual({ kind: "file", query: "src/com", start: 4, end: 12 });
    expect(activeTrigger("@", 1)).toBeNull();
    expect(activeTrigger("one\nopen @lib", 13)).toEqual({ kind: "file", query: "lib", start: 9, end: 13 });
  });

  it("uses the caret prefix as the query while replacing the complete token", () => {
    expect(activeTrigger("open @src/file.ts now", 10)).toEqual({
      kind: "file",
      query: "src/",
      start: 5,
      end: 17,
    });
  });

  it("rejects invalid caret positions", () => {
    expect(activeTrigger("/go", -1)).toBeNull();
    expect(activeTrigger("/go", 4)).toBeNull();
  });
});

describe("applyCompletion", () => {
  it("inserts a slash command and places the caret after its trailing space", () => {
    const trigger = activeTrigger("/sta", 4);
    expect(trigger).not.toBeNull();
    expect(applyCompletion("/sta", trigger!, "/status ")).toEqual({ text: "/status ", caret: 8 });
  });

  it("replaces the whole file token without disturbing surrounding text", () => {
    const text = "open @src/oldd.ts please";
    const trigger = activeTrigger(text, 10);
    expect(trigger).not.toBeNull();
    expect(applyCompletion(text, trigger!, "@src/new.ts ")).toEqual({
      text: "open @src/new.ts  please",
      caret: 17,
    });
  });
});

describe("$ skills", () => {
  it("opens where a word starts with $, only when skills are asked for", () => {
    expect(activeTrigger("use $dee", 8, { skills: true })).toEqual({ kind: "slash", prefix: "$", query: "dee", start: 4, end: 8 });
    expect(activeTrigger("$", 1, { skills: true })).toEqual({ kind: "slash", prefix: "$", query: "", start: 0, end: 1 });
    expect(activeTrigger("use $dee", 8)).toBeNull();
    // a price or a shell variable inside a word is no skill
    expect(activeTrigger("cost5$x", 7, { skills: true })).toBeNull();
    expect(applyCompletion("use $dee now", { kind: "slash", prefix: "$", query: "dee", start: 4, end: 8 }, "$deepinit ")).toEqual({ text: "use $deepinit  now", caret: 14 });
  });
});
