import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearFileCache, paneFiles } from "./files.ts";

const roots: string[] = [];
afterEach(() => {
  clearFileCache();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "files-search-"));
  roots.push(root);
  mkdirSync(join(root, "src", "components"), { recursive: true });
  mkdirSync(join(root, "node_modules", "hidden"), { recursive: true });
  writeFileSync(join(root, "src", "components", "PromptCard.tsx"), "export {};");
  writeFileSync(join(root, "src", "api.ts"), "export {};");
  writeFileSync(join(root, "README.md"), "read me");
  writeFileSync(join(root, "node_modules", "hidden", "prompt.ts"), "hidden");
  return root;
}

describe("paneFiles", () => {
  it("walks a non-git tree, skips heavy directories, and ranks matches", async () => {
    const root = fixture();
    expect(await paneFiles(root, "prompt", 20)).toEqual(["src/components/PromptCard.tsx"]);
    expect(await paneFiles(root, "sat", 20)).toContain("src/api.ts");
    expect(await paneFiles(root, "", 2)).toHaveLength(2);
  });

  it("uses tracked and untracked non-ignored files in a git repository", async () => {
    const root = fixture();
    const init = Bun.spawnSync(["git", "init", "-q", root]);
    expect(init.exitCode).toBe(0);
    writeFileSync(join(root, ".gitignore"), "README.md\n");
    const files = await paneFiles(root, "", 100);
    expect(files).toContain("src/api.ts");
    expect(files).not.toContain("README.md");
  });

  it("clamps the result limit to one through one hundred", async () => {
    const root = fixture();
    expect(await paneFiles(root, "", 0)).toHaveLength(3);
    expect(await paneFiles(root, "", 1)).toHaveLength(1);
  });

  it("preserves Unicode and newline filenames returned by git", async () => {
    const root = fixture();
    expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
    for (const name of ["설계 문서.md", "line\nbreak.txt"]) writeFileSync(join(root, name), "fixture");
    const files = await paneFiles(root, "", 100);
    expect(files).toContain("설계 문서.md");
    expect(files).toContain("line\nbreak.txt");
  });

  it("honors git ignores from a nested working directory", async () => {
    const root = fixture();
    expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
    writeFileSync(join(root, ".gitignore"), "src/secret.txt\n");
    writeFileSync(join(root, "src", "secret.txt"), "private");
    expect(await paneFiles(join(root, "src"), "", 100)).toEqual(["api.ts", "components/PromptCard.tsx"]);
  });
});
