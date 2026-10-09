import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The context window a pi model runs in.
 *
 * A pi transcript records what a request filled but never the window it filled, so the
 * percentage the composer's ring shows cannot come from the file. pi answers it from its
 * own model registry, which lives in the process (`getBuiltinModel`, compiled into the
 * bundle) and is refreshed over the network, so a reader of the transcript cannot duplicate
 * it. What it can read is the one catalog pi does keep on disk: the user's own
 * `models.json`, the file that defines every custom provider. `~/.pi/agent/models.json`
 * is pi's default location, moved by `PI_CODING_AGENT_DIR`.
 *
 * So this resolves what that file states and nothing else. A model pi knows from its
 * built-in registry, a provider whose entry omits `contextWindow`, and a model that names none
 * while its provider states one (pi does not inherit that number) all stay unresolved and the ring
 * is not drawn: guessing a window would draw a percentage the user cannot tell from pi's own. pi's
 * footer does the same, showing `?` in place of a number.
 */

/** The file's own spelling: `providers` by id, each with a list of models. */
type PiModel = { id?: unknown; contextWindow?: unknown };
type PiProvider = { models?: unknown };
type PiCatalog = { providers?: Record<string, PiProvider> };

/** pi strips a BOM and `//` comments before parsing this file, so a commented file still loads. */
function parse(text: string): unknown {
  const stripped = text.replace(/^\uFEFF/, "").replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : "")).replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail: string | undefined) => tail ?? (match[0] === '"' ? match : ""));
  try { return JSON.parse(stripped); } catch { return null; }
}

/**
 * A provider's models by id.
 *
 * A model's own `contextWindow`, or the `modelOverrides[model.id]` window when pi has one, and
 * nothing else. Two things this deliberately does not do, both checked against pi 0.87.1 by
 * pointing `PI_CODING_AGENT_DIR` at a crafted `models.json` and reading `pi --list-models`:
 *
 * - A provider-level `contextWindow` is NOT inherited by its models. A provider at 32000 whose
 *   model names no window shows that model at pi's own default of 128000, not at 32000. So this
 *   reports no window there: pi's default is pi's to apply, not a number this reader may show as
 *   though the user had stated it, and the ring stays undrawn rather than showing a denominator pi
 *   never used.
 * - `modelOverrides` IS applied, after the model definitions, and wins
 *   (`contextWindow: override.contextWindow ?? model.contextWindow`). Reading only `models` would
 *   report the pre-override window; at 128000 against an override of 256000 that is half the window
 *   and double the percentage the ring shows.
 *
 * An entry that is not an object is skipped rather than read, and the models beside it are still
 * resolved. pi is stricter: it validates the file, warns, and refuses the whole provider — checked
 * with a `models` list of `null, "a string", {id}`, which leaves `pi --list-models` reporting no
 * models at all. This reader is deliberately the more forgiving of the two, because its worst
 * outcome is one fewer number on the ring, while pi's worst outcome is switching to a model that
 * does not exist. It is not merely defensive: a `null` in that list threw, and the throw came from
 * the read every poll does, so the chat went down for a comma in a hand-edited file.
 */
function windowsOf(provider: PiProvider): Map<string, number> {
  const list: unknown[] = Array.isArray(provider.models) ? provider.models : [];
  const overrides = (provider as { modelOverrides?: unknown }).modelOverrides;
  const models = new Map<string, number>();
  for (const value of list) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const model = value as PiModel;
    if (typeof model.id !== "string") continue;
    const listed = overrides !== null && typeof overrides === "object" && !Array.isArray(overrides)
      ? (overrides as Record<string, unknown>)[model.id]
      : undefined;
    const override = listed !== null && typeof listed === "object" && !Array.isArray(listed) ? listed as PiModel : undefined;
    // pi's own rule, field by field: the override states a window or the model's own stands. An
    // override that only renames a model, or sets its cost, says nothing here
    const window = override?.contextWindow ?? model.contextWindow;
    if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) continue;
    models.set(model.id, window);
  }
  return models;
}

/** `models.json` read once per change: a conversation is re-read on every poll. */
let cache: { path: string; signature: string; providers: Map<string, Map<string, number>> } | null = null;

export function piAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env["PI_CODING_AGENT_DIR"];
  return typeof dir === "string" && dir.length > 0 ? (dir === "~" || dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir) : join(homedir(), ".pi", "agent");
}

/**
 * The window a model runs in, by the provider that served it. Both parts are asked for:
 * two providers can offer the same model id at different windows, and a session records
 * which of them answered.
 */
export function piContextWindow(model: string, provider: string | null, agentDir = piAgentDir()): number | null {
  let path: string;
  try { path = join(agentDir, "models.json"); } catch { return null; }
  let signature: string;
  try { const stat = statSync(path); signature = `${stat.mtimeMs}:${stat.size}`; } catch { return null; }
  if (cache === null || cache.path !== path || cache.signature !== signature) {
    let text: string;
    try { text = readFileSync(path, "utf8"); } catch { return null; }
    const catalog = parse(text) as PiCatalog | null;
    const providers = new Map<string, Map<string, number>>();
    if (catalog !== null && typeof catalog === "object" && catalog.providers !== undefined && catalog.providers !== null) {
      for (const [id, provider] of Object.entries(catalog.providers)) {
        if (provider === null || typeof provider !== "object") continue;
        providers.set(id, windowsOf(provider));
      }
    }
    cache = { path, signature, providers };
  }
  // an exact provider match only: a model id a second provider also serves, at another
  // window, must not borrow the first one's number
  const byId = provider === null ? undefined : cache.providers.get(provider);
  return byId?.get(model) ?? null;
}

/** The cache is process-wide; tests point it at another directory. */
export function forgetPiModels(): void { cache = null; }
