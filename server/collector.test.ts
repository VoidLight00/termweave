import { describe, expect, it } from "bun:test";
import type { HerdrPane } from "../shared/protocol.ts";
import { HerdrError, type EventFrame } from "./herdr/client.ts";
import { parseFocusFrame, parseStatusFrame, parseStructureFrame, startStatusCollector, type StatusCollectorDeps, type StatusCollectorHandlers } from "./collector.ts";

/**
 * Frame shapes are the live wire format observed against herdr protocol 22 (see
 * collector.ts's header): status frames are flat with a dotted `event` key,
 * structure frames carry a snake_case `data.type`.
 */

describe("parseStatusFrame", () => {
  it("parses a real agent_status_changed frame", () => {
    const frame: EventFrame = {
      event: "pane.agent_status_changed",
      data: { agent: "claude", agent_status: "blocked", pane_id: "w3J:p1", workspace_id: "w3J" },
    };
    expect(parseStatusFrame(frame)).toEqual({ paneId: "w3J:p1", status: "blocked", agent: "claude" });
  });

  it("rejects frames that are not status events", () => {
    expect(parseStatusFrame({ event: "pane_exited", data: { type: "pane_exited", pane_id: "w1:p1" } })).toBeNull();
  });

  it("rejects malformed payloads instead of throwing", () => {
    expect(parseStatusFrame({ event: "pane.agent_status_changed", data: { pane_id: 7 } })).toBeNull();
    expect(parseStatusFrame({ event: "pane.agent_status_changed" })).toBeNull();
    expect(parseStatusFrame({})).toBeNull();
  });
});

describe("parseStructureFrame", () => {
  it("parses a pane_exited frame into a pane-ended event", () => {
    const frame: EventFrame = { event: "pane_exited", data: { type: "pane_exited", pane_id: "w3M:p1", workspace_id: "w3M" } };
    expect(parseStructureFrame(frame)).toEqual({ kind: "pane-ended", paneId: "w3M:p1" });
  });

  it("parses pane_created and pane_closed into a structure-changed event", () => {
    expect(parseStructureFrame({ data: { type: "pane_created" } })).toEqual({ kind: "structure-changed" });
    expect(parseStructureFrame({ data: { type: "pane_closed", pane_id: "w1:p1" } })).toEqual({ kind: "structure-changed", closed: "w1:p1" });
    expect(parseStructureFrame({ data: { type: "pane_closed" } })).toEqual({ kind: "structure-changed" });
  });

  it("carries the pane a pane_created frame names", () => {
    const pane = { pane_id: "w2:p1", workspace_id: "w2", tab_id: "w2:t1" };
    expect(parseStructureFrame({ event: "pane_created", data: { type: "pane_created", pane } }))
      .toEqual({ kind: "structure-changed", created: { paneId: "w2:p1", workspaceId: "w2", label: null } });
    expect(parseStructureFrame({ data: { type: "pane_created", pane: { ...pane, label: "api" } } }))
      .toEqual({ kind: "structure-changed", created: { paneId: "w2:p1", workspaceId: "w2", label: "api" } });
    // a pane without both ids is no news of a pane
    expect(parseStructureFrame({ data: { type: "pane_created", pane: { pane_id: "w2:p1" } } })).toEqual({ kind: "structure-changed" });
  });

  it("rejects unknown or malformed frames", () => {
    expect(parseStructureFrame({ data: { type: "workspace_closed" } })).toBeNull();
    expect(parseStructureFrame({ data: { type: "pane_exited", pane_id: 42 } })).toBeNull();
    expect(parseStructureFrame({})).toBeNull();
  });
});

describe("parseFocusFrame", () => {
  it("names the pane a focus lands on, from the live frame", () => {
    // live (herdr 0.9.0): a workspace brought to the front also sends pane_focused for its pane
    expect(parseFocusFrame({ event: "pane_focused", data: { pane_id: "w1A4:p1", type: "pane_focused", workspace_id: "w1A4" } })).toBe("w1A4:p1");
    expect(parseFocusFrame({ event: "tab_focused", data: { tab_id: "w1A4:t1", type: "tab_focused", workspace_id: "w1A4" } })).toBeNull();
    expect(parseFocusFrame({ data: { type: "pane_focused", pane_id: 3 } })).toBeNull();
    expect(parseFocusFrame({})).toBeNull();
  });
});

/**
 * The collector's recovery, driven through its seam: a fake herdr whose subscriptions
 * the test starts, feeds and closes, and whose snapshot it answers.
 */
interface FakeSubscription {
  types: string[];
  paneIds: string[];
  handlers: Parameters<StatusCollectorDeps["subscribe"]>[1];
  closedByCollector: boolean;
  start: () => void;
  emit: (frame: EventFrame) => void;
  /** herdr closes it, as after `events_lost` */
  drop: (code?: string) => void;
}

function fakeHerdr(initial: HerdrPane[]) {
  const subscriptions: FakeSubscription[] = [];
  let panes = initial;
  const snapshots: { at: number; resolve: () => void }[] = [];
  let calls = 0;
  let autoAnswer = true;
  const deps: Partial<StatusCollectorDeps> = {
    reconnectMinMs: 5,
    reconnectMaxMs: 40,
    backstopMs: 60_000,
    debounceMs: 5,
    snapshotRetryMs: 5,
    replaySettleMs: 5,
    subscribe: (subs, handlers) => {
      const record: FakeSubscription = {
        types: subs.map((sub) => sub.type),
        paneIds: subs.flatMap((sub) => ("pane_id" in sub && typeof sub.pane_id === "string" ? [sub.pane_id] : [])),
        handlers,
        closedByCollector: false,
        start: () => handlers.onStarted?.(),
        emit: (frame) => handlers.onEvent(frame),
        drop: (code = "events_lost") => {
          handlers.onError?.(new HerdrError(code, "event subscription fell behind"));
          handlers.onClose?.();
        },
      };
      subscriptions.push(record);
      return { close: () => { record.closedByCollector = true; } };
    },
    snapshot: () => {
      calls += 1;
      const at = calls;
      return new Promise((resolve) => {
        const answer = () => resolve({ panes });
        if (autoAnswer) queueMicrotask(answer);
        else snapshots.push({ at, resolve: answer });
      });
    },
  };
  return {
    deps,
    subscriptions,
    snapshotCalls: () => calls,
    setPanes: (next: HerdrPane[]) => { panes = next; },
    /** snapshots wait until answered by hand */
    hold: () => { autoAnswer = false; },
    answerAll: () => { for (const s of snapshots.splice(0)) s.resolve(); },
    status: () => subscriptions.filter((s) => s.types[0] === "pane.agent_status_changed" && !s.closedByCollector).at(-1),
    lifecycle: () => subscriptions.filter((s) => s.types.includes("pane.created")).at(-1)!,
    lifecycles: () => subscriptions.filter((s) => s.types.includes("pane.created")),
  };
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const paneOf = (pane_id: string, agent_status: string) => ({ pane_id, agent_status }) as unknown as HerdrPane;
const statusFrame = (pane_id: string, agent_status: string): EventFrame => ({ event: "pane.agent_status_changed", data: { pane_id, agent_status, agent: "claude" } });

function recorder() {
  const log = {
    baselines: 0,
    resyncs: [] as { panes: string[]; newer: string[] }[],
    structure: 0,
    statuses: [] as string[],
  };
  const handlers: StatusCollectorHandlers = {
    onStatus: (paneId, status, _agent, replay) => log.statuses.push(`${paneId}:${status}${replay ? ` (was ${replay.before})` : ""}`),
    onBaseline: () => { log.baselines += 1; },
    onResync: (panes, newer) => log.resyncs.push({ panes: panes.map((p) => p.pane_id), newer: [...newer].sort() }),
    onPaneEnded: () => {},
    onStructureChange: () => { log.structure += 1; },
    onFocus: () => {},
  };
  return { log, handlers };
}

describe("startStatusCollector pane creation", () => {
  it("tells a pane the moment herdr says it opened, and not one the frame does not name", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "idle")]);
    const { handlers } = recorder();
    const opened: string[] = [];
    const collector = startStatusCollector({ ...handlers, onPaneCreated: (pane) => opened.push(`${pane.workspaceId}/${pane.paneId}/${pane.label}`) }, herdr.deps);
    await tick();
    herdr.lifecycle().emit({ event: "pane_created", data: { type: "pane_created", pane: { pane_id: "w1:p2", workspace_id: "w1" } } });
    herdr.lifecycle().emit({ event: "pane_created", data: { type: "pane_created", pane_id: "w1:p3" } });
    await tick();
    expect(opened).toEqual(["w1/w1:p2/null"]);
    collector.stop();
  });
});

describe("startStatusCollector recovery", () => {
  it("snapshots again once the status subscription has started, without resyncing", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "idle")]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, herdr.deps);
    await tick();
    expect(herdr.status()?.paneIds).toEqual(["w1:p1"]);
    expect(herdr.snapshotCalls()).toBe(1);
    herdr.status()!.start();
    await tick(20);
    expect(herdr.snapshotCalls()).toBe(2);
    expect(log.resyncs).toEqual([]);
    collector.stop();
  });

  it("tells a status that changed while the subscription was reopened for another pane set", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "working")]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, herdr.deps);
    await tick();
    herdr.status()!.start();
    await tick(20);
    const first = herdr.status()!;
    // a pane opens elsewhere: the connection is reopened with both, and p1 finishes meanwhile
    herdr.setPanes([paneOf("w1:p1", "working"), paneOf("w2:p1", "idle")]);
    herdr.lifecycle().emit({ event: "pane_created", data: { type: "pane_created", pane_id: "w2:p1" } });
    await tick(20);
    const second = herdr.status()!;
    expect(second).not.toBe(first);
    expect(second.paneIds).toEqual(["w1:p1", "w2:p1"]);
    herdr.setPanes([paneOf("w1:p1", "idle"), paneOf("w2:p1", "idle")]);
    expect(log.statuses).toEqual([]);
    second.start();
    await tick(20);
    // once, as the event would have been; a pane first seen is no change; nothing was "lost"
    expect(log.statuses).toEqual(["w1:p1:idle (was working)"]);
    expect(log.resyncs).toEqual([]);
    // the same snapshot again tells nothing more, and an event since outranks an older snapshot
    herdr.hold();
    herdr.lifecycle().emit({ event: "pane_closed", data: { type: "pane_closed" } });
    await tick(20);
    second.emit(statusFrame("w1:p1", "working"));
    herdr.answerAll();
    await tick();
    expect(log.statuses).toEqual(["w1:p1:idle (was working)", "w1:p1:working"]);
    collector.stop();
  });

  it("tells a change that fell into a subscription herdr refused for a pane that had gone", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "working"), paneOf("w9:p1", "idle")]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, herdr.deps);
    await tick();
    // w9:p1 closed between the snapshot and the subscribe: herdr refuses the batch, and p1 finishes meanwhile
    herdr.setPanes([paneOf("w1:p1", "idle")]);
    herdr.status()!.drop("pane_not_found");
    await tick();
    const reopened = herdr.status()!;
    expect(reopened.paneIds).toEqual(["w1:p1"]);
    reopened.start();
    await tick(20);
    expect(log.statuses).toEqual(["w1:p1:idle (was working)"]);
    expect(log.resyncs).toEqual([]);
    collector.stop();
  });

  it("tells nothing from a snapshot that follows no gap, nor a finish herdr reads two ways", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "working")]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, { ...herdr.deps, backstopMs: 15 });
    await tick();
    herdr.status()!.start();
    await tick(20);
    herdr.status()!.emit(statusFrame("w1:p1", "done"));
    // the backstop's snapshot reads the same finish as idle: no change, and no undoing of the done
    herdr.setPanes([paneOf("w1:p1", "idle")]);
    await tick(40);
    expect(herdr.snapshotCalls()).toBeGreaterThan(2);
    expect(log.statuses).toEqual(["w1:p1:done"]);
    // around a gap it is passed on with what the pane was last told as: whoever shows the pane decides if that is a change
    herdr.setPanes([paneOf("w1:p1", "idle"), paneOf("w2:p1", "idle")]);
    herdr.lifecycle().emit({ event: "pane_created", data: { type: "pane_created", pane_id: "w2:p1" } });
    await tick(30);
    herdr.status()!.start();
    await tick(20);
    expect(log.statuses).toEqual(["w1:p1:done", "w1:p1:idle (was done)"]);
    collector.stop();
  });

  it("tells what the snapshot that closes the subscription already shows: the event for it is lost with the connection", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "working")]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, herdr.deps);
    await tick();
    herdr.status()!.start();
    await tick(20);
    // p1 finishes and a pane opens: herdr's snapshot shows both, its event for p1 is still unread when the connection closes
    herdr.setPanes([paneOf("w1:p1", "unknown"), paneOf("w2:p1", "idle")]);
    herdr.lifecycle().emit({ event: "pane_created", data: { type: "pane_created", pane_id: "w2:p1" } });
    await tick(20);
    expect(log.statuses).toEqual(["w1:p1:unknown (was working)"]);
    herdr.status()!.start();
    await tick(20);
    expect(log.statuses).toEqual(["w1:p1:unknown (was working)"]);
    collector.stop();
  });

  it("lets an event that was on its way outrank the snapshot that overtook it", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "blocked")]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, { ...herdr.deps, replaySettleMs: 40 });
    await tick();
    herdr.status()!.start();
    await tick(20);
    herdr.setPanes([paneOf("w1:p1", "blocked"), paneOf("w2:p1", "idle")]);
    herdr.lifecycle().emit({ event: "pane_created", data: { type: "pane_created", pane_id: "w2:p1" } });
    await tick(70);
    // answered, worked and finished right after the new subscription started: the snapshot says idle before its two events are read
    herdr.setPanes([paneOf("w1:p1", "idle"), paneOf("w2:p1", "idle")]);
    const live = herdr.status()!;
    live.start();
    await tick(10);
    live.emit(statusFrame("w1:p1", "working"));
    live.emit(statusFrame("w1:p1", "idle"));
    await tick(60);
    // told once each, in the order they happened, and no finish before the work
    expect(log.statuses).toEqual(["w1:p1:working", "w1:p1:idle"]);
    collector.stop();
  });

  it("tells nothing of a pane closed, or once the subscription is lost, while a replay waits", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "working"), paneOf("w1:p2", "working")]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, { ...herdr.deps, replaySettleMs: 40 });
    await tick();
    herdr.status()!.start();
    await tick(20);
    herdr.setPanes([paneOf("w1:p1", "working"), paneOf("w1:p2", "working"), paneOf("w2:p1", "idle")]);
    herdr.lifecycle().emit({ event: "pane_created", data: { type: "pane_created", pane_id: "w2:p1" } });
    await tick(70);
    // both finish in the gap; while the replay waits, p1 is closed (no exit frame)
    herdr.setPanes([paneOf("w1:p1", "idle"), paneOf("w1:p2", "idle"), paneOf("w2:p1", "idle")]);
    herdr.status()!.start();
    await tick(10);
    herdr.lifecycle().emit({ event: "pane_closed", data: { type: "pane_closed", pane_id: "w1:p1" } });
    await tick(60);
    expect(log.statuses).toEqual(["w1:p2:idle (was working)"]);
    collector.stop();

    const lost = fakeHerdr([paneOf("w1:p1", "working")]);
    const second = recorder();
    const other = startStatusCollector(second.handlers, { ...lost.deps, replaySettleMs: 40 });
    await tick();
    lost.status()!.start();
    await tick(20);
    lost.setPanes([paneOf("w1:p1", "working"), paneOf("w2:p1", "idle")]);
    lost.lifecycle().emit({ event: "pane_created", data: { type: "pane_created", pane_id: "w2:p1" } });
    await tick(70);
    lost.setPanes([paneOf("w1:p1", "idle"), paneOf("w2:p1", "idle")]);
    lost.status()!.start();
    await tick(10);
    // herdr drops the new subscription while the replay waits: from here on nobody knows what was missed
    lost.status()!.drop();
    await tick(60);
    expect(second.log.statuses).toEqual([]);
    other.stop();
  });

  it("leaves out of the replay a pane that ended or came to the front while the snapshot was on its way", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "working"), paneOf("w1:p2", "working")]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, herdr.deps);
    await tick();
    herdr.status()!.start();
    await tick(20);
    herdr.setPanes([paneOf("w1:p1", "working"), paneOf("w1:p2", "working"), paneOf("w2:p1", "idle")]);
    herdr.lifecycle().emit({ event: "pane_created", data: { type: "pane_created", pane_id: "w2:p1" } });
    await tick(20);
    // both finish in the gap
    herdr.setPanes([paneOf("w1:p1", "idle"), paneOf("w1:p2", "idle"), paneOf("w2:p1", "idle")]);
    herdr.hold();
    herdr.status()!.start();
    await tick(20);
    // the snapshot that will replay is asked for; p1 exits and p2 is brought to the front before it answers
    herdr.lifecycle().emit({ event: "pane_exited", data: { type: "pane_exited", pane_id: "w1:p1" } });
    herdr.subscriptions.find((s) => s.types[0] === "pane.focused")!.emit({ event: "pane_focused", data: { type: "pane_focused", pane_id: "w1:p2" } });
    herdr.answerAll();
    await tick();
    expect(log.statuses).toEqual([]);
    collector.stop();
  });

  it("forgets what a pane was heard as once it came to the front, and recovers silently when a snapshot fails in a gap", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "working"), paneOf("w1:p2", "working")]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, herdr.deps);
    await tick();
    herdr.status()!.start();
    await tick(20);
    // p1 is brought to the front; later a gap, in which both read idle
    herdr.subscriptions.find((s) => s.types[0] === "pane.focused")!.emit({ event: "pane_focused", data: { type: "pane_focused", pane_id: "w1:p1" } });
    herdr.setPanes([paneOf("w1:p1", "working"), paneOf("w1:p2", "working"), paneOf("w2:p1", "idle")]);
    herdr.lifecycle().emit({ event: "pane_created", data: { type: "pane_created", pane_id: "w2:p1" } });
    await tick(20);
    herdr.setPanes([paneOf("w1:p1", "working"), paneOf("w1:p2", "idle"), paneOf("w2:p1", "idle")]);
    herdr.status()!.start();
    await tick(20);
    // p2's finish is told; p1 was taken in anew by the snapshot that saw the new pane, and did not change since
    expect(log.statuses).toEqual(["w1:p2:idle (was working)"]);
    collector.stop();

    const broken = fakeHerdr([paneOf("w1:p1", "working")]);
    const second = recorder();
    let failing = false;
    const snapshot = broken.deps.snapshot!;
    const flaky = startStatusCollector(second.handlers, { ...broken.deps, snapshot: () => failing ? Promise.reject(new HerdrError("timeout", "no answer")) : snapshot() });
    await tick();
    broken.status()!.start();
    await tick(20);
    broken.setPanes([paneOf("w1:p1", "working"), paneOf("w2:p1", "idle")]);
    broken.lifecycle().emit({ event: "pane_created", data: { type: "pane_created", pane_id: "w2:p1" } });
    await tick(20);
    // herdr stops answering snapshots inside the gap, for nobody knows how long; p1 finishes meanwhile
    failing = true;
    broken.status()!.start();
    await tick(20);
    broken.setPanes([paneOf("w1:p1", "idle"), paneOf("w2:p1", "idle")]);
    failing = false;
    await tick(30);
    expect(second.log.statuses).toEqual([]);
    expect(second.log.resyncs).toHaveLength(1);
    flaky.stop();
  });

  it("still tells the finish of work that was brought to the front while it went on", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "working")]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, herdr.deps);
    await tick();
    herdr.status()!.start();
    await tick(20);
    herdr.subscriptions.find((s) => s.types[0] === "pane.focused")!.emit({ event: "pane_focused", data: { type: "pane_focused", pane_id: "w1:p1" } });
    herdr.setPanes([paneOf("w1:p1", "working"), paneOf("w2:p1", "idle")]);
    herdr.lifecycle().emit({ event: "pane_created", data: { type: "pane_created", pane_id: "w2:p1" } });
    await tick(30);
    herdr.setPanes([paneOf("w1:p1", "idle"), paneOf("w2:p1", "idle")]);
    herdr.status()!.start();
    await tick(30);
    expect(log.statuses).toEqual(["w1:p1:idle (was working)"]);
    collector.stop();
  });

  it("reads an event still on its way before it closes the connection, also when the snapshot shows nothing to replay", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "working")]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, { ...herdr.deps, replaySettleMs: 40 });
    await tick();
    herdr.status()!.start();
    await tick(20);
    const live = herdr.status()!;
    // brought to the front: what p1 was told as is forgotten, so the snapshot has nothing to measure it against
    herdr.subscriptions.find((s) => s.types[0] === "pane.focused")!.emit({ event: "pane_focused", data: { type: "pane_focused", pane_id: "w1:p1" } });
    herdr.setPanes([paneOf("w1:p1", "idle"), paneOf("w2:p1", "idle")]);
    herdr.lifecycle().emit({ event: "pane_created", data: { type: "pane_created", pane_id: "w2:p1" } });
    await tick(20);
    // the finish arrives on the old connection while the collector waits before closing it
    expect(live.closedByCollector).toBe(false);
    live.emit(statusFrame("w1:p1", "idle"));
    await tick(60);
    expect(live.closedByCollector).toBe(true);
    expect(log.statuses).toEqual(["w1:p1:idle"]);
    collector.stop();
  });

  it("recovers without telling when the reopened subscription could not connect", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "working")]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, herdr.deps);
    await tick();
    herdr.status()!.start();
    await tick(20);
    herdr.setPanes([paneOf("w1:p1", "working"), paneOf("w2:p1", "idle")]);
    herdr.lifecycle().emit({ event: "pane_created", data: { type: "pane_created", pane_id: "w2:p1" } });
    await tick(20);
    // herdr cannot be reached: nobody knows for how long nothing listened
    herdr.status()!.drop("connect_failed");
    herdr.setPanes([paneOf("w1:p1", "idle"), paneOf("w2:p1", "idle")]);
    await tick();
    herdr.status()!.start();
    await tick(20);
    expect(log.statuses).toEqual([]);
    expect(log.resyncs).toHaveLength(1);
    collector.stop();
  });

  it("resubscribes after events_lost and resyncs from a snapshot taken after the start", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "working"), paneOf("w1:p2", "working")]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, herdr.deps);
    await tick();
    herdr.status()!.start();
    await tick(20);
    const lost = herdr.status()!;
    herdr.setPanes([paneOf("w1:p1", "idle"), paneOf("w1:p2", "blocked")]);
    lost.drop();
    await tick();
    const reopened = herdr.status()!;
    expect(reopened).not.toBe(lost);
    // nothing is resynced before the new subscription is live
    expect(log.resyncs).toEqual([]);
    const before = herdr.snapshotCalls();
    reopened.start();
    await tick(20);
    expect(herdr.snapshotCalls()).toBe(before + 1);
    expect(log.resyncs).toEqual([{ panes: ["w1:p1", "w1:p2"], newer: [] }]);
    expect(log.structure).toBe(1);
    collector.stop();
  });

  it("still resyncs a pane that only came to the front while the recovery snapshot was on its way", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "working"), paneOf("w1:p2", "working")]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, herdr.deps);
    await tick();
    herdr.status()!.start();
    await tick(20);
    herdr.setPanes([paneOf("w1:p1", "idle"), paneOf("w1:p2", "idle")]);
    herdr.status()!.drop();
    await tick();
    herdr.hold();
    herdr.status()!.start();
    await tick();
    // p1 is brought to the front, p2 exits, while the recovery snapshot is on its way
    herdr.subscriptions.find((s) => s.types[0] === "pane.focused")!.emit({ event: "pane_focused", data: { type: "pane_focused", pane_id: "w1:p1" } });
    herdr.lifecycle().emit({ event: "pane_exited", data: { type: "pane_exited", pane_id: "w1:p2" } });
    herdr.answerAll();
    await tick(20);
    expect(log.resyncs).toEqual([{ panes: ["w1:p1", "w1:p2"], newer: ["w1:p2"] }]);
    collector.stop();
  });

  it("leaves out of the resync a pane whose event arrived while the snapshot was on its way", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "working"), paneOf("w1:p2", "working")]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, herdr.deps);
    await tick();
    herdr.status()!.start();
    await tick(20);
    herdr.status()!.drop();
    await tick();
    herdr.hold();
    const reopened = herdr.status()!;
    reopened.start();
    await tick(20);
    reopened.emit(statusFrame("w1:p2", "idle"));
    herdr.answerAll();
    await tick();
    expect(log.statuses).toEqual(["w1:p2:idle"]);
    expect(log.resyncs).toEqual([{ panes: ["w1:p1", "w1:p2"], newer: ["w1:p2"] }]);
    collector.stop();
  });

  it("reconciles when the lifecycle subscription comes back, not on its first start", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "idle")]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, herdr.deps);
    await tick();
    herdr.lifecycle().start();
    await tick(20);
    expect(log.structure).toBe(0);
    const calls = herdr.snapshotCalls();
    // a pane created while the lifecycle stream was lost
    herdr.setPanes([paneOf("w1:p1", "idle"), paneOf("w1:p2", "idle")]);
    herdr.lifecycle().drop();
    await tick(10);
    expect(herdr.lifecycles().length).toBe(2);
    herdr.lifecycle().start();
    await tick(20);
    expect(log.structure).toBe(1);
    expect(herdr.snapshotCalls()).toBeGreaterThan(calls);
    expect(herdr.status()?.paneIds).toEqual(["w1:p1", "w1:p2"]);
    collector.stop();
  });

  it("backs off while a subscription keeps closing before it starts, and resets once one starts", async () => {
    const herdr = fakeHerdr([]);
    const { handlers } = recorder();
    // long enough that a busy runner's timer lateness stays small beside the doubling
    const collector = startStatusCollector(handlers, { ...herdr.deps, reconnectMinMs: 20, reconnectMaxMs: 160 });
    const opened: number[] = [];
    const t0 = Date.now();
    for (let i = 0; i < 4; i++) {
      herdr.lifecycle().drop("connect_failed");
      const count = herdr.lifecycles().length;
      while (herdr.lifecycles().length === count) await tick(1);
      opened.push(Date.now() - t0);
    }
    const gaps = opened.map((at, i) => at - (opened[i - 1] ?? 0));
    // 20, 40, 80, 160 ms
    expect(gaps[3]!).toBeGreaterThanOrEqual(120);
    herdr.lifecycle().start();
    const count = herdr.lifecycles().length;
    const dropped = Date.now();
    herdr.lifecycle().drop();
    while (herdr.lifecycles().length === count) await tick(1);
    // back to the first delay once one started
    expect(Date.now() - dropped).toBeLessThan(100);
    collector.stop();
  });

  it("does not let a snapshot asked for a subscription that closed meanwhile end the recovery", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "working")]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, herdr.deps);
    await tick();
    herdr.status()!.start();
    await tick(20);
    herdr.status()!.drop();
    await tick();
    herdr.hold();
    const second = herdr.status()!;
    second.start();
    await tick(20);
    // the snapshot for `second` is on its way when `second` is lost too
    second.drop();
    await tick();
    herdr.setPanes([paneOf("w1:p1", "idle")]);
    herdr.answerAll();
    await tick(10);
    expect(log.resyncs).toEqual([]);
    const third = herdr.status()!;
    expect(third).not.toBe(second);
    third.start();
    // answer whatever is asked, including the reconcile queued behind an earlier one
    for (let i = 0; i < 4; i++) { await tick(5); herdr.answerAll(); }
    await tick(10);
    expect(log.resyncs).toEqual([{ panes: ["w1:p1"], newer: [] }]);
    collector.stop();
  });

  it("reconciles when a lifecycle retry starts although the first attempt never did", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "idle")]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, herdr.deps);
    await tick();
    herdr.setPanes([paneOf("w1:p1", "idle"), paneOf("w1:p2", "idle")]);
    herdr.lifecycle().drop("connect_failed");
    await tick(10);
    const calls = herdr.snapshotCalls();
    herdr.lifecycle().start();
    await tick(20);
    expect(log.structure).toBe(1);
    expect(herdr.snapshotCalls()).toBeGreaterThan(calls);
    collector.stop();
  });

  it("does nothing more once stopped, even mid-recovery", async () => {
    const herdr = fakeHerdr([paneOf("w1:p1", "working")]);
    const { log, handlers } = recorder();
    const collector = startStatusCollector(handlers, herdr.deps);
    await tick();
    herdr.status()!.start();
    await tick(20);
    herdr.status()!.drop();
    herdr.lifecycle().drop();
    collector.stop();
    const subscriptions = herdr.subscriptions.length;
    await tick(60);
    expect(herdr.subscriptions.length).toBe(subscriptions);
    expect(log.resyncs).toEqual([]);
  });
});
