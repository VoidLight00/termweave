import { expect, test } from "bun:test";
import type { ConversationTurn } from "../../shared/protocol.ts";
import { turnRevision } from "./turnRevision.ts";
import { RenderBoundary } from "../components/RenderBoundary.tsx";

const turn = (text: string, end?: string): ConversationTurn => ({ role: "assistant", ts: "2026-10-02T00:00:00Z", ...(end ? { end_ts: end } : {}), parts: [{ kind: "text", text }] });

test("a turn parsed again unchanged keeps its revision; new content or a later end changes it", () => {
  expect(turnRevision(turn("same"))).toBe(turnRevision(structuredClone(turn("same"))));
  expect(turnRevision(turn("same"))).not.toBe(turnRevision(turn("same, and more")));
  expect(turnRevision(turn("same"))).not.toBe(turnRevision(turn("same", "2026-10-02T00:00:09Z")));
  // rewritten to the same length, or a tool renamed: still a change
  expect(turnRevision(turn("ab"))).not.toBe(turnRevision(turn("cd")));
  const tool = (name: string): ConversationTurn => ({ role: "assistant", ts: null, parts: [{ kind: "tool", name, summary: "", input: "{}", output: "" }] });
  expect(turnRevision(tool("read"))).not.toBe(turnRevision(tool("edit")));
  const shown = (summary: string, ref: string): ConversationTurn => ({ role: "assistant", ts: null, parts: [{ kind: "tool", name: "read", summary, input: "{}", output: "", images: [{ media_type: "image/png", ref }] }] });
  expect(turnRevision(shown("a.ts", "pi:1:0"))).not.toBe(turnRevision(shown("b.ts", "pi:1:0")));
  expect(turnRevision(shown("a.ts", "pi:1:0"))).not.toBe(turnRevision(shown("a.ts", "pi:2:0")));
});

test("the boundary tries again in the render where its key changes, and not while it stays", () => {
  const props = (resetKey: unknown) => ({ resetKey, fallback: () => null, children: null });
  expect(RenderBoundary.getDerivedStateFromProps(props("a"), { failed: true, key: "a" })).toBeNull();
  expect(RenderBoundary.getDerivedStateFromProps(props("b"), { failed: true, key: "a" })).toEqual({ failed: false, key: "b" });
});
