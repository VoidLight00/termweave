import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const stylesheets = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? stylesheets(join(dir, entry.name)) : entry.name.endsWith(".css") ? [join(dir, entry.name)] : []);

/** The endless `animation` declarations that are not stepped, whole and on one line. */
function smoothEndless(css: string): string[] {
  return css.replace(/\/\*[\s\S]*?\*\//g, "").split(/[;{}]/).map((declaration) => declaration.replace(/\s+/g, " ").trim())
    .filter((declaration) => /^animation\s*:/.test(declaration) && /\binfinite\b/.test(declaration)
      && !/steps\(|var\(--ease-pulse\)/.test(declaration) && !/bridge-progress-slide/.test(declaration));
}

describe("motion", () => {
  // A smooth endless animation has the browser draw a frame at every display refresh while it
  // runs (an agent works for minutes), which stutters a video playing next to the app. An endless
  // one jumps between steps instead; only the bridge install's progress bar, shown while it
  // installs, slides.
  it("runs no endless animation smoothly, apart from the bridge install's progress bar", () => {
    expect(stylesheets(import.meta.dir).flatMap((file) =>
      smoothEndless(readFileSync(file, "utf8")).map((declaration) => `${file.slice(import.meta.dir.length + 1)}: ${declaration}`))).toEqual([]);
  });

  it("reads a declaration whole, however it is split across lines", () => {
    expect(smoothEndless(".a {\n  animation: pulse 1.6s\n    ease-in-out\n    infinite;\n}")).toEqual(["animation: pulse 1.6s ease-in-out infinite"]);
    expect(smoothEndless(".a { animation:\n  pulse var(--dur-pulse) var(--ease-pulse)\n  infinite }")).toEqual([]);
    expect(smoothEndless("/* animation: pulse 1s infinite; */ .a { animation: fade 1s; }")).toEqual([]);
  });
});
