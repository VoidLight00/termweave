import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSnapshot } from "../shared/protocol.ts";
import { CompletionTracker } from "./completion.ts";

const snapshot = (panes: { id: string; status: string; agent?: string | null; focused?: boolean }[]): SessionSnapshot => ({
  panes: panes.map((pane) => ({ pane_id: pane.id, agent: pane.agent === undefined ? "claude" : pane.agent, agent_status: pane.status, focused: pane.focused ?? false })),
  agents: panes.map((pane) => ({ pane_id: pane.id, agent_status: pane.status, focused: pane.focused ?? false })),
} as unknown as SessionSnapshot);

function delayedSnapshot() {
  let release!: (value: SessionSnapshot) => void;
  const pending = new Promise<SessionSnapshot>((resolve) => { release = resolve; });
  return { read: () => pending, release };
}

describe("CompletionTracker", () => {
  it("does not let an unknown snapshot captured before a new turn finish that turn", async () => {
    const tracker = new CompletionTracker();
    const atRest = snapshot([{ id: "p", agent: "codex", status: "unknown" }]);
    tracker.present(atRest);
    let release!: (value: SessionSnapshot) => void;
    const pending = new Promise<SessionSnapshot>((resolve) => { release = resolve; });
    const reading = tracker.readSnapshot(() => pending);
    tracker.observe("p", "working", "codex");
    release(atRest);
    expect((await reading).panes[0]!.agent_status).toBe("working");
    expect(tracker.seen("p")).toBe(false);
    expect(tracker.observe("p", "unknown", "codex")).toBe("done");
  });

  it("keeps a finish and its acknowledgment ahead of an older working snapshot", async () => {
    for (const acknowledge of [false, true]) {
      const tracker = new CompletionTracker();
      tracker.observe("p", "working", "codex");
      const old = delayedSnapshot();
      const reading = tracker.readSnapshot(old.read);
      expect(tracker.observe("p", "unknown", "codex")).toBe("done");
      if (acknowledge) expect(tracker.seen("p")).toBe(true);
      old.release(snapshot([{ id: "p", agent: "codex", status: "working" }]));
      const shown = await reading;
      expect(shown.panes[0]!.agent_status).toBe(acknowledge ? "idle" : "done");
      expect(shown.agents[0]!.agent_status).toBe(acknowledge ? "idle" : "done");
      expect(tracker.observe("p", "unknown", "codex")).toBe(acknowledge ? "unknown" : "done");
    }
  });

  it("gives a later snapshot precedence when concurrent reads resolve out of order", async () => {
    for (const newerFirst of [false, true]) {
      const tracker = new CompletionTracker();
      const old = delayedSnapshot();
      const fresh = delayedSnapshot();
      const olderRead = tracker.readSnapshot(old.read);
      const newerRead = tracker.readSnapshot(fresh.read);
      if (newerFirst) {
        fresh.release(snapshot([{ id: "p", agent: "codex", status: "working" }]));
        await newerRead;
        old.release(snapshot([{ id: "p", agent: "codex", status: "unknown" }]));
        expect((await olderRead).panes[0]!.agent_status).toBe("working");
      } else {
        old.release(snapshot([{ id: "p", agent: "codex", status: "unknown" }]));
        await olderRead;
        fresh.release(snapshot([{ id: "p", agent: "codex", status: "working" }]));
        expect((await newerRead).panes[0]!.agent_status).toBe("working");
      }
      expect(tracker.observe("p", "unknown", "codex")).toBe("done");
    }
  });

  it("does not revive a closed pane from an old snapshot or forget work newer than a missing pane", async () => {
    const tracker = new CompletionTracker();
    const missing = delayedSnapshot();
    const missingRead = tracker.readSnapshot(missing.read);
    tracker.observe("p", "working", "codex");
    missing.release(snapshot([]));
    await missingRead;
    expect(tracker.observe("p", "unknown", "codex")).toBe("done");

    tracker.observe("p", "working", "codex");
    const old = delayedSnapshot();
    const reading = tracker.readSnapshot(old.read);
    tracker.forget("p");
    old.release(snapshot([{ id: "p", agent: "codex", status: "working" }]));
    expect((await reading).panes).toHaveLength(0);
    expect(tracker.observe("p", "unknown", "codex")).toBe("unknown");
  });

  it("does not restore an old agent's finish from a snapshot after its replacement", async () => {
    const tracker = new CompletionTracker();
    tracker.observe("p", "working", "codex");
    tracker.observe("p", "unknown", "codex");
    const old = delayedSnapshot();
    const reading = tracker.readSnapshot(old.read);
    expect(tracker.observe("p", "unknown", "claude")).toBe("unknown");
    old.release(snapshot([{ id: "p", agent: "codex", status: "unknown" }]));
    expect((await reading).panes[0]!.agent_status).toBe("unknown");
    expect(tracker.present(snapshot([{ id: "p", agent: "claude", status: "unknown" }])).panes[0]!.agent_status).toBe("unknown");
  });

  it("matches finished raw identities before applying an omo display label", async () => {
    const tracker = new CompletionTracker();
    tracker.observe("p", "working", "pi");
    tracker.observe("p", "unknown", "claude");
    expect(tracker.observe("p", "idle", "claude")).toBe("done");
    const raw = snapshot([{ id: "p", agent: "claude", status: "idle" }]);
    const shown = await tracker.readSnapshot(async () => raw, async (value) => ({
      ...value,
      panes: value.panes.map((pane) => ({ ...pane, agent: "omo" })),
      agents: value.agents.map((agent) => ({ ...agent, agent: "omo" })),
    }));
    expect(shown.panes[0]!.agent).toBe("omo");
    expect(shown.panes[0]!.agent_status).toBe("done");
    expect(shown.agents[0]!.agent_status).toBe("done");
  });

  it("keeps new work ahead of a snapshot still waiting for display labeling", async () => {
    const tracker = new CompletionTracker();
    const raw = snapshot([{ id: "p", agent: "claude", status: "unknown" }]);
    const label = delayedSnapshot();
    let entered!: () => void;
    const labeling = new Promise<void>((resolve) => { entered = resolve; });
    const reading = tracker.readSnapshot(async () => raw, () => { entered(); return label.read(); });
    await labeling;
    tracker.observe("p", "working", "claude");
    label.release(snapshot([{ id: "p", agent: "omo", status: "unknown" }]));
    const shown = await reading;
    expect(shown.panes[0]!.agent).toBe("omo");
    expect(shown.panes[0]!.agent_status).toBe("working");
    expect(tracker.seen("p")).toBe(false);
    expect(tracker.observe("p", "unknown", "claude")).toBe("done");
  });

  it("drops a derived finish when its agent leaves or another agent replaces it", () => {
    const tracker = new CompletionTracker();
    tracker.observe("left", "working", "codex");
    expect(tracker.observe("left", "unknown", "codex")).toBe("done");
    expect(tracker.observe("left", "unknown", null)).toBe("unknown");
    expect(tracker.observe("left", "unknown", "claude")).toBe("unknown");

    tracker.observe("replaced", "working", "codex");
    expect(tracker.observe("replaced", "unknown", "codex")).toBe("done");
    expect(tracker.observe("replaced", "unknown", "claude")).toBe("unknown");
    expect(tracker.observe("replaced", "idle", "claude")).toBe("idle");
  });

  it("does not transfer a persisted Codex finish to another agent after a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-completion-replaced-"));
    try {
      const file = join(dir, "completions.json");
      const before = new CompletionTracker(file, () => "herdr-a");
      before.observe("p", "working", "codex");
      before.observe("p", "unknown", "codex");
      const after = new CompletionTracker(file, () => "herdr-a");
      expect(after.present(snapshot([{ id: "p", agent: "claude", status: "unknown" }])).panes[0]!.agent_status).toBe("unknown");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reports an idle after work as done until focus moves onto the pane, as herdr does for agents it does not lose", () => {
    const tracker = new CompletionTracker();
    // omo, live-traced: pi/working, then claude/unknown, then claude/idle
    expect(tracker.observe("p", "working", "pi")).toBe("working");
    // the turn goes on under omo's claude child: still working, not unknown
    expect(tracker.observe("p", "unknown", "claude")).toBe("working");
    expect(tracker.observe("p", "idle", "claude")).toBe("done");
    // snapshots keep saying done until the pane is seen
    expect(tracker.present(snapshot([{ id: "p", status: "idle" }])).panes[0]!.agent_status).toBe("done");
    expect(tracker.seen("p")).toBe(true);
    expect(tracker.present(snapshot([{ id: "p", status: "idle", focused: true }])).panes[0]!.agent_status).toBe("idle");
    expect(tracker.present(snapshot([{ id: "p", status: "idle" }])).panes[0]!.agent_status).toBe("idle");
    expect(tracker.seen("p")).toBe(false);
  });

  it("finishes the pane herdr has focused as done: nobody moved focus there to see it", () => {
    // live: the browser sent work to herdr's focused pane, which went working -> idle
    const tracker = new CompletionTracker();
    expect(tracker.observe("p", "working", "claude")).toBe("working");
    expect(tracker.observe("p", "idle", "claude")).toBe("done");
    // a snapshot with the focus it had all along does not count as seeing it
    expect(tracker.present(snapshot([{ id: "p", status: "idle", focused: true }])).panes[0]!.agent_status).toBe("done");
    expect(tracker.seen("p")).toBe(true);
    expect(tracker.present(snapshot([{ id: "p", status: "idle", focused: true }])).panes[0]!.agent_status).toBe("idle");
  });

  it("leaves idle alone when the pane never worked, herdr said done itself, or it works again", () => {
    const tracker = new CompletionTracker();
    expect(tracker.observe("q", "idle")).toBe("idle");
    tracker.observe("q", "working");
    expect(tracker.observe("q", "done")).toBe("done");
    // herdr's own done turns idle when its terminal brings the pane to the front
    expect(tracker.observe("q", "idle")).toBe("idle");
    tracker.observe("r", "working");
    expect(tracker.observe("r", "idle")).toBe("done");
    expect(tracker.observe("r", "working")).toBe("working");
    expect(tracker.seen("r")).toBe(false);
  });

  it("finishes an agent that reads unknown at rest, as Codex does, and keeps it done until seen", () => {
    const tracker = new CompletionTracker();
    // A first sighting at rest is not a finish.
    expect(tracker.observe("p", "unknown", "codex")).toBe("unknown");
    // live, herdr 0.9.3: codex/working for a turn, then codex/unknown at rest
    expect(tracker.observe("p", "working", "codex")).toBe("working");
    expect(tracker.observe("p", "unknown", "codex")).toBe("done");
    const codex = (status: string, focused = false) => snapshot([{ id: "p", agent: "codex", status, focused }]);
    expect(tracker.present(codex("unknown")).panes[0]!.agent_status).toBe("done");
    expect(tracker.seen("p")).toBe(true);
    expect(tracker.present(codex("unknown", true)).panes[0]!.agent_status).toBe("unknown");
    // the next turn works and finishes the same way
    expect(tracker.observe("p", "working", "codex")).toBe("working");
    expect(tracker.observe("p", "unknown", "codex")).toBe("done");
  });

  it("keeps an agent handoff working through repeated unknown snapshots until it goes idle", () => {
    const tracker = new CompletionTracker();
    tracker.observe("p", "working", "pi");
    const handoff = snapshot([{ id: "p", agent: "claude", status: "unknown" }]);
    for (let repeat = 0; repeat < 3; repeat++) {
      const presented = tracker.present(handoff);
      expect(presented.panes[0]!.agent_status).toBe("working");
      expect(presented.agents[0]!.agent_status).toBe("working");
    }
    expect(tracker.seen("p")).toBe(false);
    expect(tracker.observe("p", "idle", "claude")).toBe("done");
  });

  it("lets an unknown with no agent left be unknown: the agent quit", () => {
    const tracker = new CompletionTracker();
    tracker.observe("p", "working", "gjc");
    expect(tracker.observe("p", "unknown", null)).toBe("unknown");
    expect(tracker.observe("p", "idle", null)).toBe("idle");
  });

  it("forgets panes that left the snapshot", () => {
    const tracker = new CompletionTracker();
    tracker.observe("gone", "working");
    tracker.observe("gone", "idle");
    tracker.present(snapshot([]));
    expect(tracker.present(snapshot([{ id: "gone", status: "idle" }])).panes[0]!.agent_status).toBe("idle");
  });

  it("keeps what finished across a restart of this server, and not what was still working", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-completion-"));
    try {
      const file = join(dir, "completions.json");
      const before = new CompletionTracker(file, () => "herdr-a");
      before.observe("finished", "working", "gjc");
      expect(before.observe("finished", "idle", "gjc")).toBe("done");
      // omo mid-turn when the server stopped: its finish may have been seen at herdr's terminal meanwhile
      before.observe("running", "working", "pi");
      const after = new CompletionTracker(file, () => "herdr-a");
      const panes = after.present(snapshot([{ id: "finished", agent: "gjc", status: "idle" }, { id: "running", agent: "pi", status: "idle" }])).panes;
      expect(panes.map((pane) => pane.agent_status)).toEqual(["done", "idle"]);
      // seen after the restart stays seen after the next one
      expect(after.seen("finished")).toBe(true);
      const again = new CompletionTracker(file, () => "herdr-a");
      expect(again.present(snapshot([{ id: "finished", agent: "gjc", status: "idle" }])).panes[0]!.agent_status).toBe("idle");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("keeps a Codex finish across a restart while herdr still reports unknown", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-completion-codex-"));
    try {
      const file = join(dir, "completions.json");
      const before = new CompletionTracker(file, () => "herdr-a");
      before.observe("p", "working", "codex");
      before.observe("p", "unknown", "codex");
      const atRest = snapshot([{ id: "p", agent: "codex", status: "unknown" }]);
      const after = new CompletionTracker(file, () => "herdr-a");
      expect(after.present(atRest).panes[0]!.agent_status).toBe("done");
      expect(after.seen("p")).toBe(true);
      expect(new CompletionTracker(file, () => "herdr-a").present(atRest).panes[0]!.agent_status).toBe("unknown");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reads legacy idle finishes without assigning their unknown identity to a new agent", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-completion-legacy-"));
    try {
      const file = join(dir, "completions.json");
      writeFileSync(file, JSON.stringify({ herdr: "herdr-a", finished: ["idle", "unknown"] }));
      const tracker = new CompletionTracker(file, () => "herdr-a");
      const shown = tracker.present(snapshot([{ id: "idle", agent: "gjc", status: "idle" }, { id: "unknown", agent: "codex", status: "unknown" }]));
      expect(shown.panes.map((pane) => pane.agent_status)).toEqual(["done", "unknown"]);
      expect(tracker.seen("unknown")).toBe(false);
      expect(tracker.seen("idle")).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("drops what was kept for another herdr, whose pane ids name other panes, and a broken file", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-completion-"));
    try {
      const file = join(dir, "completions.json");
      const before = new CompletionTracker(file, () => "herdr-a");
      before.observe("p", "working");
      before.observe("p", "idle");
      const restarted = new CompletionTracker(file, () => "herdr-b");
      expect(restarted.present(snapshot([{ id: "p", status: "idle" }])).panes[0]!.agent_status).toBe("idle");
      writeFileSync(file, "{not json");
      expect(new CompletionTracker(file, () => "herdr-a").present(snapshot([{ id: "p", status: "idle" }])).panes[0]!.agent_status).toBe("idle");
      // without a herdr to name, nothing is written: it could not be told apart later
      const nowhere = join(dir, "none.json");
      const unnamed = new CompletionTracker(nowhere, () => null);
      unnamed.observe("p", "working");
      unnamed.observe("p", "idle");
      expect(existsSync(nowhere)).toBe(false);
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ herdr: "herdr-a" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("takes a status read back from a snapshot for news only where it is a change", () => {
    const tracker = new CompletionTracker(null);
    // a pane never reported here: it starts from what it was, so the finish is a finish
    expect(tracker.replayed("fresh", "idle", { before: "working", agent: "claude" })).toBe(true);
    expect(tracker.observe("fresh", "idle", "claude")).toBe("done");
    // herdr reads that finish as idle in a snapshot and done in an event: not news, the DONE stands
    expect(tracker.replayed("fresh", "idle", { before: "done", agent: "claude" })).toBe(false);
    expect(tracker.current("fresh")).toBe("done");
    // unknown under another agent's name is shown as working: its idle after a gap is the finish
    tracker.observe("handoff", "working", "pi");
    expect(tracker.observe("handoff", "unknown", "claude")).toBe("working");
    expect(tracker.replayed("handoff", "idle", { before: "unknown", agent: "claude" })).toBe(true);
    expect(tracker.observe("handoff", "idle", "claude")).toBe("done");
    // a browser's snapshot reported the pane at rest before the replay came: the work it did is still taken in
    const late = new CompletionTracker(null);
    late.present(snapshot([{ id: "late", status: "unknown", agent: "codex" }]));
    expect(late.replayed("late", "unknown", { before: "working", agent: "codex" })).toBe(true);
    expect(late.observe("late", "unknown", "codex")).toBe("done");
    // a browser's snapshot settled the finish first: the replay still goes on to the devices, and it stays DONE
    const settled = new CompletionTracker(null);
    settled.observe("p", "working", "claude");
    settled.present(snapshot([{ id: "p", status: "idle" }]));
    expect(settled.current("p")).toBe("done");
    expect(settled.replayed("p", "idle", { before: "working", agent: "claude" })).toBe(true);
    expect(settled.observe("p", "idle", "claude")).toBe("done");
    // work kept from before a loss of events is settled by the resync, and makes no finish of a later change at rest
    const lossy = new CompletionTracker(null);
    lossy.observe("p", "working", "codex");
    lossy.observe("q", "working", "codex");
    lossy.resync([{ pane_id: "p", agent_status: "idle", agent: "codex" }, { pane_id: "q", agent_status: "idle", agent: "codex" }], new Set(["q"]));
    expect([lossy.current("p"), lossy.current("q")]).toEqual(["done", "working"]);
    expect(lossy.replayed("p", "unknown", { before: "idle", agent: "codex" })).toBe(false);
    // another agent sits in the pane at rest after the loss: the work from before is over, not going on under its name
    const handed = new CompletionTracker(null);
    handed.observe("p", "working", "codex");
    handed.observe("gone", "working", "codex");
    handed.resync([{ pane_id: "p", agent_status: "unknown", agent: "claude" }], new Set());
    expect(handed.current("p")).toBe("done");
    expect(handed.replayed("p", "idle", { before: "unknown", agent: "claude" })).toBe(false);
    // and a pane that went during the loss is forgotten
    expect(handed.current("gone")).toBeUndefined();
    // work starting, or stopping for a question, is news from any state
    expect(tracker.replayed("fresh", "working", { before: "idle", agent: "claude" })).toBe(true);
    expect(tracker.replayed("fresh", "blocked", { before: "idle", agent: "claude" })).toBe(true);
  });
});
