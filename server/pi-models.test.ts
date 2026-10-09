import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { forgetPiModels, piContextWindow } from "./pi-models.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-pi-models-"));
afterEach(() => forgetPiModels());
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A directory laid out like an agent dir: only `models.json` matters here. */
const agentDir = (name: string, body: string) => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "models.json"), body);
  return dir;
};

const catalog = JSON.stringify({
  providers: {
    "lwsa-platform": {
      baseUrl: "https://example.invalid/v1",
      api: "openai-completions",
      models: [
        { id: "vllm-flash/Qwen3.8-Flash-Next", contextWindow: 215000 },
        { id: "no-window-model" },
      ],
    },
    "other-platform": { models: [{ id: "vllm-flash/Qwen3.8-Flash-Next", contextWindow: 32000 }] },
    // pi does NOT inherit a provider-level contextWindow into its models: checked against pi
    // 0.87.1 (`pi --list-models`), a provider at 32000 with a model that names none shows that
    // model at 128K, pi's own default, not at 32000. So "a" here has no window to report
    "shared-default": { contextWindow: 128000, models: [{ id: "a" }, { id: "b", contextWindow: 64000 }] },
    // modelOverrides[model.id] is applied by pi AFTER the model definitions, and wins: a model
    // declaring 128000 under an override of 256000 runs at 256K, so reading only `models` here
    // would report half the window and double the percentage the ring shows
    "overridden": {
      baseUrl: "https://example.invalid/v1",
      models: [{ id: "over", contextWindow: 128000 }, { id: "over-no-window" }, { id: "over-renamed", contextWindow: 20000 }],
      modelOverrides: {
        over: { contextWindow: 256000 },
        "over-no-window": { contextWindow: 96000 },
        // an override that renames a model says nothing about its window, and pi keeps the model's
        // own (`override.contextWindow ?? model.contextWindow`), so dropping the window here would
        // undraw a ring pi has a number for
        "over-renamed": { name: "shown under another name" },
      },
    },
    // a model entry that is not an object is damage in the file, and pi rejects the provider and
    // says so; reading its `.id` here would throw and take the whole chat down with it
    "ragged": { models: [null, "a string", 7, { id: "after-the-rubble", contextWindow: 44000 }] },
    "no-models": { baseUrl: "https://example.invalid" },
  },
});

describe("the context window a pi model runs in", () => {
  it("reads the window pi reads its custom providers from", () => {
    const dir = agentDir("basic", catalog);
    expect(piContextWindow("vllm-flash/Qwen3.8-Flash-Next", "lwsa-platform", dir)).toBe(215000);
  });

  it("asks the provider too: the same model id at two windows answers with the one that served it", () => {
    const dir = agentDir("two-providers", catalog);
    expect(piContextWindow("vllm-flash/Qwen3.8-Flash-Next", "other-platform", dir)).toBe(32000);
    // no provider to ask, and an unknown one: neither may borrow a number it cannot confirm
    expect(piContextWindow("vllm-flash/Qwen3.8-Flash-Next", null, dir)).toBeNull();
    expect(piContextWindow("vllm-flash/Qwen3.8-Flash-Next", "absent-platform", dir)).toBeNull();
  });

  it("refuses a provider-level window it cannot confirm, and takes the override pi applies", () => {
    const dir = agentDir("defaults", catalog);
    // pi's own default is not this reader's to guess: a model with no window of its own stays
    // unresolved and the ring is not drawn, rather than showing a number pi never used
    expect(piContextWindow("a", "shared-default", dir)).toBeNull();
    expect(piContextWindow("b", "shared-default", dir)).toBe(64000);
    // an override is what pi actually runs at, over the model's own number
    expect(piContextWindow("over", "overridden", dir)).toBe(256000);
    // and an override can give a window to a model that declared none — still pi's, still exact
    expect(piContextWindow("over-no-window", "overridden", dir)).toBe(96000);
    // an override that says nothing about the window leaves the model's own standing
    expect(piContextWindow("over-renamed", "overridden", dir)).toBe(20000);
  });

  it("skips a model entry that is not an object instead of throwing", () => {
    // one bad line in a hand-edited file must not take the chat down: the models beside it are
    // still readable
    const dir = agentDir("ragged", catalog);
    expect(piContextWindow("after-the-rubble", "ragged", dir)).toBe(44000);
    expect(piContextWindow("a", "ragged", dir)).toBeNull();
  });

  it("says nothing it cannot support: no entry, no window, no file, a file that is not JSON", () => {
    const dir = agentDir("silent", catalog);
    expect(piContextWindow("no-window-model", "lwsa-platform", dir)).toBeNull();
    expect(piContextWindow("any", "no-models", dir)).toBeNull();
    expect(piContextWindow("any", "anywhere", join(root, "never-written"))).toBeNull();
    expect(piContextWindow("any", "anywhere", agentDir("broken", "{ providers"))).toBeNull();
    expect(piContextWindow("any", "anywhere", agentDir("not-a-catalog", "[1,2]"))).toBeNull();
    expect(piContextWindow("any", "anywhere", agentDir("empty-window", ""))).toBeNull();
  });

  it("reads the file the way pi does: comments, a BOM, and a window updated underneath a warm page", () => {
    const dir = agentDir("live", catalog);
    expect(piContextWindow("b", "shared-default", dir)).toBe(64000);
    // pi itself strips `//` comments and a BOM before parsing; a user editing the file to
    // correct a window must not have to restart anything for the ring to agree
    writeFileSync(join(dir, "models.json"), `\uFEFF{ // the platform raised this week\n${JSON.stringify({ providers: { "shared-default": { models: [{ id: "a", contextWindow: 256000 }] } } }).slice(1, -1)}\n}`);
    expect(piContextWindow("a", "shared-default", dir)).toBe(256000);
  });

  it("never answers a model with the window of the one standing in for it", () => {
    // pi picks its model by default when a transcript's own is unavailable, and then divides
    // that transcript's tokens by the stand-in's window: a session recorded at xai's grok-4.7
    // was reported at 215000, which is lwsa's number and belongs to neither model. Reading the
    // transcript says which model actually answered, so this cannot make the same mistake.
    const dir = agentDir("stand-in", catalog);
    expect(piContextWindow("grok-4.7", "xai", dir)).toBeNull();
    expect(piContextWindow("Ling-3.0-tiny", "llama.cpp", dir)).toBeNull();
    expect(piContextWindow("vllm-flash/Qwen3.8-Flash-Next", "lwsa-platform", dir)).toBe(215000);
  });

  it("refuses a window that is not a number worth dividing by", () => {
    const dir = agentDir("nonsense", JSON.stringify({ providers: { p: { models: [
      { id: "zero", contextWindow: 0 },
      { id: "negative", contextWindow: -1 },
      { id: "text", contextWindow: "200000" },
      { id: "infinite", contextWindow: 1e400 },
    ] } } }));
    for (const id of ["zero", "negative", "text", "infinite"]) expect(piContextWindow(id, "p", dir)).toBeNull();
  });
});
