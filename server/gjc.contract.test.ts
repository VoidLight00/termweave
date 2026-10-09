import { processOpenFiles } from "./process-files.ts";
import { afterAll, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herdrRpc, herdrSocketPath, sessionSnapshot, workspaceClose, workspaceCreate, paneRead } from "./herdr/client.ts";
import { ConversationUnavailable, gjcTranscriptPath, paneConversation, transcriptPage } from "./conversation.ts";

import { gjcTerminal, isGjcProcess } from "./gjc-runtime.ts";
import { startShellAgent } from "./shell-agent.ts";

const home = mkdtempSync(join(tmpdir(), "herdr-gjc-binding-"));
const dir = join(home, ".gjc", "agent", "sessions", "v2-shared");
mkdirSync(dir, { recursive: true });
const workspaces: string[] = [];
const script = join(home, "gjc");
// The stand-in keeps actual descriptors open; all files and panes belong to this test.
writeFileSync(script, "if (process.env.GJC_TEST_CWD) process.chdir(process.env.GJC_TEST_CWD);\nfor (const path of process.argv.slice(2)) require('node:fs').openSync(path, 'r');\nconsole.log('GJC descriptor ready'); console.log(process.env.GJC_TEST_SCREEN || ''); setInterval(() => {}, 1000);\n");
afterAll(async () => {
  for (const workspace of workspaces) await workspaceClose(workspace);
  rmSync(home, { recursive: true, force: true });
});

async function pane(paths: string[], screen = "", cwd = home): Promise<string> {
  const created = await workspaceCreate({ cwd: home, label: "herdr-web-ui-test-gjc-binding" });
  workspaces.push(created.workspace.workspace_id);
  const id = created.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: id, text: `GJC_TEST_CWD='${cwd.replaceAll("'", "'\\''")}' GJC_TEST_SCREEN='${screen.replaceAll("'", "'\\''")}' ${process.execPath} ${script} ${paths.join(" ")}\n` });
  for (let attempt = 0; attempt < 100; attempt++) {
    const info = await herdrRpc<{ process_info?: { foreground_processes?: { pid: number; argv?: string[] }[] } }>("pane.process_info", { pane_id: id });
    const process = info.process_info?.foreground_processes?.find((p) => p.argv?.includes(script));
    if (process) {
      const held = processOpenFiles(process.pid);
      if (paths.every((path) => held.includes(path))) return id;
    }
    await Bun.sleep(50);
  }
  throw new Error("GJC stand-in did not open its descriptors");
}

it("reads the foreground GJC session after its process changes directory, not another session in the pane cwd", async () => {
  const cwd = join(home, "project");
  mkdirSync(cwd);
  const path = join(dir, "foreground.jsonl"), other = join(dir, "pane-cwd.jsonl");
  for (const [file, directory, answer] of [[path, cwd, "foreground answer"], [other, home, "wrong pane cwd answer"]]) {
    writeFileSync(file!, JSON.stringify({ type: "session", cwd: directory }) + "\n" + JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: answer }] } }) + "\n");
  }
  const id = await pane([path], "", cwd);
  await herdrRpc("pane.report_agent", { pane_id: id, source: "manual", agent: "gjc", state: "idle" });
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await sessionSnapshot()).panes.find((p) => p.pane_id === id)?.agent === "gjc") break;
    await Bun.sleep(50);
  }
  const metadata = (await sessionSnapshot()).panes.find((p) => p.pane_id === id)!;
  expect(metadata.agent).toBe("gjc");
  expect(metadata.cwd).toBe(home);
  expect(metadata.foreground_cwd).toBe(cwd);
  const oldHome = process.env["HOME"], oldSocket = process.env["HERDR_SOCKET"];
  process.env["HERDR_SOCKET"] = herdrSocketPath();
  process.env["HOME"] = home;
  try {
    const conversation = await paneConversation(id);
    expect(conversation.source).toBe("gjc-transcript");
    expect(conversation.turns[0]!.parts[0]).toMatchObject({ kind: "text", text: "foreground answer" });
  } finally {
    if (oldHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = oldHome;
    if (oldSocket === undefined) delete process.env["HERDR_SOCKET"]; else process.env["HERDR_SOCKET"] = oldSocket;
  }
});

it("binds same-cwd panes to their own files regardless of which transcript was modified last", async () => {
  const a = join(dir, "a.jsonl"), b = join(dir, "b.jsonl");
  for (const path of [a, b]) writeFileSync(path, JSON.stringify({ type: "session", cwd: home }) + "\n");
  const first = await pane([a]), second = await pane([b]);
  for (const newest of [a, b]) {
    utimesSync(newest, new Date(), new Date(Date.now() + 60_000));
    expect(await gjcTranscriptPath(first, home, home)).toBe(a);
    expect(await gjcTranscriptPath(second, home, home)).toBe(b);
  }
  const directoryOnly = await pane([dir]);
  await expect(gjcTranscriptPath(directoryOnly, home, home)).rejects.toThrow(ConversationUnavailable);
  const ambiguous = await pane([a, b]);
  await expect(gjcTranscriptPath(ambiguous, home, home)).rejects.toThrow(ConversationUnavailable);
  await expect(gjcTranscriptPath(first, "/different-cwd", home)).rejects.toThrow(ConversationUnavailable);
});

it("binds a pane whose session holds a subagent's file open to the session, not the subagent", async () => {
  const session = join(dir, "parent.jsonl"), subagent = join(dir, "parent", "0-Worker.jsonl");
  mkdirSync(join(dir, "parent"));
  for (const path of [session, subagent]) writeFileSync(path, JSON.stringify({ type: "session", cwd: home }) + "\n");
  expect(await gjcTranscriptPath(await pane([subagent]), home, home)).toBe(session);
  // the session and its subagent open at once are one session, not two candidates
  expect(await gjcTranscriptPath(await pane([session, subagent]), home, home)).toBe(session);
});


it("restores a directory-only runtime using its fresh terminal breadcrumb, without cwd recency", async () => {
  const a = join(dir, "breadcrumb-a.jsonl"), b = join(dir, "breadcrumb-b.jsonl");
  for (const [path, answer] of [[a, "first answer"], [b, "second answer"]]) {
    writeFileSync(path!, JSON.stringify({ type: "session", cwd: home }) + "\n" + JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: answer }] } }) + "\n");
  }
  const first = await pane([dir]), second = await pane([dir]);
  const marker = async (id: string, path: string) => {
    const info = await herdrRpc<{ process_info: { foreground_processes: { pid: number; argv?: string[] }[] } }>("pane.process_info", { pane_id: id });
    const pid = info.process_info.foreground_processes.find(p => p.argv?.includes(script))!.pid;
    const terminal = gjcTerminal(pid)!;
    expect(terminal).not.toBeNull();
    const folder = join(home, ".gjc", "agent", "terminal-sessions");
    mkdirSync(folder, { recursive: true });
    const file = join(folder, terminal.id);
    writeFileSync(file, `${home}\n${path}\n`);
    return { file, terminal };
  };
  const one = await marker(first, a);
  await marker(second, b);
  utimesSync(b, new Date(), new Date(Date.now() + 60_000));
  expect(await gjcTranscriptPath(first, home, home)).toBe(a);
  expect(await gjcTranscriptPath(second, home, home)).toBe(b);
  const conversation = transcriptPage("gjc-transcript", await gjcTranscriptPath(first, home, home));
  expect(conversation.turns[0]!.parts[0]).toMatchObject({ kind: "text", text: "first answer" });
  // /new or /resume updates this terminal's pointer, even if its old file is newer.
  writeFileSync(one.file, `${home}\n${b}\n`);
  expect(await gjcTranscriptPath(first, home, home)).toBe(b);
  utimesSync(one.file, new Date(0), new Date(one.terminal.startedAt - 60_000));
  await expect(gjcTranscriptPath(first, home, home)).rejects.toThrow(ConversationUnavailable);
});


it("restores a directory-only runtime by unique visible assistant text, never newest-file order", async () => {
  const answer = "This uniquely identifiable assistant answer belongs to the first pane and describes restoring its structured chat without borrowing a neighboring session.";
  const other = "A completely different assistant response belongs to the neighboring pane and explains its own unrelated task with enough detail to distinguish the two sessions.";
  const record = (value: string) => JSON.stringify({ type: "session", cwd: home }) + "\n" + JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: value }] } }) + "\n";
  const a = join(dir, "visible-a.jsonl"), b = join(dir, "visible-b.jsonl");
  writeFileSync(a, record(answer)); writeFileSync(b, record(other));
  const first = await pane([dir], answer), second = await pane([dir], other);
  for (const [id, text] of [[first, answer], [second, other]]) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await paneRead({ paneId: id! })).text.includes(text!.slice(0, 40))) break;
      await Bun.sleep(50);
    }
  }
  utimesSync(b, new Date(), new Date(Date.now() + 60_000));
  expect(await gjcTranscriptPath(first, home, home)).toBe(a);
  expect(await gjcTranscriptPath(second, home, home)).toBe(b);
  writeFileSync(join(dir, "duplicate.jsonl"), record(answer));
  await expect(gjcTranscriptPath(first, home, home)).rejects.toThrow(ConversationUnavailable);
});

it("starts the gjc this server found on its PATH, by absolute path, and waits until it runs in the pane", async () => {
  const shell = async () => {
    const created = await workspaceCreate({ cwd: home, label: "herdr-web-ui-test-gjc-start" });
    workspaces.push(created.workspace.workspace_id);
    return created.root_pane.pane_id;
  };
  // a `gjc` executable in a directory with a space, on this process's PATH only: the pane shell never sees that PATH
  const bin = join(home, "agent bin");
  mkdirSync(bin);
  const exe = join(bin, "gjc");
  writeFileSync(exe, `#!/bin/sh\nexec ${process.execPath} ${script} "$@"\n`, { mode: 0o755 });
  const path = process.env["PATH"];
  try {
    process.env["PATH"] = `${bin}:${path}`;
    const id = await shell();
    await startShellAgent("gjc", id, [dir]);
    const info = await herdrRpc<{ process_info?: { foreground_processes?: { argv?: string[] }[] } }>("pane.process_info", { pane_id: id });
    expect(info.process_info?.foreground_processes?.find((process) => isGjcProcess(process.argv ?? []))?.argv?.slice(-1)).toEqual([dir]);
    process.env["PATH"] = "/nonexistent";
    const bare = await shell();
    await expect(startShellAgent("gjc", bare, [], { timeoutMs: 1500 })).rejects.toThrow("not on this server's PATH");
    expect((await paneRead({ paneId: bare })).text.replaceAll(home, "")).not.toContain("gjc");
  } finally { process.env["PATH"] = path; }
});
