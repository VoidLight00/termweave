import { describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The generated herdr wire types must never silently drift from the schema they
 * were derived from. These tests are the gate that turns drift into a red build.
 */

const ROOT = join(import.meta.dir, "..");
const GENERATOR = join(ROOT, "scripts", "generate-protocol-types.ts");
const GENERATED = join(ROOT, "shared", "herdr-api.generated.ts");

async function runGenerator(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", GENERATOR, ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

describe("generate-protocol-types --check", () => {
  it("passes when the committed output matches the committed schema", async () => {
    const result = await runGenerator(["--check"]);
    expect(result.stderr + result.stdout).not.toContain("Cannot find module");
    expect(result.exitCode).toBe(0);
  });

  it("fails loudly when the generated file has drifted", async () => {
    const original = readFileSync(GENERATED, "utf8");
    try {
      writeFileSync(GENERATED, `${original}\nexport type DriftSentinel = "stale";\n`);
      const result = await runGenerator(["--check"]);
      expect(result.exitCode).not.toBe(0);
      expect((result.stdout + result.stderr).toLowerCase()).toContain("stale");
    } finally {
      writeFileSync(GENERATED, original);
    }
    // the repo is left exactly as it was found
    expect(readFileSync(GENERATED, "utf8")).toBe(original);
  });

  it("is deterministic: regenerating produces a byte-identical file", async () => {
    const before = readFileSync(GENERATED, "utf8");
    const result = await runGenerator([]);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(GENERATED, "utf8")).toBe(before);
  });
});

describe("generated types", () => {
  it("spells ReadSource the way the JSON API accepts it", async () => {
    // The CLI flag is --source recent-unwrapped, but the JSON API rejects that
    // hyphenated spelling with invalid_request and demands recent_unwrapped.
    // A hand-written type carried the CLI spelling; generating from the schema is
    // what keeps the two from being confused again.
    const source = readFileSync(GENERATED, "utf8");
    expect(source).toContain("recent_unwrapped");
    expect(source).not.toContain("recent-unwrapped");
  });

  it("widens string enums so an unknown herdr value still decodes", async () => {
    const source = readFileSync(GENERATED, "utf8");
    expect(source).toContain("(string & {})");
  });
});
