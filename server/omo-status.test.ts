import { afterAll, describe, expect, it } from "bun:test";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentStatus, HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { CompletionTracker } from "./completion.ts";
import { paneAfterStatus } from "./machines.ts";
import { earliestStart, holderStartedAt } from "./omo.ts";
import { noTurn, OMO_ALIASES, omoBackgroundTasks, omoSessionId, OmoStatus, omoTurnAfter, omoTurnStatus, readLines, type OmoLine, type OmoPane } from "./omo-status.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-omo-status-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// records as OmO 5.1.7 writes them
const message = (role: string, stopReason?: string, at = "2026-10-02T00:00:10.000Z", text = "") => JSON.stringify({ type: "message", id: "x", parentId: null, timestamp: at, message: { role, content: [{ type: "text", text }], ...(stopReason ? { stopReason } : {}) } });
const runtime = (customType: string) => JSON.stringify({ type: "custom_message", customType, display: false, content: "…", timestamp: "2026-10-02T00:00:20.000Z" });
const bookkeeping = (customType: string) => JSON.stringify({ type: "custom", customType });
const lines = (...entries: string[]) => entries.join("\n") + "\n";

describe("an OmO turn, read from its session file", () => {
  it("runs from a prompt through its tool calls, and is over at an answer that stopped for good", () => {
    expect(omoTurnStatus(lines(message("user")))).toBe("working");
    expect(omoTurnStatus(lines(message("user"), bookkeeping("claude-sdk-oauth-binding"), message("assistant", "toolUse")))).toBe("working");
    expect(omoTurnStatus(lines(message("user"), message("assistant", "toolUse"), message("toolResult")))).toBe("working");
    expect(omoTurnStatus(lines(message("user"), message("assistant", "toolUse"), message("toolResult"), message("assistant", "stop")))).toBe("idle");
    expect(omoTurnStatus(lines(message("user"), message("assistant", "aborted")))).toBe("idle");
  });

  it("is over at an answer that ended in an error, and runs again when a retry answers", () => {
    // seen in real files: an error, OmO's stop record 2 ms later, then a retry 2 to 16 s later all the same
    expect(omoTurnStatus(lines(message("user"), message("assistant", "error")))).toBe("idle");
    expect(omoTurnStatus(lines(message("user"), message("assistant", "error"), bookkeeping("senpi.hooks.stop-state"), message("assistant", "error")))).toBe("idle");
    expect(omoTurnStatus(lines(message("user"), message("assistant", "error"), message("assistant", "toolUse")))).toBe("working");
    expect(omoTurnStatus(lines(message("user"), message("assistant", "error"), bookkeeping("senpi.hooks.stop-state"), runtime("goal-continuation")))).toBe("working");
    // OmO's stop record says nothing of the turn: it is held back while a background task runs
    expect(omoTurnStatus(lines(message("user"), message("assistant", "toolUse"), bookkeeping("senpi.hooks.stop-state")))).toBe("working");
  });

  it("starts with one of the runtime's own messages, nobody typing", () => {
    const rested = [message("user"), message("assistant", "stop"), bookkeeping("senpi.hooks.stop-state")];
    for (const start of ["omo-senpi:wake", "senpi-monitor:notification", "senpi-terminal:notification", "goal-continuation", "senpi.todo-owed", "senpi-codemode:notification", "omo-init-deep-advisor:run", "omo-onboarding:bootstrap", "ttsr-injection"]) {
      expect(omoTurnStatus(lines(...rested, runtime(start)))).toBe("working");
    }
    // what OmO notes down after a finished answer starts nothing
    for (const note of ["omo-memory:notice", "omo-kibitzer:recall", "senpi-task.usage", "environment-context"]) expect(omoTurnStatus(lines(...rested, runtime(note)))).toBe("idle");
    expect(omoTurnStatus(lines(...rested, bookkeeping("goal-cache-warmup"), bookkeeping("omo-memory:accepted-turns")))).toBe("idle");
    expect(omoTurnStatus(lines(bookkeeping("pi-rules.scan"), "not json"))).toBeNull();
  });

  it("reads a record of any size by its ends, and only whole lines", () => {
    const path = join(root, "2026-10-02T00-00-00-000Z_01a0f88b-481c-7139-8125-c9cd453b9e17.jsonl");
    const big = "x".repeat(400_000);
    // a prompt and an answer each far longer than a read holds
    writeFileSync(path, lines(message("assistant", "stop"), message("user", undefined, "2026-10-02T00:01:00.000Z", big)));
    const read = (from = 0) => {
      const seen: OmoLine[] = [];
      const fd = openSync(path, "r");
      try { return { offset: readLines(fd, from, statSync(path).size, (line) => seen.push(line)), seen }; } finally { closeSync(fd); }
    };
    let { seen, offset } = read();
    expect(seen.map((line) => "text" in line ? "whole" : "ends")).toEqual(["whole", "ends"]);
    expect(seen.reduce(omoTurnAfter, noTurn())).toMatchObject({ status: "working", at: Date.parse("2026-10-02T00:01:00.000Z") });
    expect(offset).toBe(statSync(path).size);
    writeFileSync(path, lines(message("user"), message("assistant", "stop", "2026-10-02T00:02:00.000Z", big)));
    expect(read().seen.reduce(omoTurnAfter, noTurn()).status).toBe("idle");
    writeFileSync(path, lines(message("user"), message("assistant", "toolUse", "2026-10-02T00:02:00.000Z", big)));
    expect(read().seen.reduce(omoTurnAfter, noTurn()).status).toBe("working");
    // a last line still being written waits for its newline
    writeFileSync(path, lines(message("user")) + message("assistant", "stop").slice(0, 40));
    ({ seen, offset } = read());
    expect(seen).toHaveLength(1);
    expect(offset).toBe(Buffer.byteLength(lines(message("user"))));
    expect(omoSessionId(path)).toBe("01a0f88b-481c-7139-8125-c9cd453b9e17");
  });

  it("counts each session's running background tasks, not a dead host's", () => {
    const cwd = join(root, "project");
    const tasks = join(cwd, ".omo", "senpi-task", "tasks");
    mkdirSync(tasks, { recursive: true });
    const task = (name: string, record: Record<string, unknown>) => writeFileSync(join(tasks, name), JSON.stringify(record));
    task("st_1.json", { task_id: "st_1", status: "running", parent_session_id: "mine", host_pid: 10 });
    task("st_2.json", { task_id: "st_2", status: "completed", parent_session_id: "mine", host_pid: 10 });
    task("st_3.json", { task_id: "st_3", status: "running", parent_session_id: "other", host_pid: 10 });
    task("st_4.json", { task_id: "st_4", status: "running", parent_session_id: "mine", host_pid: 99 });
    task("st_5.json", { task_id: "st_5", status: "running", parent_session_id: "mine" });
    writeFileSync(join(tasks, "st_6.json"), "{half");
    expect(Object.fromEntries(omoBackgroundTasks(cwd, (pid) => pid === 10))).toEqual({ mine: 2, other: 1 });
    expect(omoBackgroundTasks(join(root, "nowhere")).size).toBe(0);
  });
});

describe("OmO panes' status in place of herdr's", () => {
  const pane = (id: string, agent: string | null, status: AgentStatus): HerdrPane => ({ pane_id: id, agent, agent_status: status, cwd: "/work" } as unknown as HerdrPane);
  const snapshotOf = (...panes: HerdrPane[]): SessionSnapshot => ({ panes, agents: panes.map((p) => ({ pane_id: p.pane_id, agent: p.agent, agent_status: p.agent_status })) } as unknown as SessionSnapshot);
  /** herdr as #286 saw it: an OmO pane reads claude/idle whatever it does */
  const herdr = () => snapshotOf(pane("omo", "claude", "idle"), pane("lost", "claude", "idle"), pane("claude", "claude", "working"), pane("shell", null, "unknown"));
  const FILE = "/s/2026_01a0f88b-481c-7139-8125-c9cd453b9e17.jsonl";

  function setup(initial = lines(message("user"), message("assistant", "stop"))) {
    const files: Record<string, string> = { [FILE]: initial };
    const ids: Record<string, string> = {};
    const told: [string, AgentStatus, number, boolean][] = [];
    const found: string[] = [];
    const state = { background: 0, discovered: new Map<string, OmoPane>([["omo", { path: FILE, startedAt: null }], ["lost", { path: null, startedAt: null }]]), lookups: 0, clock: 0, failing: false, during: () => {} };
    const omo = new OmoStatus({
      // the session of `lost` cannot be told (two OmO panes in one folder without /proc)
      discover: async () => { state.lookups += 1; state.during(); return new Map(state.discovered); },
      snapshot: async () => herdr(),
      onChange: (id, status, count, turn) => told.push([id, status, count, turn]),
      onFound: (id) => found.push(id),
      file: {
        stat: (path) => path in files ? { size: Buffer.byteLength(files[path]!), id: ids[path] ?? "1" } : null,
        lines: (path, from, size, each) => { if (state.failing) return from; const text = Buffer.from(files[path]!).subarray(from, size).toString("utf8"); const whole = text.slice(0, text.lastIndexOf("\n") + 1); for (const line of whole.split("\n").slice(0, -1)) each({ text: line }); return from + Buffer.byteLength(whole); },
      },
      background: () => new Map([["01a0f88b-481c-7139-8125-c9cd453b9e17", state.background]]),
      now: () => state.clock,
    });
    const append = (...entries: string[]) => { files[FILE] += lines(...entries); };
    /** the file put anew in place of the old one, as a rewrite does */
    const replace = (...entries: string[]) => { files[FILE] = lines(...entries); ids[FILE] = `${Number(ids[FILE] ?? 1) + 1}`; };
    return { omo, told, found, append, replace, state };
  }
  const statuses = (snapshot: SessionSnapshot) => Object.fromEntries(snapshot.panes.map((p) => [p.pane_id, `${p.agent}/${p.agent_status}`]));

  it("reads RUN while a turn runs and DONE when it ends, in events and in every snapshot", async () => {
    const { omo, told, append, state } = setup();
    const completions = new CompletionTracker(null);
    const served = () => completions.readSnapshot(async () => { const raw = herdr(); await omo.refresh(raw.panes); return omo.apply(raw); });
    // at rest: nothing worked, so READY; every OmO pane is `omo`, and the other panes are herdr's own
    expect(statuses(await served())).toEqual({ omo: "omo/idle", lost: "omo/idle", claude: "claude/working", shell: "null/unknown" });
    expect([omo.tracks("omo"), omo.tracks("lost"), omo.runs("lost"), omo.runs("claude")]).toEqual([true, false, true, false]);
    // a turn starts: told once, and herdr's claude/idle no longer undoes it at the next snapshot
    append(message("user"));
    omo.poll();
    expect(told).toEqual([["omo", "working", 0, true]]);
    expect(completions.observe("omo", "working", "omo")).toBe("working");
    for (let i = 0; i < 3; i++) { state.clock += 10_000; expect(statuses(await served())["omo"]).toBe("omo/working"); }
    append(message("assistant", "toolUse"), message("toolResult"));
    omo.poll();
    expect(told).toHaveLength(1);
    // it ends: DONE, and it stays DONE in the snapshots after, across refreshes
    append(message("assistant", "stop"));
    omo.poll();
    expect(told.at(-1)).toEqual(["omo", "idle", 0, true]);
    expect(completions.observe("omo", "idle", "omo")).toBe("done");
    for (let i = 0; i < 3; i++) { state.clock += 10_000; expect(statuses(await served())["omo"]).toBe("omo/done"); }
    // a finished background task wakes the session: a turn of its own
    append(runtime("omo-senpi:wake"));
    omo.poll();
    expect(completions.observe("omo", told.at(-1)![1], "omo")).toBe("working");
    expect(statuses(await served())["omo"]).toBe("omo/working");
  });

  it("tells a turn that ended while the panes were being looked up again", async () => {
    const { omo, told, append, state } = setup(lines(message("user")));
    await omo.refresh(herdr().panes);
    expect(told).toEqual([["omo", "working", 0, true]]);
    // the answer lands during the lookup of the next refresh: it is told, not swallowed
    state.clock += 10_000;
    state.during = () => append(message("assistant", "stop"));
    await omo.refresh(herdr().panes);
    expect(told.slice(1)).toEqual([["omo", "idle", 0, true]]);
  });

  it("tells a turn that ended while the pane's OmO could not be told, or in another session", async () => {
    const { omo, told, append, replace, state } = setup(lines(message("user")));
    await omo.refresh(herdr().panes);
    // one lookup misses the pane (its process list could not be read); the answer lands meanwhile
    state.discovered.delete("omo");
    state.clock += 10_000;
    await omo.refresh(herdr().panes);
    append(message("assistant", "stop"));
    state.discovered.set("omo", { path: FILE, startedAt: null });
    state.clock += 10_000;
    await omo.refresh(herdr().panes);
    expect(told).toEqual([["omo", "working", 0, true], ["omo", "idle", 0, true]]);
    // nor is it lost when only the session could not be told for a while
    append(message("user"));
    omo.poll();
    state.discovered.set("omo", { path: null, startedAt: null });
    state.clock += 10_000;
    await omo.refresh(herdr().panes);
    append(message("assistant", "stop"));
    state.discovered.set("omo", { path: FILE, startedAt: null });
    state.clock += 10_000;
    await omo.refresh(herdr().panes);
    expect(told.slice(2)).toEqual([["omo", "working", 0, true], ["omo", "idle", 0, true]]);
    // the file is rewritten whole, a turn running in it: read again from its start, not from where the old one was read to
    replace(message("user"), message("assistant", "stop"), message("user"), message("assistant", "toolUse"));
    omo.poll();
    expect(told.at(-1)).toEqual(["omo", "working", 0, true]);
    replace(message("user"), message("assistant", "stop"), message("user"), message("assistant", "toolUse"), message("toolResult"), message("assistant", "stop"));
    omo.poll();
    expect(told.at(-1)).toEqual(["omo", "idle", 0, true]);
  });

  it("makes a finish of a turn found running by the watch alone, no snapshot served", async () => {
    const { omo, told, append } = setup(lines(message("user")));
    const completions = new CompletionTracker(null);
    const settled = () => told.map(([id, status]) => completions.observe(id, status, "omo"));
    await omo.refresh(herdr().panes);
    append(message("assistant", "stop"));
    omo.poll();
    expect(settled()).toEqual(["working", "done"]);
  });

  it("finds a turn already running when the server starts, and takes over what herdr's name finished", async () => {
    const { omo, told, found } = setup(lines(message("user")));
    const completions = new CompletionTracker(null);
    // before: herdr's own events, under its name for the pane
    completions.observe("omo", "working", "claude");
    expect(completions.observe("omo", "idle", "claude")).toBe("done");
    const raw = herdr();
    await omo.refresh(raw.panes);
    // what Codex finished in a pane before OmO was started there is not OmO's finish
    completions.observe("lost", "working", "codex");
    expect(completions.observe("lost", "unknown", "codex")).toBe("done");
    for (const paneId of found) completions.adopt(paneId, "omo", OMO_ALIASES);
    expect(found.sort()).toEqual(["lost", "omo"]);
    expect(completions.current("lost")).toBeUndefined();
    expect(completions.observe("lost", "idle", "omo")).toBe("idle");
    expect(told).toEqual([["omo", "working", 0, true]]);
    expect(statuses(completions.present(omo.apply(raw)))["omo"]).toBe("omo/working");
    // a pane whose session is lost and found again keeps its DONE: its identity never changed
    completions.observe("lost", "working", "omo");
    expect(completions.observe("lost", "idle", "omo")).toBe("done");
    expect(statuses(completions.present(omo.apply(herdr())))["lost"]).toBe("omo/done");
  });

  it("does not take an unfinished turn of a process that is gone for a running one", async () => {
    // killed after a tool call, then resumed by a new process without a prompt
    const { omo, state, append, told } = setup(lines(message("user", undefined, "2026-10-02T00:00:10.000Z"), message("assistant", "toolUse", "2026-10-02T00:00:12.000Z")));
    state.discovered.set("omo", { path: FILE, startedAt: Date.parse("2026-10-02T00:05:00.000Z") });
    const raw = herdr();
    await omo.refresh(raw.panes);
    expect(statuses(omo.apply(raw))["omo"]).toBe("omo/idle");
    // a later lookup that cannot read the start keeps the one read before
    state.discovered.set("omo", { path: FILE, startedAt: null });
    state.clock += 10_000;
    await omo.refresh(raw.panes);
    expect(statuses(omo.apply(raw))["omo"]).toBe("omo/idle");
    expect(told).toEqual([]);
    // nor does a lookup that misses the pane lose it
    state.discovered.delete("omo");
    state.clock += 10_000;
    await omo.refresh(raw.panes);
    state.discovered.set("omo", { path: FILE, startedAt: null });
    state.clock += 10_000;
    await omo.refresh(raw.panes);
    expect(statuses(omo.apply(raw))["omo"]).toBe("omo/idle");
    expect(told).toEqual([]);
    // a prompt to the new process is a turn
    append(message("user", undefined, "2026-10-02T00:06:00.000Z"));
    omo.poll();
    expect(told).toEqual([["omo", "working", 0, true]]);
  });

  it("lets go of a pane at once when herdr names another agent in it", async () => {
    const { omo, state } = setup();
    await omo.refresh(herdr().panes);
    // herdr's names for OmO itself change nothing
    for (const name of [null, "claude", "pi", "omo"]) expect(omo.named("omo", name)).toBe(false);
    expect(omo.tracks("omo")).toBe(true);
    // Codex started in the pane: its events are no longer swallowed, and the panes are looked up again
    expect(omo.named("omo", "codex")).toBe(true);
    expect(omo.named("omo", "codex")).toBe(false);
    expect([omo.tracks("omo"), omo.runs("omo")]).toEqual([false, false]);
    state.discovered.delete("omo");
    await omo.refresh(herdr().panes);
    expect(state.lookups).toBe(2);
  });

  it("does not take a pane back from a lookup that began before another agent was named in it", async () => {
    const { omo, told, state } = setup(lines(message("user")));
    await omo.refresh(herdr().panes);
    state.clock += 10_000;
    // the lookup still sees OmO; Codex's event arrives while it runs
    state.during = () => { omo.named("omo", "codex"); };
    await omo.refresh(herdr().panes);
    expect(omo.runs("omo")).toBe(false);
    expect(told).toEqual([["omo", "working", 0, true]]);
    // a pane only remembered (its lookup missed) is let go the same way
    state.during = () => {};
    await omo.refresh(herdr().panes);
    state.discovered.delete("omo");
    state.clock += 10_000;
    await omo.refresh(herdr().panes);
    expect(omo.named("omo", "codex")).toBe(true);
  });

  it("tells a turn still running anew once herdr's status stood for the pane a while", async () => {
    const { omo, told, state } = setup(lines(message("user")));
    const completions = new CompletionTracker(null);
    const settle = () => { const [id, status] = told.at(-1)!; return completions.observe(id, status, "omo"); };
    await omo.refresh(herdr().panes);
    expect(settle()).toBe("working");
    // the session cannot be told: herdr's claude/idle counts, and reads as a finish
    state.discovered.set("omo", { path: null, startedAt: null });
    state.clock += 10_000;
    await omo.refresh(herdr().panes);
    expect(completions.observe("omo", "idle", "omo")).toBe("done");
    // told again, the turn still runs: RUN is said anew, so its real end is a finish
    state.discovered.set("omo", { path: FILE, startedAt: null });
    state.clock += 10_000;
    await omo.refresh(herdr().panes);
    expect(told).toHaveLength(2);
    expect(settle()).toBe("working");
  });

  it("keeps another agent's status out of a snapshot being read when OmO takes the pane", async () => {
    const completions = new CompletionTracker(null);
    let release = (_: SessionSnapshot) => {};
    const reading = completions.readSnapshot(() => new Promise<SessionSnapshot>((resolve) => { release = resolve; }));
    completions.observe("omo", "blocked", "codex");
    completions.adopt("omo", "omo", OMO_ALIASES);
    release(snapshotOf(pane("omo", "omo", "idle")));
    expect(statuses(await reading)["omo"]).toBe("omo/idle");
    // herdr's own done for Codex is not OmO's either
    completions.observe("omo", "done", "codex");
    completions.adopt("omo", "omo", OMO_ALIASES);
    expect(completions.current("omo")).toBeUndefined();
  });

  it("reads again what a failed read left", async () => {
    const { omo, told, append, replace, state } = setup();
    await omo.refresh(herdr().panes);
    state.failing = true;
    append(message("user"));
    omo.poll();
    expect(told).toEqual([]);
    state.failing = false;
    omo.poll();
    expect(told).toEqual([["omo", "working", 0, true]]);
    // a rewritten file that cannot be read is no finished turn: one RUN, one DONE
    state.failing = true;
    replace(message("user"));
    omo.poll();
    state.failing = false;
    omo.poll();
    expect(told).toHaveLength(1);
    append(message("assistant", "stop"));
    omo.poll();
    expect(told.slice(1)).toEqual([["omo", "idle", 0, true]]);
  });

  it("keeps the start of a process known before its session was", async () => {
    const { omo, told, state } = setup(lines(message("user", undefined, "2026-10-02T00:00:10.000Z"), message("assistant", "toolUse", "2026-10-02T00:00:12.000Z")));
    state.discovered.set("omo", { path: null, startedAt: Date.parse("2026-10-02T00:05:00.000Z") });
    await omo.refresh(herdr().panes);
    state.discovered.set("omo", { path: FILE, startedAt: null });
    state.clock += 10_000;
    await omo.refresh(herdr().panes);
    expect(statuses(omo.apply(herdr()))["omo"]).toBe("omo/idle");
    expect(told).toEqual([]);
  });

  it("tells a change in background tasks as that, not as a turn", async () => {
    const { omo, told, state } = setup();
    await omo.refresh(herdr().panes);
    state.background = 2;
    omo.poll();
    expect(told).toEqual([["omo", "idle", 2, false]]);
    expect(omo.backgroundOf("omo")).toBe(2);
    state.background = 0;
    omo.poll();
    expect(told.at(-1)).toEqual(["omo", "idle", 0, false]);
  });

  it("reads a process's start from the record OmO keeps of it, where the system tells none", () => {
    const dir = join(root, "sessions");
    mkdirSync(join(dir, "session-holders", "01a0f88b"), { recursive: true });
    writeFileSync(join(dir, "session-holders", "01a0f88b", "4242.json"), JSON.stringify({ pid: 4242, processStartedAtMs: 1_790_000_000_000 }));
    expect(holderStartedAt(dir, 4242)).toBe(1_790_000_000_000);
    expect(holderStartedAt(dir, 4243)).toBeNull();
    expect(holderStartedAt(join(root, "nowhere"), 4242)).toBeNull();
    // a helper process with no record does not undo the engine's
    expect(earliestStart([1_790_000_000_000, null])).toBe(1_790_000_000_000);
    expect(earliestStart([5, 3])).toBe(3);
    expect(earliestStart([null])).toBeNull();
  });

  it("keeps a remote PC's count of background tasks as its frames say", () => {
    const frame = (background_tasks?: number) => ({ type: "pane-status" as const, pane_id: "omo", agent_status: "working" as const, ...(background_tasks === undefined ? {} : { background_tasks }) });
    const two = paneAfterStatus(pane("omo", "omo", "idle"), frame(2));
    expect(two).toMatchObject({ agent_status: "working", background_tasks: 2 });
    expect(paneAfterStatus(two, frame())).toMatchObject({ background_tasks: 2 });
    expect("background_tasks" in paneAfterStatus(two, frame(0))).toBe(false);
  });

  it("looks the panes up once per refresh, and not again while nothing changed", async () => {
    const { omo, state } = setup();
    await omo.refresh(herdr().panes);
    await omo.refresh(herdr().panes);
    expect(state.lookups).toBe(1);
    state.clock += 6000;
    await omo.refresh(herdr().panes);
    expect(state.lookups).toBe(2);
  });
});
