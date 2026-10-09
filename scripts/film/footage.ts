/**
 * The raw takes in _film/footage/rec/<name>/ (made by capture.ts), read for the compositor:
 * frame files with their paint times, the hand's cues and the marks, all in seconds from the
 * take's first frame. Screencast takes (R*) paint 20-45 fps, so a moment shows the last frame
 * painted at or before it; stepped takes (S*) are exact 60 fps (frame i at i/60).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const REPO = join(import.meta.dir, "../..");
export const FOOTAGE = join(REPO, "_film/footage");

export type Cue = { t: number; kind: "move" | "down" | "up" | "tap"; x: number; y: number };

export interface Take {
  name: string;
  /** viewport in CSS px, and source px per CSS px */
  vp: { w: number; h: number };
  dpr: number;
  times: number[];
  files: string[];
  cues: Cue[];
  marks: { label: string; t: number }[];
  end: number;
}

const cache = new Map<string, Take>();

export function take(name: string): Take {
  const hit = cache.get(name);
  if (hit) return hit;
  const dir = join(FOOTAGE, "rec", name);
  const meta = JSON.parse(readFileSync(join(dir, "frames.json"), "utf8"));
  let times: number[], files: string[], end: number;
  if (meta.stepped) {
    const n: number = meta.frames;
    times = Array.from({ length: n }, (_, i) => i / meta.fps);
    files = Array.from({ length: n }, (_, i) => String(i + 1).padStart(6, "0") + ".png");
    end = n / meta.fps;
  } else {
    times = meta.frames.map((f: { t: number }) => f.t);
    files = meta.frames.map((f: { file: string }) => f.file);
    end = meta.end;
  }
  const read = (file: string) => { try { return JSON.parse(readFileSync(join(dir, file), "utf8")); } catch { return []; } };
  const t: Take = { name, vp: { w: meta.viewport.width, h: meta.viewport.height }, dpr: meta.scale, times, files, cues: read("cues.json"), marks: read("marks.json"), end };
  cache.set(name, t);
  return t;
}

/** A mark's time; `label` matches the start of the mark's label. */
export function mark(t: Take, label: string): number {
  const m = t.marks.find((m) => m.label.startsWith(label));
  if (!m) throw new Error(`${t.name}: no mark "${label}"`);
  return m.t;
}

/** The time of the n-th cue of a kind (0-based). */
export function cue(t: Take, kind: Cue["kind"], n = 0): Cue {
  const c = t.cues.filter((c) => c.kind === kind)[n];
  if (!c) throw new Error(`${t.name}: no ${kind} cue #${n}`);
  return c;
}

/** Index of the frame on screen at time s (the last painted at or before it). */
export function frameAt(t: Take, s: number): number {
  let lo = 0, hi = t.times.length - 1;
  if (s <= t.times[0]!) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (t.times[mid]! <= s) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** URL path of a frame, as the render server serves the repo. */
export const frameUrl = (t: Take, i: number): string => `/_film/footage/rec/${t.name}/frames/${t.files[i]}`;

/**
 * The pointer at time s in CSS px: the recorded moves (~30 per second while gliding) joined by a
 * Catmull-Rom curve so it glides at 60 fps. Moves more than 0.25 s apart are a jump, not a glide.
 */
export function pointerAt(t: Take, s: number): { x: number; y: number } | null {
  const pts = t.cues.filter((c) => c.kind !== "tap");
  if (!pts.length) return null;
  let i = -1;
  for (let j = 0; j < pts.length; j++) if (pts[j]!.t <= s) i = j; else break;
  if (i < 0) return { x: pts[0]!.x, y: pts[0]!.y };
  const p1 = pts[i]!, p2 = pts[i + 1];
  if (!p2 || p2.t - p1.t > 0.25) return { x: p1.x, y: p1.y };
  const p0 = pts[i - 1] && p1.t - pts[i - 1]!.t <= 0.25 ? pts[i - 1]! : p1;
  const p3 = pts[i + 2] && pts[i + 2]!.t - p2.t <= 0.25 ? pts[i + 2]! : p2;
  const u = (s - p1.t) / (p2.t - p1.t);
  const cr = (a: number, b: number, c: number, d: number) =>
    0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u * u + (-a + 3 * b - 3 * c + d) * u * u * u);
  return { x: cr(p0.x, p1.x, p2.x, p3.x), y: cr(p0.y, p1.y, p2.y, p3.y) };
}

/** Presses (mouse downs, or taps) within `window` s before s, with their age. */
export function pressesAt(t: Take, s: number, kind: "down" | "tap", window = 0.42): { x: number; y: number; age: number }[] {
  return t.cues.filter((c) => c.kind === kind && c.t <= s && s - c.t < window).map((c) => ({ x: c.x, y: c.y, age: s - c.t }));
}

/**
 * The first trough (opacity 0.35, 800 ms into the 1.6 s CSS `pulse`) of a status dot at or after
 * `after` s, from the take's "pulse <dot> <ms>" marks (capture.ts reads each dot's animation time).
 */
export function trough(t: Take, after: number, dot = "badge"): number {
  const m = t.marks.find((m) => m.label.startsWith(`pulse ${dot} `));
  if (!m) throw new Error(`${t.name}: no pulse mark for ${dot}`);
  const ms = Number(m.label.split(" ").pop());
  let at = m.t + ((800 - ms + 1600) % 1600) / 1000;
  while (at < after) at += 1.6;
  while (at - 1.6 >= after) at -= 1.6;
  return at;
}
