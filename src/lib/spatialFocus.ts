export type Direction = "left" | "right" | "up" | "down";
export function spatialChord(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "isComposing" | "keyCode">): Direction | null {
  if (!event.metaKey || event.ctrlKey || event.shiftKey || event.isComposing || event.keyCode === 229) return null;
  return ({ ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" } as const)[event.key as "ArrowLeft"] ?? null;
}
export interface SpatialRect { id: string; left: number; right: number; top: number; bottom: number }
export function spatialNeighbor(source: SpatialRect, candidates: readonly SpatialRect[], direction: Direction): string | null {
  const horizontal = direction === "left" || direction === "right";
  const positive = direction === "right" || direction === "down";
  const edge = horizontal ? positive ? source.right : source.left : positive ? source.bottom : source.top;
  const center = horizontal ? (source.top + source.bottom) / 2 : (source.left + source.right) / 2;
  const score = (c: SpatialRect) => {
    const near = horizontal ? positive ? c.left : c.right : positive ? c.top : c.bottom;
    const gap = positive ? near - edge : edge - near;
    const lo = horizontal ? c.top : c.left, hi = horizontal ? c.bottom : c.right;
    const overlap = Math.min(hi, horizontal ? source.bottom : source.right) - Math.max(lo, horizontal ? source.top : source.left);
    return { c, gap, overlap, offset: Math.abs((lo + hi) / 2 - center) };
  };
  return candidates.filter(c => c.id !== source.id).map(score).filter(x => x.gap >= -1)
    .sort((a,b) => Number(b.overlap > 0) - Number(a.overlap > 0) || a.gap-b.gap || a.offset-b.offset || a.c.id.localeCompare(b.c.id))[0]?.c.id ?? null;
}
