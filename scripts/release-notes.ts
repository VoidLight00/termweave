import { readFileSync } from "node:fs";

/** Fail before publishing a tag: all three version sources and nonempty notes must agree. */
export function releaseNotes(version: string, packageVersion: string, manifest: string, changelog: string): string {
  if (version !== version.trim() || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error("Expected version X.Y.Z without v");
  if (packageVersion !== version) throw new Error("package.json version does not match");
  if (!manifest.split(/\r?\n/).some((line) => line === `version = "${version}"`)) throw new Error("herdr-plugin.toml version does not match");
  const sections = changelog.split(/^## /m).slice(1);
  const matching = sections.filter((section) => section.startsWith(`[${version}]`) && /^(?:\s|$)/.test(section.slice(version.length + 2)));
  if (matching.length !== 1) throw new Error("CHANGELOG.md must contain exactly one heading for this version");
  const notes = matching[0]!.split("\n").slice(1).filter((line) => !/^\[[^\]]+\]: /.test(line)).join("\n").trim();
  if (!notes) throw new Error("Release notes are empty");
  return notes;
}

if (import.meta.main) {
  console.log(releaseNotes(process.argv[2] ?? "", JSON.parse(readFileSync("package.json", "utf8")).version,
    readFileSync("herdr-plugin.toml", "utf8"), readFileSync("CHANGELOG.md", "utf8")));
}
