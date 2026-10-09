import { describe, expect, it } from "bun:test";

import { formatWorkDuration, splitTurn, workSummary } from "./workBlocks.ts";
import type { ConversationPart } from "../../shared/protocol.ts";

const tool = (name: string, summary = name): Extract<ConversationPart, { kind: "tool" }> => ({ kind: "tool", name, summary, input: "{}", output: "" });
const text = (value: string): Extract<ConversationPart, { kind: "text" }> => ({ kind: "text", text: value });
const thinking = (value: string): Extract<ConversationPart, { kind: "thinking" }> => ({ kind: "thinking", text: value });

describe("splitTurn", () => {
  it("folds every action and the narration between them into the work; the trailing prose is the answer", () => {
    const split = splitTurn([thinking("hm"), tool("read"), text("looking…"), tool("edit"), text("done"), text("really")]);
    expect(split.work).toEqual([thinking("hm"), tool("read"), text("looking…"), tool("edit")]);
    expect(split.answer).toEqual([text("done"), text("really")]);
  });

  it("is all answer when the agent only spoke, and drops whitespace-only prose", () => {
    expect(splitTurn([text("  \n"), text("hi")])).toEqual({ work: [], answer: [text("hi")] });
  });

  it("is all work when the turn ends on an action (still running)", () => {
    expect(splitTurn([text("on it"), tool("bash")])).toEqual({ work: [text("on it"), tool("bash")], answer: [] });
  });

  it("keeps Codex commentary inside work even after the last tool or with no tools", () => {
    const narration = { ...text("Still investigating"), phase: "commentary" as const };
    expect(splitTurn([tool("exec_command"), narration]).answer).toEqual([]);
    expect(splitTurn([narration])).toEqual({ work: [narration], answer: [] });
  });

  it("honors an explicit final answer even if a later record contains an action", () => {
    const final = { ...text("Done"), phase: "final_answer" as const };
    expect(splitTurn([tool("exec_command"), final, tool("cleanup")])).toEqual({ work: [tool("exec_command"), tool("cleanup")], answer: [final] });
  });
});

describe("workSummary", () => {
  it("counts by what the reader cares about, singular and plural", () => {
    expect(workSummary([tool("Edit"), tool("Write"), tool("read"), tool("Bash"), tool("WebFetch")])).toBe("2 edits · 1 file read · 1 command · 1 other tool");
  });

  it("is empty for reasoning and prose alone", () => {
    expect(workSummary([thinking("x"), text("y")])).toBe("");
  });

  it("leaves todo updates out of the counts", () => {
    expect(workSummary([tool("TodoWrite"), tool("Edit"), tool("update_plan"), tool("todo_write"), tool("Read")])).toBe("1 edit · 1 file read");
  });
});

describe("formatWorkDuration", () => {
  it("formats seconds, minutes and rejects unknown or negative spans", () => {
    expect(formatWorkDuration("2026-01-01T00:00:00Z", "2026-01-01T00:00:07.4Z")).toBe("7s");
    expect(formatWorkDuration("2026-01-01T00:00:00Z", "2026-01-01T00:01:12Z")).toBe("1m 12s");
    expect(formatWorkDuration("2026-01-01T00:00:10Z", "2026-01-01T00:00:00Z")).toBeNull();
    expect(formatWorkDuration(null, "2026-01-01T00:00:00Z")).toBeNull();
  });
});

describe("workSummary failures", () => {
  it("says how many calls failed, last", () => {
    const failed: ConversationPart = { kind: "tool", name: "Bash", summary: "", input: "", output: "", error: true };
    expect(workSummary([{ kind: "tool", name: "Edit", summary: "", input: "", output: "" }, failed, failed])).toBe("1 edit · 2 commands · 2 failed");
  });
});


it("keeps an approval-blocked assistant turn live, including with a last-activity timestamp", async () => {
  const { isLiveWorkTurn } = await import("./workBlocks.ts");
  const turn = { role: "assistant" as const, ts: null, parts: [], end_ts: "2026-09-28T00:00:00Z" };
  expect(isLiveWorkTurn(turn, true, "blocked")).toBe(true);
  expect(isLiveWorkTurn({ ...turn, end_ts: undefined }, true, "blocked")).toBe(true);
  expect(isLiveWorkTurn(turn, true, "working")).toBe(true);
  expect(isLiveWorkTurn(turn, false, "blocked")).toBe(false);
  expect(isLiveWorkTurn(turn, true, "idle")).toBe(false);
  expect(isLiveWorkTurn({ ...turn, role: "user" }, true, "blocked")).toBe(false);
});

it("does not title a finished turn as running after a message was sent over it", async () => {
  const { isLiveWorkTurn } = await import("./workBlocks.ts");
  const finished = { role: "assistant" as const, ts: "2026-09-29T00:00:00Z", parts: [], end_ts: "2026-09-29T00:00:06Z" };
  // sent over it, status already `working`, transcript not yet holding the new message
  expect(isLiveWorkTurn(finished, true, "working", finished)).toBe(false);
  expect(isLiveWorkTurn(finished, true, "blocked", finished)).toBe(false);
  // a turn without a recorded time is still the one sent over
  const untimed = { ...finished, ts: null };
  expect(isLiveWorkTurn(untimed, true, "working", untimed)).toBe(false);
  // the turn that answers the message is a different one and is live again, even with the same time
  const next = { ...finished, end_ts: undefined };
  expect(isLiveWorkTurn(next, true, "working", finished)).toBe(true);
  expect(isLiveWorkTurn({ ...untimed }, true, "working", untimed)).toBe(true);
  // nothing sent over keeps following the status
  expect(isLiveWorkTurn(finished, true, "working", null)).toBe(true);
  expect(isLiveWorkTurn(finished, true, "working")).toBe(true);
});
