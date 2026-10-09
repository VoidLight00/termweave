import { expect, it } from "bun:test";
import type { Machine } from "../../shared/machines.ts";
import type { SessionSnapshot } from "../../shared/protocol.ts";
import { panesNeedingInput } from "./needsInput.ts";

function machine(id: string, state: Machine["state"] = "connected"): Machine {
  return { id, name: id, kind: "ssh", enabled: true, state, error: null, snapshot: {
    workspaces: [{ workspace_id: "second", label: "Second" }, { workspace_id: "first", label: "First" }],
    panes: [
      { workspace_id: "first", pane_id: "same-id", agent_status: "blocked" },
      { workspace_id: "second", pane_id: "running", agent_status: "working" },
      { workspace_id: "second", pane_id: "waiting", agent_status: "blocked" },
    ],
  } as SessionSnapshot };
}

it("gathers blocked panes in PC and workspace order without changing the roster", () => {
  const machines = [machine("local"), machine("remote")];
  const before = JSON.stringify(machines);
  expect(panesNeedingInput(machines).map(({ machine, pane }) => [machine.id, pane.pane_id])).toEqual([
    ["local", "waiting"], ["local", "same-id"], ["remote", "waiting"], ["remote", "same-id"],
  ]);
  expect(JSON.stringify(machines)).toBe(before);
});

it("drops resumed, closed, offline and missing-roster panes", () => {
  const online = machine("online");
  online.snapshot!.panes[0]!.agent_status = "working";
  online.snapshot!.panes.pop();
  const missing = machine("missing"); missing.snapshot = null;
  expect(panesNeedingInput([online, missing, machine("offline", "disconnected"), machine("reconnecting", "reconnecting")])).toEqual([]);
});
