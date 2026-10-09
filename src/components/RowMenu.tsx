/**
 * The ⋯ menu of a sidebar row. On a desktop it is a popover under its button, drawn through a
 * portal at fixed coordinates: the roster scrolls, and a menu inside it would be cut off at the
 * list's edge. At phone width it is the modal primitive, which is already a bottom sheet there.
 * Escape, a press outside, focus leaving it (the palette opening over it, a Tab out) and, on a
 * desktop, a scroll or a resize close it. Focus goes back to the button when the menu goes,
 * unless what an item mounted (a rename field, a confirm) takes it first: the button is focused
 * in a layout cleanup, before a new field's autoFocus and a dialog's own focus.
 */
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import type { LucideIcon } from "lucide-react";

import "./RowMenu.css";

import { useT } from "../lib/i18n.ts";

export interface RowMenuItem {
  id: string;
  label: string;
  icon: LucideIcon;
  /** a hairline above this item */
  divider?: boolean;
  danger?: boolean;
  run: () => void;
}

interface Props {
  anchor: HTMLElement;
  /** the menu's accessible name, and the sheet's title */
  title: string;
  subtitle?: string;
  items: RowMenuItem[];
  onClose: () => void;
}

const SHEET_QUERY = "(max-width: 640px)";
const GAP = 4;
const EDGE = 8;
const POPOVER_ITEMS = '[role="menuitem"]';
// the sheet is modal: its Cancel is one of the stops
const SHEET_ITEMS = '.row-sheet-item, .row-sheet-cancel';

export function RowMenu({ anchor, title, subtitle, items, onClose }: Props) {
  const t = useT();
  const [sheet] = useState(() => window.matchMedia(SHEET_QUERY).matches);
  const surface = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => () => { if (anchor.isConnected) anchor.focus({ preventScroll: true }); }, [anchor]);

  // under the button, right edges aligned; above it when the screen ends first
  useLayoutEffect(() => {
    if (sheet) return;
    const menu = surface.current;
    if (!menu || !anchor.isConnected) { onClose(); return; }
    const rect = anchor.getBoundingClientRect();
    const left = Math.max(EDGE, Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - EDGE));
    const below = rect.bottom + GAP;
    const top = below + menu.offsetHeight + EDGE <= window.innerHeight ? below : Math.max(EDGE, rect.top - GAP - menu.offsetHeight);
    setPlace({ top, left });
  }, [anchor, onClose, sheet]);

  useEffect(() => {
    const first = surface.current?.querySelector<HTMLElement>(sheet ? SHEET_ITEMS : POPOVER_ITEMS);
    window.requestAnimationFrame(() => first?.focus());
  }, [sheet]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    // the button's own click toggles the menu, so a press on it is not "outside"
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (surface.current?.contains(target) || anchor.contains(target)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    if (!sheet) {
      window.addEventListener("scroll", onClose, true);
      window.addEventListener("resize", onClose);
    }
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [anchor, onClose, sheet]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const buttons = [...(surface.current?.querySelectorAll<HTMLElement>(sheet ? SHEET_ITEMS : POPOVER_ITEMS) ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLElement);
    const move = (next: number): void => {
      event.preventDefault();
      buttons[(next + buttons.length) % buttons.length]?.focus();
    };
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(buttons.length - 1);
    // Tab stays inside the sheet, which is modal; it leaves the popover, which then goes
    else if (event.key === "Tab" && sheet) move(index + (event.shiftKey ? -1 : 1));
    else if (event.key === "Tab") { event.preventDefault(); onClose(); }
  };

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget as Node | null;
    if (next && (surface.current?.contains(next) || anchor.contains(next))) return;
    onClose();
  };
  // Safari on a Mac does not focus a clicked button, so the press would blur the focused item
  // with no relatedTarget, close the menu, and the click would land on nothing: the press keeps
  // the focus where it is, and the click still comes
  const keepFocus = (event: ReactMouseEvent<HTMLButtonElement>): void => event.preventDefault();

  const run = (item: RowMenuItem): void => {
    onClose();
    item.run();
  };

  if (sheet) {
    return createPortal(
      <div className="modal-scrim">
        <div ref={surface} className="modal row-sheet" role="dialog" aria-modal="true" aria-label={title} onKeyDown={onKeyDown} onBlur={onBlur}>
          <span className="row-sheet-grip" aria-hidden="true" />
          <div className="row-sheet-head">
            <span className="row-sheet-title">{title}</span>
            {subtitle && <span className="row-sheet-subtitle">{subtitle}</span>}
          </div>
          {items.map((item) => (
            <button key={item.id} type="button" className={`row-sheet-item${item.danger ? " is-danger" : ""}${item.divider ? " has-divider" : ""}`} onMouseDown={keepFocus} onClick={() => run(item)}>
              <item.icon aria-hidden="true" />
              {item.label}
            </button>
          ))}
          <button type="button" className="btn row-sheet-cancel" onMouseDown={keepFocus} onClick={onClose}>{t("Cancel")}</button>
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div ref={surface} className="menu row-menu" role="menu" aria-label={title} style={place ?? { visibility: "hidden" }} onKeyDown={onKeyDown} onBlur={onBlur}>
      {items.map((item) => (
        <Fragment key={item.id}>
          {item.divider && <span className="row-menu-divider" role="separator" />}
          <button type="button" role="menuitem" className={`menu-item${item.danger ? " is-danger" : ""}`} onMouseDown={keepFocus} onClick={() => run(item)}>
            <item.icon aria-hidden="true" />
            <span className="menu-item-main">{item.label}</span>
          </button>
        </Fragment>
      ))}
    </div>,
    document.body,
  );
}
