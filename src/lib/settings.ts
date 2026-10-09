import { preset, colors, appearanceColors, appearanceVariables, CUSTOM_DEFAULT, type AppearancePreset, type ThemeColors } from "./appearance.ts";
/**
 * User preferences: one localStorage record, one React context, applied to the
 * document as `data-theme` / `data-density` attributes that src/styles.css keys
 * its token overrides on. xterm reads no CSS, so `terminalTheme()` mirrors the
 * `--term-*` tokens of each theme for PaneTerminal's theme object.
 */

import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { LANGUAGE_SETTINGS, LOCALE_TAGS, resolveLanguage, setCurrentLanguage, type Language, type LanguageSetting } from "./i18n.ts";
import type { AlertPrefs, DoneAlerts } from "../../shared/notify-policy.ts";
import { chatFontStack, sanitizeFontFamily } from "./fontFamily.ts";

export type ThemeSetting = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";
export type Density = "compact" | "comfortable";
export type SidebarGrouping = "workspace" | "directory";
/** what the plan meters count: the share of a limit used, or what is left of it */
export type UsageCount = "used" | "left";
/** amber: the herdr look (the default); report: the dark technical report look; charcoal: neutral Ghostty-style dark */
export type Palette = "amber" | "report" | "charcoal";
/** where the plan meters sit: chips beside Settings, or a panel at the top of the sidebar */
export type UsagePlacement = "footer" | "top";
/** the lens a pane opens in until it is switched there: auto is chat for an agent on a touch screen, else terminal */
export type DefaultView = "auto" | "chat" | "terminal";

import { sanitizeShortcutOverrides, type ShortcutOverrides } from "./shortcutBindings.ts";

export interface Settings {
  appearancePreset: AppearancePreset;
  customColors: ThemeColors;
  uiFontFamily: string;
  terminalInputMode: "auto" | "line" | "direct";
  shortcutOverrides: ShortcutOverrides;
  theme: ThemeSetting;
  density: Density;
  /** The sidebar's display grouping; workspaces themselves remain independent. */
  sidebarGrouping: SidebarGrouping;
  /** the chrome color family, keyed as data-palette in src/styles.css */
  palette: Palette;
  /** xterm font size in px */
  terminalFontSize: number;
  /** mouse reports sent to herdr per wheel event in the terminal: 1 is what xterm sends by itself */
  terminalWheelSpeed: number;
  /** fonts tried before the built-in terminal stack, as a CSS font-family list; "" keeps the built-in one */
  terminalFontFamily: string;
  /** chat text size in px (its body text; the rest scales with it); null follows the density */
  chatFontSize: number | null;
  /** fonts tried before the UI font in the chat's prose (code stays mono), as a CSS font-family list; "" keeps the UI font */
  chatFontFamily: string;
  /** true: Enter sends in the composer, Shift+Enter breaks the line; false: Ctrl/Cmd+Enter sends */
  enterSends: boolean;
  /** show the agent's folded reasoning blocks in the chat view */
  showThinking: boolean;
  /** request a screen wake lock while a pane is open in this visible tab */
  keepScreenOn: boolean;
  /** UI language; `system` follows the browser (src/lib/i18n.ts) */
  language: LanguageSetting;
  /** alerts on this device at all: the bell turns them off (push subscription dropped) and on */
  alertsOn: boolean;
  /** alert this device when an agent waits on the user (shared/notify-policy.ts AlertPrefs) */
  alertInput: boolean;
  /** alert this device when a turn finishes: never, after a long one, or every one */
  alertDone: DoneAlerts;
  /** while the app is on screen, the same alerts drop in from the top edge (components/Droplet.tsx) */
  alertInApp: boolean;
  /** one-tap replies above the composer, in order; blank ones are kept while being typed, never shown */
  quickReplies: string[];
  /** whether the quick replies show above the composer at all */
  showQuickReplies: boolean;
  /** touch screens: a chip above the message box takes the prompt Claude suggests next; off until chosen */
  showSuggestionChip: boolean;
  /** the plan meters beside Settings in the sidebar (GET /api/usage); off until chosen, as it sends this PC's sign-ins out */
  showUsage: boolean;
  usageCount: UsageCount;
  usagePlacement: UsagePlacement;
  /** every pane's lens until switched in that pane; changing it puts every pane back on it */
  defaultView: DefaultView;
  /** the plan meters' order by ProviderUsage.key; accounts not in it follow, the one nearest a limit first */
  usageOrder: string[];
  /** accounts left out of the plan meters, strip and popover alike, by ProviderUsage.key */
  usageHidden: string[];
  /** the microphone button in the composer and the terminal input line; off until chosen, as it sends audio out */
  voiceInput: boolean;
  voicePolishChat: boolean;
  /** off by default: a terminal line is usually a command, kept as spoken */
  voicePolishTerminal: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  appearancePreset: "default", customColors: {...CUSTOM_DEFAULT}, uiFontFamily: "",
  terminalInputMode: "auto",
  shortcutOverrides: {},
  theme: "dark",
  density: "comfortable",
  sidebarGrouping: "workspace",
  palette: "amber",
  terminalFontSize: 13,
  terminalWheelSpeed: 1,
  terminalFontFamily: "",
  chatFontSize: null,
  chatFontFamily: "",
  enterSends: true,
  showThinking: false,
  keepScreenOn: false,
  language: "system",
  alertsOn: true,
  alertInput: true,
  alertDone: "long",
  alertInApp: true,
  quickReplies: ["continue", "yes", "no", "commit and push", "retry"],
  showQuickReplies: false,
  showSuggestionChip: false,
  showUsage: false,
  usageCount: "used",
  usagePlacement: "footer",
  defaultView: "terminal",
  usageOrder: [],
  usageHidden: [],
  voiceInput: false,
  voicePolishChat: true,
  voicePolishTerminal: false,
};

export const QUICK_REPLIES_MAX = 12;
/** accounts the usage order and hiding remember; more are a hand-edited record */
export const USAGE_KEYS_MAX = 64;

/** A list of usage keys: strings only, each once, bounded. */
function usageKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((key): key is string => typeof key === "string" && key.length > 0 && key.length <= 512))].slice(0, USAGE_KEYS_MAX);
}
export const QUICK_REPLY_MAX_CHARS = 200;

/** The replies worth a button: what the list holds, without the blank ones still being written. */
export function quickReplyButtons(settings: Settings): string[] {
  return settings.quickReplies.filter((reply) => reply.trim() !== "");
}

/** This device's alert choices, as the server keeps them with its push subscription. */
export function alertPrefs(settings: Settings): AlertPrefs {
  return { input: settings.alertInput, done: settings.alertDone };
}

const STORAGE_KEY = "termweave:settings";
export const TERMINAL_FONT_MIN = 10;
export const TERMINAL_FONT_MAX = 22;
export const TERMINAL_WHEEL_SPEED_MIN = 1;
export const TERMINAL_WHEEL_SPEED_MAX = 10;

export const CHAT_FONT_MIN = 11;
export const CHAT_FONT_MAX = 24;
/** each density's body size, --fs-md in src/styles.css: the chat's size when none is chosen */
const CHAT_BASE_FONT: Record<Density, number> = { comfortable: 14, compact: 13 };

function clampFont(size: number): number {
  return Math.min(TERMINAL_FONT_MAX, Math.max(TERMINAL_FONT_MIN, Math.round(size)));
}

/** The chat's body text size in px: the chosen one, or the density's. */
export function chatFontSize(settings: Settings): number {
  return settings.chatFontSize ?? CHAT_BASE_FONT[settings.density];
}

/** Only known keys with the right type survive: a stale or hand-edited record never breaks the UI. */
export function sanitizeSettings(raw: unknown): Settings {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const theme = record["theme"];
  const density = record["density"];
  const font = record["terminalFontSize"];
  const chatFont = record["chatFontSize"];
  return {
    appearancePreset: preset(record["appearancePreset"]), customColors: colors(record["customColors"]), uiFontFamily: sanitizeFontFamily(record["uiFontFamily"]),
    terminalInputMode: record["terminalInputMode"] === "line" || record["terminalInputMode"] === "direct" ? record["terminalInputMode"] : "auto",
    shortcutOverrides: sanitizeShortcutOverrides(record["shortcutOverrides"]),
    theme: theme === "dark" || theme === "light" || theme === "system" ? theme : DEFAULT_SETTINGS.theme,
    density: density === "compact" || density === "comfortable" ? density : DEFAULT_SETTINGS.density,
    sidebarGrouping: record["sidebarGrouping"] === "workspace" || record["sidebarGrouping"] === "directory" ? record["sidebarGrouping"] : DEFAULT_SETTINGS.sidebarGrouping,
    palette: record["palette"] === "amber" || record["palette"] === "report" || record["palette"] === "charcoal" ? record["palette"] : DEFAULT_SETTINGS.palette,
    terminalFontSize: typeof font === "number" && Number.isFinite(font) ? clampFont(font) : DEFAULT_SETTINGS.terminalFontSize,
    terminalWheelSpeed: typeof record["terminalWheelSpeed"] === "number" && Number.isFinite(record["terminalWheelSpeed"])
      ? Math.min(TERMINAL_WHEEL_SPEED_MAX, Math.max(TERMINAL_WHEEL_SPEED_MIN, Math.round(record["terminalWheelSpeed"])))
      : DEFAULT_SETTINGS.terminalWheelSpeed,
    chatFontSize: typeof chatFont === "number" && Number.isFinite(chatFont)
      ? Math.min(CHAT_FONT_MAX, Math.max(CHAT_FONT_MIN, Math.round(chatFont)))
      : DEFAULT_SETTINGS.chatFontSize,
    terminalFontFamily: sanitizeFontFamily(record["terminalFontFamily"]),
    chatFontFamily: sanitizeFontFamily(record["chatFontFamily"]),
    enterSends: typeof record["enterSends"] === "boolean" ? record["enterSends"] : DEFAULT_SETTINGS.enterSends,
    showThinking: typeof record["showThinking"] === "boolean" ? record["showThinking"] : DEFAULT_SETTINGS.showThinking,
    keepScreenOn: typeof record["keepScreenOn"] === "boolean" ? record["keepScreenOn"] : DEFAULT_SETTINGS.keepScreenOn,
    language: LANGUAGE_SETTINGS.includes(record["language"] as LanguageSetting) ? record["language"] as LanguageSetting : DEFAULT_SETTINGS.language,
    alertsOn: typeof record["alertsOn"] === "boolean" ? record["alertsOn"] : DEFAULT_SETTINGS.alertsOn,
    alertInput: typeof record["alertInput"] === "boolean" ? record["alertInput"] : DEFAULT_SETTINGS.alertInput,
    alertDone: record["alertDone"] === "off" || record["alertDone"] === "long" || record["alertDone"] === "always" ? record["alertDone"] : DEFAULT_SETTINGS.alertDone,
    alertInApp: typeof record["alertInApp"] === "boolean" ? record["alertInApp"] : DEFAULT_SETTINGS.alertInApp,
    // kept as typed (a trailing space is the next word being started), only bounded
    quickReplies: Array.isArray(record["quickReplies"])
      ? record["quickReplies"].filter((reply): reply is string => typeof reply === "string").slice(0, QUICK_REPLIES_MAX).map((reply) => reply.slice(0, QUICK_REPLY_MAX_CHARS))
      : [...DEFAULT_SETTINGS.quickReplies],
    showQuickReplies: typeof record["showQuickReplies"] === "boolean" ? record["showQuickReplies"] : DEFAULT_SETTINGS.showQuickReplies,
    showSuggestionChip: typeof record["showSuggestionChip"] === "boolean" ? record["showSuggestionChip"] : DEFAULT_SETTINGS.showSuggestionChip,
    showUsage: typeof record["showUsage"] === "boolean" ? record["showUsage"] : DEFAULT_SETTINGS.showUsage,
    usageCount: record["usageCount"] === "used" || record["usageCount"] === "left" ? record["usageCount"] : DEFAULT_SETTINGS.usageCount,
    usagePlacement: record["usagePlacement"] === "top" || record["usagePlacement"] === "footer" ? record["usagePlacement"] : DEFAULT_SETTINGS.usagePlacement,
    defaultView: record["defaultView"] === "chat" || record["defaultView"] === "terminal" ? record["defaultView"] : DEFAULT_SETTINGS.defaultView,
    usageOrder: usageKeys(record["usageOrder"]),
    usageHidden: usageKeys(record["usageHidden"]),
    voiceInput: typeof record["voiceInput"] === "boolean" ? record["voiceInput"] : DEFAULT_SETTINGS.voiceInput,
    voicePolishChat: typeof record["voicePolishChat"] === "boolean" ? record["voicePolishChat"] : DEFAULT_SETTINGS.voicePolishChat,
    voicePolishTerminal: typeof record["voicePolishTerminal"] === "boolean" ? record["voicePolishTerminal"] : DEFAULT_SETTINGS.voicePolishTerminal,
  };
}

export function loadSettings(): Settings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === null ? DEFAULT_SETTINGS : sanitizeSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(settings: Settings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* private mode: preferences last for the session */
  }
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

export function resolveTheme(setting: ThemeSetting): ResolvedTheme {
  if (setting !== "system") return setting;
  return typeof window !== "undefined" && window.matchMedia?.(DARK_QUERY).matches === false ? "light" : "dark";
}

type TerminalColors = { background: string; foreground: string; cursor: string; selectionBackground: string };

/** The xterm theme for a resolved theme and palette: the `--term-*` tokens of src/styles.css, verbatim. */
const TERMINAL_THEMES: Record<Palette, Record<ResolvedTheme, TerminalColors>> = {
  amber: {
    light: { background: "#faf8f3", foreground: "#2a251f", cursor: "#8c5000", selectionBackground: "#f0d9ae" },
    dark: { background: "#181613", foreground: "#d8d0c3", cursor: "#f0a830", selectionBackground: "#4a3d26" },
  },
  report: {
    light: { background: "#fafaf9", foreground: "#242424", cursor: "#1f5fcc", selectionBackground: "#cfe0fb" },
    dark: { background: "#0f1319", foreground: "#c9d1dc", cursor: "#4c9aff", selectionBackground: "#1f3a66" },
  },
  charcoal: {
    light: { background: "#fafaf9", foreground: "#242424", cursor: "#242424", selectionBackground: "#dedad3" },
    dark: { background: "#171717", foreground: "#cbc7c0", cursor: "#cbc7c0", selectionBackground: "#49443d" },
  },
};

export function terminalTheme(theme: ResolvedTheme, palette: Palette = "amber", appearance?: Pick<Settings,"appearancePreset"|"customColors">): TerminalColors {
  const c = appearance && appearanceColors(appearance.appearancePreset,theme,appearance.customColors);
  if(c) return {background:c.surface,foreground:c.text,cursor:c.accent,selectionBackground:c.border};
  return TERMINAL_THEMES[palette][theme];
}

/** `<meta name="theme-color">` follows the panel surface so the PWA title bar matches. */
const THEME_COLOR: Record<Palette, Record<ResolvedTheme, string>> = {
  amber: { dark: "#181613", light: "#faf8f3" },
  report: { dark: "#0f1319", light: "#fafaf9" },
  charcoal: { dark: "#171717", light: "#fafaf9" },
};

function applyToDocument(settings: Settings, resolved: ResolvedTheme, language: Language): void {
  const root = document.documentElement;
  root.lang = LOCALE_TAGS[language];
  root.dataset["theme"] = resolved;
  root.dataset["density"] = settings.density;
  root.dataset["palette"] = settings.palette;
  // ChatView.css scales its type tokens by this: the chosen size over the density's
  root.style.setProperty("--chat-scale", String(chatFontSize(settings) / CHAT_BASE_FONT[settings.density]));
  // ChatView.css sets the transcript's prose in this, and falls back to --font-ui without it
  const chatFont = chatFontStack(settings.chatFontFamily);
  if (chatFont === null) root.style.removeProperty("--font-chat");
  else root.style.setProperty("--font-chat", chatFont);
  const appearance = appearanceColors(settings.appearancePreset,resolved,settings.customColors);
  for(const key of Object.keys(appearanceVariables(CUSTOM_DEFAULT)))root.style.removeProperty(key);
  if(appearance)for(const [key,value] of Object.entries(appearanceVariables(appearance)))root.style.setProperty(key,value);
  if(settings.uiFontFamily)root.style.setProperty("--font-ui",`${settings.uiFontFamily}, sans-serif`);else root.style.removeProperty("--font-ui");
  root.style.colorScheme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", appearance?.surface ?? THEME_COLOR[settings.palette][resolved]);
}

interface SettingsContextValue {
  settings: Settings;
  /** the theme after resolving `system` against the OS preference */
  resolvedTheme: ResolvedTheme;
  /** the language after resolving `system` against the browser's */
  resolvedLanguage: Language;
  update: (patch: Partial<Settings>) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [systemDark, setSystemDark] = useState(() => resolveTheme("system") === "dark");

  useEffect(() => {
    const query = window.matchMedia?.(DARK_QUERY);
    if (!query) return;
    const onChange = (event: MediaQueryListEvent): void => setSystemDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const resolvedTheme: ResolvedTheme = settings.theme === "system" ? (systemDark ? "dark" : "light") : settings.theme;

  const [browserLanguages, setBrowserLanguages] = useState<readonly string[]>(() => (typeof navigator !== "undefined" ? navigator.languages : []));
  useEffect(() => {
    const onChange = (): void => setBrowserLanguages([...navigator.languages]);
    window.addEventListener("languagechange", onChange);
    return () => window.removeEventListener("languagechange", onChange);
  }, []);
  const resolvedLanguage = resolveLanguage(settings.language, browserLanguages);
  // helpers outside React read this during the same render, so it is set before the children render
  setCurrentLanguage(resolvedLanguage);

  useEffect(() => {
    applyToDocument(settings, resolvedTheme, resolvedLanguage);
  }, [settings, resolvedTheme, resolvedLanguage]);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((current) => {
      const next = sanitizeSettings({ ...current, ...patch });
      saveSettings(next);
      return next;
    });
  }, []);

  const value = useMemo(() => ({ settings, resolvedTheme, resolvedLanguage, update }), [settings, resolvedTheme, resolvedLanguage, update]);
  return createElement(SettingsContext.Provider, { value }, children);
}

export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext);
  if (value === null) throw new Error("useSettings needs a SettingsProvider above it");
  return value;
}

export const PANE_VIEW_KEY_PREFIX = "termweave:view:";

/** Forgets every pane's own lens on this device, so each opens in the default one again. */
export function forgetPaneViews(given?: Pick<Storage, "length" | "key" | "removeItem">): number {
  const keys: string[] = [];
  try {
    // inside the try: reading localStorage itself throws where storage is blocked
    const storage = given ?? window.localStorage;
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key?.startsWith(PANE_VIEW_KEY_PREFIX)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    /* private mode: there is nothing remembered to forget */
  }
  return keys.length;
}
