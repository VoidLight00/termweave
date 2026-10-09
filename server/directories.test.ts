import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { listDirectories, MAX_DIRECTORY_ENTRIES } from "./directories.ts";

describe("listDirectories", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  const temp = () => { const root = mkdtempSync(join(tmpdir(), "herdr-dirs-")); roots.push(root); return root; };

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
