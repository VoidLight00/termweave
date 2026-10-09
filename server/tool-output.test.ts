import { expect, test } from "bun:test";
import type { ConversationPart } from "../shared/protocol.ts";
import { TOOL_OUTPUT_CHARS, trimOutput } from "./tool-output.ts";

test("a goal call's answer stays whole up to 16000 characters: its JSON, status and all, reaches the chat", () => {
  const objective = "o".repeat(3990);
  const answer = JSON.stringify({ goal: { objective, status: "complete", tokensUsed: 1, timeUsedSeconds: 2 } }, null, 2);
  expect(answer.length).toBeGreaterThan(TOOL_OUTPUT_CHARS);
  const goal: Extract<ConversationPart, { kind: "tool" }> = { kind: "tool", name: "update_goal", summary: "", input: "{}", output: "" };
  trimOutput(goal, answer, "ref");
  expect(goal.output).toBe(answer);
  expect(goal.output_ref).toBeUndefined();
  const other: Extract<ConversationPart, { kind: "tool" }> = { kind: "tool", name: "bash", summary: "", input: "{}", output: "" };
  trimOutput(other, answer, "ref");
  expect(other.output.endsWith("… trimmed")).toBe(true);
  expect(other.output_ref).toBe("ref");
});
