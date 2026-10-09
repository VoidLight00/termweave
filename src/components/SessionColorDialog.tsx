import { useEffect, useRef, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import "./SessionColorDialog.css";
import { SESSION_COLORS, type SessionColor } from "../lib/sessionColor.ts";
import { useT } from "../lib/i18n.ts";

export function SessionColorDialog({ title, selected, onSelect, onClose }: {
  title: string; selected: SessionColor | null; onSelect: (color: SessionColor | null) => void; onClose: () => void;
}) {
  const t = useT();
  const names: Record<SessionColor, string> = { blue: t("Blue"), green: t("Green"), amber: t("Amber"), rose: t("Rose"), violet: t("Violet"), cyan: t("Cyan") };
  const surface = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    surface.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus();
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    window.addEventListener("keydown", escape, true);
    return () => { window.removeEventListener("keydown", escape, true); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, [onClose]);
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["Tab", "ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = [...surface.current!.querySelectorAll<HTMLButtonElement>("button")];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const backwards = event.key === "ArrowLeft" || event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (backwards ? -1 : 1) + buttons.length) % buttons.length;
    event.preventDefault(); buttons[next]?.focus();
  };
  const choose = (color: SessionColor | null) => { onSelect(color); onClose(); };
  return createPortal(<div className="modal-scrim" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={surface} className="modal session-color-dialog" role="dialog" aria-modal="true" aria-label={title} onKeyDown={move}>
      <header className="modal-header"><h2 className="modal-title">{title}</h2></header>
      <div className="modal-body"><div className="session-color-palette">
        {SESSION_COLORS.map(color => <button className="btn session-color-choice" key={color.id} type="button" aria-pressed={selected === color.id}
          aria-label={t("Session color: {color}", { color: names[color.id] })} onClick={() => choose(color.id)}>
          <span className="session-color-dot" style={{ backgroundColor: color.value }} aria-hidden="true" />{names[color.id]}
        </button>)}
        <button className="btn session-color-choice" type="button" aria-pressed={selected === null} onClick={() => choose(null)}>{t("Reset session color")}</button>
      </div></div>
      <footer className="modal-footer"><button className="btn" type="button" onClick={onClose}>{t("Cancel")}</button></footer>
    </div>
  </div>, document.body);
}
