import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceColors, isWorkspaceColor } from "./workspace-colors.ts";

test("colors survive a restart and replace the file in place (Windows rename over an existing file)", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "tw-colors-")), "state");
  const first = new WorkspaceColors(dir);
  first.set("w1", "#ff0000");
  first.set("w2", "blue");
  first.set("w1", null);
  expect(new WorkspaceColors(dir).all()).toEqual({ w2: "blue" });
});

test("a broken or hostile file loads as no colors", () => {
  const dir = mkdtempSync(join(tmpdir(), "tw-colors-"));
  writeFileSync(join(dir, "workspace-colors.json"), '{"w1":"url(x)","w2":"#00ff00"}');
  expect(new WorkspaceColors(dir).all()).toEqual({ w2: "#00ff00" });
  writeFileSync(join(dir, "workspace-colors.json"), "not json");
  expect(new WorkspaceColors(dir).all()).toEqual({});
  expect([isWorkspaceColor("#ABCDEF"), isWorkspaceColor("red"), isWorkspaceColor(null)]).toEqual([false, false, false]);
});
