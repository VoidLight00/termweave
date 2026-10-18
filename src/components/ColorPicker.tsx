import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { hexToRgb, hsvToHex, hsvToRgb, rgbToHsv, type Hsv } from "../lib/color.ts";
import { useT } from "../lib/i18n.ts";
import "./ColorPicker.css";

/**
 * Photoshop-style picker: a saturation/brightness square over the hue, a hue slider, and HEX,
 * RGB and HSB fields. Hue lives in local state, so it survives a pure grey or black.
 */
export function ColorPicker({ value, onChange, label }: { value: string; onChange: (hex: string) => void; label: string }) {
  const t = useT();
  const [hsv, setHsv] = useState<Hsv>(() => rgbToHsv(hexToRgb(value) ?? { r: 0, g: 0, b: 0 }));
  const [hexDraft, setHexDraft] = useState(value);
  const square = useRef<HTMLDivElement>(null);
  // a value changed elsewhere (preset reset, import) replaces the local one; our own echo does not
  useEffect(() => {
    if (value.toLowerCase() !== hsvToHex(hsv)) {
      const rgb = hexToRgb(value);
      if (rgb) setHsv(previous => ({ ...rgbToHsv(rgb), h: rgbToHsv(rgb).s === 0 ? previous.h : rgbToHsv(rgb).h }));
    }
    setHexDraft(value);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = (next: Hsv) => { setHsv(next); onChange(hsvToHex(next)); };
  const rgb = hsvToRgb(hsv);
  const fromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const box = square.current!.getBoundingClientRect();
    const s = Math.min(100, Math.max(0, ((event.clientX - box.left) / box.width) * 100));
    const v = Math.min(100, Math.max(0, 100 - ((event.clientY - box.top) / box.height) * 100));
    commit({ ...hsv, s, v });
  };
  const squareKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 10 : 1;
    const move: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const delta = move[event.key];
    if (!delta) return;
    event.preventDefault();
    commit({ ...hsv, s: Math.min(100, Math.max(0, hsv.s + delta[0])), v: Math.min(100, Math.max(0, hsv.v + delta[1])) });
  };
  const number = (text: string, max: number): number | null => {
    const n = Number(text);
    return text.trim() !== "" && Number.isFinite(n) ? Math.min(max, Math.max(0, n)) : null;
  };
  const setRgb = (key: "r" | "g" | "b", text: string) => {
    const n = number(text, 255);
    if (n === null) return;
    // a grey has no hue of its own: keep the one the slider shows
    const next = rgbToHsv({ ...rgb, [key]: n });
    commit(next.s === 0 ? { ...next, h: hsv.h } : next);
  };
  const setHsvField = (key: "h" | "s" | "v", text: string) => {
    const n = number(text, key === "h" ? 360 : 100);
    if (n !== null) commit({ ...hsv, [key]: key === "h" ? n % 360 : n });
  };
  return <div className="color-picker" role="group" aria-label={label}>
    <div ref={square} className="color-picker-square" style={{ backgroundColor: hsvToHex({ h: hsv.h, s: 100, v: 100 }) }}
      role="slider" tabIndex={0} aria-label={t("Saturation and brightness")}
      aria-valuetext={t("Saturation {s}%, brightness {v}%", { s: Math.round(hsv.s), v: Math.round(hsv.v) })}
      onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); fromPointer(event); }}
      onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) fromPointer(event); }}
      onKeyDown={squareKey}>
      <span className="color-picker-thumb" style={{ left: `${hsv.s}%`, top: `${100 - hsv.v}%`, backgroundColor: hsvToHex(hsv) }} />
    </div>
    <input className="color-picker-hue" type="range" min={0} max={359} step={1} value={Math.round(hsv.h)}
      aria-label={t("Hue")} onChange={event => commit({ ...hsv, h: Number(event.target.value) })} />
    <div className="color-picker-hexrow">
      <span className="color-picker-preview" style={{ backgroundColor: hsvToHex(hsv) }} aria-hidden="true" />
      <label>HEX<input className="input" value={hexDraft} maxLength={7} spellCheck={false} aria-label={`${label} HEX`}
        onChange={event => { setHexDraft(event.target.value); const parsed = hexToRgb(event.target.value); if (parsed && /^#?[0-9a-f]{6}$/i.test(event.target.value.trim())) commit(rgbToHsv(parsed)); }}
        onBlur={() => setHexDraft(hsvToHex(hsv))} /></label>
    </div>
    <div className="color-picker-fields">
      {(["r", "g", "b"] as const).map(key => <label key={key}>{key.toUpperCase()}<input className="input" inputMode="numeric"
        aria-label={`${label} ${key.toUpperCase()}`} value={rgb[key]} onChange={event => setRgb(key, event.target.value)} /></label>)}
      {(["h", "s", "v"] as const).map(key => <label key={key}>{key === "v" ? "B" : key.toUpperCase()}<input className="input" inputMode="numeric"
        aria-label={`${label} ${key === "h" ? t("Hue") : key === "s" ? t("Saturation") : t("Brightness")}`} value={Math.round(hsv[key])}
        onChange={event => setHsvField(key, event.target.value)} /></label>)}
    </div>
  </div>;
}
