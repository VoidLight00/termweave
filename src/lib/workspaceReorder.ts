import { useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";

export interface WorkspaceBox { id: string; top: number; height: number; gap: number }

/** Measured slots, not row counts: expanded folders need not have the same height.
 * Conceptually follows SortableJS's measured displacement and dnd-kit's separate
 * drag/commit phases (both MIT). No library source is copied or required.
 */
export function workspaceSlots(boxes: readonly WorkspaceBox[], id: string, index: number): Map<string, number> {
  const remaining = boxes.filter(box => box.id !== id);
  const dragged = boxes.find(box => box.id === id);
  if (!dragged) return new Map();
  const ordered = [...remaining.slice(0, index), dragged, ...remaining.slice(index)];
  return ordered.reduce((result, box) => ({ top: result.top + box.height + box.gap,
    slots: new Map([...result.slots, [box.id, result.top]]) }), { top: boxes[0]?.top ?? 0, slots: new Map<string, number>() }).slots;
}

export function workspaceInsertion(boxes: readonly WorkspaceBox[], id: string, top: number, current: number): number {
  const remaining = boxes.filter(box => box.id !== id);
  const boundaries = remaining.reduce<{ top: number; values: number[] }>((result, box) => ({
    top: result.top + box.height + box.gap,
    values: [...result.values, result.top + box.height / 2],
  }), { top: boxes[0]?.top ?? 0, values: [] }).values;
  let index = current;
  while (index < boundaries.length && top > boundaries[index]! + 8) index += 1;
  while (index > 0 && top < boundaries[index - 1]! - 8) index -= 1;
  return index;
}

function scrollParent(element: HTMLElement): HTMLElement {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight) return parent;
  }
  return (document.scrollingElement ?? document.documentElement) as HTMLElement;
}

type Drag = {
  id: string; pointer: number; handle: HTMLButtonElement; section: HTMLElement; list: HTMLElement;
  scroll: HTMLElement; startX: number; startY: number; y: number; offset: number;
  index: number; active: boolean; settling: boolean; frame: number; animation?: Animation;
};

/** The real sections stay mounted and focused; preview transforms never change stored order. */
export function useWorkspaceReorder(structure: string, busy: boolean, commit: (id: string, index: number) => void) {
  const drag = useRef<Drag | null>(null);
  const latest = useRef({ busy, commit });
  latest.current = { busy, commit };

  const clear = () => {
    const state = drag.current;
    if (!state) return;
    drag.current = null;
    cancelAnimationFrame(state.frame);
    state.animation?.cancel();
    state.list.classList.remove("is-reordering");
    for (const section of state.list.querySelectorAll<HTMLElement>(":scope > .workspace")) {
      section.style.removeProperty("transform");
      section.classList.remove("is-dragging", "is-settling");
    }
    if (state.handle.hasPointerCapture(state.pointer)) state.handle.releasePointerCapture(state.pointer);
  };

  useLayoutEffect(() => {
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") clear(); };
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("keydown", escape); clear(); };
  }, [structure]);

  const measure = (state: Drag): WorkspaceBox[] => Array.from(state.list.querySelectorAll<HTMLElement>(":scope > .workspace"), section => ({
    id: section.dataset.reorderWorkspace!, top: section.offsetTop,
    height: section.offsetHeight, gap: parseFloat(getComputedStyle(section).marginBottom) || 0,
  }));

  const preview = (state: Drag) => {
    const boxes = measure(state);
    const own = boxes.find(box => box.id === state.id)!;
    // offsetTop is in the list's positioned coordinate system. Rect includes scrolling.
    const base = state.section.getBoundingClientRect().top - (parseFloat(state.section.style.transform.match(/translateY\(([-.\d]+)px\)/)?.[1] ?? "0"));
    const delta = state.y - state.offset - base;
    state.index = workspaceInsertion(boxes, state.id, own.top + delta, state.index);
    const slots = workspaceSlots(boxes, state.id, state.index);
    for (const section of state.list.querySelectorAll<HTMLElement>(":scope > .workspace")) {
      const box = boxes.find(box => box.id === section.dataset.reorderWorkspace)!;
      const shift = box.id === state.id ? delta : slots.get(box.id)! - box.top;
      section.style.transform = `translateY(${shift}px)`;
    }
  };

  const tick = () => {
    const state = drag.current;
    if (!state?.active || state.settling) return;
    const rect = state.scroll.getBoundingClientRect();
    const edge = 36;
    const velocity = state.y < rect.top + edge ? -Math.min(12, (rect.top + edge - state.y) / 3)
      : state.y > rect.bottom - edge ? Math.min(12, (state.y - rect.bottom + edge) / 3) : 0;
    if (velocity) state.scroll.scrollTop += velocity;
    preview(state);
    state.frame = requestAnimationFrame(tick);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    if (event.button !== 0 || !event.isPrimary || latest.current.busy || drag.current) return;
    const handle = event.currentTarget;
    const section = handle.closest<HTMLElement>(".workspace")!;
    const list = section.parentElement!;
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(event.pointerId);
    drag.current = { id, pointer: event.pointerId, handle, section, list, scroll: scrollParent(section),
      startX: event.clientX, startY: event.clientY, y: event.clientY,
      offset: event.clientY - section.getBoundingClientRect().top,
      index: Array.from(list.children).indexOf(section), active: false, settling: false, frame: 0 };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const state = drag.current;
    if (!state || state.pointer !== event.pointerId || state.settling) return;
    state.y = event.clientY;
    if (!state.active && Math.hypot(event.clientX - state.startX, event.clientY - state.startY) < 6) return;
    event.preventDefault();
    if (!state.active) {
      state.active = true;
      state.list.classList.add("is-reordering");
      state.section.classList.add("is-dragging");
      state.frame = requestAnimationFrame(tick);
    }
    preview(state);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const state = drag.current;
    if (!state || state.pointer !== event.pointerId || state.settling) return;
    if (!state.active) { clear(); return; }
    state.y = event.clientY;
    preview(state);
    state.settling = true;
    cancelAnimationFrame(state.frame);
    const boxes = measure(state);
    const target = workspaceSlots(boxes, state.id, state.index).get(state.id)! - boxes.find(box => box.id === state.id)!.top;
    const finish = () => {
      if (drag.current !== state) return;
      clear();
      latest.current.commit(state.id, state.index);
      state.handle.focus({ preventScroll: true });
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { finish(); return; }
    state.section.classList.add("is-settling");
    state.animation = state.section.animate([{ transform: state.section.style.transform }, { transform: `translateY(${target}px)` }],
      { duration: 160, easing: "cubic-bezier(.2,.8,.2,1)", fill: "forwards" });
    void state.animation.finished.then(finish, () => {});
  };

  return { onPointerDown, onPointerMove, onPointerUp,
    onPointerCancel: clear,
    // Pointerup releases capture implicitly; the settle phase no longer needs it.
    onLostPointerCapture: () => { if (!drag.current?.settling) clear(); },
    dragging: () => drag.current !== null };
}
