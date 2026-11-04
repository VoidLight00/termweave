import { afterEach, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileDacl, grantEveryoneRead, ownerOnlyDacl } from "./private-file-fixture.ts";
import { writePrivateFile } from "./private-file.ts";

const onWindows = process.platform === "win32";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), "herdr-private-file-")); dirs.push(dir); return dir; };

it("writes a secret whole and owner-only, in a directory it creates", () => {
  const path = join(scratch(), "state", "secret.json");
  writePrivateFile(path, "{\"key\":\"sk-1\"}\n");
  expect(readFileSync(path, "utf8")).toBe("{\"key\":\"sk-1\"}\n");
  if (onWindows) expect(fileDacl(path)).toEqual(ownerOnlyDacl());
  else expect(statSync(path).mode & 0o777).toBe(0o600);
  writePrivateFile(path, "{\"key\":\"sk-2\"}\n");
  expect(readFileSync(path, "utf8")).toBe("{\"key\":\"sk-2\"}\n");
  if (onWindows) expect(fileDacl(path)).toEqual(ownerOnlyDacl());
  else expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readdirSync(join(path, ".."))).toEqual(["secret.json"]);
});

it.skipIf(!onWindows)("drops the ACEs a Windows directory would hand down, and a crashed write's leftover", () => {
  const dir = scratch();
  // a file written plainly here carries every inherited ACE of the directory (Administrators at least)
  writeFileSync(join(dir, "plain.json"), "{}");
  expect(fileDacl(join(dir, "plain.json"))).not.toEqual(ownerOnlyDacl());
  const path = join(dir, "secret.json");
  writeFileSync(`${path}.${process.pid}.tmp`, "stale");
  writePrivateFile(path, "{}");
  expect(fileDacl(path)).toEqual(ownerOnlyDacl());
  expect(readFileSync(path, "utf8")).toBe("{}");
  expect(readdirSync(dir).sort()).toEqual(["plain.json", "secret.json"]);
});

it.skipIf(!onWindows)("creates the temporary file already owner-only and unshared, before any secret byte is written", () => {
  const dir = scratch();
  const path = join(dir, "secret.json");
  const seen: string[] = [];
  writePrivateFile(path, "sk-secret", { created: (temporary) => {
    seen.push(temporary);
    // the DACL exists from CreateFileW on, never inherited, while the file is still empty
    expect(fileDacl(temporary)).toEqual(ownerOnlyDacl());
    expect(statSync(temporary).size).toBe(0);
    // share mode 0: not even this user can open it for reading while the write is under way
    expect(() => readFileSync(temporary)).toThrow();
  } });
  expect(seen).toEqual([`${path}.${process.pid}.tmp`]);
  expect(readFileSync(path, "utf8")).toBe("sk-secret");
  expect(fileDacl(path)).toEqual(ownerOnlyDacl());
  expect(readdirSync(dir)).toEqual(["secret.json"]);
});

it.skipIf(!onWindows)("refuses a temporary file whose DACL is not owner-only, leaving no file and the old secret as it was", () => {
  const dir = scratch();
  const path = join(dir, "secret.json");
  writePrivateFile(path, "old");
  const corrupt = { created: grantEveryoneRead };
  expect(() => writePrivateFile(path, "new", corrupt)).toThrow(/not owner-only/);
  expect(() => writePrivateFile(join(dir, "fresh.json"), "new", corrupt)).toThrow(/not owner-only/);
  expect(readFileSync(path, "utf8")).toBe("old");
  expect(fileDacl(path)).toEqual(ownerOnlyDacl());
  expect(existsSync(join(dir, "fresh.json"))).toBeFalse();
  expect(readdirSync(dir)).toEqual(["secret.json"]);
});

it.skipIf(!onWindows)("deletes a final file whose DACL fails the read-back after the rename", () => {
  const dir = scratch();
  const path = join(dir, "secret.json");
  expect(() => writePrivateFile(path, "new", { renamed: grantEveryoneRead })).toThrow(/not owner-only/);
  expect(readdirSync(dir)).toEqual([]);
});
