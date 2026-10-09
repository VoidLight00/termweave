export type SplitLayout = "single" | "columns" | "rows" | "grid";

export const splitLayouts: readonly { value: SplitLayout; label: string; count: number }[] = [
  { value: "single", label: "단일", count: 1 },
  { value: "columns", label: "좌우 2분할", count: 2 },
  { value: "rows", label: "상하 2분할", count: 2 },
  { value: "grid", label: "4분할", count: 4 },
];

/** Reserve the sidebar's selection first; never attach one PTY twice in this view. */
export function splitPaneIds(available: readonly string[], primary: string | null, saved: readonly (string | null)[], count: number): (string | null)[] {
  const first = primary && available.includes(primary) ? primary : null;
  return Array.from({ length: count }).reduce<(string | null)[]>((ids, _, index) => {
    if (index === 0) return [first];
    const preferred = saved[index];
    const next = preferred && available.includes(preferred) && !ids.includes(preferred)
      ? preferred : available.find(id => !ids.includes(id)) ?? null;
    return [...ids, next];
  }, []);
}

export function selectSplitPane(ids: readonly (string | null)[], slot: number, id: string): (string | null)[] {
  if (slot < 0 || slot >= ids.length || ids.some((value, index) => index !== slot && value === id)) return [...ids];
  return ids.map((value, index) => index === slot ? id : value);
}
