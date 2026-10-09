import { expect, test } from "bun:test";
import type { ConversationPart } from "../../shared/protocol.ts";
import { formatGoalTime, goalOf, turnGoal } from "./goals.ts";

type Tool = Extract<ConversationPart, { kind: "tool" }>;
const call = (name: string, output: unknown, extra: Partial<Tool> = {}): Tool => ({
  kind: "tool", name, summary: "", input: "{}", output: typeof output === "string" ? output : JSON.stringify(output, null, 2), ...extra,
});
const goal = (status: string, more: Record<string, unknown> = {}) => ({ goal: { threadId: "t", objective: "Ship the goal card", status, tokensUsed: 120000, timeUsedSeconds: 540, ...more } });

test("a goal call's answer is the goal as it now stands", () => {
  expect(goalOf(call("create_goal", goal("active")))).toEqual({ objective: "Ship the goal card", status: "active", tokensUsed: 120000, timeUsedSeconds: 540, blockedReason: null });
  expect(goalOf(call("update_goal", goal("blocked", { blockedReason: "needs the user's key" })))?.blockedReason).toBe("needs the user's key");
});

test("no goal, a refused or failed call, an unknown status, other tools: nothing to show", () => {
  expect(goalOf(call("get_goal", { goal: null }))).toBeNull();
  expect(goalOf(call("create_goal", "Cannot create a new goal because this thread already has an unfinished goal"))).toBeNull();
  expect(goalOf(call("update_goal", goal("complete"), { error: true }))).toBeNull();
  expect(goalOf(call("update_goal", goal("someday")))).toBeNull();
  expect(goalOf(call("todo", goal("active")))).toBeNull();
});

test("a create_goal whose answer was cut keeps the objective it asked for", () => {
  const cut = call("create_goal", '{\n  "goal": {\n    "objective": "Ship the go\n… trimmed', { input: JSON.stringify({ objective: "Ship the goal card" }), output_ref: "pi:1", output_size: 9000 });
  expect(goalOf(cut)).toEqual({ objective: "Ship the goal card", status: "active", tokensUsed: null, timeUsedSeconds: null, blockedReason: null });
  expect(goalOf({ ...cut, name: "update_goal" })).toBeNull();
});

test("the turn shows the goal as its last goal call left it", () => {
  const parts: ConversationPart[] = [call("create_goal", goal("active")), { kind: "text", text: "working" }, call("update_goal", goal("complete")), call("get_goal", "not json")];
  expect(turnGoal(parts)?.status).toBe("complete");
  // cleared (/goal clear), a get_goal says so: the turn shows no goal
  expect(turnGoal([...parts, call("get_goal", { goal: null })])).toBeNull();
  expect(turnGoal([{ kind: "text", text: "no goal here" }])).toBeNull();
});

test("time on a goal reads in the largest units that matter", () => {
  expect([formatGoalTime(45), formatGoalTime(540), formatGoalTime(3600), formatGoalTime(7500)]).toEqual(["45s", "9m", "1h", "2h 5m"]);
});
