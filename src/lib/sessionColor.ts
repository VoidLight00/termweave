export const SESSION_COLORS = [
  { id: "blue", name: "Blue", value: "#5688c7" },
  { id: "green", name: "Green", value: "#4c9876" },
  { id: "amber", name: "Amber", value: "#b48a43" },
  { id: "rose", name: "Rose", value: "#bd718a" },
  { id: "violet", name: "Violet", value: "#9279ba" },
  { id: "cyan", name: "Cyan", value: "#4c9ca9" },
] as const;
export type SessionPreset = typeof SESSION_COLORS[number]["id"];
/** A preset id, or a custom lowercase "#rrggbb". */
export type SessionColor = SessionPreset | `#${string}`;
const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
/** Lowercase 6-digit "#rrggbb", or null when the text is not a hex color. */
export function normalizeHex(text: string): `#${string}` | null {
  const match = HEX.exec(text.trim());
  if (!match) return null;
  const digits = match[1]!.length === 3 ? [...match[1]!].map(c => c + c).join("") : match[1]!;
  return `#${digits.toLowerCase()}`;
}
export function isSessionPreset(value: unknown): value is SessionPreset {
  return SESSION_COLORS.some(color => color.id === value);
}
/** CSS value for a stored color: the preset's value, or the hex itself. */
export function resolveSessionColor(color: SessionColor | null): string | undefined {
  if (color === null) return undefined;
  return SESSION_COLORS.find(preset => preset.id === color)?.value ?? normalizeHex(color) ?? undefined;
}
/** Dark or light text for a background of this hex (WCAG relative luminance). */
export function readableTextOn(hex: string): "#111111" | "#ffffff" {
  const value = normalizeHex(hex) ?? "#000000";
  const channel = (i: number) => { const c = parseInt(value.slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return (luminance + 0.05) / 0.05 > 1.05 / (luminance + 0.05) ? "#111111" : "#ffffff";
}
export interface ColorStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export function sessionColorKey(origin: string, machine: string, workspace: string): string {
  return `herdr:session-color:v1:${JSON.stringify([origin, machine, workspace])}`;
}
export function isSessionColor(value: unknown): value is SessionColor {
  return isSessionPreset(value) || (typeof value === "string" && /^#[0-9a-f]{6}$/.test(value));
}
/** Accepts presets and any hex spelling; returns the stored form, or null. */
export function toSessionColor(value: unknown): SessionColor | null {
  if (isSessionPreset(value)) return value;
  return typeof value === "string" ? normalizeHex(value) : null;
}
export function readSessionColor(storage: ColorStorage | null, key: string): SessionColor | null {
  try { return toSessionColor(storage?.getItem(key)); } catch { return null; }
}
export function writeSessionColor(storage: ColorStorage | null, key: string, color: SessionColor | null): boolean {
  try {
    const stored = color === null ? null : toSessionColor(color);
    if (!storage || (color !== null && stored === null)) return false;
    if (stored === null) storage.removeItem(key); else storage.setItem(key, stored);
    return true;
  } catch { return false; }
}
export function browserColorStorage(): ColorStorage | null {
  try { return window.localStorage; } catch { return null; }
}
const RECENT_KEY = "termweave:session-color:recent:v1";
export function readRecentColors(storage: ColorStorage | null): string[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.flatMap(v => typeof v === "string" && normalizeHex(v) ? [normalizeHex(v)!] : []).slice(0, 6) : [];
  } catch { return []; }
}
export function rememberRecentColor(storage: ColorStorage | null, hex: string): string[] {
  const value = normalizeHex(hex);
  if (!value) return readRecentColors(storage);
  const next = [value, ...readRecentColors(storage).filter(c => c !== value)].slice(0, 6);
  try { storage?.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* storage blocked: keep in memory only */ }
  return next;
}
