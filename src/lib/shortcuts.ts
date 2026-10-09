import { useEffect } from "react";
import { useSettings } from "./settings.ts";
import type { ShortcutOverrides } from "./shortcutBindings.ts";

import type { AppActions } from "./actions.ts";

export const SHORTCUTS = [
  { id: "palette", label: "Command palette", keys: ["Mod", "Shift", "K"] },
  { id: "toggle-view", label: "Switch chat / terminal", keys: ["Mod", "Shift", "J"] },
  { id: "toggle-sidebar", label: "Toggle sidebar", keys: ["Mod", "Shift", "B"] },
  // Mod+Shift+N keeps working where the browser lets it through (the installed app), but Chrome
  // keeps Ctrl+Shift+N for a new incognito window in a tab: O is the one shown, and works in both
  { id: "new-session", label: "New session", keys: ["Mod", "Shift", "O"] },
  { id: "previous-pane", label: "Previous pane", keys: ["Mod", "Shift", "ArrowUp"] },
  { id: "next-pane", label: "Next pane", keys: ["Mod", "Shift", "ArrowDown"] },
  { id: "settings", label: "Settings", keys: ["Mod", "Shift", ","] },
  // listed only: held, not dispatched; VoiceInput.tsx listens for it itself (isVoiceShortcut)
  { id: "voice", label: "Dictate (hold)", keys: ["Mod", "Shift", "Space"] },
] as const;

export type ShortcutId = (typeof SHORTCUTS)[number]["id"];

export interface ShortcutEventLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

const KEY_TO_ID: Readonly<Record<string, ShortcutId>> = {
  k: "palette",
  j: "toggle-view",
  b: "toggle-sidebar",
  n: "new-session",
  o: "new-session",
  ArrowUp: "previous-pane",
  ArrowDown: "next-pane",
  ",": "settings",
};

export function shortcutKeys(id: ShortcutId, overrides: ShortcutOverrides): string[] {
  if (Object.hasOwn(overrides, id)) return overrides[id] ? [overrides[id]!] : [];
  return Object.entries(KEY_TO_ID).filter(([, action]) => action === id).map(([key]) => key);
}
export function shortcutConflict(id: ShortcutId, keys: string[], overrides: ShortcutOverrides): boolean {
  return SHORTCUTS.some((other) => other.id !== id && shortcutKeys(other.id, overrides).some((key) => keys.includes(key)));
}

export function matchShortcut(event: ShortcutEventLike, platformIsMac: boolean, overrides: ShortcutOverrides = {}): ShortcutId | null {
  if (event.isComposing || event.keyCode === 229) return null;
  const hasMod = platformIsMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!hasMod || !event.shiftKey || event.altKey) return null;
  // Shift+Comma produces "<" on common keyboard layouts.
  const key = event.code === "Comma" ? "," : /^Digit[0-9]$/.test(event.code ?? "") ? event.code!.slice(-1) : event.key.length === 1 ? event.key.toLowerCase() : event.key;
  for (const shortcut of SHORTCUTS) {
    if (shortcut.id === "voice") continue;
    if (Object.hasOwn(overrides, shortcut.id) && overrides[shortcut.id] === key) return shortcut.id;
  }
  const id = KEY_TO_ID[key];
  return id && !Object.hasOwn(overrides, id) ? id : null;
}

/** Mod+Shift+Space, held to dictate. matchShortcut never returns "voice": it has no action. */
export function isVoiceShortcut(event: ShortcutEventLike, platformIsMac: boolean): boolean {
  const hasMod = platformIsMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return hasMod && event.shiftKey && !event.altKey && (event.code === "Space" || event.key === " ");
}

/**
 * Mod+Shift+ArrowUp/ArrowDown move the selection in a text field (on a Mac Cmd+Shift+↑ selects to
 * the start of the text): in the message box or any other field they stay the field's, and switch
 * panes everywhere else, the terminal included (its own input element is xterm's, not a field to edit).
 */
export interface KeyTargetLike {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
  classList?: { contains(name: string): boolean };
}

export function keepsArrowsForText(target: KeyTargetLike | EventTarget | null): boolean {
  if (target === null || typeof target !== "object" || !("tagName" in target)) return false;
  const element = target as KeyTargetLike;
  if (element.classList?.contains("xterm-helper-textarea")) return false;
  if (element.isContentEditable) return true;
  const tag = element.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag !== "INPUT") return false;
  const type = element.type ?? "";
  return type === "text" || type === "search" || type === "url" || type === "email" || type === "password" || type === "tel" || type === "number" || type === "";
}

/**
 * The capture listener below only prevents the browser's default, so xterm would still encode an
 * app shortcut for the pane: its key handler asks this first.
 */
export function isAppShortcut(event: ShortcutEventLike, overrides: ShortcutOverrides = {}): boolean {
  return matchShortcut(event, isMacPlatform(), overrides) !== null;
}

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
}

export function modKeyLabel(): string {
  return isMacPlatform() ? "⌘" : "Ctrl";
}

export function formatKeys(keys: readonly string[]): string[] {
  const mod = modKeyLabel();
  return keys.map((key) => (key === "Mod" ? mod : key));
}

export function useShortcuts(actions: AppActions, enabled: boolean): void {
  const { settings } = useSettings();
  useEffect(() => {
    if (!enabled) return;
    const platformIsMac = isMacPlatform();
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.target as HTMLElement | null)?.closest?.("[data-shortcut-recorder], .browser-preview")) return;
      const shortcut = matchShortcut(event, platformIsMac, settings.shortcutOverrides);
      if (shortcut === null) return;
      if (event.key.startsWith("Arrow") && keepsArrowsForText(event.target)) return;
      event.preventDefault();
      switch (shortcut) {
        case "palette":
          actions.openPalette();
          break;
        case "toggle-view":
          actions.toggleView();
          break;
        case "toggle-sidebar":
          actions.toggleSidebar();
          break;
        case "new-session":
          actions.openNewSession();
          break;
        case "previous-pane":
          actions.selectAdjacentPane(-1);
          break;
        case "next-pane":
          actions.selectAdjacentPane(1);
          break;
        case "settings":
          actions.openSettings();
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [actions, enabled, settings.shortcutOverrides]);
}
