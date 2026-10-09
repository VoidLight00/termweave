import { describe, expect, it } from "bun:test";

import type { WorkspaceInfo } from "../../shared/protocol.ts";
import { rankPanes, type SearchPane } from "./paletteSearch.ts";

function pane(paneId: string, fields: Partial<SearchPane> = {}): SearchPane {
  return {
    pane_id: paneId,
    workspace_id: "w1",
    tab_id: "t1",
    terminal_id: `term-${paneId}`,
    agent_status: "idle",
    focused: false,
    revision: 1,
    ...fields,
  };
}

const workspaces = [
  { workspace_id: "w1", label: "Frontend", active_tab_id: "t1", agent_status: "idle", focused: false, number: 1, pane_count: 2, tab_count: 1 },
  { workspace_id: "w2", label: "Backend", active_tab_id: "t2", agent_status: "working", focused: false, number: 2, pane_count: 1, tab_count: 1 },
] satisfies WorkspaceInfo[];

const panes = [
  pane("alpha", { label: "Dashboard", cwd: "/work/client", agent: "claude" }),
  pane("beta", { label: "Database migration", cwd: "/work/server", agent: "codex", workspace_id: "w2" }),
  pane("gamma", { title: "Shell", cwd: "/work/frontend-tools" }),
];

describe("rankPanes", () => {
  it("keeps session order for an empty query", () => {
    expect(rankPanes("  ", panes, workspaces).map((item) => item.pane_id)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("searches title, cwd, workspace and agent metadata", () => {
    expect(rankPanes("migration", panes, workspaces).map((item) => item.pane_id)).toEqual(["beta"]);
    expect(rankPanes("server", panes, workspaces).map((item) => item.pane_id)).toEqual(["beta"]);
    expect(rankPanes("backend", panes, workspaces).map((item) => item.pane_id)).toEqual(["beta"]);
    expect(rankPanes("claude", panes, workspaces).map((item) => item.pane_id)).toEqual(["alpha"]);
  });

  it("supports ordered fuzzy characters and ranks a direct match first", () => {
    expect(rankPanes("dsh", panes, workspaces).map((item) => item.pane_id)).toEqual(["alpha"]);
    expect(rankPanes("front", panes, workspaces).map((item) => item.pane_id)).toEqual(["alpha", "gamma"]);
    expect(rankPanes("zzq", panes, workspaces)).toEqual([]);
  });
});

it("P-number jump is exact and never falls through to a matching title",()=>{
 const items=[pane("one",{global_pane_number:3}),pane("two",{global_pane_number:30,label:"P3"})];
 expect(rankPanes("P3",items,workspaces).map(p=>p.pane_id)).toEqual(["one"]);
 expect(rankPanes("p99",items,workspaces)).toEqual([]);
});
