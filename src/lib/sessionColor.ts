export const SESSION_COLORS = [
  { id: "blue", name: "Blue", value: "#5688c7" },
  { id: "green", name: "Green", value: "#4c9876" },
  { id: "amber", name: "Amber", value: "#b48a43" },
  { id: "rose", name: "Rose", value: "#bd718a" },
  { id: "violet", name: "Violet", value: "#9279ba" },
  { id: "cyan", name: "Cyan", value: "#4c9ca9" },
] as const;
export type SessionColor = typeof SESSION_COLORS[number]["id"];
export interface ColorStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export function sessionColorKey(origin: string, machine: string, workspace: string): string {
  return `herdr:session-color:v1:${JSON.stringify([origin, machine, workspace])}`;
}
export function isSessionColor(value: unknown): value is SessionColor {
  return SESSION_COLORS.some(color => color.id === value);
}
export function readSessionColor(storage: ColorStorage | null, key: string): SessionColor | null {
  try { const value = storage?.getItem(key); return isSessionColor(value) ? value : null; } catch { return null; }
}
export function writeSessionColor(storage: ColorStorage | null, key: string, color: SessionColor | null): boolean {
  try {
    if (!storage || (color !== null && !isSessionColor(color))) return false;
    if (color === null) storage.removeItem(key); else storage.setItem(key, color);
    return true;
  } catch { return false; }
}
export function browserColorStorage(): ColorStorage | null {
  try { return window.localStorage; } catch { return null; }
}
