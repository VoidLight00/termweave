import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import "./SessionColorDialog.css";
import { SESSION_COLORS, browserColorStorage, isSessionPreset, normalizeHex, readRecentColors, rememberRecentColor, resolveSessionColor, type SessionColor, type SessionPreset } from "../lib/sessionColor.ts";
import { useT } from "../lib/i18n.ts";
import { ColorPicker } from "./ColorPicker.tsx";

const FOCUSABLE = "button, input, [tabindex]:not([tabindex='-1'])";

export function SessionColorDialog({ title, selected, onSelect, onClose }: {
  title: string; selected: SessionColor | null; onSelect: (color: SessionColor | null) => void; onClose: () => void;
}) {
  const t = useT();
  const names: Record<SessionPreset, string> = { blue: t("Blue"), green: t("Green"), amber: t("Amber"), rose: t("Rose"), violet: t("Violet"), cyan: t("Cyan") };
  const surface = useRef<HTMLDivElement>(null);
  const [custom, setCustom] = useState(() => resolveSessionColor(selected) ?? "#ff7a00");
  const [recent] = useState(() => readRecentColors(browserColorStorage()));
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (surface.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]') ?? surface.current?.querySelector<HTMLButtonElement>("button"))?.focus();
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    window.addEventListener("keydown", escape, true);
    return () => { window.removeEventListener("keydown", escape, true); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, [onClose]);
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const inSwatches = target.closest(".session-color-swatches");
    if (event.key === "Tab") {
      // trap focus inside the dialog
      const all = [...surface.current!.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const index = all.indexOf(target);
      const next = (index + (event.shiftKey ? -1 : 1) + all.length) % all.length;
      event.preventDefault(); all[next]?.focus(); return;
    }
    if (!inSwatches || !["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = [...surface.current!.querySelectorAll<HTMLButtonElement>(".session-color-swatches button")];
    const current = buttons.indexOf(target as HTMLButtonElement);
    const backwards = event.key === "ArrowLeft" || event.key === "ArrowUp";
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (backwards ? -1 : 1) + buttons.length) % buttons.length;
    event.preventDefault(); buttons[next]?.focus();
  };
  const choose = (color: SessionColor | null) => { onSelect(color); onClose(); };
  const applyCustom = (hex: string) => {
    const value = normalizeHex(hex);
    if (!value) return;
    rememberRecentColor(browserColorStorage(), value);
    choose(value);
  };
  const customValue = normalizeHex(custom) ?? "#000000";
  return createPortal(<div className="modal-scrim" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={surface} className="modal session-color-dialog" role="dialog" aria-modal="true" aria-label={title} onKeyDown={move}>
      <header className="modal-header"><h2 className="modal-title">{title}</h2></header>
      <div className="modal-body">
        <div className="session-color-swatches">
          <div className="session-color-palette">
            {SESSION_COLORS.map(color => <button className="btn session-color-choice" key={color.id} type="button" aria-pressed={selected === color.id}
              aria-label={t("Session color: {color}", { color: names[color.id] })} onClick={() => choose(color.id)}>
              <span className="session-color-dot" style={{ backgroundColor: color.value }} aria-hidden="true" />{names[color.id]}
            </button>)}
          </div>
          {recent.length > 0 && <div className="session-color-recent" role="group" aria-label={t("Recent colors")}>
            {recent.map(hex => <button className="btn session-color-swatch" key={hex} type="button" aria-pressed={selected === hex}
              aria-label={t("Session color: {color}", { color: hex })} onClick={() => choose(hex as SessionColor)}>
              <span className="session-color-dot" style={{ backgroundColor: hex }} aria-hidden="true" />
            </button>)}
          </div>}
        </div>
        <section className="session-color-custom" aria-label={t("Custom color")}>
          <h3 className="session-color-heading">{t("Custom color")}</h3>
          <ColorPicker value={customValue} onChange={setCustom} label={t("Custom color")} />
          <div className="session-color-apply">
            <span className="session-color-preview" style={{ backgroundColor: customValue }} role="img" aria-label={t("Preview: {color}", { color: customValue })} />
            <code className="session-color-hex">{customValue}</code>
            <button className="btn btn-primary" type="button" aria-pressed={selected === customValue && !isSessionPreset(selected)} onClick={() => applyCustom(customValue)}>{t("Apply")}</button>
          </div>
        </section>
        <button className="btn session-color-reset" type="button" aria-pressed={selected === null} onClick={() => choose(null)}>{t("Reset session color")}</button>
      </div>
      <footer className="modal-footer"><button className="btn" type="button" onClick={onClose}>{t("Cancel")}</button></footer>
    </div>
  </div>, document.body);
}
