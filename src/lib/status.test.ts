import { describe, expect, it } from "bun:test";

import { statusEdgeRead, workspaceStatusSummary } from "./status.ts";
import type { HerdrPane, SessionSnapshot } from "../../shared/protocol.ts";
import { applyPaneStatus } from "./snapshot.ts";

const pane = (paneId: string, status: string, backgroundTasks = 0, workspaceId = "ws"): HerdrPane => ({
  pane_id: paneId, workspace_id: workspaceId, tab_id: `tab-${paneId}`, terminal_id: paneId,
  focused: false, revision: 0, agent_status: status, background_tasks: backgroundTasks,
});

describe("workspaceStatusSummary", () => {
  it("counts simultaneous states across hidden tabs, without double-counting working children", () => {
    const panes = [pane("input", "blocked", 2), pane("worker", "working", 3),
      pane("answer", "done", 1), pane("ready", "idle"), pane("future", "new-state"),
      pane("other", "blocked", 10, "other")];
    expect(workspaceStatusSummary(panes, "ws")).toEqual({
      needsInput: { count: 1, paneId: "input" },
      running: { count: 3, paneId: "input" },
      done: { count: 1, paneId: "answer" },
      backgroundTasks: 6,
    });
    expect(panes[1]?.background_tasks).toBe(3);
  });

  it("counts only explicit done, and does not invent a state for empty or ready workspaces", () => {
    expect(workspaceStatusSummary([pane("ready", "idle"), pane("future", "new-state", -1)], "ws")).toEqual({
      needsInput: { count: 0, paneId: null }, running: { count: 0, paneId: null },
      done: { count: 0, paneId: null }, backgroundTasks: 0,
    });
    expect(workspaceStatusSummary([pane("done", "done")], "missing").done.count).toBe(0);
  });

  it("includes background-only ready and unknown panes as running, never done", () => {
    expect(workspaceStatusSummary([pane("idle-child", "idle", 2), pane("unknown-child", "future", 1)], "ws")).toEqual({
      needsInput: { count: 0, paneId: null }, running: { count: 2, paneId: "idle-child" },
      done: { count: 0, paneId: null }, backgroundTasks: 3,
    });
  });

  it("updates aggregation from pushed pane status while workspace status remains stale", () => {
    const current: SessionSnapshot = {
      protocol: 1, version: "fixture", agents: [], layouts: [], tabs: [],
      panes: [pane("waiting", "blocked", 2), pane("worker", "working", 3), pane("answer", "done", 1)],
      workspaces: [{ workspace_id: "ws", label: "Mixed", active_tab_id: "active", agent_status: "idle",
        focused: false, number: 1, pane_count: 3, tab_count: 3 }],
    };
    const resumed = applyPaneStatus(current, "waiting", "idle", 0);
    expect(resumed.workspaces).toBe(current.workspaces);
    expect(resumed.workspaces[0]?.agent_status).toBe("idle");
    expect(resumed.panes).toHaveLength(3);
    expect(workspaceStatusSummary(resumed.panes, "ws")).toEqual({
      needsInput: { count: 0, paneId: null }, running: { count: 2, paneId: "worker" },
      done: { count: 1, paneId: "answer" }, backgroundTasks: 4,
    });
    const answered = applyPaneStatus(resumed, "worker", "done", 0);
    expect(answered.workspaces).toBe(current.workspaces);
    expect(workspaceStatusSummary(answered.panes, "ws")).toEqual({
      needsInput: { count: 0, paneId: null }, running: { count: 1, paneId: "answer" },
      done: { count: 2, paneId: "worker" }, backgroundTasks: 1,
    });
    expect(current.panes[0]?.agent_status).toBe("blocked");
  });

  it("chooses the first matching pane deterministically and updates targets from fresh panes", () => {
    const panes = [pane("first", "blocked"), pane("hidden", "blocked"), pane("run", "working")];
    expect(workspaceStatusSummary(panes, "ws").needsInput).toEqual({ count: 2, paneId: "first" });
    expect(workspaceStatusSummary(panes.slice(1), "ws").needsInput).toEqual({ count: 1, paneId: "hidden" });
    expect(workspaceStatusSummary(panes, "ws").running).toEqual({ count: 1, paneId: "run" });
  });
});

describe("statusEdgeRead", () => {
  it("reads at once when a turn starts or ends", () => {
    expect(statusEdgeRead("working", "done")).toBe(true);
    expect(statusEdgeRead("working", "idle")).toBe(true);
    expect(statusEdgeRead("working", "blocked")).toBe(true);
    expect(statusEdgeRead("idle", "working")).toBe(true);
    expect(statusEdgeRead("done", "working")).toBe(true);
    expect(statusEdgeRead(undefined, "working")).toBe(true);
  });

  it("leaves an unchanged status and changes that neither start nor end a turn to the poll", () => {
    expect(statusEdgeRead("working", "working")).toBe(false);
    expect(statusEdgeRead("idle", "idle")).toBe(false);
    expect(statusEdgeRead("idle", "done")).toBe(false);
    expect(statusEdgeRead("blocked", "idle")).toBe(false);
    expect(statusEdgeRead(undefined, undefined)).toBe(false);
  });
});
