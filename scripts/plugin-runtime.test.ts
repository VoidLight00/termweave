import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activePluginScript } from "./plugin-runtime.ts";
import { updateStateDir } from "../server/update-state.ts";

let root: string, state: string, updates: string, revision: string, release: string;
beforeEach(() => {
  // the active release comes back canonical; macOS's tmpdir is a symlink into /private
  root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-plugin-runtime-")));
  state = join(root, "state");
  Bun.spawnSync(["git", "init", "-q", root], { windowsHide: true });
  Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "--allow-empty", "-m", "fixture"], { cwd: root, windowsHide: true });
  revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root, windowsHide: true }).stdout.toString().trim();
  updates = updateStateDir(root, 7317, state);
  release = join(updates, "release-test");
  mkdirSync(join(release, "scripts"), { recursive: true });
  writeFileSync(join(release, "scripts", "plugin.ts"), "");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function save(source_revision = revision, directory = release) {
  writeFileSync(join(updates, "current.json"), JSON.stringify({ source_revision, directory }));
}

it("follows only this checkout and port's active release", () => {
  save();
  expect(activePluginScript(root, 7317, state)).toBe(join(release, "scripts", "plugin.ts"));
  expect(activePluginScript(root, 7318, state)).toBe(join(root, "scripts", "plugin.ts"));
  save("old-revision");
  expect(activePluginScript(root, 7317, state)).toBe(join(root, "scripts", "plugin.ts"));
});

it("falls back for a missing, malformed or escaped release", () => {
  expect(activePluginScript(root, 7317, state)).toBe(join(root, "scripts", "plugin.ts"));
  writeFileSync(join(updates, "current.json"), "broken");
  expect(activePluginScript(root, 7317, state)).toBe(join(root, "scripts", "plugin.ts"));
  save(revision, root);
  expect(activePluginScript(root, 7317, state)).toBe(join(root, "scripts", "plugin.ts"));
  save(); rmSync(join(release, "scripts", "plugin.ts"));
  expect(activePluginScript(root, 7317, state)).toBe(join(root, "scripts", "plugin.ts"));
});
