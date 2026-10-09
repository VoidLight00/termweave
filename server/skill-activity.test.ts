import { expect, test } from "bun:test";
import { createCodexTranscriptParser, parseCodexTranscript } from "./codex.ts";
import { parseClaudeTranscript } from "./conversation.ts";
import { parseOmpTranscript } from "./transcript-records.ts";
import { codexReadCall, codexReadSkills, selectedSkill, skillInvocationPrompt } from "./skill-activity.ts";
import { turnSkills } from "../src/lib/skillActivity.ts";
import type { SkillActivity } from "../shared/protocol.ts";
import { splitTurn, workSummary } from "../src/lib/workBlocks.ts";

const lines = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
const response = (payload: unknown) => ({ type: "response_item", timestamp: "2026-09-27T00:00:01Z", payload });
const prompt = response({ type: "message", role: "user", content: [{ type: "input_text", text: "Please review" }] });
const envelope = "<skill>\n<name>review</name>\n<path>/skills/review/SKILL.md</path>\nPRIVATE INSTRUCTIONS\n</skill>";
const selected = response({ type: "message", role: "user", content: [{ type: "input_text", text: envelope }] });
const call = (id: string, skill: string) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Skill", input: { skill } }] } });
const result = (id: string, isError = false) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: isError ? "Unavailable" : "Launching skill", is_error: isError }] } });

test("Claude records skill request, invocation and failure without claiming task completion", () => {
  const first = parseClaudeTranscript(lines([call("one", "plugin:review")]));
  expect(turnSkills(first[0]!.parts)).toEqual([{ name: "plugin:review", evidence: "invocation", status: "requested" }]);
  const complete = parseClaudeTranscript(lines([call("one", "plugin:review"), result("one"), call("two", "deploy"), result("two", true)]));
  expect(turnSkills(complete[0]!.parts)).toEqual([
    { name: "plugin:review", evidence: "invocation", status: "loaded" },
    { name: "deploy", evidence: "invocation", status: "failed" },
  ]);
  expect(workSummary(complete[0]!.parts)).toBe("2 skills · 1 failed");
  expect(complete[0]?.parts[0]).toMatchObject({ kind: "tool", summary: "plugin:review", input: expect.stringContaining("plugin:review") });
  const mention = parseClaudeTranscript(lines([{ type: "assistant", message: { content: [{ type: "text", text: "Maybe use review" }, { type: "tool_use", name: "Read", input: { file_path: "/notes/review.txt" } }] } }]));
  expect(turnSkills(mention[0]!.parts)).toEqual([]);
});

test("Codex selected instructions become assistant skill evidence, not a user bubble or exposed prompt", () => {
  const turns = parseCodexTranscript(lines([prompt, selected, selected, response({ type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Reviewed" }] })]));
  expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  expect(turnSkills(turns[1]!.parts)).toEqual([{ name: "review", path: "/skills/review/SKILL.md", evidence: "instructions", status: "loaded" }]);
  expect(JSON.stringify(turns)).not.toContain("PRIVATE INSTRUCTIONS");
  expect(splitTurn(turns[1]!.parts).answer).toEqual([{ kind: "text", text: "Reviewed", phase: "final_answer" }]);
  const mixed = parseCodexTranscript(lines([response({ type: "message", role: "user", content: [{ type: "input_text", text: "Actual prompt" }, { type: "input_text", text: envelope }] })]));
  expect(mixed.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  expect(selectedSkill("Please explain " + envelope)).toBeNull();
  expect(selectedSkill(envelope.slice(0, -8))).toBeNull();
  expect(selectedSkill("<skills_instructions>available skills</skills_instructions>")).toBeNull();
});

test("Codex native completed read events work through code-mode wrappers, deduplicate and survive incremental snapshots", () => {
  const completed = { type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", id: "exec-one", parsed_cmd: [{ type: "read", path: "/skills/review/SKILL.md" }], exit_code: 0, status: "completed" } } };
  const parser = createCodexTranscriptParser();
  parser.write(lines([prompt]));
  const before = parser.snapshot();
  parser.write(lines([completed, completed]));
  const after = parser.snapshot();
  expect(after).toEqual(parseCodexTranscript(lines([prompt, completed])));
  expect(after[1]!.parts).toHaveLength(1);
  expect(before).toHaveLength(1);
  expect(codexReadSkills({ ...completed.payload.item, parsed_cmd: [{ type: "unknown", cmd: "echo /skills/review/SKILL.md" }] })).toEqual([]);
  expect(codexReadSkills({ ...completed.payload.item, exit_code: 1, status: "failed" })[0]?.status).toBe("failed");
  expect(codexReadSkills({ ...completed.payload.item, status: "in_progress" })).toEqual([]);
});

test("Codex literal read calls update immutable snapshots on success/failure and ignore shell lookalikes", () => {
  const read = response({ type: "function_call", name: "exec_command", call_id: "one", arguments: JSON.stringify({ cmd: "cat '/skills/review/SKILL.md'" }) });
  const done = response({ type: "function_call_output", call_id: "one", output: "Process exited with code 1\nNo such file" });
  const parser = createCodexTranscriptParser();
  parser.write(lines([prompt, read]));
  const pending = parser.snapshot();
  expect(turnSkills(pending[1]!.parts)[0]?.status).toBe("requested");
  parser.write(lines([done]));
  expect(turnSkills(parser.snapshot()[1]!.parts)[0]?.status).toBe("failed");
  expect(turnSkills(pending[1]!.parts)[0]?.status).toBe("requested");
  for (const cmd of ["echo /skills/review/SKILL.md", "rg SKILL.md /skills", "cat $ROOT/review/SKILL.md", "cat /skills/review/SKILL.md > /tmp/out", "printf 'cat /skills/review/SKILL.md'", "cat /notes/README.md", "git diff -- /skills/review/SKILL.md"]) {
    expect(codexReadCall("exec_command", { cmd })).toBeNull();
  }
  expect(codexReadCall("exec_command", { cmd: "sed -n '1,220p' /skills/review/SKILL.md" })?.name).toBe("review");
});

test("skill evidence is scoped to each turn and clear removes previous Claude skill activity", () => {
  const clear = { type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } };
  expect(parseClaudeTranscript(lines([call("one", "review"), result("one"), clear]))).toEqual([]);
  const turns = parseCodexTranscript(lines([prompt, selected, response({ type: "message", role: "user", content: "Another request" }), response({ type: "message", role: "assistant", content: "No skill" })]));
  expect(turnSkills(turns.at(-1)!.parts)).toEqual([]);
});

test("late native read events from another Codex turn do not attach to the current answer", () => {
  const turns = parseCodexTranscript(lines([
    { type: "event_msg", payload: { type: "task_started", turn_id: "current" } },
    prompt,
    { type: "event_msg", payload: { type: "item_completed", turn_id: "old", item: { type: "CommandExecution", id: "late", status: "completed", exit_code: 0, parsed_cmd: [{ type: "read", path: "/skills/old/SKILL.md" }] } } },
    response({ type: "message", role: "assistant", content: "Current answer" }),
  ]));
  expect(turnSkills(turns.at(-1)!.parts)).toEqual([]);
});

test("Codex tool and native read records count one skill and keep the tool output", () => {
  const turns = parseCodexTranscript(lines([
    prompt,
    response({ type: "function_call", name: "exec_command", call_id: "read", arguments: '{"cmd":"cat /skills/review/SKILL.md"}' }),
    { type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", id: "native-read", status: "completed", exit_code: 0, parsed_cmd: [{ type: "read", path: "/skills/review/SKILL.md" }] } } },
    response({ type: "function_call_output", call_id: "read", output: "Process exited with code 0\nInstructions" }),
  ]));
  expect(turns[1]!.parts).toHaveLength(1);
  expect(turnSkills(turns[1]!.parts)).toHaveLength(1);
  expect(workSummary(turns[1]!.parts)).toBe("1 skill");
  expect(turns[1]!.parts[0]).toMatchObject({ output: expect.stringContaining("Instructions"), skill: { status: "loaded" } });
});

const invoked = (name: string, location = `/home/u/.omo/skills/${name}/SKILL.md`) => // leakscan:allow: test fixture
  `The user explicitly invoked the "${name}" skill. Follow the instructions in <skill-instruction> as binding for this request, while respecting higher-priority instructions.\n\n<skill-instruction name="${name}" location="${location}">\nReferences are relative to /home/u/.omo/skills/${name}.\n\nPRIVATE ${name} INSTRUCTIONS\n</skill-instruction>`; // leakscan:allow: test fixture
const loaded = (name: string): SkillActivity => ({ name, path: `/home/u/.omo/skills/${name}/SKILL.md`, evidence: "instructions", status: "loaded" }); // leakscan:allow: test fixture
const piUser = (text: string) => ({ type: "message", timestamp: "2026-10-02T00:00:00Z", message: { role: "user", content: [{ type: "text", text }] } });
const piAnswer = (text: string) => ({ type: "message", timestamp: "2026-10-02T00:00:05Z", message: { role: "assistant", content: [{ type: "text", text }] } });

test("an omo/omp skill invocation reads as the request, with the skill on it", () => {
  const text = `${invoked("ulw-research")}\n\n<user-request>\n  compare the three apps\n</user-request>`;
  expect(skillInvocationPrompt(text)).toEqual({ skills: [loaded("ulw-research")], request: "compare the three apps" });
  const turns = parseOmpTranscript(lines([piUser(text), piAnswer("On it.")]));
  expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  expect(turns[0]!.parts).toEqual([{ kind: "text", text: "compare the three apps" }, { kind: "skill", skill: loaded("ulw-research") }]);
  expect(turnSkills(turns[1]!.parts)).toEqual([]);
  expect(JSON.stringify(turns)).not.toContain("PRIVATE");
  expect(splitTurn(turns[1]!.parts).answer).toEqual([{ kind: "text", text: "On it." }]);
});

test("chained skill invocations and a request-less one", () => {
  const chained = `${invoked("a")}\n\n${invoked("b")}`;
  expect(skillInvocationPrompt(chained)).toEqual({ skills: [loaded("a"), loaded("b")], request: "" });
  expect(parseOmpTranscript(lines([piUser(chained)]))[0]!.parts).toEqual([{ kind: "text", text: "/skill:a /skill:b" }, { kind: "skill", skill: loaded("a") }, { kind: "skill", skill: loaded("b") }]);
});

test("the legacy <skill> form, and text that only looks like an invocation, as pi reads them", () => {
  expect(skillInvocationPrompt('<skill name="x" location="/s/x/SKILL.md">\nBODY\n</skill>\n\nplease')).toEqual({ skills: [{ name: "x", path: "/s/x/SKILL.md", evidence: "instructions", status: "loaded" } satisfies SkillActivity], request: "please" });
  // a name that differs from its block, trailing text outside <user-request>, a broken chain: the user's text as typed
  expect(skillInvocationPrompt(invoked("a").replace('name="a" location', 'name="b" location'))).toBeNull();
  expect(skillInvocationPrompt(`${invoked("a")}\n\nmore`)).toBeNull();
  expect(skillInvocationPrompt(`${invoked("a")}\n\nThe user explicitly invoked the "b" skill.`)).toBeNull();
  expect(skillInvocationPrompt("The user explicitly invoked nothing")).toBeNull();
  expect(parseOmpTranscript(lines([piUser(`${invoked("a")}\n\nmore`)]))[0]!.parts[0]).toMatchObject({ kind: "text", text: expect.stringContaining("PRIVATE a") });
});

test("the skill stays on its message wherever the transcript is cut: parsed apart, the record is whole", () => {
  const text = `${invoked("ulw-research")}\n\n<user-request>\ncompare\n</user-request>`;
  // conversation.ts parses the settled turns and the live last turn separately
  const settled = parseOmpTranscript(lines([piUser(text)]));
  const live = parseOmpTranscript(lines([piUser("also check the docs"), piAnswer("On it.")]));
  expect([...settled, ...live].map((turn) => turn.role)).toEqual(["user", "user", "assistant"]);
  expect(turnSkills(settled[0]!.parts)).toEqual([loaded("ulw-research")]);
  expect(turnSkills(live[1]!.parts)).toEqual([]);
});

test("a standalone .md skill (pi --skill review.md) is a skill too", () => {
  const text = invoked("review", "/home/u/skills/review.md"); // leakscan:allow: test fixture
  expect(skillInvocationPrompt(text)).toEqual({ skills: [{ name: "review", path: "/home/u/skills/review.md", evidence: "instructions", status: "loaded" }], request: "" }); // leakscan:allow: test fixture
});
