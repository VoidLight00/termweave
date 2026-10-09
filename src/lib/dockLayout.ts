export type Edge = "center" | "left" | "right" | "top" | "bottom";
export type Group = { kind: "group"; id: string; tabs: string[]; active: string | null };
export type Split = { kind: "split"; id: string; axis: "columns" | "rows"; ratio: number; first: Layout; second: Layout };
export type Layout = Group | Split;
export const group = (id: string, tabs: string[] = []): Group => ({ kind: "group", id, tabs: [...tabs], active: tabs[0] ?? null });
export const groups = (tree: Layout): Group[] => tree.kind === "group" ? [tree] : [...groups(tree.first), ...groups(tree.second)];
export const clampRatio = (ratio: number) => Math.max(0.15, Math.min(0.85, ratio));

export function updateGroup(tree: Layout, id: string, update: (value: Group) => Group): Layout {
  if (tree.kind === "group") return tree.id === id ? update(tree) : tree;
  return { ...tree, first: updateGroup(tree.first, id, update), second: updateGroup(tree.second, id, update) };
}

export function removeTab(tree: Layout, tab: string): Layout | null {
  if (tree.kind === "group") {
    const tabs = tree.tabs.filter(id => id !== tab);
    if (!tabs.length) return null;
    return { ...tree, tabs, active: tabs.includes(tree.active ?? "") ? tree.active : tabs[0]! };
  }
  const first = removeTab(tree.first, tab), second = removeTab(tree.second, tab);
  return first && second ? { ...tree, first, second } : first ?? second;
}

/** Browser docking changes layout only, never herdr workspace/tab or process identity. */
export function dock(tree: Layout, tab: string, target: string, edge: Edge, newId: string, index?: number): Layout {
  const destination = groups(tree).find(item => item.id === target);
  const source = groups(tree).find(item => item.tabs.includes(tab));
  if (!destination || !source) return tree;
  if (source.id === target && edge !== "center" && source.tabs.length === 1) return tree;
  if (edge === "center" && source.id === target) {
    const tabs = source.tabs.filter(id => id !== tab);
    const at = Math.max(0, Math.min(tabs.length, index ?? tabs.length));
    return updateGroup(tree, target, value => ({ ...value, tabs: [...tabs.slice(0, at), tab, ...tabs.slice(at)], active: tab }));
  }
  const removed = removeTab(tree, tab);
  if (!removed) return tree;
  if (edge === "center") return updateGroup(removed, target, value => {
    const at = Math.max(0, Math.min(value.tabs.length, index ?? value.tabs.length));
    return { ...value, tabs: [...value.tabs.slice(0, at), tab, ...value.tabs.slice(at)], active: tab };
  });
  const replacement = (node: Layout): Layout => {
    if (node.kind === "group") {
      if (node.id !== target) return node;
      const added = group(`${newId}-group`, [tab]);
      const before = edge === "left" || edge === "top";
      return { kind: "split", id: newId, axis: edge === "left" || edge === "right" ? "columns" : "rows", ratio: 0.5,
        first: before ? added : node, second: before ? node : added };
    }
    return { ...node, first: replacement(node.first), second: replacement(node.second) };
  };
  return replacement(removed);
}

export function resizeSplit(tree: Layout, id: string, ratio: number): Layout {
  if (tree.kind === "group") return tree;
  return { ...tree, ratio: tree.id === id ? clampRatio(ratio) : tree.ratio,
    first: resizeSplit(tree.first, id, ratio), second: resizeSplit(tree.second, id, ratio) };
}

export function sanitize(tree: Layout, available: readonly string[]): Layout | null {
  const seen = new Set<string>();
  const visit = (node: Layout): Layout | null => {
    if (node.kind === "group") {
      const tabs = node.tabs.filter(id => available.includes(id) && !seen.has(id) && (seen.add(id), true));
      return tabs.length ? { ...node, tabs, active: tabs.includes(node.active ?? "") ? node.active : tabs[0]! } : null;
    }
    const first = visit(node.first), second = visit(node.second);
    return first && second ? { ...node, ratio: clampRatio(node.ratio), first, second } : first ?? second;
  };
  return visit(tree);
}

export function parseLayout(raw: unknown, depth = 0): Layout | null {
  if (!raw || typeof raw !== "object" || depth > 8) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || value.id.length > 100) return null;
  if (value.kind === "group" && Array.isArray(value.tabs) && value.tabs.length <= 64 && value.tabs.every(id => typeof id === "string")) {
    return { kind: "group", id: value.id, tabs: [...value.tabs], active: typeof value.active === "string" ? value.active : null };
  }
  if (value.kind !== "split" || !["rows", "columns"].includes(String(value.axis)) || typeof value.ratio !== "number" || !Number.isFinite(value.ratio)) return null;
  const first = parseLayout(value.first, depth + 1), second = parseLayout(value.second, depth + 1);
  return first && second ? { kind: "split", id: value.id, axis: value.axis as Split["axis"], ratio: clampRatio(value.ratio), first, second } : null;
}

export function preset(tabs: string[], mode: "single" | "columns" | "rows" | "grid", id: string): Layout {
  if (mode === "single" || tabs.length < 2) return group(`${id}-0`, tabs.slice(0, 1));
  const leaves = tabs.slice(0, mode === "grid" ? 4 : 2).map((tab, index) => group(`${id}-${index}`, [tab]));
  const pair = (a: Layout, b: Layout, key: string, axis: Split["axis"]): Split => ({ kind: "split", id: key, axis, ratio: 0.5, first: a, second: b });
  if (mode !== "grid" || leaves.length < 3) return pair(leaves[0]!, leaves[1]!, `${id}-split`, mode === "rows" ? "rows" : "columns");
  return pair(pair(leaves[0]!, leaves[1]!, `${id}-top`, "columns"), leaves[3] ? pair(leaves[2]!, leaves[3], `${id}-bottom`, "columns") : leaves[2]!, `${id}-root`, "rows");
}
