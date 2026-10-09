import { describe, expect, test } from "bun:test";
import { mirrorInput } from "./mirror-input.ts";

const agent = async () => "gjc";
const noAgent = async () => null;
const unreachable = async (): Promise<string | null> => { throw new Error("herdr did not answer"); };

describe("typing into a mirrored pane", () => {
  test("a pasted block of lines reaches an agent on a mirrored pane as one bracketed paste", async () => {
    expect(await mirrorInput("line one\rline two", agent)).toBe("\x1b[200~line one\rline two\x1b[201~");
    expect(await mirrorInput("line one\r\rline three\r", agent)).toBe("\x1b[200~line one\r\rline three\r\x1b[201~");
    expect(await mirrorInput("line one\nline two", agent)).toBe("\x1b[200~line one\nline two\x1b[201~");
  });

  test("a pane without an agent gets a pasted block exactly as it came", async () => {
    expect(await mirrorInput("line one\rline two", noAgent)).toBe("line one\rline two");
  });

  test("a pasted block goes as it came when herdr cannot say what the pane runs", async () => {
    expect(await mirrorInput("line one\rline two", unreachable)).toBe("line one\rline two");
  });

  test("keys and a line that ends in Enter go as they were typed, and herdr is not asked about them", async () => {
    let asked = 0;
    const counted = async () => { asked += 1; return "gjc"; };
    for (const typed of ["a", "한", "\r", "\x03", "\x1b", "\t", "\x1b[A", "\x1bOA", "echo a\r", "\r\r"]) {
      expect(await mirrorInput(typed, counted)).toBe(typed);
    }
    expect(asked).toBe(0);
  });

  test("a pasted block that holds an escape byte, as coloured output does, is still one paste", async () => {
    expect(await mirrorInput("\x1b[31mline one\x1b[0m\rline two", agent)).toBe("\x1b[200~\x1b[31mline one\x1b[0m\rline two\x1b[201~");
  });

  test("a paste the terminal already bracketed is not wrapped again", async () => {
    const pasted = "\x1b[200~line one\rline two\x1b[201~";
    expect(await mirrorInput(pasted, agent)).toBe(pasted);
  });
});
