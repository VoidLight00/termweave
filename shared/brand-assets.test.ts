import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("installable brand icon files match the manifest dimensions", () => {
  const root = resolve(import.meta.dir, "../public");
  const manifest = JSON.parse(readFileSync(resolve(root, "manifest.webmanifest"), "utf8"));
  expect(manifest.name).toBe("TermWeave");
  expect(manifest.icons.some((icon: { purpose: string }) => icon.purpose === "maskable")).toBe(true);
  for (const icon of manifest.icons) {
    expect(icon.src).toMatch(/^\/icons\/termweave-v2-[a-z0-9-]+\.png$/);
    const data = readFileSync(resolve(root, icon.src.slice(1)));
    expect(data.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(`${data.readUInt32BE(16)}x${data.readUInt32BE(20)}`).toBe(icon.sizes);
  }
});
