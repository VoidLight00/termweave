import { describe, expect, it, spyOn } from "bun:test";
import { createPaneMesh, nextLabel } from "./pane-mesh.ts";

type Pane = { pane_id: string; workspace_id: string; label?: string | null };
const pane = (id: string, label?: string | null, workspace = "w1"): Pane => ({ pane_id: id, workspace_id: workspace, ...(label === undefined ? {} : { label }) });

/** a herdr that keeps labels the way pane.rename does */
function fakeHerdr(initial: Pane[], failFor: string[] = []) {
  const panes = initial.map((p) => ({ ...p }));
  const renames: Array<[string, string]> = [];
  return {
    renames,
    snapshot: async () => ({ panes: panes.map((p) => ({ ...p })) }),
    rename: async (id: string, label: string) => {
      await Bun.sleep(1);
      if (failFor.includes(id)) throw new Error("rename refused");
      const target = panes.find((p) => p.pane_id === id);
      if (target) target.label = label;
      renames.push([id, label]);
    },
    add: (p: Pane) => void panes.push({ ...p }),
  };
}
const created = (id: string, workspaceId = "w1", label: string | null = null) => ({ paneId: id, workspaceId, label });

describe("nextLabel", () => {
  it("starts at pane 1 and fills the smallest gap", () => {
    expect(nextLabel([], "w1")).toBe("pane 1");
    expect(nextLabel([pane("w1:p1", "pane 1"), pane("w1:p2", "pane 3")], "w1")).toBe("pane 2");
  });

  it("counts each workspace on its own", () => {
    expect(nextLabel([pane("w2:p1", "pane 1", "w2")], "w1")).toBe("pane 1");
  });

  it("does not mistake a name someone chose for a number", () => {
    const named = [pane("w1:p1", "build"), pane("w1:p2", "Pane 1"), pane("w1:p3", "pane 01"), pane("w1:p4", "pane 1 old"), pane("w1:p5", null)];
    expect(nextLabel(named, "w1")).toBe("pane 1");
  });
});

describe("createPaneMesh", () => {
  const on = () => true;

  it("names a new pane that has no label", async () => {
    const herdr = fakeHerdr([pane("w1:p1"), pane("w1:p2")]);
    await createPaneMesh({ ...herdr, enabled: on }).onPaneCreated(created("w1:p2"));
    expect(herdr.renames).toEqual([["w1:p2", "pane 1"]]);
  });

  it("gives panes opened together different numbers", async () => {
    const herdr = fakeHerdr([pane("w1:p1"), pane("w1:p2"), pane("w1:p3")]);
    const mesh = createPaneMesh({ ...herdr, enabled: on });
    await Promise.all(["w1:p1", "w1:p2", "w1:p3"].map((id) => mesh.onPaneCreated(created(id))));
    expect(herdr.renames).toEqual([["w1:p1", "pane 1"], ["w1:p2", "pane 2"], ["w1:p3", "pane 3"]]);
  });

  it("leaves a pane alone that came with a label", async () => {
    const herdr = fakeHerdr([pane("w1:p1", "deploy")]);
    await createPaneMesh({ ...herdr, enabled: on }).onPaneCreated(created("w1:p1", "w1", "deploy"));
    expect(herdr.renames).toEqual([]);
  });

  it("leaves a pane alone that someone named while it waited its turn", async () => {
    const herdr = fakeHerdr([pane("w1:p1", "mine")]);
    await createPaneMesh({ ...herdr, enabled: on }).onPaneCreated(created("w1:p1"));
    expect(herdr.renames).toEqual([]);
  });

  it("skips a pane that closed before its turn", async () => {
    const herdr = fakeHerdr([pane("w1:p1")]);
    await createPaneMesh({ ...herdr, enabled: on }).onPaneCreated(created("w1:p9"));
    expect(herdr.renames).toEqual([]);
  });

  it("does nothing while switched off", async () => {
    const herdr = fakeHerdr([pane("w1:p1")]);
    await createPaneMesh({ ...herdr, enabled: () => false }).onPaneCreated(created("w1:p1"));
    expect(herdr.renames).toEqual([]);
  });

  it("goes on with the next pane after a rename failed", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    const herdr = fakeHerdr([pane("w1:p1"), pane("w1:p2")], ["w1:p1"]);
    const mesh = createPaneMesh({ ...herdr, enabled: on });
    await Promise.all([mesh.onPaneCreated(created("w1:p1")), mesh.onPaneCreated(created("w1:p2"))]);
    expect(herdr.renames).toEqual([["w1:p2", "pane 1"]]);
    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });
});
