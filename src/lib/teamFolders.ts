import type { ColorStorage } from "./sessionColor.ts";

export interface TeamFolder { id: string; name: string; parentId: string | null; collapsed: boolean }
export interface TeamFolders { folders: TeamFolder[]; assignments: Record<string, string> }
export const emptyTeamFolders = (): TeamFolders => ({ folders: [], assignments: {} });
export const teamFoldersKey = (machine: string, workspace: string): string =>
  `termweave:team-folders:v1:${JSON.stringify([machine, workspace])}`;

/** Invalid or cyclic metadata must never hide a live terminal. Native sessions are untouched. */
export function parseTeamFolders(value: string | null): TeamFolders {
  try {
    const data = JSON.parse(value ?? "null");
    if (!data || !Array.isArray(data.folders)) return emptyTeamFolders();
    const folders: TeamFolder[] = data.folders.filter((f: unknown): f is TeamFolder => {
      if (!f || typeof f !== "object") return false;
      const item = f as Partial<TeamFolder>;
      return typeof item.id === "string" && !!item.id && typeof item.name === "string" && !!item.name.trim() &&
        (item.parentId === null || typeof item.parentId === "string");
    })
      .map((f: TeamFolder) => ({ id: f.id, name: f.name.trim(), parentId: f.parentId, collapsed: f.collapsed === true }));
    const ids = new Set(folders.map(f => f.id));
    if (ids.size !== folders.length) return emptyTeamFolders();
    const byId = new Map(folders.map(f => [f.id, f]));
    const valid = folders.every(folder => {
      const seen = new Set([folder.id]);
      let parent = folder.parentId;
      while (parent !== null) {
        if (seen.has(parent) || !byId.has(parent)) return false;
        seen.add(parent);
        parent = byId.get(parent)!.parentId;
      }
      return true;
    });
    if (!valid) return emptyTeamFolders();
    const assignments = Object.fromEntries(Object.entries(data.assignments ?? {})
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && ids.has(entry[1])));
    return { folders, assignments };
  } catch { return emptyTeamFolders(); }
}

export function readTeamFolders(storage: ColorStorage | null, key: string): TeamFolders {
  try { return parseTeamFolders(storage?.getItem(key) ?? null); } catch { return emptyTeamFolders(); }
}
export function writeTeamFolders(storage: ColorStorage | null, key: string, state: TeamFolders): boolean {
  try {
    if (!storage) return false;
    storage.setItem(key, JSON.stringify(state));
    return true;
  } catch { return false; }
}
export function addTeamFolder(state: TeamFolders, id: string, name: string, parentId: string | null): TeamFolders {
  if (!id || !name.trim() || state.folders.some(f => f.id === id) ||
    (parentId !== null && !state.folders.some(f => f.id === parentId))) return state;
  return { ...state, folders: [...state.folders, { id, name: name.trim(), parentId, collapsed: false }] };
}
/** Persist terminal identity, not the reusable pane slot. Missing terminal IDs remain unassigned. */
export function assignTeamPane(state: TeamFolders, terminalId: string, folderId: string | null): TeamFolders {
  if (!terminalId || (folderId !== null && !state.folders.some(f => f.id === folderId))) return state;
  const { [terminalId]: _, ...rest } = state.assignments;
  return { ...state, assignments: folderId === null ? rest : { ...rest, [terminalId]: folderId } };
}
/** Delete only the folder. Its children and terminals return to its parent, never close. */
export function removeTeamFolder(state: TeamFolders, id: string): TeamFolders {
  const folder = state.folders.find(f => f.id === id);
  if (!folder) return state;
  return {
    folders: state.folders.filter(f => f.id !== id).map(f => f.parentId === id ? { ...f, parentId: folder.parentId } : f),
    assignments: Object.fromEntries(Object.entries(state.assignments).flatMap(([pane, target]) =>
      target !== id ? [[pane, target]] : folder.parentId === null ? [] : [[pane, folder.parentId]])),
  };
}
export function teamFolderPath(state: TeamFolders, id: string): string {
  const folder = state.folders.find(f => f.id === id);
  return folder ? (folder.parentId === null ? folder.name : `${teamFolderPath(state, folder.parentId)} / ${folder.name}`) : "";
}
