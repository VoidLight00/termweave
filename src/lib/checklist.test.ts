import { describe, expect, test } from "bun:test";

import { phaseRows, planRows, taskRows, todoRows } from "./checklist.ts";

describe("phaseRows", () => {
  test("a phased plan becomes headings followed by their items", () => {
    expect(
      phaseRows([
        { phase: "Foundation", items: ["Scaffold crate", "Wire workspace"] },
        { phase: "Verification", items: ["Run cargo test"] },
      ]),
    ).toEqual([
      { label: "Foundation", done: false, heading: true },
      { label: "Scaffold crate", done: false },
      { label: "Wire workspace", done: false },
      { label: "Verification", done: false, heading: true },
      { label: "Run cargo test", done: false },
    ]);
  });

  test("a phase without items still heads the list, and junk entries are dropped", () => {
    expect(phaseRows([{ phase: "Empty" }, null, "string", { items: [1, "kept"] }])).toEqual([
      { label: "Empty", done: false, heading: true },
      { label: "kept", done: false },
    ]);
  });
});

describe("todoRows", () => {
  test("status maps to the done and in-flight rows", () => {
    expect(
      todoRows([
        { content: "Apply fix", status: "completed" },
        { content: "Run tests", status: "in_progress" },
        { content: "Ship it", status: "pending" },
      ]),
    ).toEqual([
      { label: "Apply fix", done: true, active: false },
      { label: "Run tests", done: false, active: true },
      { label: "Ship it", done: false, active: false },
    ]);
  });

  test("a todo with no status is neither done nor active", () => {
    expect(todoRows([{ content: "Unstated" }])).toEqual([{ label: "Unstated", done: false, active: false }]);
  });

  test("entries without a string content are skipped", () => {
    expect(todoRows([{ status: "completed" }, { content: 42 }, null, { content: "kept" }])).toEqual([
      { label: "kept", done: false, active: false },
    ]);
  });
});

describe("planRows", () => {
  test("a Codex plan's steps keep their done and in-flight state", () => {
    expect(
      planRows([
        { step: "Read the parser", status: "completed" },
        { step: "Add the fallback", status: "in_progress" },
        { step: "Run tests", status: "pending" },
      ]),
    ).toEqual([
      { label: "Read the parser", done: true, active: false },
      { label: "Add the fallback", done: false, active: true },
      { label: "Run tests", done: false, active: false },
    ]);
  });

  test("entries without a string step are skipped", () => {
    expect(planRows([{ status: "completed" }, { step: 7 }, null, "loose", { step: "kept" }])).toEqual([
      { label: "kept", done: false, active: false },
    ]);
  });
});

describe("taskRows", () => {
  test("named, bare-string and anonymous tasks all get a label", () => {
    expect(taskRows(["review the diff", { name: "BuildDocs" }, { agent: "scout" }, { name: "" }])).toEqual([
      { label: "review the diff", done: false },
      { label: "BuildDocs", done: false },
      { label: "task 3", done: false },
      { label: "task 4", done: false },
    ]);
  });

  test("the anonymous fallback numbers by position in the original list", () => {
    expect(taskRows([null, { agent: "scout" }])).toEqual([{ label: "task 2", done: false }]);
  });
});
