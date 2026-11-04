import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OPEN_URL_MAX_CHARS, OpenUrlError, asideExecutable, openInAside, parseOpenUrl } from "./open-url.ts";

describe("parseOpenUrl", () => {
  test("accepts absolute http and https addresses, normalized", () => {
    expect(parseOpenUrl("https://example.com/a?b=1#c")).toBe("https://example.com/a?b=1#c");
    expect(parseOpenUrl("http://localhost:5173")).toBe("http://localhost:5173/");
    expect(parseOpenUrl("HTTPS://Example.com/x y")).toBe("https://example.com/x%20y");
  });

  test.each([
    ["javascript:", "javascript:alert(1)"],
    ["file:", "file:///C:/Windows/System32/calc.exe"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["a relative path", "/api/session"],
    ["a bare host", "example.com"],
    ["an empty string", ""],
  ])("refuses %s", (_label, url) => {
    expect(() => parseOpenUrl(url)).toThrow(OpenUrlError);
  });

  test.each([[undefined], [null], [42], [{ url: "https://example.com" }], [["https://example.com"]]])("refuses the non-string %p", (value) => {
    expect(() => parseOpenUrl(value)).toThrow(OpenUrlError);
  });

  test("refuses an address over the limit and accepts one at it", () => {
    const base = "https://example.com/";
    expect(parseOpenUrl(base + "a".repeat(OPEN_URL_MAX_CHARS - base.length))).toHaveLength(OPEN_URL_MAX_CHARS);
    expect(() => parseOpenUrl(base + "a".repeat(OPEN_URL_MAX_CHARS - base.length + 1))).toThrow(OpenUrlError);
  });

  test("refuses an address that grows over the limit once encoded", () => {
    const base = "https://example.com/";
    // each space inside the path becomes %20: three characters for one
    expect(() => parseOpenUrl(base + "a ".repeat((OPEN_URL_MAX_CHARS - base.length) / 2))).toThrow(OpenUrlError);
  });
});

test("openInAside rejects when the browser cannot start, instead of reporting success", async () => {
  await expect(openInAside(join(tmpdir(), "termweave-no-such-dir", "Aside.exe"), "https://example.com/")).rejects.toThrow();
});

describe("asideExecutable", () => {
  const env = { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" };
  const machine = "C:\\Program Files\\Aside\\Application\\Aside.exe";
  const x86 = "C:\\Program Files (x86)\\Aside\\Application\\Aside.exe";
  const user = "C:\\Users\\me\\AppData\\Local\\Aside\\Application\\Aside.exe";

  test("prefers the per-machine install", () => {
    expect(asideExecutable(env, () => true, "win32")).toBe(machine);
  });

  test("falls through to the x86 and then the per-user install", () => {
    expect(asideExecutable(env, (path) => path === x86 || path === user, "win32")).toBe(x86);
    expect(asideExecutable(env, (path) => path === user, "win32")).toBe(user);
  });

  test("skips a root the environment does not name", () => {
    const seen: string[] = [];
    expect(asideExecutable({ LOCALAPPDATA: env.LOCALAPPDATA }, (path) => { seen.push(path); return true; }, "win32")).toBe(user);
    expect(seen).toEqual([user]);
  });

  test("is null when Aside is not installed", () => {
    expect(asideExecutable(env, () => false, "win32")).toBeNull();
  });

  test("is null off Windows, without looking", () => {
    expect(asideExecutable(env, () => { throw new Error("looked"); }, "linux")).toBeNull();
    expect(asideExecutable(env, () => { throw new Error("looked"); }, "darwin")).toBeNull();
  });
});
