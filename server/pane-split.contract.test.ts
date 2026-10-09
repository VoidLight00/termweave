import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { workspaceCreate, workspaceClose, sessionSnapshot } from "./herdr/client.ts";
import { DeviceStore } from "./devices.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-add-test-"));
let server: ReturnType<typeof createServer>;
let workspace: string;
let source: string;
let other: string;
let watchToken: string;
const testToken = "isolated-add-terminal-test";
beforeAll(async () => {
  const created = await workspaceCreate({ cwd: root, label: "add-test-owned" });
  workspace = created.workspace.workspace_id; source = created.root_pane.pane_id;
  other = (await workspaceCreate({ cwd: root, label: "add-test-other" })).workspace.workspace_id;
  const devices = new DeviceStore(root);
  watchToken = devices.pair(devices.startPairing().code, "isolated watcher", "watch")!.token;
  server = createServer({ port: 0, hostname: "127.0.0.1", stateDir: root, token: testToken });
});
afterAll(async () => {
  server?.stop();
  await workspaceClose(workspace); await workspaceClose(other);
  rmSync(root, { recursive: true, force: true });
});
const request = (body: unknown, extra: Record<string, string> = {}, route = "/api/pane/split") => fetch(`http://localhost:${server.port}${route}`, {
  method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${testToken}`, ...extra }, body: JSON.stringify(body),
});
test("creates a distinct real shell in same workspace and tab, with source cwd", async () => {
  const before = await sessionSnapshot();
  const old = before.panes.find(pane => pane.pane_id === source)!;
  const response = await request({ pane_id: source, workspace_id: workspace });
  expect(response.status).toBe(200);
  const created = await response.json();
  const after = await sessionSnapshot();
  const pane = after.panes.find(pane => pane.pane_id === created.pane_id)!;
  expect(pane.pane_id).not.toBe(source);
  expect(pane.workspace_id).toBe(workspace);
  expect(pane.tab_id).toBe(old.tab_id);
  expect(pane.cwd).toBe(old.foreground_cwd ?? old.cwd);
  expect(after.workspaces.length).toBe(before.workspaces.length);
});
test("rejects absent auth, watcher role and cross-origin", async () => {
  const body = { pane_id: source, workspace_id: workspace };
  expect((await request(body, { Authorization: "" })).status).toBe(401);
  expect((await request(body, { Authorization: "", Cookie: `termweave_device=${watchToken}` })).status).toBe(403);
  expect((await request(body, { Origin: "https://untrusted.invalid" })).status).toBe(403);
});
test("rejects workspace mismatch, stale pane, caller cwd and malformed body", async () => {
  expect((await request({ pane_id: source, workspace_id: other })).status).toBe(400);
  expect((await request({ pane_id: "missing", workspace_id: workspace })).status).toBe(404);
  expect((await request({ pane_id: source, workspace_id: workspace, cwd: "/tmp" })).status).toBe(400);
  expect((await request(null)).status).toBe(400);
});
test("unknown remote scope never falls back to local creation", async () => {
  const before = await sessionSnapshot();
  const response = await request({ pane_id: source, workspace_id: workspace }, { "x-herdr-machine": "1" }, "/api/machines/missing-machine/pane/split");
  expect(response.status).toBe(404);
  expect((await sessionSnapshot()).panes.length).toBe(before.panes.length);
});
