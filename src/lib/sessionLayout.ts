import { group, groups, parseLayout, updateGroup, type Layout } from './dockLayout.ts';

// v2 remains available for recovery; workspace navigation never writes or deletes it.
export const sessionLayoutKey = (machine: string, owner: string) => `termweave:dock:session:v2:${encodeURIComponent(machine)}:${encodeURIComponent(owner)}`;
export const workspaceLayoutKey = (machine: string, workspace: string) => `termweave:dock:workspace:v3:${encodeURIComponent(machine)}:${encodeURIComponent(workspace)}`;
export type SessionLayout = { tree: Layout; primary: string | null; workspace: string };
function readKey(key: string): SessionLayout | null {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? 'null');
    const tree = parseLayout(raw?.tree);
    return tree && typeof raw.workspace === 'string' ? { tree, workspace: raw.workspace,
      primary: typeof raw.primary === 'string' && groups(tree).some(g => g.tabs.includes(raw.primary)) ? raw.primary : groups(tree)[0]?.active ?? null } : null;
  } catch { return null; }
}
export const readSessionLayout = (machine: string, owner: string) => readKey(sessionLayoutKey(machine, owner));
export const readWorkspaceLayout = (machine: string, workspace: string) => readKey(workspaceLayoutKey(machine, workspace));
function saveKey(key: string, value: SessionLayout): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage denied */ }
}
export const saveSessionLayout = (machine: string, owner: string, value: SessionLayout) => saveKey(sessionLayoutKey(machine, owner), value);
export const saveWorkspaceLayout = (machine: string, workspace: string, value: SessionLayout) => saveKey(workspaceLayoutKey(machine, workspace), value);
/** Deterministic, non-destructive migration: v3 > lexical v2 owner > v1.
 * Keep the winner's geometry/focus; merge other v2 members as inactive tabs.
 * The native roster, not storage, is authoritative for terminal membership.
 */
export function initialWorkspaceLayout(machine: string, workspace: string, ids: readonly string[], preferred: string | null): SessionLayout {
  const stored = readWorkspaceLayout(machine, workspace);
  if (stored?.workspace === workspace) return stored;
  const prefix = `termweave:dock:session:v2:${encodeURIComponent(machine)}:`;
  let keys = ids.map(id => sessionLayoutKey(machine, id));
  try { keys = [...new Set([...keys, ...Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((key): key is string => !!key?.startsWith(prefix))])]; } catch { /* bounded roster fallback */ }
  const candidates = keys.sort().map(readKey).filter((value): value is SessionLayout => value?.workspace === workspace && groups(value.tree).some(g => g.tabs.some(id => ids.includes(id))));
  let legacy: Layout | null = null;
  try { legacy = parseLayout(JSON.parse(localStorage.getItem(`termweave:dock:v1:${machine}:${workspace}`) ?? 'null')); } catch { /* recovery keys stay intact */ }
  // Deployed v2 has no timestamp: prefer it to potentially stale v1, then lexical owner.
  const winner = candidates[0] ?? (legacy ? { tree: legacy, primary: groups(legacy)[0]?.active ?? null, workspace } : null);
  let tree = winner?.tree ?? group('main', preferred ? [preferred] : ids.slice(0, 1));
  const members = groups(tree).flatMap(g => g.tabs);
  const extras = [...new Set(candidates.flatMap(value => groups(value.tree).flatMap(g => g.tabs)))].filter(id => ids.includes(id) && !members.includes(id));
  const first = groups(tree)[0];
  if (first && extras.length) tree = updateGroup(tree, first.id, g => ({ ...g, tabs: [...g.tabs, ...extras] }));
  const value = { tree, primary: winner?.primary ?? preferred ?? ids[0] ?? null, workspace };
  saveWorkspaceLayout(machine, workspace, value);
  return value;
}
/** Kept for old recovery clients and their tests, not used by workspace navigation. */
export function initialSessionLayout(machine: string, owner: string, workspace: string): SessionLayout {
  const stored = readSessionLayout(machine, owner);
  if (stored?.workspace === workspace) return stored;
  try {
    const key = `termweave:dock:v1:${machine}:${workspace}`;
    const legacy = parseLayout(JSON.parse(localStorage.getItem(key) ?? 'null'));
    const claim = `${key}:session-owner-v2`;
    if (legacy && groups(legacy).some(g => g.tabs.includes(owner)) && (!localStorage.getItem(claim) || localStorage.getItem(claim) === owner)) {
      localStorage.setItem(claim, owner);
      const migrated = { tree: legacy, primary: owner, workspace };
      saveSessionLayout(machine, owner, migrated);
      return migrated;
    }
  } catch { /* recovery keys stay intact */ }
  return { tree: group('main', [owner]), primary: owner, workspace };
}
