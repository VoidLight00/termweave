import { describe, expect, it } from "bun:test";
import { parseTodoAnswer, todoCallSummary } from "./todos.ts";

const call = (name: string, input: unknown, output = "") => ({ kind: "tool" as const, name, summary: name, input: JSON.stringify(input), output });

// an omp/omo answer, as the tool prints it
const OMP_ANSWER = `Remaining items (2):
  - E2E check [in_progress] (Verify)
  - Release run [pending] (Verify)
Overall: 2/5 done, 2 open.
Active phase 2/2 "Verify" (0/3).
  Build:
    - [X] Parser
    - [X] Panel
  Verify:
    - [ ] Old flow (dropped)
    - [ ] E2E check (in progress)
    - [ ] Release run`;

// a gjc answer
const GJC_ANSWER = `Remaining items (2):
  - Fix installer [in_progress] (Recovery)
  - Run regressions [pending] (Verification)
Phase 1/2 "Recovery" — 1/2 tasks complete
  Recovery:
    ✓ Confirm handoff
    → Fix installer
  Verification:
    ○ Run regressions`;

describe("parseTodoAnswer", () => {
  it("reads omp/omo boxes and gjc glyphs, with a blocked item's reason", () => {
    expect(parseTodoAnswer(GJC_ANSWER)!.map((item) => item.status)).toEqual(["completed", "in_progress", "pending"]);
    const blocked = parseTodoAnswer("Remaining items (1):\n  Ops:\n    - [ ] Update tailscale (blocked: needs sudo)")!;
    expect(blocked).toEqual([{ label: "Update tailscale", phase: "Ops", status: "blocked", note: "needs sudo" }]);
    // a label that merely ends in parentheses keeps them
    expect(parseTodoAnswer("  A:\n    - [X] Install rsync (fast tools)")![0]!.label).toBe("Install rsync (fast tools)");
  });

  it("refuses an answer cut short, or one without a list", () => {
    expect(parseTodoAnswer(`${OMP_ANSWER.split("\n").slice(0, -1).join("\n")}`)).toBeNull();
    expect(parseTodoAnswer(`${OMP_ANSWER}\n… trimmed`)).toBeNull();
    expect(parseTodoAnswer("[shaken ~178 tokens — recover: artifact://298]")).toBeNull();
  });
});

describe("todoCallSummary", () => {
  it("says what a call did in one line", () => {
    expect(todoCallSummary(call("todo", { op: "init", list: [{ phase: "A", items: ["x", "y"] }] }))).toBe("plan · 2 items");
    expect(todoCallSummary(call("todo", { op: "done", phase: "Contract" }))).toBe("done · Contract");
    expect(todoCallSummary(call("todo_write", { ops: [{ op: "start", task: "Fix" }, { op: "append", phase: "B", items: ["z"] }] }))).toBe("start · Fix, add · 1 to B");
    expect(todoCallSummary(call("TodoWrite", { todos: [{ content: "a", status: "completed" }, { content: "b", status: "pending" }] }))).toBe("1/2 done");
    expect(todoCallSummary(call("Bash", { command: "ls" }))).toBeNull();
  });
});
