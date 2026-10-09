import { processOpenFiles } from "./process-files.ts";
import { afterAll, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herdrRpc, sessionSnapshot, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { labelOmoPanes } from "./conversation.ts";
import { isOmoProcess, omoSessionForPane, omoTranscriptForPane } from "./omo.ts";
import { createServer } from "./index.ts";
import type { ConversationResponse } from "../shared/protocol.ts";
import { startShellAgent } from "./shell-agent.ts";
import { processStartedAt } from "./process-start.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-omo-binding-"));
const workspaces: string[] = [];
const script = join(root, "omo");
writeFileSync(script, "setInterval(() => {}, 1000);\n");
const dir = join(root, ".omo", "agent", "sessions", `-${root.replaceAll("/", "-")}--`);
mkdirSync(dir, { recursive: true });
afterAll(async () => {
  for (const id of workspaces) await workspaceClose(id);
  rmSync(root, { recursive: true, force: true });
});

async function pane(id?: string): Promise<string> {
  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-omo-binding" });
  workspaces.push(created.workspace.workspace_id);
  const paneId = created.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: paneId, text: `${process.execPath} ${script}${id ? ` --session-id ${id}` : ""}\n` });
  for (let attempt = 0; attempt < 100; attempt++) {
    const info = await herdrRpc<{ process_info?: { foreground_processes?: { argv?: string[] }[] } }>("pane.process_info", { pane_id: paneId });
    // the stand-in itself, by its path: the shell's own startup processes come and go before it
    if (info.process_info?.foreground_processes?.some((process) => process.argv?.includes(script))) return paneId;
    await Bun.sleep(50);
  }
  throw new Error("test omo process did not start");
}
const read = async (paneId: string) => omoTranscriptForPane(paneId, root, (await sessionSnapshot()).panes, root);
const session = (id: string, timestamp = new Date().toISOString()) => {
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, JSON.stringify({ type: "session", id, cwd: root, timestamp }) + "\n");
  return path;
};

it("labels a running omo pane when herdr supplies no agent kind", async () => {
  const paneId = await pane();
  const snapshot = await sessionSnapshot();
  try {
    expect(snapshot.panes.find((entry) => entry.pane_id === paneId)?.agent).toBeUndefined();

    const labelled = await labelOmoPanes(snapshot);

    expect(labelled.panes.find((entry) => entry.pane_id === paneId)?.agent).toBe("omo");
    expect(snapshot.panes.find((entry) => entry.pane_id === paneId)?.agent).toBeUndefined();
  } finally {
    const workspaceId = workspaces.pop();
    if (workspaceId) await workspaceClose(workspaceId);
  }
});

it("leaves a shell labelled OmO DAG without an agent kind", async () => {
  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-omo-shell" });
  workspaces.push(created.workspace.workspace_id);
  const paneId = created.root_pane.pane_id;
  const snapshot = await sessionSnapshot();
  const titled = { ...snapshot, panes: snapshot.panes.map((entry) =>
    entry.pane_id === paneId ? { ...entry, terminal_title: "OmO DAG" } : entry) };

  try {
    const labelled = await labelOmoPanes(titled);

    expect(labelled.panes.find((entry) => entry.pane_id === paneId)?.agent).toBeUndefined();
  } finally {
    workspaces.pop();
    await workspaceClose(created.workspace.workspace_id);
  }
});

it("uses live process evidence and stops cwd inference as soon as a second omo shares it", async () => {
  const first = await pane();
  const fresh = session("fresh-session");
  expect(await read(first)).toBe(fresh);
  const resumed = session("resumed-session", "2020-01-01T00:00:00Z");
  const second = await pane("resumed-session");
  expect(await read(first)).toBeNull();
  expect(await read(second)).toBe(resumed);
  const duplicate = await pane("resumed-session");
  expect(await read(second)).toBeNull();
  expect(await read(duplicate)).toBeNull();
});

it("starts omo through the pane's shell and waits until omo is its foreground process", async () => {
  const shell = async () => {
    const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-omo-start" });
    workspaces.push(created.workspace.workspace_id);
    return created.root_pane.pane_id;
  };
  const started = await shell();
  await startShellAgent("omo", started, ["it's one arg"], { command: `${process.execPath} ${script}` });
  const info = await herdrRpc<{ process_info?: { foreground_processes?: { argv?: string[] }[] } }>("pane.process_info", { pane_id: started });
  expect(info.process_info?.foreground_processes?.find((process) => isOmoProcess(process.argv ?? []))?.argv?.slice(-1)).toEqual(["it's one arg"]);
  // a command that never becomes omo fails at the deadline instead of reporting a start
  await expect(startShellAgent("omo", await shell(), [], { command: "true", timeoutMs: 1500 })).rejects.toThrow("omo did not start");
});

// omo keeps no descriptor on its session file; it publishes a holder record instead
const hold = async (paneId: string, id: string) => {
  const info = await herdrRpc<{ process_info?: { foreground_processes?: { pid: number; argv?: string[] }[] } }>("pane.process_info", { pane_id: paneId });
  const pid = info.process_info!.foreground_processes!.find((process) => isOmoProcess(process.argv ?? []))!.pid;
  const holders = join(dir, "session-holders", encodeURIComponent(id));
  mkdirSync(holders, { recursive: true });
  writeFileSync(join(holders, `${pid}.json`), JSON.stringify({ pid, bootAtMs: 0, processStartedAtMs: Math.floor(processStartedAt(pid)! / 1000) * 1000, cwd: root }));
};

it("binds each omo pane in a shared cwd to the session its process holds", async () => {
  const first = await pane();
  const second = await pane();
  const afterNew = await pane("launch-session");
  const reportedBefore = await pane();
  const resumed = session("held-resumed", "2020-01-01T00:00:00Z");
  const fresh = session("held-fresh");
  session("launch-session");
  const replaced = session("held-after-new");
  const reported = session("herdr-reported");
  const heldSinceReport = session("held-since-report");
  await hold(first, "held-resumed");
  await hold(second, "held-fresh");
  await hold(afterNew, "held-after-new");
  await hold(reportedBefore, "held-since-report");
  expect(await read(first)).toBe(resumed);
  expect(await read(second)).toBe(fresh);
  expect(await read(afterNew)).toBe(replaced);
  // herdr still names the session this pane had before /new
  const panes = (await sessionSnapshot()).panes.map((entry) =>
    entry.pane_id === reportedBefore ? { ...entry, agent_session: { agent: "omo", kind: "path", source: "herdr:omo", value: reported } } : entry);
  expect(await omoTranscriptForPane(reportedBefore, root, panes, root)).toBe(heldSinceReport);
});
it("tells a held session omo has not written yet from an older one", async () => {
  // omo writes the file with the first prompt; a launch id can name the session before /new
  const started = await pane();
  const afterNew = await pane("launched-before-new");
  session("launched-before-new");
  await hold(started, "unwritten-first");
  await hold(afterNew, "unwritten-after-new");
  // a file whose name only contains the held id is another session's
  writeFileSync(join(dir, "unwritten-first-copy.jsonl"), JSON.stringify({ type: "session", id: "copied", cwd: root, timestamp: new Date().toISOString() }) + "\n");
  const panes = (await sessionSnapshot()).panes;
  expect(await omoSessionForPane(started, root, panes, root)).toEqual({ path: null, pending: "unwritten-first" });
  expect(await omoSessionForPane(afterNew, root, panes, root)).toEqual({ path: null, pending: "unwritten-after-new" });
  const written = session("unwritten-first");
  expect(await omoSessionForPane(started, root, panes, root)).toEqual({ path: realpathSync(written), pending: null });
});

it("serves a held omo session as an empty conversation until its file is written", async () => {
  const paneId = await pane();
  await hold(paneId, "unwritten-http");
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "server-state"), machines: false });
  const home = process.env["HOME"];
  // the conversation route reads omo's store under HOME
  process.env["HOME"] = root;
  const read = (query = "") => fetch(`http://127.0.0.1:${server.port}/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}${query}`);
  try {
    const pending = await read();
    expect(pending.status).toBe(200);
    expect(await pending.json()).toEqual({ source: "omo-transcript", turns: [], metadata: { model: null, reasoning_effort: null }, cursor: null, history_id: "unwritten:unwritten-http" });
    // a cursor from the conversation before /new has no page here
    expect((await read("&before=stale:0")).status).toBe(409);
    writeFileSync(join(dir, "2026-10-03T00-00-00-000Z_unwritten-http.jsonl"), [
      { type: "session", id: "unwritten-http", cwd: root, timestamp: new Date().toISOString() },
      { type: "message", id: "u1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "first message" }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const written = await (await read()).json() as ConversationResponse;
    expect(written.source).toBe("omo-transcript");
    expect(written.history_id).not.toBe("unwritten:unwritten-http");
    expect(written.turns.map((turn) => turn.role)).toEqual(["user"]);
  } finally {
    process.env["HOME"] = home;
    server.stop();
  }
});

it("ignores the background task logs omo holds open outside its session store", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "herdr-omo-task-log-"));
  const store = join(cwd, ".omo", "agent", "sessions", `-${cwd.replaceAll("/", "-")}--`);
  const logs = join(cwd, ".omo", "senpi-task", "logs");
  mkdirSync(store, { recursive: true });
  mkdirSync(logs, { recursive: true });
  // a stand-in omo that holds a task log open, as omo does while a background task runs
  const holder = join(cwd, "omo");
  writeFileSync(holder, "require('node:fs').openSync(process.argv[2], 'a');\nsetInterval(() => {}, 1000);\n");
  const created = await workspaceCreate({ cwd, label: "herdr-web-ui-test-omo-task-log" });
  try {
    const paneId = created.root_pane.pane_id;
    await herdrRpc("pane.send_text", { pane_id: paneId, text: `${process.execPath} ${holder} ${join(logs, "st_task.jsonl")}\n` });
    let held = false;
    for (let attempt = 0; attempt < 100 && !held; attempt++) {
      const info = await herdrRpc<{ process_info?: { foreground_processes?: { pid: number; argv?: string[] }[] } }>("pane.process_info", { pane_id: paneId });
      const omo = info.process_info?.foreground_processes?.find((process) => isOmoProcess(process.argv ?? []));
      if (omo) held = processOpenFiles(omo.pid).some(path => path.endsWith("st_task.jsonl"));
      if (!held) await Bun.sleep(50);
    }
    expect(held).toBe(true);
    const path = join(store, "task-session.jsonl");
    writeFileSync(path, JSON.stringify({ type: "session", id: "task-session", cwd, timestamp: new Date().toISOString() }) + "\n");
    expect(await omoTranscriptForPane(paneId, cwd, (await sessionSnapshot()).panes, cwd)).toBe(realpathSync(path));
  } finally {
    await workspaceClose(created.workspace.workspace_id);
    rmSync(cwd, { recursive: true, force: true });
  }
});
