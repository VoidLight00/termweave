import { useT } from "../lib/i18n.ts";
import { useRef } from "react";
import type { Split } from "../lib/dockLayout.ts";

export function DockDivider({ node, onResize }: { node: Split; onResize: (id: string, ratio: number) => void }) {
  const t = useT();
  const drag = useRef<{ start: number; min: number; pointer: number } | null>(null);
  const columns = node.axis === "columns";
  const finish = (event: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
    if (!drag.current) return;
    if (cancelled) onResize(node.id, drag.current.start);
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    document.documentElement.classList.remove("dock-resizing");
  };
  return <div className={`dock-divider dock-divider-${node.axis}`} role="separator" tabIndex={0}
    aria-label={columns ? t("Horizontal pane size") : t("Vertical pane size")} aria-orientation={columns ? "vertical" : "horizontal"}
    aria-valuemin={15} aria-valuemax={85} aria-valuenow={Math.round(node.ratio * 100)}
    onPointerDown={event => {
      if (event.button !== 0) return;
      const bounds = event.currentTarget.parentElement!.getBoundingClientRect();
      const dimension = columns ? bounds.width : bounds.height;
      // Keep readable minimums where space permits; at narrow sizes share equally.
      const min = Math.min(0.45, Math.max(0.15, (columns ? 220 : 150) / dimension));
      drag.current = { start: node.ratio, min, pointer: event.pointerId };
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic accessibility/test pointer */ }
      document.documentElement.classList.add("dock-resizing");
      event.preventDefault();
    }}
    onPointerMove={event => {
      if (!drag.current || drag.current.pointer !== event.pointerId) return;
      const bounds = event.currentTarget.parentElement!.getBoundingClientRect();
      const ratio = columns ? (event.clientX - bounds.left) / bounds.width : (event.clientY - bounds.top) / bounds.height;
      onResize(node.id, Math.max(drag.current.min, Math.min(1 - drag.current.min, ratio)));
    }}
    onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)}
    onLostPointerCapture={() => { drag.current = null; document.documentElement.classList.remove("dock-resizing"); }}
    onKeyDown={event => {
      const decrease = columns ? "ArrowLeft" : "ArrowUp";
      const increase = columns ? "ArrowRight" : "ArrowDown";
      if (event.key !== decrease && event.key !== increase) return;
      event.preventDefault(); onResize(node.id, node.ratio + (event.key === decrease ? -0.05 : 0.05));
    }} />;
}
