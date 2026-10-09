import { expect, it } from "bun:test";
import { freeAgentName } from "./agent-name.ts";

it("names the first agent of a kind after the kind", () => {
  expect(freeAgentName("claude", [])).toBe("claude");
  expect(freeAgentName("claude", ["codex", "claude-2", null, undefined])).toBe("claude");
});

it("gives a later agent of the same kind the first free number", () => {
  expect(freeAgentName("claude", ["claude"])).toBe("claude-2");
  expect(freeAgentName("claude", ["claude", "claude-2", "claude-3"])).toBe("claude-4");
  expect(freeAgentName("claude", ["claude", "claude-3"])).toBe("claude-2");
});

it("keeps a numbered name within herdr's 32 characters", () => {
  const kind = "a".repeat(32);
  expect(freeAgentName(kind, [])).toBe(kind);
  expect(freeAgentName(kind, [kind])).toBe(`${"a".repeat(30)}-2`);
  const nine = Array.from({ length: 8 }, (_, index) => `${"a".repeat(30)}-${index + 2}`);
  expect(freeAgentName(kind, [kind, ...nine])).toBe(`${"a".repeat(29)}-10`);
});
