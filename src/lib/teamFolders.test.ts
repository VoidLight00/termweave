import { describe, expect, it } from "bun:test";
import { addTeamFolder, assignTeamPane, emptyTeamFolders, parseTeamFolders, readTeamFolders, removeTeamFolder, teamFolderPath, teamFoldersKey, writeTeamFolders } from "./teamFolders.ts";
import type { ColorStorage } from "./sessionColor.ts";

const nested = () => addTeamFolder(addTeamFolder(emptyTeamFolders(), "team", "개발팀", null), "sub", "검증팀", "team");

describe("team folder presentation metadata", () => {
  it("starts empty without migrating or changing existing sessions", () => {
    expect(parseTeamFolders(null)).toEqual(emptyTeamFolders());
    expect(parseTeamFolders("{}")).toEqual(emptyTeamFolders());
    expect(parseTeamFolders("invalid")).toEqual(emptyTeamFolders());
  });
  it("creates nested folders, trims names and rejects empty or orphan folders", () => {
    const state = nested();
    expect(teamFolderPath(state, "sub")).toBe("개발팀 / 검증팀");
    expect(addTeamFolder(state, "empty", "  ", null)).toBe(state);
    expect(addTeamFolder(state, "orphan", "x", "absent")).toBe(state);
    expect(addTeamFolder(state, "team", "duplicate", null)).toBe(state);
    expect(addTeamFolder(state, "new", "  운영팀  ", null).folders.at(-1)?.name).toBe("운영팀");
  });
  it("assigns and unassigns a pane immutably; rejects unknown destinations", () => {
    const state = nested();
    const assigned = assignTeamPane(state, "pane-1", "sub");
    expect(state.assignments).toEqual({});
    expect(assigned.assignments).toEqual({ "pane-1": "sub" });
    expect(assignTeamPane(assigned, "pane-1", "missing")).toBe(assigned);
    expect(assignTeamPane(assigned, "pane-1", "team").assignments).toEqual({ "pane-1": "team" });
    expect(assignTeamPane(assigned, "pane-1", null).assignments).toEqual({});
  });
  it("removes only a folder and promotes its children and assigned panes", () => {
    const state = assignTeamPane(assignTeamPane(nested(), "p1", "sub"), "p2", "team");
    const withoutChild = removeTeamFolder(state, "sub");
    expect(withoutChild.assignments).toEqual({ p1: "team", p2: "team" });
    const withoutParent = removeTeamFolder(state, "team");
    expect(withoutParent.folders[0]?.parentId).toBeNull();
    expect(withoutParent.assignments).toEqual({ p1: "sub" });
    expect(state.folders).toHaveLength(2);
    expect(removeTeamFolder(state, "missing")).toBe(state);
  });
  it("round trips nested folders, collapse, and assignments across reload", () => {
    const state = assignTeamPane(nested(), "pane-1", "sub");
    const collapsed = { ...state, folders: state.folders.map(f => ({ ...f, collapsed: true })) };
    const data = new Map<string, string>();
    const storage: ColorStorage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: key => { data.delete(key); } };
    const key = teamFoldersKey("local", "project");
    expect(writeTeamFolders(storage, key, collapsed)).toBe(true);
    expect(readTeamFolders(storage, key)).toEqual(collapsed);
    expect(readTeamFolders(storage, teamFoldersKey("remote", "project"))).toEqual(emptyTeamFolders());
    expect(readTeamFolders(storage, teamFoldersKey("local", "other"))).toEqual(emptyTeamFolders());
  });
  it("fails safely for blocked storage and invalid tree metadata", () => {
    const blocked: ColorStorage = { getItem: () => { throw Error("blocked"); }, setItem: () => { throw Error("full"); }, removeItem: () => {} };
    expect(readTeamFolders(blocked, "key")).toEqual(emptyTeamFolders());
    expect(writeTeamFolders(blocked, "key", nested())).toBe(false);
    expect(writeTeamFolders(null, "key", nested())).toBe(false);
    for (const folders of [
      [{ id: "a", name: "a", parentId: "a" }],
      [{ id: "a", name: "a", parentId: "b" }, { id: "b", name: "b", parentId: "a" }],
      [{ id: "a", name: "a", parentId: "missing" }],
      [{ id: "a", name: "a", parentId: null }, { id: "a", name: "duplicate", parentId: null }],
    ]) expect(parseTeamFolders(JSON.stringify({ folders }))).toEqual(emptyTeamFolders());
  });
  it("drops invalid assignments so a live pane remains visible at the workspace root", () => {
    const state = parseTeamFolders(JSON.stringify({ ...nested(), assignments: { p1: "sub", p2: "deleted", p3: 42 } }));
    expect(state.assignments).toEqual({ p1: "sub" });
  });
});
