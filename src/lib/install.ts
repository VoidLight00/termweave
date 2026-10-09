import { useCallback, useSyncExternalStore } from "react";
import { t } from "./i18n.ts";

interface InstallChoice {
  outcome: "accepted" | "dismissed";
  platform: string;
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<InstallChoice>;
}

type Listener = () => void;

let pendingPrompt: BeforeInstallPromptEvent | null = null;
let installedByEvent = false;
let revision = 0;
const listeners = new Set<Listener>();

function emitChange(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): number {
  return revision;
}

function isStandalone(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const iosNavigator = navigator as Navigator & { standalone?: boolean };
  return installedByEvent || iosNavigator.standalone === true || window.matchMedia?.("(display-mode: standalone)").matches === true;
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    pendingPrompt = event as BeforeInstallPromptEvent;
    emitChange();
  });
  window.addEventListener("appinstalled", () => {
    installedByEvent = true;
    pendingPrompt = null;
    emitChange();
  });
  const displayMode = window.matchMedia?.("(display-mode: standalone)");
  displayMode?.addEventListener("change", emitChange);
}

export interface InstallEnvironment {
  userAgent: string;
  /** window.isSecureContext: browsers only offer installation over HTTPS or localhost */
  secure: boolean;
  /** iPadOS reports a Mac user agent; touch points tell the two apart */
  maxTouchPoints: number;
}

/** How to install when the browser offers no prompt of its own (iOS never does). */
export function installHelp(env: InstallEnvironment): string {
  const ua = env.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && env.maxTouchPoints > 1);
  if (ios) return t("Tap the Share button, then Add to Home Screen.");
  if (!env.secure) return t("Open this page over HTTPS (or on localhost) to install it.");
  if (/Firefox\//.test(ua) && !/Android/.test(ua)) return t("Firefox on desktop can't install web apps. Open this page in Chrome or Edge.");
  if (/Android/.test(ua)) return t("Open the browser menu, then Install app or Add to Home screen.");
  if (/Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\//.test(ua)) return t("Choose File, then Add to Dock.");
  return t("Use the install icon in the address bar, or the browser menu's Install option.");
}

function currentInstallHelp(): string {
  if (typeof window === "undefined" || typeof navigator === "undefined") return "";
  return installHelp({ userAgent: navigator.userAgent, secure: window.isSecureContext, maxTouchPoints: navigator.maxTouchPoints ?? 0 });
}

export interface InstallPromptState {
  canInstall: boolean;
  installed: boolean;
  install(): Promise<void>;
  /** what to tell the user when there is no prompt to show */
  help: string;
}

export function useInstallPrompt(): InstallPromptState {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const installed = isStandalone();
  const install = useCallback(async (): Promise<void> => {
    const prompt = pendingPrompt;
    if (prompt === null || isStandalone()) return;
    await prompt.prompt();
    await prompt.userChoice;
    if (pendingPrompt === prompt) pendingPrompt = null;
    emitChange();
  }, []);
  return { canInstall: pendingPrompt !== null && !installed, installed, install, help: currentInstallHelp() };
}
