#!/usr/bin/env bun
/**
 * Generate TypeScript wire types from herdr's own API schema.
 *
 *   bun run scripts/generate-protocol-types.ts            # write shared/herdr-api.generated.ts
 *   bun run scripts/generate-protocol-types.ts --check     # fail if the committed output is stale
 *   bun run scripts/generate-protocol-types.ts --refresh   # re-read the schema from `herdr api schema --json`
 *                                                           (HERDR_WEB_HERDR_BIN picks the herdr binary)
 *
 * Shape decisions, and why:
 *
 * - Only the types herdr-web-ui actually consumes are emitted, plus their transitive
 *   closure. Generating all 170+ definitions would bury the ones under review.
 * - String enums become unions widened with `(string & {})`. herdr gives no
 *   stability guarantee, so a value from a future version must still flow through
 *   instead of failing to typecheck. This mirrors the RawRepresentable structs
 *   Heeler generates for the same reason.
 * - Definition names repeat across the schema's five top-level sections and are
 *   NOT always structurally identical: in herdr 0.9.0 a request's ReadSource is
 *   "recent-unwrapped" while a response's is "recent_unwrapped". Colliding names
 *   are therefore namespaced by section rather than merged, because merging them
 *   would silently emit invalid requests.
 * - Output is deterministic (types and properties sorted, no timestamps), so
 *   regenerating against an unchanged schema is a no-op diff.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SCHEMA_PATH = join(ROOT, "scripts", "herdr-schema.json");
const OUTPUT_PATH = join(ROOT, "shared", "herdr-api.generated.ts");

/** Roots per schema section; their transitive closure is what gets emitted. */
const ROOTS: Record<string, string[]> = {
  success_response: ["SessionSnapshot", "PaneReadResult", "AgentManifestInfo"],
  request: [
    "AgentStartParams",
    "PaneReadParams",
    "PaneSendTextParams",
    "PaneSendKeysParams",
    "EventsSubscribeParams",
    "Subscription",
  ],
};

const SECTION_PREFIX: Record<string, string> = {
  request: "Request",
  success_response: "Response",
  event: "Event",
  subscription_event: "SubscriptionEvent",
  error_response: "Error",
};

type Json = Record<string, any>;

interface Collected {
  section: string;
  name: string;
  def: Json;
}

function parseRef(ref: string): { section: string; name: string } {
  // "#/schemas/success_response/$defs/PaneInfo"
  const parts = ref.split("/");
  const section = parts[2];
  const name = parts[4];
  if (!section || !name) throw new Error(`unsupported $ref: ${ref}`);
  return { section, name };
}

function collect(schema: Json): Map<string, Collected> {
  const found = new Map<string, Collected>();

  const visit = (section: string, name: string): void => {
    const key = `${section}/${name}`;
    if (found.has(key)) return;
    const def = schema.schemas?.[section]?.$defs?.[name];
    if (!def) throw new Error(`missing definition ${key}`);
    found.set(key, { section, name, def });
    walkRefs(def, (ref) => {
      const target = parseRef(ref);
      visit(target.section, target.name);
    });
  };

  for (const [section, names] of Object.entries(ROOTS)) {
    for (const name of names) visit(section, name);
  }
  return found;
}

function walkRefs(node: unknown, onRef: (ref: string) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walkRefs(item, onRef);
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node as Json)) {
    if (key === "$ref" && typeof value === "string") onRef(value);
    else walkRefs(value, onRef);
  }
}

/** Colliding names are namespaced only when their structures actually differ. */
function resolveNames(found: Map<string, Collected>): Map<string, string> {
  const byName = new Map<string, Collected[]>();
  for (const entry of found.values()) {
    const list = byName.get(entry.name) ?? [];
    list.push(entry);
    byName.set(entry.name, list);
  }
  const names = new Map<string, string>();
  for (const [name, entries] of byName) {
    const shapes = new Set(entries.map((e) => JSON.stringify(e.def)));
    const ambiguous = entries.length > 1 && shapes.size > 1;
    for (const entry of entries) {
      const prefix = ambiguous ? (SECTION_PREFIX[entry.section] ?? entry.section) : "";
      names.set(`${entry.section}/${entry.name}`, `${prefix}${entry.name}`);
    }
  }
  return names;
}

function tsTypeOf(def: Json, section: string, names: Map<string, string>, indent: string): string {
  if (def.$ref) {
    const target = parseRef(def.$ref);
    const resolved = names.get(`${target.section}/${target.name}`);
    if (!resolved) throw new Error(`unresolved ref ${def.$ref}`);
    return resolved;
  }
  if (def.enum) {
    const literals = [...def.enum].sort().map((value: string) => JSON.stringify(value));
    // widened so an unknown value from a newer herdr still typechecks
    return `${literals.join(" | ")} | (string & {})`;
  }
  if (def.oneOf || def.anyOf) {
    const variants: Json[] = def.oneOf ?? def.anyOf;
    const rendered = [...new Set(variants.map((variant) => tsTypeOf(variant, section, names, indent)))];
    // `T | unknown` collapses to `unknown` in TypeScript and would erase the union,
    // so an untyped variant is dropped whenever a typed one exists.
    const meaningful = rendered.filter((type) => type !== "unknown");
    return (meaningful.length > 0 ? meaningful : rendered).join(" | ");
  }

  const rawType = def.type;
  const types = Array.isArray(rawType) ? rawType : rawType ? [rawType] : [];
  const nullable = types.includes("null");
  const primary = types.filter((t: string) => t !== "null");
  const render = (kind: string): string => {
    switch (kind) {
      case "string":
        return "string";
      case "integer":
      case "number":
        return "number";
      case "boolean":
        return "boolean";
      case "array":
        return `${tsTypeOf(def.items ?? {}, section, names, indent)}[]`;
      case "object":
        return def.properties ? renderObject(def, section, names, indent) : "Record<string, unknown>";
      default:
        return "unknown";
    }
  };
  // a variant that is only {"type":"null"} must render as null, not as `unknown | null`,
  // which would poison any union it takes part in
  if (primary.length === 0) return nullable ? "null" : "unknown";
  const body = primary.map(render).join(" | ");
  return nullable ? `${body} | null` : body;
}

function renderObject(def: Json, section: string, names: Map<string, string>, indent: string): string {
  const properties: Json = def.properties ?? {};
  const required: string[] = def.required ?? [];
  const inner = `${indent}  `;
  const lines = Object.keys(properties)
    .sort()
    .map((key) => {
      const optional = required.includes(key) ? "" : "?";
      const rendered = tsTypeOf(properties[key], section, names, inner);
      const safeKey = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
      return `${inner}${safeKey}${optional}: ${rendered};`;
    });
  if (lines.length === 0) return "Record<string, unknown>";
  return `{\n${lines.join("\n")}\n${indent}}`;
}

function generate(schema: Json): string {
  const found = collect(schema);
  const names = resolveNames(found);

  // Definitions that repeat across sections with an identical shape resolve to one
  // name, so they must also emit exactly one declaration.
  const emitted = new Map<string, string>();
  for (const entry of found.values()) {
    const tsName = names.get(`${entry.section}/${entry.name}`)!;
    if (emitted.has(tsName)) continue;
    const isInterface = entry.def.type === "object" && entry.def.properties && !entry.def.enum;
    emitted.set(
      tsName,
      isInterface
        ? `export interface ${tsName} ${renderObject(entry.def, entry.section, names, "")}`
        : `export type ${tsName} = ${tsTypeOf(entry.def, entry.section, names, "")};`,
    );
  }
  const declarations = [...emitted.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, declaration]) => declaration);

  const header = [
    "/**",
    " * GENERATED FILE - DO NOT EDIT.",
    " *",
    ` * Source: herdr API schema, protocol ${schema.protocol}, schema_version ${schema.schema_version}.`,
    " * Regenerate with: bun run generate:types",
    " * Verify freshness with: bun run generate:types --check",
    " */",
    "",
  ].join("\n");

  return `${header}\n${declarations.join("\n\n")}\n`;
}

async function loadSchema(refresh: boolean): Promise<Json> {
  if (refresh) {
    // the same binary the tests and the server use, so a schema can come from a herdr that is not installed
    const herdr = process.env["HERDR_WEB_HERDR_BIN"] || "herdr";
    const proc = Bun.spawn([herdr, "api", "schema", "--json"], { stdout: "pipe", stderr: "pipe" });
    const text = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) throw new Error("herdr api schema --json failed");
    writeFileSync(SCHEMA_PATH, text);
    return JSON.parse(text) as Json;
  }
  if (!existsSync(SCHEMA_PATH)) throw new Error(`schema snapshot missing: ${SCHEMA_PATH}`);
  return JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as Json;
}

const args = process.argv.slice(2);
const check = args.includes("--check");
const schema = await loadSchema(args.includes("--refresh"));
const output = generate(schema);

if (check) {
  const current = existsSync(OUTPUT_PATH) ? readFileSync(OUTPUT_PATH, "utf8") : "";
  if (current !== output) {
    console.error(
      `${OUTPUT_PATH} is STALE relative to ${SCHEMA_PATH}.\nRun: bun run generate:types`,
    );
    process.exit(1);
  }
  console.log("generated types are up to date");
} else {
  writeFileSync(OUTPUT_PATH, output);
  console.log(`wrote ${OUTPUT_PATH}`);
}
