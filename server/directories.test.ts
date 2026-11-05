import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { createProjectDirectory, listDirectories, MAX_DIRECTORY_ENTRIES } from "./directories.ts";

describe("listDirectories", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  const temp = () => { const root = mkdtempSync(join(tmpdir(), "herdr-dirs-")); roots.push(root); return root; };

  it("creates one empty project folder and refuses collisions or unsafe names", () => {
    const root = temp();
    const result = createProjectDirectory(root, "새 프로젝트");
    expect(result).toEqual({ path: join(root, "새 프로젝트") });
    expect(listDirectories(join(root, "새 프로젝트"))?.directories).toEqual([]);
    expect(createProjectDirectory(root, "새 프로젝트")).toEqual({ error: "folder_exists" });
    writeFileSync(join(root, "file"), "preserve");
    expect(createProjectDirectory(root, "file")).toEqual({ error: "folder_exists" });
    for (const name of ["", " ", ".", "..", "../escape", "/escape", "a/b", "a\\b", "a\x00b", "CON", "nul.txt", "end.", " space", "가".repeat(86)]) {
      expect(createProjectDirectory(root, name)).toEqual({ error: "invalid_folder_name" });
    }
    expect(createProjectDirectory(join(root, "missing"), "child")).toEqual({ error: "invalid_cwd" });
    expect(createProjectDirectory(null, "child")).toEqual({ error: "invalid_cwd" });
    expect(createProjectDirectory(root, {})).toEqual({ error: "invalid_folder_name" });
  });

  it("lists folders only, sorted naturally, with links to folders and without hidden ones", () => {
    const root = temp();
    for (const name of ["web", "api10", "api2", ".git", "Docs"]) mkdirSync(join(root, name));
    writeFileSync(join(root, "README.md"), "");
    symlinkSync(join(root, "web"), join(root, "web-link"));
    symlinkSync(join(root, "missing"), join(root, "dangling"));
    const listing = listDirectories(root)!;
    expect(listing.directories).toEqual(["api2", "api10", "Docs", "web", "web-link"]);
    expect(listing.path).toBe(root);
    expect(listing.parent).toBe(tmpdir());
    expect(listing.truncated).toBe(false);
    expect(listDirectories(root, true)!.directories).toContain(".git");
  });

  it("reads ~ and an empty path as home, and has no parent at the root", () => {
    expect(listDirectories("")!.path).toBe(homedir());
    expect(listDirectories("~")!.path).toBe(homedir());
    expect(listDirectories("/")!.parent).toBeNull();
  });

  it("answers null for a file or a missing path, and stops at the cap", () => {
    const root = temp();
    writeFileSync(join(root, "file"), "");
    expect(listDirectories(join(root, "file"))).toBeNull();
    expect(listDirectories(join(root, "nope"))).toBeNull();
    for (let n = 0; n <= MAX_DIRECTORY_ENTRIES; n++) mkdirSync(join(root, `d${n}`));
    const listing = listDirectories(root)!;
    expect(listing.directories).toHaveLength(MAX_DIRECTORY_ENTRIES);
    expect(listing.truncated).toBe(true);
  });
});
