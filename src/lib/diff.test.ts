import { describe, expect, it } from "bun:test";

import { lineDiff } from "./diff.ts";

describe("lineDiff", () => {
  it("keeps unchanged lines once and puts each change where it happened", () => {
    expect(lineDiff("a\nb\nc\nd", "a\nB\nc\nd\ne")).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "B" },
      { kind: "same", text: "c" },
      { kind: "same", text: "d" },
      { kind: "add", text: "e" },
    ]);
    expect(lineDiff("", "x")).toEqual([{ kind: "add", text: "x" }]);
    expect(lineDiff("gone", "")).toEqual([{ kind: "del", text: "gone" }]);
    expect(lineDiff("same", "same")).toEqual([{ kind: "same", text: "same" }]);
  });

  it("gives up on a table too large, as removed then added", () => {
    const big = Array.from({ length: 600 }, (_, index) => `line ${index}`).join("\n");
    const lines = lineDiff(big, big + "\nmore");
    expect(lines.filter((line) => line.kind === "del")).toHaveLength(600);
    expect(lines.at(-1)).toEqual({ kind: "add", text: "more" });
  });
});
