import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseConversationMetadata } from "./conversation-metadata.ts";
import { forgetPiModels } from "./pi-models.ts";

const jsonl = (...entries: unknown[]) => entries.map((entry) => JSON.stringify(entry)).join("\n");

// A pi window is looked up in the agent dir's models.json, so a test that left that unset
// would read whatever machine ran it: the same test would pass here and fail on a laptop.
// Everything in here points at a directory of its own instead.
const emptyDir = mkdtempSync(join(tmpdir(), "herdr-meta-empty-"));
const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
process.env["PI_CODING_AGENT_DIR"] = emptyDir;
afterAll(() => {
  if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"]; else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
  rmSync(emptyDir, { recursive: true, force: true });
  forgetPiModels();
});

describe("recorded conversation model settings", () => {
  it("uses the latest Codex turn context, not the session's initial model", () => {
    expect(parseConversationMetadata(jsonl(
      { type: "session_meta", payload: { model: "initial", reasoning_effort: "low" } },
      { type: "turn_context", payload: { model: "current", effort: "xhigh" } },
      { type: "response_item", payload: { type: "message", role: "user", model: "user text is not metadata" } },
    ), "codex-transcript")).toEqual({ model: "current", reasoning_effort: "xhigh" });
  });

  it("recognizes collaboration-mode settings and explicit effort overrides", () => {
    const context = { collaboration_mode: { settings: { model: "collaboration-model", reasoning_effort: "high" } } };
    expect(parseConversationMetadata(jsonl({ type: "turn_context", payload: context }), "codex-transcript"))
      .toEqual({ model: "collaboration-model", reasoning_effort: "high" });
    expect(parseConversationMetadata(jsonl({ type: "turn_context", payload: { ...context, effort: "none" } }), "codex-transcript"))
      .toEqual({ model: "collaboration-model", reasoning_effort: "none" });
    expect(parseConversationMetadata(jsonl({ type: "turn_context", payload: { ...context, effort: null } }), "codex-transcript"))
      .toEqual({ model: "collaboration-model", reasoning_effort: null });
  });

  it("does not carry an old effort into a Codex context that no longer reports one", () => {
    expect(parseConversationMetadata(jsonl(
      { type: "turn_context", payload: { model: "first", effort: "high" } },
      { type: "turn_context", payload: { model: "second" } },
    ), "codex-transcript")).toEqual({ model: "second", reasoning_effort: null });
  });

  it("updates independent omp/omo/pi model and thinking settings, including off", () => {
    for (const source of ["omp-transcript", "omo-transcript", "pi-transcript"] as const) {
      expect(parseConversationMetadata(jsonl(
        { type: "model_change", modelId: "first" },
        { type: "thinking_level_change", thinkingLevel: "max" },
        { type: "model_change", modelId: "second" },
      ), source)).toEqual({ model: "second", reasoning_effort: "max" });
      expect(parseConversationMetadata(jsonl(
        { type: "thinking_level_change", thinkingLevel: "off" },
        { type: "message", message: { role: "assistant", model: "actual-response-model" } },
      ), source)).toEqual({ model: "actual-response-model", reasoning_effort: "off" });
    }
  });

  it("reads Claude's actual model without deriving effort from thinking content", () => {
    expect(parseConversationMetadata(jsonl(
      { type: "assistant", message: { role: "assistant", model: "claude-test", content: [{ type: "thinking", thinking: "text" }] } },
      { type: "assistant", message: { role: "assistant", model: "<synthetic>" } },
    ), "claude-transcript")).toEqual({ model: "claude-test", reasoning_effort: null });
    expect(parseConversationMetadata(jsonl(
      { type: "assistant", effort: "high", message: { role: "assistant", model: "claude-test" } },
      { type: "assistant", effort: "xhigh", message: { role: "assistant", model: "claude-test" } },
      { type: "assistant", message: { role: "assistant", model: "<synthetic>" } },
    ), "claude-transcript")).toEqual({ model: "claude-test", reasoning_effort: "xhigh" });
  });

  it("tolerates absent metadata, unexpected types and a torn append without losing valid settings", () => {
    const text = jsonl(null, [], { type: "turn_context", payload: null },
      { type: "turn_context", payload: { model: "recorded", effort: "medium" } },
      { type: "turn_context", payload: { model: {}, effort: undefined } });
    expect(parseConversationMetadata(`${text}\n{"type":`, "codex-transcript"))
      .toEqual({ model: "recorded", reasoning_effort: "medium" });
    expect(parseConversationMetadata("", "scrollback")).toEqual({ model: null, reasoning_effort: null });
  });
});

describe("context use", () => {
  const assistant = (usage: Record<string, number>, model = "claude-opus-5-5", extra: Record<string, unknown> = {}) =>
    ({ type: "assistant", ...extra, message: { role: "assistant", model, usage } });

  it("reads Codex's last request against the window it states", () => {
    const tokens = (total: number) => ({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: total }, model_context_window: 258_400 } } });
    expect(parseConversationMetadata(jsonl(tokens(10_000), tokens(67_723), { type: "event_msg", payload: { type: "token_count", info: null } }), "codex-transcript").context)
      .toEqual({ used: 67_723, window: 258_400 });
  });

  it("adds up a Claude request's input and cache, skipping subagents, and knows the 1M window once past 200k", () => {
    const small = parseConversationMetadata(jsonl(assistant({ input_tokens: 2, cache_creation_input_tokens: 700, cache_read_input_tokens: 40_000, output_tokens: 900 })), "claude-transcript");
    expect(small.context).toEqual({ used: 40_702, window: null });
    const long = parseConversationMetadata(jsonl(
      assistant({ input_tokens: 5, cache_read_input_tokens: 420_000 }),
      assistant({ input_tokens: 1, cache_read_input_tokens: 5_000 }, "claude-opus-5-5", { isSidechain: true }),
      // compacted: the use shrinks, the window stays
      assistant({ input_tokens: 3, cache_read_input_tokens: 30_000 }),
      assistant({ input_tokens: 0, output_tokens: 0 }, "<synthetic>"),
    ), "claude-transcript");
    expect(long.context).toEqual({ used: 30_003, window: 1_000_000 });
  });

  it("reads omp's usage shape, with no window to go by", () => {
    const entry = { type: "message", message: { role: "assistant", model: "gpt-6", usage: { input: 2, output: 7_000, cacheRead: 10_000, cacheWrite: 22_000 } } };
    expect(parseConversationMetadata(jsonl(entry), "omo-transcript").context).toEqual({ used: 32_002, window: null });
    expect(parseConversationMetadata(jsonl({ type: "message", message: { role: "user" } }), "omp-transcript").context).toBeUndefined();
  });

  it("reads pi's usage shape, which names the same fields omp does", () => {
    const entry = { type: "message", message: { role: "assistant", model: "qwen-test", usage: { input: 4_924, output: 198, cacheRead: 18_400, cacheWrite: 1_000, reasoning: 53, totalTokens: 24_522 } } };
    // the figure pi draws its own footer from: totalTokens, which counts the answer as well
    expect(parseConversationMetadata(jsonl(entry), "pi-transcript")).toEqual({
      model: "qwen-test", reasoning_effort: null, context: { used: 24_522, window: null },
    });
  });

  it("adds up a pi request itself when it states no total", () => {
    const usage = (extra: Record<string, unknown> = {}) => ({ type: "message", message: { role: "assistant", model: "qwen-test", usage: { input: 1_000, output: 200, cacheRead: 500, cacheWrite: 0, ...extra } } });
    expect(parseConversationMetadata(jsonl(usage()), "pi-transcript").context).toEqual({ used: 1_700, window: null });
    expect(parseConversationMetadata(jsonl(usage({ totalTokens: 1_234 })), "pi-transcript").context).toEqual({ used: 1_234, window: null });
    // a request that failed or was stopped filled nothing: pi leaves it out of its own figure
    const failed = { type: "message", message: { role: "assistant", model: "qwen-test", stopReason: "error", errorMessage: "401", usage: { input: 9_000, output: 0 } } };
    const aborted = { ...failed, message: { ...failed.message, stopReason: "aborted" } };
    expect(parseConversationMetadata(jsonl(usage(), failed), "pi-transcript").context).toEqual({ used: 1_700, window: null });
    expect(parseConversationMetadata(jsonl(usage(), aborted), "pi-transcript").context).toEqual({ used: 1_700, window: null });
  });

  it("draws pi's ring against the window its own catalog states, and not against a guess", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-meta-window-"));
    const previous = process.env["PI_CODING_AGENT_DIR"];
    writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { lwsa: { models: [{ id: "qwen-test", contextWindow: 215_000 }] } } }));
    process.env["PI_CODING_AGENT_DIR"] = dir;
    forgetPiModels();
    try {
      const entry = (extra: Record<string, unknown> = {}) => ({ type: "message", message: { role: "assistant", model: "qwen-test", provider: "lwsa", usage: { totalTokens: 100_000 }, ...extra } });
      expect(parseConversationMetadata(jsonl(entry()), "pi-transcript").context).toEqual({ used: 100_000, window: 215_000 });
      // the provider that answered is the one asked: a model_change to another provider, whose
      // catalog says nothing about this model, must not borrow the first one's number
      const changed = [
        { type: "model_change", provider: "lwsa", modelId: "qwen-test" },
        entry(),
        { type: "model_change", provider: "other", modelId: "qwen-test" },
        entry({ provider: "other" }),
      ];
      expect(parseConversationMetadata(jsonl(...changed), "pi-transcript").context).toEqual({ used: 100_000, window: null });
      // omp, omo and gjc are read by the same code and resolve nothing: their figure stays
      const omp = { type: "message", message: { role: "assistant", model: "qwen-test", provider: "lwsa", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } } };
      expect(parseConversationMetadata(jsonl(omp), "omp-transcript").context).toEqual({ used: 8, window: null });
    } finally {
      if (previous === undefined) delete process.env["PI_CODING_AGENT_DIR"]; else process.env["PI_CODING_AGENT_DIR"] = previous;
      forgetPiModels();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
