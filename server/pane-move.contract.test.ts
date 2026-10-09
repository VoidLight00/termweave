import { expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { DeviceStore } from "./devices.ts";
import { herdrRpc, paneSendKeys, paneSendText, sessionSnapshot, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { moveRequest, type PaneMoveResult } from "../shared/paneMove.ts";

it("moves the real PTY across workspaces and tabs without replacing its running process", async () => {
  if (process.env.HERDR_TEST_LIVE === "1" || !process.env.HERDR_SOCKET?.includes("sessions/")) throw new Error("An isolated named herdr test session is required");
  const root = mkdtempSync(join(tmpdir(), "herdr-native-move-"));
  const source = await workspaceCreate({ cwd: root, label: "native-move-owned-source" });
  const target = await workspaceCreate({ cwd: root, label: "native-move-owned-target" });
  const bridge = createServer({ port: 0, stateDir: join(root, "app"), token: "owned-test-token" });
  const url = `http://127.0.0.1:${bridge.port}`;
  const post = (body: unknown, headers: Record<string, string> = { authorization: "Bearer owned-test-token" }, path = "/api/pane/move") => fetch(`${url}${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  const marker = join(root, "process.json");
  try {
    // exec replaces only our test shell with a long-running heartbeat process before the move.
    const code = `const fs=require('fs');let n=0;setInterval(()=>fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,cwd:process.cwd(),n:++n})),40)`;
    await paneSendText(source.root_pane.pane_id, `exec ${Bun.which("node")!} -e '${code.replaceAll("'", "'\\''")}'`);
    await paneSendKeys(source.root_pane.pane_id, ["Enter"]);
    const readMarker = async () => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try { return JSON.parse(readFileSync(marker, "utf8")) as { pid: number; cwd: string; n: number }; } catch { await Bun.sleep(30); }
      }
      throw new Error("Owned process did not start");
    };
    const before = await readMarker();
    const initial = await sessionSnapshot();
    const original = initial.panes.find(pane => pane.pane_id === source.root_pane.pane_id)!;
    const destination = initial.panes.find(pane => pane.pane_id === target.root_pane.pane_id)!;
    const request = moveRequest(original, destination);
    expect((await post(request, {})).status).toBe(401);
    expect((await post(request, { authorization: "Bearer owned-test-token", origin: "https://other.invalid" })).status).toBe(403);
    expect((await post({ ...request, target_workspace_id: "stale" })).status).toBe(409);
    expect((await post({ ...request, terminal_id: "stale" })).status).toBe(409);
    expect((await post({ ...request, machine_id: "other" })).status).toBe(400);
    const response = await post(request, { authorization: "Bearer owned-test-token", "x-herdr-machine": "1" }, "/api/machines/local/pane/move");
    expect(response.status).toBe(200);
    const moved = await response.json() as PaneMoveResult;
    expect(moved.changed).toBe(true);
    expect(moved.previous_pane_id).toBe(original.pane_id);
    expect(moved.pane.pane_id).not.toBe(original.pane_id);
    expect(moved.pane.terminal_id).toBe(original.terminal_id);
    expect(moved.pane.workspace_id).toBe(destination.workspace_id);
    expect(moved.pane.cwd).toBe(original.cwd);
    expect((await sessionSnapshot()).panes.find(pane => pane.terminal_id === original.terminal_id)?.pane_id).toBe(moved.pane.pane_id);
    const next = await herdrRpc<{ root_pane: typeof original }>("tab.create", { workspace_id: destination.workspace_id, focus: false });
    const sameWorkspace = await post(moveRequest(moved.pane, next.root_pane));
    expect(sameWorkspace.status).toBe(200);
    const retabbed = await sameWorkspace.json() as PaneMoveResult;
    expect(retabbed.changed).toBe(true);
    expect(retabbed.pane.terminal_id).toBe(original.terminal_id);
    expect(retabbed.pane.tab_id).toBe(next.root_pane.tab_id);
    expect(retabbed.pane.cwd).toBe(original.cwd);
    await Bun.sleep(160);
    const after = await readMarker();
    expect(after.pid).toBe(before.pid);
    expect(after.cwd).toBe(before.cwd);
    expect(after.n).toBeGreaterThan(before.n);
    process.kill(before.pid, 0);
  } finally {
    bridge.stop();
    for (const id of [source.workspace.workspace_id, target.workspace.workspace_id]) {
      if ((await sessionSnapshot()).workspaces.some(workspace => workspace.workspace_id === id)) await workspaceClose(id);
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);

it("watch devices cannot move local or remote panes", async () => {
  const state = mkdtempSync(join(tmpdir(), "herdr-move-watch-"));
  const store = new DeviceStore(state);
  const paired = store.pair(store.startPairing().code, "owned-watch-test", "watch")!;
  const server = createServer({ port: 0, stateDir: state, tailscaleOwner: null });
  try {
    for (const path of ["/api/pane/move", "/api/machines/local/pane/move", "/api/machines/remote/pane/move"]) {
      const response = await fetch(`http://127.0.0.1:${server.port}${path}`, { method: "POST", headers: {
        cookie: `termweave_device=${paired.token}`, "x-forwarded-for": "203.0.113.5", "x-herdr-machine": "1", "content-type": "application/json",
      }, body: "{}" });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "read_only" } });
    }
  } finally { server.stop(); rmSync(state, { recursive: true, force: true }); }
});
