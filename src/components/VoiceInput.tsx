/**
 * The mic button and the recording pill for the composer and the terminal input line, on top
 * of useVoiceInput. Dictated text is only inserted at the caret; nothing here ever sends.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Check, Mic, Square, X } from "lucide-react";

import "./VoiceInput.css";

import { useT, type Translate } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";
import { isMacPlatform, isVoiceShortcut } from "../lib/shortcuts.ts";
import { applyDictation, useVoiceInput, type InsertedSpan, type VoiceError, type VoiceInput, type VoiceText, type VoiceUnavailable } from "../lib/voice.ts";
import { VOICE_MAX_SECONDS, type VoiceMode } from "../../shared/voice.ts";

// literal t() calls, so the i18n test finds every key
function errorNote(t: Translate, error: VoiceError | VoiceUnavailable): string | null {
  switch (error) {
    case "insecure": return t("Voice input needs HTTPS");
    case "permission": return t("Microphone permission was denied");
    case "no_mic": return t("No microphone found");
    case "not_configured": return t("Add an OpenAI API key in Settings > Voice input");
    case "provider_auth": return t("The OpenAI key was refused");
    case "provider":
    case "network": return t("Transcription failed");
    case "too_large": return t("Recording is too long");
    case "no_speech": return t("No speech was heard");
    case "unsupported": return t("This browser cannot record audio");
    case "disabled": return null;
  }
}

const BAR_COUNT = 7;

// Mod+Shift+Space dictates into one mounted field: the focused one, else the composer, else any visible one
interface VoiceTarget { mode: VoiceMode; box: RefObject<HTMLTextAreaElement | null>; voice: () => VoiceInput; press: () => void }
const targets = new Set<VoiceTarget>();
let held: VoiceTarget | null = null;

function shortcutTarget(): VoiceTarget | null {
  const usable = [...targets].filter((target) => target.voice().available && target.box.current !== null && target.box.current.getClientRects().length > 0);
  return usable.find((target) => target.box.current === document.activeElement)
    ?? usable.find((target) => target.mode === "chat")
    ?? usable[0] ?? null;
}

function releaseHeld(): void {
  const target = held;
  held = null;
  target?.voice().release();
}

function onShortcutDown(event: KeyboardEvent): void {
  if (!isVoiceShortcut(event, isMacPlatform())) return;
  const target = shortcutTarget();
  if (!target) return;
  // a focused terminal must not also get the key (xterm would send ^@ for it)
  event.preventDefault();
  event.stopPropagation();
  if (event.repeat || held) return;
  held = target;
  target.press();
}

function onShortcutUp(event: KeyboardEvent): void {
  if (held && (event.code === "Space" || event.key === " " || event.key === "Shift" || event.key === "Meta" || event.key === "Control")) releaseHeld();
}

function registerTarget(target: VoiceTarget): () => void {
  if (targets.size === 0) {
    window.addEventListener("keydown", onShortcutDown, true);
    window.addEventListener("keyup", onShortcutUp, true);
    window.addEventListener("blur", releaseHeld);
  }
  targets.add(target);
  return () => {
    targets.delete(target);
    if (held === target) held = null;
    if (targets.size > 0) return;
    window.removeEventListener("keydown", onShortcutDown, true);
    window.removeEventListener("keyup", onShortcutUp, true);
    window.removeEventListener("blur", releaseHeld);
  };
}

export interface DictationOptions {
  mode: VoiceMode;
  connected: boolean;
  polish: boolean;
  keywords?: () => string[];
  box: RefObject<HTMLTextAreaElement | null>;
  /** the input's current text */
  read: () => string;
  /** sets the text and puts the caret at `caret`, without taking focus */
  write: (value: string, caret: number) => void;
  /** the input's character limit: a dictation that would pass it is refused whole, not cut */
  maxLength?: number;
  /** the input's one-line note: a failed dictation's reason, null to clear it */
  onNote: (note: string | null) => void;
}

export interface Dictation {
  /** settings.voiceInput: the button and pill are shown at all */
  shown: boolean;
  connected: boolean;
  voice: VoiceInput;
  /** drops the polish still owed to text already in the box: the caller is sending that text as it is */
  forget: () => void;
  /** the transcript so far, while it is being made */
  partial: string;
  press: () => void;
}

/**
 * Inserts what is said at the caret (raw first, then its polished form over it unless the user
 * edited that span meanwhile), registers the field for the desktop shortcut, cancels on Esc,
 * on unmount and when the connection drops.
 */
export function useDictation(options: DictationOptions): Dictation {
  const t = useT();
  const { settings } = useSettings();
  const shown = settings.voiceInput;
  const [partial, setPartial] = useState("");
  const latest = useRef(options);
  latest.current = options;
  // per take: a slow polish of an earlier dictation must not land on a later one's words
  const spans = useRef(new Map<number, InsertedSpan>());

  const apply = useCallback((result: VoiceText): void => {
    const { box, read, write, maxLength, onNote } = latest.current;
    const value = read();
    const element = box.current;
    const live = element !== null && element.value === value;
    const selection = live ? { start: element.selectionStart, end: element.selectionEnd } : { start: value.length, end: value.length };
    const next = applyDictation(value, selection, spans.current, result, maxLength);
    if (next === "too_long") onNote(t("The dictation does not fit in the box"));
    else if (next) write(next.value, next.caret);
  }, [t]);

  // An answer that lands while an IME is composing (a Hangul syllable half typed) would rewrite the
  // box under the composition and break it: it waits for compositionend, in arrival order.
  const composing = useRef(false);
  const held = useRef<VoiceText[]>([]);
  const onText = useCallback((result: VoiceText): void => {
    if (composing.current) held.current.push(result);
    else apply(result);
  }, [apply]);

  useEffect(() => {
    const element = options.box.current;
    if (!element) return;
    const start = (): void => { composing.current = true; };
    const end = (): void => {
      composing.current = false;
      // after the input event that commits the syllable, so read() already holds it
      setTimeout(() => {
        if (composing.current) return;
        const waiting = held.current.splice(0);
        for (const result of waiting) apply(result);
      }, 0);
    };
    element.addEventListener("compositionstart", start);
    element.addEventListener("compositionend", end);
    return () => {
      element.removeEventListener("compositionstart", start);
      element.removeEventListener("compositionend", end);
    };
  }, [options.box, apply]);
  // a flush already scheduled finds nothing to insert once the field is gone
  useEffect(() => () => { held.current = []; }, []);

  const voice = useVoiceInput({
    mode: options.mode,
    enabled: shown,
    polish: options.polish,
    keywords: options.keywords,
    onText,
    onPartial: setPartial,
  });
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  // a transcript waiting for an IME composition to end is part of what the user cancels
  const engineCancel = voice.cancel;
  const cancel = useCallback((): void => { held.current = []; engineCancel(); }, [engineCancel]);
  const forget = useCallback((): void => { spans.current.clear(); held.current = held.current.filter((result) => result.phase === "raw"); }, []);

  const press = useCallback((): void => {
    if (voiceRef.current.state === "idle") { setPartial(""); latest.current.onNote(null); }
    voiceRef.current.press();
  }, []);

  useEffect(() => {
    if (voice.error) latest.current.onNote(errorNote(t, voice.error));
  }, [voice.error, t]);

  useEffect(() => {
    if (voice.state === "idle") setPartial("");
  }, [voice.state]);

  useEffect(() => {
    if (!options.connected) cancel();
  }, [options.connected, cancel]);

  const active = voice.state !== "idle";
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, cancel]);

  useEffect(() => {
    if (!shown) return;
    return registerTarget({ mode: latest.current.mode, box: latest.current.box, voice: () => voiceRef.current, press });
  }, [shown, press]);

  return { shown, connected: options.connected, voice: { ...voice, cancel }, forget, partial, press };
}

/** The mic: press to talk, held (release finishes) or tapped (tap again to finish). */
export function MicButton({ dictation, className = "" }: { dictation: Dictation; className?: string }) {
  const t = useT();
  const { voice, connected, press } = dictation;
  const recording = voice.state === "starting" || voice.state === "recording";
  const reason = voice.unavailableReason ? errorNote(t, voice.unavailableReason) : null;
  const label = recording ? t("Insert dictation") : t("Dictate (hold)");
  // a pointer already acted on pointerdown, so the click that follows its release is skipped;
  // a touch tap's click has detail 0 like a keyboard's, so detail cannot tell them apart
  const pointerUpAt = useRef(-Infinity);
  return (
    <span className={`voice-mic-wrap ${className}`} data-state={voice.state}>
      <span className="voice-mic-ring" ref={voice.bindRing} aria-hidden="true" />
      <button
        type="button"
        className="voice-mic"
        aria-label={label}
        aria-pressed={recording}
        title={reason ?? label}
        disabled={!voice.available || !connected}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          // focus and the soft keyboard stay where they are
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          press();
        }}
        onPointerUp={() => { pointerUpAt.current = performance.now(); voice.release(); }}
        onPointerCancel={() => voice.release()}
        onClick={() => { if (performance.now() - pointerUpAt.current > 500) press(); }}
      >
        {recording ? <Square aria-hidden="true" /> : <Mic aria-hidden="true" />}
      </button>
    </span>
  );
}

function clock(totalSeconds: number): string {
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

/**
 * Always mounted, so CSS transitions carry both ways (a cancel mid-entrance reverses) and the
 * live region exists before it speaks. `align` is the mic's side: the pill grows from there.
 */
export function VoiceRecordingPill({ dictation, align }: { dictation: Dictation; align: "start" | "end" }) {
  const t = useT();
  const { voice, partial } = dictation;
  const { state } = voice;
  const open = state !== "idle";
  const seconds = Math.floor(voice.elapsedMs / 1000);
  const left = VOICE_MAX_SECONDS - seconds;
  const label = state === "transcribing" ? t("Transcribing…")
    : state === "starting" ? t("Ready…")
    : voice.silent ? t("No microphone input")
    : t("Recording");
  return (
    <div className={`voice-pill${open ? " is-open" : ""}`} data-state={state} data-align={align} aria-hidden={!open}>
      <button type="button" className="voice-pill-button voice-cancel" aria-label={t("Cancel dictation")} title={t("Cancel dictation")}
        tabIndex={open ? 0 : -1} onPointerDown={(event) => event.preventDefault()} onClick={() => voice.cancel()}>
        <X aria-hidden="true" />
      </button>
      <span className="voice-pill-dot" aria-hidden="true" />
      <span className="voice-pill-label" role="status" aria-live="polite">{open ? label : ""}</span>
      {partial !== "" && <span className="voice-pill-partial" title={partial}>{partial}</span>}
      <span className="voice-bars" ref={voice.bindBars} aria-hidden="true">
        {Array.from({ length: BAR_COUNT }, (_, index) => <span key={index} data-voice-bar="" />)}
      </span>
      <span className="voice-meter" aria-hidden="true"><span ref={voice.bindMeter} /></span>
      <span className={`voice-timer${state === "recording" && left <= 10 ? " is-ending" : ""}`} aria-hidden="true">
        {clock(state === "recording" && left <= 10 ? Math.max(0, left) : seconds)}
      </span>
      <button type="button" className="voice-pill-button voice-done" aria-label={t("Insert dictation")} title={t("Insert dictation")}
        tabIndex={open ? 0 : -1} disabled={state === "transcribing"} onPointerDown={(event) => event.preventDefault()} onClick={() => voice.finish()}>
        <Check aria-hidden="true" />
      </button>
    </div>
  );
}
