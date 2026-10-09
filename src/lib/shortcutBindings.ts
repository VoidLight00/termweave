/** Overrides keep the app's Mod+Shift convention; null returns a key to the terminal. */
export type ShortcutOverrides = Record<string, string | null>;
export const CUSTOM_SHORTCUT_IDS = ["palette", "toggle-view", "toggle-sidebar", "new-session", "previous-pane", "next-pane", "settings"];
export function sanitizeShortcutOverrides(raw: unknown): ShortcutOverrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: ShortcutOverrides = {};
  for (const id of CUSTOM_SHORTCUT_IDS) {
    const value = (raw as Record<string, unknown>)[id];
    if (value === null || (typeof value === "string" && /^(?:[a-z0-9,]|ArrowUp|ArrowDown|ArrowLeft|ArrowRight)$/.test(value))) result[id] = value;
  }
  return result;
}
