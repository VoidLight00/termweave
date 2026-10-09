import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStructureFrame } from "./collector.ts";
import { createPaneMesh } from "./pane-mesh.ts";
import { herdrRpc, paneRead, paneRename, paneSendKeys, paneSendText, sessionSnapshot, subscribeEvents, workspaceClose, workspaceCreate, type Subscription } from "./herdr/client.ts";

/** The isolated test herdr (scripts/test-herdr.ts): its own workspaces, never the user's. */
const root = mkdtempSync(join(tmpdir(), "pane-mesh-"));
const hook = join(import.meta.dir, "..", "scripts", "hooks", "pane-mesh-roster.sh");
const workspaces: string[] = [];
let subscription: Subscription | undefined;
let rootA = "";
let rootB = "";
let workspaceA = "";
let workspaceB = "";

async function until<T>(what: string, read: () => Promise<T | null | false | undefined>): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}
const labelOf = async (paneId: string) => (await sessionSnapshot()).panes.find((pane) => pane.pane_id === paneId)?.label ?? null;
const labelsNow = async () => new Map((await sessionSnapshot()).panes.map((pane) => [pane.pane_id, pane.label ?? null]));
const split = async (workspaceId: string, from: string) =>
  (await herdrRpc<{ pane: { pane_id: string } }>("pane.split", { target_pane_id: from, workspace_id: workspaceId, direction: "right", cwd: root, focus: false })).pane.pane_id;

beforeAll(async () => {
  const a = await workspaceCreate({ cwd: root, label: "mesh-a" });
  const b = await workspaceCreate({ cwd: root, label: "mesh-b" });
  workspaces.push(a.workspace.workspace_id, b.workspace.workspace_id);
  [workspaceA, rootA, workspaceB, rootB] = [a.workspace.workspace_id, a.root_pane.pane_id, b.workspace.workspace_id, b.root_pane.pane_id];
  const mesh = createPaneMesh({ snapshot: sessionSnapshot, rename: (paneId, label) => paneRename(paneId, label), enabled: () => true });
  // what server/collector.ts hands server/index.ts: the pane a pane_created frame names
  await new Promise<void>((started) => {
    subscription = subscribeEvents([{ type: "pane.created" }], {
      onEvent: (frame) => { const parsed = parseStructureFrame(frame); if (parsed?.kind === "structure-changed" && parsed.created) void mesh.onPaneCreated(parsed.created); },
      onStarted: started,
    });
  });
});
afterAll(async () => {
  subscription?.close();
  for (const workspace of workspaces) await workspaceClose(workspace).catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

let a1 = "";
let a2 = "";
let a3 = "";

test("names panes opened after it started, per workspace, and leaves the ones that were there", async () => {
  const before = await labelsNow();
  a1 = await split(workspaceA, rootA);
  a2 = await split(workspaceA, rootA);
  const b1 = await split(workspaceB, rootB);
  await until("three names", async () => (await labelOf(a1)) === "pane 1" && (await labelOf(a2)) === "pane 2" && (await labelOf(b1)) === "pane 1");
  const after = await labelsNow();
  for (const [paneId, label] of before) expect(after.get(paneId)).toBe(label);
});

test("a name someone chose stays, and its number is free for the next terminal", async () => {
  await paneRename(a1, "build");
  a3 = await split(workspaceA, rootA);
  await until("the next name", async () => (await labelOf(a3)) === "pane 1");
  expect(await labelOf(a1)).toBe("build");
});

test("an agent started in a pane is told the panes beside it, and only those", async () => {
  await paneSendText(a2, `bash '${hook}'; echo MESH_END`);
  await paneSendKeys(a2, ["Enter"]);
  const text = await until("the roster", async () => {
    const read = await paneRead({ paneId: a2, source: "recent_unwrapped", lines: 60 });
    return read.text.split("\n").some((line) => line.trim() === "MESH_END") ? read.text : null;
  });
  expect(text).toContain(`[pane mesh] You are pane 2 (${a2}). Panes beside you in this workspace:`);
  expect(text).toContain(`- build (${a1}): shell,`);
  expect(text).toContain(`- pane 1 (${a3}): shell,`);
  expect(text).toContain(`- ${rootA}: shell,`);
  expect(text).not.toContain(rootB);
  expect(text).toContain("herdr pane read <pane_id>");
});
