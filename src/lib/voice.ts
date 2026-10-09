/**
 * Dictation for the composer and the terminal input line. With a key on the server the
 * browser records a clip (MediaRecorder) and POSTs it to /api/voice/transcribe, which streams
 * NDJSON VoiceEvents back; without one it falls back to the browser's own SpeechRecognition.
 * Text is only ever handed to `onText` for the caller to insert, never sent.
 *
 * The level meter paints straight onto DOM nodes from one requestAnimationFrame loop, so the
 * waveform moves at frame rate without a React render per frame.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchVoiceStatus } from "./api.ts";
import { LOCALE_TAGS, type Language } from "./i18n.ts";
import { useSettings } from "./settings.ts";
import {
  VOICE_FORM,
  VOICE_KEYWORDS_MAX,
  VOICE_KEYWORD_MAX_CHARS,
  VOICE_MAX_AUDIO_BYTES,
  VOICE_MAX_SECONDS,
  type VoiceEvent,
  type VoiceMode,
  type VoiceStatus,
} from "../../shared/voice.ts";

export type VoiceState = "idle" | "starting" | "recording" | "transcribing";
export type VoiceEngine = "server" | "browser";
/** why the last dictation failed, short enough to key a translated message on */
export type VoiceError = "insecure" | "permission" | "no_mic" | "not_configured" | "provider_auth" | "provider" | "network" | "too_large" | "no_speech";
/** why the mic button is off: the setting, no https, or neither a server key nor browser speech */
export type VoiceUnavailable = "disabled" | "insecure" | "not_configured" | "unsupported";
/** `take` numbers each press-to-text run, so a late answer never lands on another run's words */
export interface VoiceText { text: string; phase: "raw" | "polished"; take: number }

/** a press held this long is push-to-talk (release finishes); a shorter tap toggles */
export const HOLD_MS = 300;
/** after a finish the mic stays open this long, so the next dictation starts at once */
export const WARM_MIC_MS = 30_000;
const SILENT_AFTER_MS = 3000;
/** below this RMS the input is a muted or wrong device, not a quiet room */
const SILENT_RMS = 0.003;
const METER_INTERVAL_MS = 250;
/** a muted track can deliver exact zeros forever: the recorder running this long counts as ready */
const READY_FALLBACK_MS = 400;
const BAR_MIN = 0.12;
const BAR_WEIGHTS = [0.45, 0.65, 0.85, 1, 0.85, 0.65, 0.45];
export const VOICE_CONFIG_EVENT = "herdr:voice-config";

const RECORDER_TYPES = [
  ["audio/webm;codecs=opus", "webm"],
  ["audio/mp4", "m4a"],
  ["audio/webm", "webm"],
  ["audio/ogg;codecs=opus", "ogg"],
] as const;

/** The first container the browser records, best first; Safari only has mp4. */
export function pickRecorderMime(isTypeSupported: (type: string) => boolean): { mimeType: string; extension: string } | null {
  for (const [mimeType, extension] of RECORDER_TYPES) if (isTypeSupported(mimeType)) return { mimeType, extension };
  return null;
}

export function classifyRelease(heldMs: number): "finish" | "keep" {
  return heldMs >= HOLD_MS ? "finish" : "keep";
}

/** One-pole smoothing: rises in ~60 ms so syllables show, falls over ~250 ms so it does not flicker. */
export function smoothLevel(previous: number, target: number, dtMs: number): number {
  const tau = target > previous ? 60 : 250;
  return previous + (target - previous) * (1 - Math.exp(-Math.max(0, dtMs) / tau));
}

/**
 * The recorder hears the microphone this much later than the meter does, so the speech gate opens
 * before a word's first sound reaches it: no syllable is clipped by trimming.
 */
export const SPEECH_PREROLL_MS = 350;
/** quiet this long closes the gate; with the pre-roll ~350 ms of quiet stays after the last word */
export const SPEECH_HANG_MS = 700;
/** below this RMS nothing is speech, whatever the room's noise floor */
const SPEECH_MIN_RMS = 0.006;
/** speech is this many times louder than the quietest level heard so far */
const SPEECH_OVER_FLOOR = 3;

export interface SpeechGate {
  readonly open: boolean;
  readonly everOpened: boolean;
  readonly lastLoudAt: number;
  /** one meter reading; "open" or "close" when the recorder should resume or pause */
  step(rms: number, now: number): "open" | "close" | null;
}

/**
 * Silence is billed by the second, so the recorder only runs while someone speaks. The noise
 * floor learns from quiet readings alone: a long sentence never raises it until it shuts itself,
 * and a room too loud to tell apart keeps the gate open (costlier, but nothing said is lost).
 */
export function createSpeechGate(): SpeechGate {
  let open = false;
  let everOpened = false;
  let lastLoudAt = -Infinity;
  let floor = SPEECH_MIN_RMS / 2;
  return {
    get open() { return open; },
    get everOpened() { return everOpened; },
    get lastLoudAt() { return lastLoudAt; },
    step(rms, now) {
      const loud = rms >= Math.max(SPEECH_MIN_RMS, floor * SPEECH_OVER_FLOOR);
      if (loud) lastLoudAt = now;
      else floor = rms < floor ? rms : floor + (rms - floor) * 0.01;
      if (loud && !open) { open = true; everOpened = true; return "open"; }
      if (!loud && open && now - lastLoudAt >= SPEECH_HANG_MS) { open = false; return "close"; }
      return null;
    },
  };
}

/** RMS of [-1, 1] samples to 0..1 on a -60..-10 dBFS scale, so normal speech fills the meter. */
export function levelFromRms(rms: number): number {
  if (!(rms > 0)) return 0;
  return Math.min(1, Math.max(0, (20 * Math.log10(rms) + 60) / 50));
}

/**
 * Seven bar heights in [BAR_MIN, 1]. The outer bars carry less of the level, and an idle
 * breath (in unison, so the centre never falls below the edges) keeps them moving in silence.
 */
export function barScales(level: number, timeMs: number): number[] {
  const amount = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  const breath = 0.5 + 0.5 * Math.sin(timeMs / 600);
  return BAR_WEIGHTS.map((weight, index) => {
    const base = BAR_MIN + 0.08 * weight * breath;
    const wobble = 0.7 + 0.3 * (0.5 + 0.5 * Math.sin(timeMs / 110 + index * 1.9));
    return Math.min(1, base + (1 - base) * amount * weight * wobble);
  });
}

function isVoiceEvent(value: unknown): value is VoiceEvent {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.type === "delta" || record.type === "done" || record.type === "polished") return typeof record.text === "string";
  return record.type === "error" && typeof record.code === "string" && typeof record.message === "string";
}

function parseVoiceLine(line: string): VoiceEvent | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  const event: unknown = JSON.parse(trimmed);
  if (!isVoiceEvent(event)) throw new Error(`unexpected voice event: ${trimmed.slice(0, 120)}`);
  return event;
}

/** The transcribe stream's events as they arrive; a line may span chunks, the last may lack its newline. */
export async function* readVoiceEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<VoiceEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  try {
    while (!finished) {
      const { done, value } = await reader.read();
      finished = done;
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = done ? "" : lines.pop() ?? "";
      for (const line of lines) {
        const event = parseVoiceLine(line);
        if (event) yield event;
      }
    }
  } finally {
    // a consumer that stops early (cancel, bad line) must not leave the response open
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * `text` in place of the selection, with one space against a neighbouring non-space character
 * so dictation never glues onto a word. start/end cover the inserted text alone, for
 * replaceIfUnchanged when the polished version arrives.
 */
export function insertAtCaret(value: string, selectionStart: number, selectionEnd: number, text: string): { value: string; start: number; end: number } {
  const from = Math.max(0, Math.min(selectionStart, selectionEnd, value.length));
  const to = Math.min(value.length, Math.max(selectionStart, selectionEnd, from));
  const spoken = text.trim();
  if (spoken === "") return { value, start: from, end: to };
  const before = value.slice(0, from);
  const after = value.slice(to);
  const lead = before !== "" && !/\s$/.test(before) ? " " : "";
  const trail = after !== "" && !/^\s/.test(after) ? " " : "";
  const start = before.length + lead.length;
  return { value: before + lead + spoken + trail + after, start, end: start + spoken.length };
}

/** Swaps the raw dictation for its polished form, unless the user has edited that span since (null). */
export function replaceIfUnchanged(value: string, range: { start: number; end: number }, expected: string, replacement: string): { value: string; end: number } | null {
  if (range.start < 0 || range.end > value.length || value.slice(range.start, range.end) !== expected) return null;
  return { value: value.slice(0, range.start) + replacement + value.slice(range.end), end: range.start + replacement.length };
}

/** Where a take's raw words sit in the box, until its polished form replaces them. */
export interface InsertedSpan { start: number; end: number; text: string }

/** spans past an edit move with it; one the edit overlapped is forgotten, so its polish is dropped */
function shiftSpans(spans: Map<number, InsertedSpan>, from: number, to: number, delta: number): void {
  for (const [take, span] of spans) {
    if (span.start >= to) { span.start += delta; span.end += delta; }
    else if (span.end > from) spans.delete(take);
  }
}

const SPANS_KEPT = 8;

/** The takes' spans, with the box text they were measured against (what the last dictation left there). */
export type DictationSpans = Map<number, InsertedSpan> & { box?: string };

/**
 * One VoiceText applied to the box: raw text goes in at the selection and its span is kept under
 * its take; a polished text replaces only its own take's span, and only while the user has not
 * edited it. Null: nothing to change. `spans` is updated in place.
 * `"too_long"`: the text would push the box past `maxLength`; nothing changes, so a box's limit
 * never cuts the user's own words after the caret.
 */
export function applyDictation(value: string, selection: { start: number; end: number }, spans: DictationSpans, result: VoiceText, maxLength = Infinity): { value: string; caret: number } | "too_long" | null {
  // the box no longer holds what the last dictation left: the user edited it, and the stored
  // offsets may now sit on other words that happen to read the same
  if (spans.box !== undefined && spans.box !== value) spans.clear();
  spans.box = value;
  if (result.phase === "raw") {
    const next = insertAtCaret(value, selection.start, selection.end, result.text);
    if (next.value === value) return null;
    if (next.value.length > maxLength) return "too_long";
    shiftSpans(spans, Math.min(selection.start, selection.end), Math.max(selection.start, selection.end), next.value.length - value.length);
    spans.set(result.take, { start: next.start, end: next.end, text: next.value.slice(next.start, next.end) });
    for (const take of spans.keys()) if (spans.size > SPANS_KEPT) spans.delete(take);
    spans.box = next.value;
    return { value: next.value, caret: next.end };
  }
  const span = spans.get(result.take);
  spans.delete(result.take);
  // a selection is the user's next edit under way and writing the box would collapse it; an
  // unchanged polish has nothing to write at all
  if (!span || selection.start !== selection.end || result.text === span.text) return null;
  const next = replaceIfUnchanged(value, span, span.text, result.text);
  // a polish that no longer fits leaves the raw words, which already did
  if (!next || next.value.length > maxLength) return null;
  shiftSpans(spans, span.start, span.end, next.value.length - value.length);
  // the caret follows the swap only if it was in or after the replaced span
  const caret = selection.start >= span.end ? selection.start + next.end - span.end : selection.start > span.start ? next.end : selection.start;
  spans.box = next.value;
  return { value: next.value, caret };
}

/** SpeechRecognition.lang for the UI language. */
export function speechLang(language: Language): string {
  return LOCALE_TAGS[language];
}

/** What the transcribe route accepts: trimmed, at most VOICE_KEYWORDS_MAX, none longer than VOICE_KEYWORD_MAX_CHARS, no blanks or repeats. */
export function voiceKeywords(words: readonly string[]): string[] {
  const kept = new Set<string>();
  for (const word of words) {
    if (kept.size >= VOICE_KEYWORDS_MAX) break;
    // an overlong term is dropped, as the server does: half a path would steer the transcript wrong
    const keyword = word.trim();
    if (keyword !== "" && keyword.length <= VOICE_KEYWORD_MAX_CHARS) kept.add(keyword);
  }
  return [...kept];
}

/** The server's error-envelope or stream error code as the hook's reason. */
export function voiceErrorFromCode(code: string | null): VoiceError {
  if (code === "voice_not_configured") return "not_configured";
  if (code === "audio_too_large") return "too_large";
  if (code === "provider_auth") return "provider_auth";
  return "provider";
}

/** getUserMedia's DOMException name as the hook's reason. */
export function micErrorReason(name: string): VoiceError {
  return name === "NotAllowedError" || name === "SecurityError" ? "permission" : "no_mic";
}

/** SpeechRecognition's error string; null for the ones that only mean "nothing was said". */
export function speechErrorReason(error: string): VoiceError | null {
  if (error === "no-speech" || error === "aborted") return null;
  if (error === "not-allowed" || error === "service-not-allowed") return "permission";
  if (error === "audio-capture") return "no_mic";
  if (error === "network") return "network";
  return "provider";
}

// lib.dom has no Web Speech recognition types: the slice of the API this file uses
interface SpeechAlternative { readonly transcript: string }
interface SpeechResult { readonly isFinal: boolean; readonly [index: number]: SpeechAlternative | undefined }
interface SpeechResultList { readonly length: number; readonly [index: number]: SpeechResult | undefined }
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onaudiostart: (() => void) | null;
  onresult: ((event: { readonly results: SpeechResultList }) => void) | null;
  onerror: ((event: { readonly error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function speechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const speech = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return speech.SpeechRecognition ?? speech.webkitSpeechRecognition ?? null;
}

function recorderMime(): { mimeType: string; extension: string } | null {
  if (typeof MediaRecorder === "undefined" || typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return null;
  return pickRecorderMime((type) => MediaRecorder.isTypeSupported(type));
}

const tidy = (text: string): string => text.replace(/\s+/g, " ").trim();

// one GET /api/voice per page, shared by every mic button; the settings UI fires VOICE_CONFIG_EVENT after a save
let statusRequest: Promise<VoiceStatus | null> | null = null;
const statusListeners = new Set<(status: VoiceStatus | null) => void>();
let statusEventBound = false;

function loadVoiceStatus(refresh = false): Promise<VoiceStatus | null> {
  if (statusRequest && !refresh) return statusRequest;
  // a failed check counts as "no key" for now and is asked again by the next button that mounts
  const request: Promise<VoiceStatus | null> = fetchVoiceStatus().catch(() => null);
  statusRequest = request;
  void request.then((status) => {
    if (statusRequest !== request) return;
    if (status === null) statusRequest = null;
    for (const listener of statusListeners) listener(status);
  });
  return request;
}

function useVoiceStatus(enabled: boolean): VoiceStatus | null | undefined {
  const [status, setStatus] = useState<VoiceStatus | null | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    if (!statusEventBound) {
      statusEventBound = true;
      window.addEventListener(VOICE_CONFIG_EVENT, () => void loadVoiceStatus(true));
    }
    statusListeners.add(setStatus);
    let live = true;
    void loadVoiceStatus().then((loaded) => { if (live) setStatus(loaded); });
    return () => { live = false; statusListeners.delete(setStatus); };
  }, [enabled]);
  return status;
}

export interface VoiceInputOptions {
  mode: VoiceMode;
  enabled: boolean;
  polish: boolean;
  /** terms that may be spoken (commands, file names, the agent), asked for when a clip is sent */
  keywords?: () => string[];
  onText: (result: VoiceText) => void;
  /** the transcript so far, for a live preview; superseded by onText */
  onPartial?: (text: string) => void;
}

export interface VoiceInput {
  /** false while GET /api/voice is pending too, with unavailableReason null */
  available: boolean;
  unavailableReason: VoiceUnavailable | null;
  engine: VoiceEngine | null;
  state: VoiceState;
  /** whole seconds since audio started flowing, in ms */
  elapsedMs: number;
  /** recording, but ~nothing heard for 3 s: a muted or wrong microphone (server engine only) */
  silent: boolean;
  error: VoiceError | null;
  press(): void;
  release(): void;
  finish(): void;
  cancel(): void;
  bindBars: (el: HTMLElement | null) => void;
  bindRing: (el: HTMLElement | null) => void;
  bindMeter: (el: HTMLElement | null) => void;
}

interface EngineIO {
  setState(state: VoiceState): void;
  setElapsed(ms: number): void;
  setSilent(silent: boolean): void;
  setError(error: VoiceError | null): void;
  options(): VoiceInputOptions;
  engine(): VoiceEngine | null;
  language(): Language;
  recorder(): { mimeType: string; extension: string } | null;
  speech(): SpeechRecognitionCtor | null;
}

/** One press-to-text run while it records; it becomes "pending" work once finished. */
interface Take {
  id: number;
  engine: VoiceEngine;
  /** nothing more is delivered from it */
  discard: boolean;
  /** cancelled or the tab hid: a mic still opening for it closes instead of staying warm */
  releaseMic: boolean;
  /** a finished browser take's entry in `pending`, removed when recognition ends */
  closing: AbortController | null;
  recorder: MediaRecorder | null;
  recorderAt: number | null;
  /** null: the recorder takes the raw microphone and keeps every second */
  gate: SpeechGate | null;
  chunks: Blob[];
  heard: boolean;
  startedAt: number | null;
  recognition: SpeechRecognitionLike | null;
  finalText: string;
}

/** The imperative half of useVoiceInput: mic, recorder, meter loop, uploads. Outlives renders. */
export function createVoiceEngine(io: EngineIO) {
  let phase: VoiceState = "idle";
  let take: Take | null = null;
  let lastTakeId = 0;
  let pressedAt: number | null = null;
  /** finished takes still transcribing; cancel aborts them */
  const pending = new Set<AbortController>();
  let stream: MediaStream | null = null;
  let warmTimer: ReturnType<typeof setTimeout> | null = null;
  let audio: {
    context: AudioContext; analyser: AnalyserNode; samples: Float32Array<ArrayBuffer>; source: MediaStreamAudioSourceNode | null; stream: MediaStream | null;
    /** the microphone SPEECH_PREROLL_MS late, for the gated recorder; null where WebAudio cannot make a stream */
    delayed: MediaStreamAudioDestinationNode | null; delay: DelayNode | null;
  } | null = null;
  let bars: HTMLElement | null = null;
  let ring: HTMLElement | null = null;
  let meterEl: HTMLElement | null = null;
  let frameId = 0;
  const meter = { level: 0, last: 0, meterAt: -Infinity, loudAt: 0, second: 0, silent: false };

  const setPhase = (next: VoiceState): void => {
    phase = next;
    io.setState(next);
    if (next === "starting" || next === "recording") startLoop();
    else stopLoop();
  };

  const settle = (): void => {
    if (take === null && pending.size === 0 && phase !== "idle") setPhase("idle");
  };

  function paint(level: number, now: number, force: boolean): void {
    if (bars) {
      const scales = barScales(level, now);
      bars.querySelectorAll<HTMLElement>("[data-voice-bar]").forEach((bar, index) => {
        bar.style.transform = `scaleY(${(scales[index % scales.length] ?? BAR_MIN).toFixed(3)})`;
      });
    }
    if (ring) ring.style.transform = `scale(${(1 + level * 0.35).toFixed(3)})`;
    if (meterEl && (force || now - meter.meterAt >= METER_INTERVAL_MS)) {
      meter.meterAt = now;
      meterEl.style.transform = `scaleX(${level.toFixed(3)})`;
    }
  }

  function frame(now: number): void {
    frameId = requestAnimationFrame(frame);
    const dt = meter.last === 0 ? 16 : now - meter.last;
    meter.last = now;
    const current = take;
    let rms = 0;
    if (audio && current?.engine === "server" && current.recorder) {
      audio.analyser.getFloatTimeDomainData(audio.samples);
      let sum = 0;
      for (const sample of audio.samples) {
        sum += sample * sample;
        if (sample !== 0) current.heard = true;
      }
      rms = Math.sqrt(sum / audio.samples.length);
    }
    meter.level = smoothLevel(meter.level, levelFromRms(rms), dt);
    paint(meter.level, now, false);
    if (!current) return;
    if (current.gate && current.recorder && current.recorder.state !== "inactive") {
      const change = current.gate.step(rms, now);
      if (change === "open" && current.recorder.state === "paused") current.recorder.resume();
      else if (change === "close" && current.recorder.state === "recording") current.recorder.pause();
    }
    if (phase === "starting" && current.recorderAt !== null && (current.heard || now - current.recorderAt >= READY_FALLBACK_MS)) markRecording(current, now);
    if (phase !== "recording" || current.startedAt === null) return;
    const elapsed = now - current.startedAt;
    const second = Math.floor(elapsed / 1000);
    if (second !== meter.second) { meter.second = second; io.setElapsed(second * 1000); }
    if (current.engine === "server") {
      if (rms >= SILENT_RMS) meter.loudAt = now;
      const silent = now - meter.loudAt >= SILENT_AFTER_MS;
      if (silent !== meter.silent) { meter.silent = silent; io.setSilent(silent); }
    }
    if (elapsed >= VOICE_MAX_SECONDS * 1000) finishTake(false);
  }

  function startLoop(): void {
    if (frameId !== 0 || typeof requestAnimationFrame === "undefined") return;
    meter.last = 0;
    frameId = requestAnimationFrame(frame);
  }

  function stopLoop(): void {
    if (frameId !== 0) cancelAnimationFrame(frameId);
    frameId = 0;
    meter.level = 0;
    paint(0, 0, true);
  }

  function markRecording(current: Take, now: number): void {
    current.startedAt = now;
    meter.loudAt = now;
    meter.second = 0;
    setPhase("recording");
  }

  function releaseStream(): void {
    if (warmTimer !== null) clearTimeout(warmTimer);
    warmTimer = null;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    if (audio) {
      audio.source?.disconnect();
      audio.delay?.disconnect();
      void audio.context.close().catch(() => undefined);
      audio = null;
    }
  }

  function keepWarm(): void {
    if (take !== null) return; // a newer take is using the stream
    if (warmTimer !== null) clearTimeout(warmTimer);
    warmTimer = stream ? setTimeout(releaseStream, WARM_MIC_MS) : null;
  }

  function createAudioContext(): void {
    if ((audio && audio.context.state !== "closed") || typeof AudioContext === "undefined") return;
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    let delayed: MediaStreamAudioDestinationNode | null = null;
    let delay: DelayNode | null = null;
    try {
      delay = context.createDelay(1);
      delay.delayTime.value = SPEECH_PREROLL_MS / 1000;
      delayed = context.createMediaStreamDestination();
      delay.connect(delayed);
    } catch {
      delayed = null;
      delay = null;
    }
    audio = { context, analyser, samples: new Float32Array(analyser.fftSize), source: null, stream: null, delayed, delay };
  }

  /** Resumed inside the press itself: iOS only lets a user gesture start an AudioContext. */
  function ensureAudioContext(): void {
    createAudioContext();
    void audio?.context.resume().catch(() => undefined);
  }

  async function beginServer(current: Take, mime: { mimeType: string; extension: string }): Promise<void> {
    try {
      if (warmTimer !== null) clearTimeout(warmTimer);
      warmTimer = null;
      if (!stream || !stream.getAudioTracks().some((track) => track.readyState === "live")) {
        stream?.getTracks().forEach((track) => track.stop());
        stream = null;
        const opened = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        if (take !== current) {
          // this request was cancelled or finished while the mic opened: only its own stream may
          // close, never the one a newer take is recording from
          if (take !== null || stream || current.releaseMic || document.hidden) opened.getTracks().forEach((track) => track.stop());
          else { stream = opened; keepWarm(); }
          return;
        }
        // an overlapping earlier start may have opened one meanwhile; keep a single stream
        if (stream) opened.getTracks().forEach((track) => track.stop());
        else stream = opened;
      }
      if (warmTimer !== null) clearTimeout(warmTimer);
      warmTimer = null;
      if (audio && audio.stream !== stream) {
        audio.source?.disconnect();
        audio.source = audio.context.createMediaStreamSource(stream);
        audio.source.connect(audio.analyser);
        if (audio.delay) audio.source.connect(audio.delay);
        audio.stream = stream;
      }
      // gated: the recorder takes the delayed copy and starts paused until the first word
      const delayed = audio?.stream === stream ? audio.delayed?.stream ?? null : null;
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(delayed ?? stream, { mimeType: mime.mimeType });
        if (delayed && typeof recorder.pause === "function") current.gate = createSpeechGate();
      } catch {
        recorder = new MediaRecorder(stream, { mimeType: mime.mimeType });
      }
      current.recorder = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size > 0) current.chunks.push(event.data); };
      recorder.onstart = () => { current.recorderAt = performance.now(); };
      recorder.start(1000);
      if (current.gate) recorder.pause();
    } catch (error) {
      if (take !== current) return;
      take = null;
      io.setError(error instanceof DOMException ? micErrorReason(error.name) : "no_mic");
      setPhase("idle");
    }
  }

  function beginBrowser(current: Take, Speech: SpeechRecognitionCtor): void {
    const recognition = new Speech();
    current.recognition = recognition;
    recognition.lang = speechLang(io.language());
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onaudiostart = () => { if (take === current && phase === "starting") markRecording(current, performance.now()); };
    recognition.onresult = (event) => {
      let final = "";
      let interim = "";
      for (let index = 0; index < event.results.length; index++) {
        const result = event.results[index];
        const text = result?.[0]?.transcript ?? "";
        if (result?.isFinal) final += text;
        else interim += text;
      }
      current.finalText = final;
      if (!current.discard && current.id === lastTakeId) io.options().onPartial?.(tidy(final + interim));
    };
    recognition.onerror = (event) => {
      const reason = speechErrorReason(event.error);
      if (reason && !current.discard) io.setError(reason);
    };
    recognition.onend = () => {
      if (take === current) take = null;
      const text = tidy(current.finalText);
      if (!current.discard && text !== "") io.options().onText({ text, phase: "raw", take: current.id });
      if (current.closing) pending.delete(current.closing);
      settle();
    };
    try {
      recognition.start();
    } catch {
      take = null;
      io.setError("provider");
      setPhase("idle");
    }
  }

  function discardTake(current: Take): void {
    current.discard = true;
    const recorder = current.recorder;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      if (recorder.state !== "inactive") recorder.stop();
    }
    current.recognition?.abort();
  }

  async function transcribe(id: number, blob: Blob, extension: string, signal: AbortSignal): Promise<void> {
    const options = io.options();
    const form = new FormData();
    form.append(VOICE_FORM.audio, blob, `voice.${extension}`);
    form.append(VOICE_FORM.mode, options.mode);
    form.append(VOICE_FORM.polish, options.polish ? "1" : "0");
    form.append(VOICE_FORM.keywords, JSON.stringify(voiceKeywords(options.keywords?.() ?? [])));
    form.append(VOICE_FORM.language, io.language());
    try {
      const response = await fetch("/api/voice/transcribe", { method: "POST", body: form, credentials: "same-origin", signal });
      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => null)) as { error?: { code?: unknown } } | null;
        const code = typeof body?.error?.code === "string" ? body.error.code : null;
        if (code === "voice_not_configured") void loadVoiceStatus(true);
        io.setError(voiceErrorFromCode(code));
        return;
      }
      let partial = "";
      for await (const event of readVoiceEvents(response.body)) {
        if (signal.aborted) return;
        // an earlier take still answering must not overwrite the preview of the one being spoken
        if (event.type === "delta") { partial += event.text; if (id === lastTakeId) io.options().onPartial?.(tidy(partial)); }
        else if (event.type === "error") io.setError(voiceErrorFromCode(event.code));
        else if (event.text.trim() !== "") io.options().onText({ text: event.text.trim(), phase: event.type === "done" ? "raw" : "polished", take: id });
      }
    } catch (error) {
      if (signal.aborted) return;
      // fetch and a dropped stream throw TypeError; anything else is a reply we could not read
      io.setError(error instanceof TypeError ? "network" : "provider");
    }
  }

  async function deliver(current: Take, controller: AbortController, mime: { mimeType: string; extension: string }): Promise<void> {
    try {
      if (controller.signal.aborted) return;
      const blob = new Blob(current.chunks, { type: current.recorder?.mimeType || mime.mimeType });
      if (blob.size === 0) return;
      if (blob.size > VOICE_MAX_AUDIO_BYTES) { io.setError("too_large"); return; }
      await transcribe(current.id, blob, mime.extension, controller.signal);
    } finally {
      pending.delete(controller);
      settle();
    }
  }

  /** `release`: the tab is going away, so the mic closes now instead of staying warm. */
  function finishTake(release: boolean): void {
    pressedAt = null;
    const current = take;
    if (!current) return;
    take = null;
    if (phase === "starting") {
      // nothing safe to keep was said yet; the stream (if it opened) stays warm
      discardTake(current);
      current.releaseMic = release;
      if (release || document.hidden) releaseStream(); else keepWarm();
      setPhase("idle");
      return;
    }
    const controller = new AbortController();
    pending.add(controller);
    setPhase("transcribing");
    if (current.engine === "browser") {
      current.closing = controller;
      controller.signal.addEventListener("abort", () => { current.discard = true; current.recognition?.abort(); });
      current.recognition?.stop();
      return;
    }
    const mime = io.recorder();
    const recorder = current.recorder;
    const gate = current.gate;
    const finishedAt = performance.now();
    const stopped = (): void => {
      if (release || document.hidden) releaseStream(); else keepWarm();
      if (gate && !gate.everOpened) {
        // nothing above the room's noise was heard: no upload, nothing billed
        io.setError("no_speech");
        pending.delete(controller);
        settle();
        return;
      }
      if (mime) void deliver(current, controller, mime);
      else { pending.delete(controller); settle(); }
    };
    if (!recorder || recorder.state === "inactive") { stopped(); return; }
    recorder.onstop = stopped;
    // still speaking at the finish: the last words are SPEECH_PREROLL_MS behind in the delay line
    const tail = gate && recorder.state === "recording" && !release ? Math.max(0, gate.lastLoudAt + SPEECH_PREROLL_MS - finishedAt) : 0;
    if (tail > 0) setTimeout(() => { if (recorder.state !== "inactive") recorder.stop(); }, tail);
    else recorder.stop();
  }

  function cancel(): void {
    pressedAt = null;
    const current = take;
    take = null;
    if (current) { current.releaseMic = true; discardTake(current); }
    for (const controller of [...pending]) controller.abort();
    pending.clear();
    releaseStream();
    if (phase !== "idle") setPhase("idle");
  }

  function press(): void {
    if (phase === "starting" || phase === "recording") { finishTake(false); return; }
    // an earlier take is still being transcribed: a second one answering first would put its
    // words in front of the first's
    if (pending.size > 0) return;
    const engine = io.engine();
    if (engine === null) return;
    const mime = io.recorder();
    const Speech = io.speech();
    if (engine === "server" ? !mime : !Speech) return;
    io.setError(null);
    io.setElapsed(0);
    io.setSilent(false);
    meter.silent = false;
    const current: Take = { id: ++lastTakeId, engine, discard: false, releaseMic: false, closing: null, recorder: null, recorderAt: null, gate: null, chunks: [], heard: false, startedAt: null, recognition: null, finalText: "" };
    take = current;
    pressedAt = performance.now();
    // the pill shows on this very frame; the mic catches up
    setPhase("starting");
    if (engine === "server" && mime) {
      if (!navigator.mediaDevices?.getUserMedia) { take = null; io.setError("insecure"); setPhase("idle"); return; }
      ensureAudioContext();
      void beginServer(current, mime);
    } else if (Speech) beginBrowser(current, Speech);
  }

  function release(): void {
    const at = pressedAt;
    pressedAt = null;
    if (at !== null && classifyRelease(performance.now() - at) === "finish") finishTake(false);
  }

  function onHidden(): void {
    if (phase === "recording") finishTake(true);
    else if (phase === "starting") cancel();
    else releaseStream();
  }

  const bind = (assign: (el: HTMLElement | null) => void) => (el: HTMLElement | null): void => {
    assign(el);
    if (el && frameId === 0) paint(0, 0, true);
  };

  return {
    press,
    release,
    finish: () => finishTake(false),
    cancel,
    onHidden,
    // the browser's first AudioContext starts its audio stack (~100 ms, blocking): done while
    // idle and left suspended, the press only resumes it, so the pill paints on that frame
    prewarm: createAudioContext,
    bindBars: bind((el) => { bars = el; }),
    bindRing: bind((el) => { ring = el; }),
    bindMeter: bind((el) => { meterEl = el; }),
  };
}

export function useVoiceInput(options: VoiceInputOptions): VoiceInput {
  const { resolvedLanguage } = useSettings();
  const status = useVoiceStatus(options.enabled);
  const mime = useMemo(recorderMime, []);
  const Speech = useMemo(speechRecognitionCtor, []);
  const secure = typeof window !== "undefined" && window.isSecureContext;

  let engine: VoiceEngine | null = null;
  let unavailableReason: VoiceUnavailable | null = null;
  if (!options.enabled) unavailableReason = "disabled";
  else if (!secure) unavailableReason = "insecure";
  else if (status === undefined) unavailableReason = null;
  else if (status?.configured && mime) engine = "server";
  else if (Speech) engine = "browser";
  else unavailableReason = status?.configured ? "unsupported" : "not_configured";

  const [state, setState] = useState<VoiceState>("idle");
  const [elapsedMs, setElapsed] = useState(0);
  const [silent, setSilent] = useState(false);
  const [error, setError] = useState<VoiceError | null>(null);

  const latest = useRef({ options, engine, language: resolvedLanguage });
  latest.current = { options, engine, language: resolvedLanguage };

  const [voice] = useState(() => createVoiceEngine({
    setState,
    setElapsed,
    setSilent,
    setError,
    options: () => latest.current.options,
    engine: () => latest.current.engine,
    language: () => latest.current.language,
    recorder: () => mime,
    speech: () => Speech,
  }));

  useEffect(() => {
    const onVisibility = (): void => { if (document.visibilityState === "hidden") voice.onHidden(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { document.removeEventListener("visibilitychange", onVisibility); voice.cancel(); };
  }, [voice]);

  // switching engines or turning the setting off mid-dictation drops it
  useEffect(() => () => voice.cancel(), [voice, engine]);

  useEffect(() => {
    if (engine !== "server") return;
    if (typeof requestIdleCallback === "undefined") {
      const timer = setTimeout(voice.prewarm, 1000);
      return () => clearTimeout(timer);
    }
    const idle = requestIdleCallback(voice.prewarm, { timeout: 3000 });
    return () => cancelIdleCallback(idle);
  }, [voice, engine]);

  return {
    available: engine !== null,
    unavailableReason,
    engine,
    state,
    elapsedMs,
    silent,
    error,
    press: voice.press,
    release: voice.release,
    finish: voice.finish,
    cancel: voice.cancel,
    bindBars: voice.bindBars,
    bindRing: voice.bindRing,
    bindMeter: voice.bindMeter,
  };
}
