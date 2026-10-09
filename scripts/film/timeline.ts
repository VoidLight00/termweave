/**
 * The film, shot by shot (brief section 6), and the hero loop (section 7), as data: which take
 * each object shows and how output time maps to take time (anchor pairs, linear in between, so
 * a freeze is two outputs on one source time and a fitted segment is its own rate), where the
 * camera is, and the type. `frame(t)` turns it into the FrameDesc the stage page draws.
 *
 * Source times come from the takes' marks.json and cues.json (never the brief's older numbers).
 * Every take is 2x, so no framing shows fewer than 960 CSS px of a desktop take's width
 * (k <= 2.0 output px per CSS px; checked per frame, with perspective, by `magnification`).
 */
import { box, clamp, drift, ease, lerp, local, magnification, path, place, type Cam, type Kind } from "./camera.ts";
import { cue, frameAt, frameUrl, mark, pointerAt, pressesAt, take, trough, type Take } from "./footage.ts";
import type { FrameDesc, ObjDesc, TypeDesc } from "./stage.ts";

export const FPS = 60;
export const DURATION = 56;

type Anchors = [number, number][];

export interface Layer {
  id: string;
  kind: Kind;
  take: string;
  t0: number;
  t1: number;
  map: Anchors;
  cam: (t: number) => Cam;
  /** alpha of the drawn cursor at out time t (0 = hidden); desktop layers only */
  cursor?: (t: number, p: { x: number; y: number }) => number;
  opacity?: (t: number) => number;
  dim?: (t: number) => number;
  pool?: number;
}

export interface Shot { name: string; t0: number; t1: number; layers: Layer[]; note: string }

export function srcTime(map: Anchors, t: number): number {
  if (t <= map[0]![0]) return map[0]![1];
  for (let i = 1; i < map.length; i++) {
    const [o0, s0] = map[i - 1]!, [o1, s1] = map[i]!;
    if (t <= o1) return o1 === o0 ? s1 : s0 + ((t - o0) / (o1 - o0)) * (s1 - s0);
  }
  return map[map.length - 1]![1];
}

const R2 = take("R2-fold"), R3 = take("R3-approve"), R4 = take("R4-palette"), R5 = take("R5-terminal");
const R6 = take("R6-phone-approve"), R10 = take("R10-stream"), R11 = take("R11-live"), S1P = take("S1-phone-chat-scroll");
const R12 = take("R12-opening"), R13 = take("R13-next");

// ---- key source moments (seconds in each take) ----
const R2_EXPAND = cue(R2, "down", 0).t, R2_FOLD = cue(R2, "down", 1).t;
const R10_ENTER = mark(R10, "Enter"), R10_T1 = mark(R10, "todo 1/3"), R10_T2 = mark(R10, "todo 2/3"), R10_T3 = mark(R10, "todo 3/3");
const R10_DONE = mark(R10, "status DONE"), R10_ANSWER = mark(R10, "answer lands");
const R6_TAP = cue(R6, "tap", 2).t;
const R4_OPEN = mark(R4, "palette opens"), R4_ENTER = mark(R4, "Enter");
const R5_CLICK = cue(R5, "down", 0).t;
/**
 * S8's two screens, measured on the frames (status word RUN -> DONE, then the "Pushed" turn painted;
 * the demo's 2.6 s answer plus each client's own 2 s chat poll): desk R3 DONE 6.400, Pushed 7.433;
 * phone R6 DONE 6.683, Pushed 8.483. Re-measure after a re-capture of R3/R6.
 */
const R3_DONE = 6.4, R3_PUSHED = 7.433, R6_DONE = 6.683, R6_PUSHED = 8.483;

const HIDE = () => 0;
/** the pointer fades as it crosses the right edge of the recorded viewport (it leaves the window) */
const leavesWindow = (vpW: number) => (_t: number, p: { x: number }) => clamp((vpW - p.x) / 36);

/** A camera move of a whole composition: every layer scaled by s about frame point (cx, cy). */
function grouped(cam: (t: number) => Cam, s: (t: number) => number, cx: number, cy: number): (t: number) => Cam {
  return (t) => { const c = cam(t), k = s(t); return { ...c, k: c.k * k, ax: cx + (c.ax - cx) * k, ay: cy + (c.ay - cy) * k }; };
}

// ---- the shots ----
/** S1 starts 0.8 s before a RUN-dot trough, so the dot brightens into beats 2 and 4 (1.6, 3.2) */
const S1_SRC = trough(R12, 1.2) - 0.8;
/** S12 starts on a trough */
const S12_SRC = trough(R13, 0.9);

export const SHOTS: Shot[] = [
  {
    name: "S1+S2 COLD OPEN / REVEAL", t0: 0, t1: 7.2,
    note: "R12 (the first task running), one continuous slice: macro on Working… and its rows, then the pull-out to the whole window, which settles right of the type",
    layers: [{
      id: "r12", kind: "window", take: R12.name, t0: 0, t1: 7.2,
      map: [[0, S1_SRC], [7.2, S1_SRC + 7.2]],
      cursor: HIDE,
      cam: path([
        // the chat column whole (sidebar just out of frame), from under the app's header row to under the plan
        { t: 0, cam: { k: 1.92, fx: 800, fy: 333, ax: 960, ay: 540, rx: 0, ry: 0, d: 2200 } },
        { t: 3.2, cam: { k: 1.96 }, curve: drift },
        // the object turns as it pulls back, then settles nearly square to the lens, right of the type
        { t: 4.6, cam: { k: 0.94, fx: 640, fy: 400, ax: 1316, ay: 556, rx: 12, ry: -14 } },
        { t: 6.4, cam: { k: 0.9, ax: 1322, ay: 552, rx: 5, ry: -5 }, curve: drift },
        { t: 7.2, cam: { k: 0.895, ax: 1324 }, curve: drift },
      ]),
      pool: 1,
    }],
  },
  {
    name: "S3 READ", t0: 7.2, t1: 12.8,
    note: "R2 (first task done, nothing asked since), one shot: the pointer opens the first Worked-for block on the beat, the rows unfold, fold on the beat; slow push",
    layers: [{
      id: "r2", kind: "window", take: R2.name, t0: 7.2, t1: 12.8,
      map: [[7.2, R2_EXPAND - 0.8], [12.8, R2_FOLD + 0.8]],
      cursor: () => 1,
      cam: path([
        { t: 7.2, cam: { k: 1.86, fx: 420, fy: 205, ax: 1070, ay: 300, rx: 0, ry: 0 } },
        { t: 12.8, cam: { k: 2.0, ax: 1060, ay: 296 }, curve: drift },
      ]),
    }],
  },
  {
    name: "S4 ASK + STREAM + S5 A", t0: 12.8, t1: 23.2,
    note: "R10, one shot: the typed tail, Enter on the beat, the turn streams in on the app's 2 s poll, plan 0/3 -> 3/3, RUN -> DONE, the answer lands; the camera rises onto the transcript's end",
    layers: [{
      id: "r10", kind: "window", take: R10.name, t0: 12.8, t1: 23.2,
      // Enter on 13.6; the plan's landings on 17.2 / 18.8 / 20.4; DONE 21.2, the answer 22.0 (holds between landings run 1.12-1.26x)
      map: [[12.8, R10_ENTER - 0.8], [13.6, R10_ENTER], [17.2, R10_T1], [18.8, R10_T2], [20.4, R10_T3], [21.2, R10_DONE], [22.0, R10_ANSWER], [23.2, R10_ANSWER + 1.2]],
      cursor: HIDE, // the hand is on the keyboard: a resting disc would sit on the typed words
      cam: path([
        // the chat column from the transcript's end down to the composer, the frame's bottom on the
        // window's; one slow push. The first task's rows (still open: it is the last turn until Enter)
        // sit top-left, under the first line's shade
        { t: 12.8, cam: { k: 1.95, fx: 792, fy: 523, ax: 972, ay: 540, rx: 0, ry: 0 } },
        { t: 20.8, cam: { k: 2.0, fx: 795, fy: 531, ax: 952 }, curve: drift },
        // DONE: the camera eases back and up, the window's foot clears the frame's, and the line
        // about the status row sits on the stage right under it
        // the frame's top edge in the gutter between rows (sidebar and chat), CSS y 213
        { t: 22.0, cam: { k: 1.5, fx: 640, ax: 960, ay: (531 - 213) * 1.5 } },
        { t: 23.2, cam: { k: 1.505 }, curve: drift },
      ]),
    }],
  },
  {
    name: "S5 B STEP AWAY", t0: 23.2, t1: 25.6,
    note: "R10 continues 1:1: the whole window right of the type, the pointer leaves; a push toward the sidebar's INPUT row",
    layers: [{
      id: "r10b", kind: "window", take: R10.name, t0: 23.2, t1: 25.6,
      map: [[23.2, R10_ANSWER + 1.2], [25.6, R10_ANSWER + 3.6]],
      cursor: leavesWindow(1280),
      cam: path([
        { t: 23.2, cam: { k: 0.94, fx: 170, fy: 262, ax: 1300 - 470 * 0.94, ay: 548 - 138 * 0.94, rx: 3, ry: -4 } },
        { t: 24.6, cam: { k: 0.95 }, curve: drift },
        { t: 25.6, cam: { k: 1.12 }, curve: drift },
      ]),
      pool: 1,
    }],
  },
  {
    name: "S6 IT NEEDS YOU", t0: 25.6, t1: 28.0,
    note: "R3, no cursor: the Codex approval card, the window right of the type, a slow push to the phone card's width",
    layers: [{
      id: "r3a", kind: "window", take: R3.name, t0: 25.6, t1: 28.0,
      map: [[25.6, 0.9], [28.0, 3.3]],
      cursor: HIDE,
      cam: path([{ t: 25.6, cam: { k: 0.87, fx: 800, fy: 466, ax: 1440, ay: 580, rx: 0, ry: 0 } }, { t: 28.0, cam: { k: 731 / 819.5 }, curve: drift }]),
      pool: 1,
    }],
  },
];

// S7: the phone card matches the desktop card of S6's last frame, then the camera pulls back;
// S8: the same phone layer carries on while the camera pulls back further and the desk comes in.
const CARD_DESK = { x: 390, y: 393 }; // Codex card's top-left in R3, CSS px (measured: 819.5 CSS px wide)
const CARD_PHONE = { x: 12, y: 0 };
export const PHONE_CARD_Y = 502; // top of the phone's card in R6 at 3.1 s, CSS px (measured: 365.5 CSS px wide)
CARD_PHONE.y = PHONE_CARD_Y;
{
  const s6 = SHOTS[4]!.layers[0]!.cam(27.999);
  const pl = place("window", s6);
  const [cx, cy] = pl.project(...local("window", s6.k, CARD_DESK.x, CARD_DESK.y));
  const phoneEnd = { k: 1.02, ax: 1250, ay: 540 };
  const endCard = { ax: phoneEnd.ax + (CARD_PHONE.x - 195) * phoneEnd.k, ay: phoneEnd.ay + (CARD_PHONE.y - 422) * phoneEnd.k };
  // phone: 1:1 from the tap; the static wait between its DONE and its Pushed turn (only the chat's
  // poll) runs 1.35x so both screens flip within 0.1 s and the Pushed lines land ~0.4 s apart
  const R6_DONE_OUT = 29.6 + (R6_DONE - R6_TAP);
  const r6map: Anchors = [[28.0, 3.1], [29.6 - (R6_TAP - 3.1), 3.1], [29.6, R6_TAP], [R6_DONE_OUT, R6_DONE], [R6_DONE_OUT + (R6_PUSHED - R6_DONE) / 1.35, R6_PUSHED], [35.2, R6_PUSHED + 35.2 - (R6_DONE_OUT + (R6_PUSHED - R6_DONE) / 1.35)]];
  // desk: DONE 0.08 s before the phone's
  const r3off = R6_DONE_OUT - 0.08 - R3_DONE;
  // the two-shot's slow push toward the two Pushed lines, from when the type has gone
  const push = (t: number) => 1 + 0.1 * drift(clamp((t - 33.0) / 2.2));
  const PX = 1010, PY = 700;
  SHOTS.push({
    name: "S7 MATCH CUT -> PHONE, S8 SAME PANE. EVERY SCREEN.", t0: 28.0, t1: 35.2,
    note: "R6: the card at 1:1 where the desktop card was, pull back to the phone; tap Yes on the beat; then the camera pulls back further and trucks to reveal the desk (R3) beside it; both land Pushed",
    layers: [
      {
        id: "r3b", kind: "window", take: R3.name, t0: 30.4, t1: 35.2,
        map: [[30.4, 30.4 - r3off], [R3.end - 0.01 + r3off, R3.end - 0.01], [35.2, R3.end - 0.01]],
        cursor: HIDE,
        cam: grouped(path([
          { t: 30.4, cam: { k: 1.0, fx: 640, fy: 400, ax: 20, ay: 600, rx: 2, ry: 10, d: 2400 } },
          { t: 31.5, cam: { k: 0.925, ax: 748, ay: 598, ry: 7 } },
          { t: 35.2, cam: { k: 0.93, ax: 752, ry: 6 }, curve: drift },
        ]), push, PX, PY),
        pool: 1,
      },
      {
        id: "r6", kind: "phone", take: R6.name, t0: 28.0, t1: 35.2, map: r6map,
        cam: grouped(path([
          { t: 28.0, cam: { k: 2.0, fx: CARD_PHONE.x, fy: CARD_PHONE.y, ax: cx, ay: cy, rx: 0, ry: 0, d: 2200 } },
          { t: 28.9, cam: { k: phoneEnd.k, ax: endCard.ax, ay: endCard.ay, rx: 3 } },
          { t: 30.4, cam: { k: 1.03, ax: endCard.ax - 2 }, curve: drift },
          { t: 31.5, cam: { k: 0.965, fx: 195, fy: 422, ax: 1514, ay: 604, rx: 2, ry: -7, d: 2400 } },
          { t: 35.2, cam: { k: 0.97, ax: 1510, ry: -6 }, curve: drift },
        ]), push, PX, PY),
        pool: 1,
      },
    ],
  });
}

SHOTS.push(
  {
    name: "S9 EVERY AGENT", t0: 35.2, t1: 38.4,
    note: "R4 (after the metric turn, Codex answered): the whole window high, the stage below it for the keycaps and the line; the palette snaps open, 'backup', Enter on the beat",
    layers: [{
      id: "r4", kind: "window", take: R4.name, t0: 35.2, t1: 38.4,
      map: [[35.2, R4_OPEN - 0.32], [35.52, R4_OPEN], [37.6, R4_ENTER], [38.4, R4_ENTER + 0.8]],
      cursor: HIDE,
      cam: path([{ t: 35.2, cam: { k: 1.1, fx: 640, fy: 300, ax: 960, ay: 380, rx: 0, ry: 0 } }, { t: 38.4, cam: { k: 1.14 }, curve: drift }]),
      pool: 1,
    }],
  },
  {
    name: "S10 THE REAL TERMINAL", t0: 38.4, t1: 42.4,
    note: "R5 (from the gjc chat S9 lands on, so S9 runs straight into it): click the shell pane on the beat, the terminal replays; push in until the terminal fills the frame, the type in its empty lower half",
    layers: [{
      id: "r5", kind: "window", take: R5.name, t0: 38.4, t1: 42.4,
      map: [[38.4, R5_CLICK - 0.8], [42.4, R5_CLICK + 3.2]],
      // the hand comes back to the mouse, clicks, and leaves the picture
      cursor: (t) => clamp((t - 38.4) / 0.3) * clamp((39.9 + 0.3 - t) / 0.3),
      // S9's camera carries on across the splice (R4 ends and R5 starts on the same gjc chat: an invisible join)
      cam: path([
        { t: 38.4, cam: { k: 1.14, fx: 640, fy: 300, ax: 960, ay: 380, rx: 0, ry: 0, d: 2200 } },
        { t: 39.4, cam: { k: 1.15 }, curve: drift },
        { t: 40.8, cam: { k: 1.85, ax: 24 + 320 * 1.85, ay: 20 + 248 * 1.85, rx: 0, ry: 0 } },
        { t: 42.4, cam: { k: 1.87, ax: 24 + 320 * 1.87, ay: 20 + 248 * 1.87 }, curve: drift },
      ]),
      pool: 1,
    }],
  },
  {
    name: "S11 IN YOUR POCKET", t0: 42.4, t1: 45.6,
    note: "S1-phone-chat-scroll (exact 60 fps, after the metric turn): the phone rises into the light",
    layers: [{
      id: "s1p", kind: "phone", take: S1P.name, t0: 42.4, t1: 45.6,
      map: [[42.4, 2.3], [45.6, 5.5]],
      cam: path([
        { t: 42.4, cam: { k: 1.04, fx: 195, fy: 422, ax: 1290, ay: 540 + 0.4 * 900, rx: 12, ry: -6, d: 2200 } },
        { t: 43.6, cam: { ay: 548, rx: 4, ry: -4 } },
        { t: 45.6, cam: { k: 1.05, ry: -3 }, curve: drift },
      ]),
      pool: 1,
    }],
  },
  {
    name: "S12 NOTHING IN BETWEEN", t0: 45.6, t1: 52.0,
    note: "R13 (the next ask running, live RUN pulse): a 3/4 object right of the type, pulling back onto a big dark table; gone into black by the end card",
    layers: [{
      id: "r13", kind: "window", take: R13.name, t0: 45.6, t1: 52.0,
      map: [[45.6, S12_SRC], [52.0, S12_SRC + 6.4]],
      cursor: HIDE,
      cam: path([
        { t: 45.6, cam: { k: 0.98, fx: 640, fy: 400, ax: 1300, ay: 548, rx: 4, ry: -8, d: 2200 } },
        { t: 49.6, cam: { k: 0.69, ax: 1270, ay: 560, rx: 10, ry: -18 } },
        { t: 52.0, cam: { k: 0.67 }, curve: drift },
      ]),
      // dims to 20% over 51.2-51.8, then fades out (not to black: a black slab would show on the stage)
      dim: (t) => 0.8 * ease(clamp((t - 51.2) / 0.6)),
      opacity: (t) => 1 - drift(clamp((t - 51.6) / 0.4)),
      pool: 1,
    }],
  },
);

// ---- type (brief section 6; the listed exit is when a line is fully gone) ----
// `shade`: the type sits over UI, so a soft local darkening sits behind it (at ~93%, feathered)
const L = 124; // text starts here; the amber rail sits at the 96 px safe margin
export const TYPE: (TypeDesc & { shade?: boolean })[] = [
  { id: "t2a", role: "primary", text: "Your agents|keep working.", x: L, y: 360, align: "left", tIn: 4.0, tOut: 6.0, rail: true },
  { id: "t2b", role: "secondary", text: "Claude Code · Codex · omp ·|omo · gjc, running in herdr", x: L, y: 586, align: "left", tIn: 4.8, tOut: 6.4 },
  { id: "t3a", role: "primary", text: "Read the work,|not the scrollback.", x: L, y: 560, align: "left", tIn: 8.4, tOut: 10.4, rail: true, shade: true, delays: [0, 0.07, 0.14, 0.8, 0.87, 0.94] },
  { id: "t3c", role: "secondary", text: "2m 36s of commands, edits and reads,|folded into one line.", x: L, y: 860, align: "left", tIn: 10.8, tOut: 12.6, shade: true, shadeCol: true, shadeTop: 180, shadeRight: 290 },
  { id: "t4a", role: "primary", text: "Ask for the|next one.", x: L, y: 150, align: "left", tIn: 12.8, tOut: 14.8, rail: true, shade: true, shadeTop: 280, shadeRight: 330 },
  { id: "t4b", role: "secondary", text: "The agent's plan,|pinned under the chat.", x: 1748, y: 668, align: "right", tIn: 18.0, tOut: 20.0 },
  { id: "t5a", role: "secondary", text: "Model and effort, as the session recorded them.", x: 495, y: 940, align: "left", tIn: 21.6, tOut: 23.2 },
  { id: "t5b", role: "primary", text: "Step away.", x: L, y: 480, align: "left", tIn: 23.6, tOut: 25.2, rail: true },
  { id: "t6a", role: "primary", text: "Codex|needs you.", x: L, y: 380, align: "left", tIn: 26.0, tOut: 27.8, rail: true },
  { id: "t7a", role: "secondary", text: "Checked against the live menu|before a key is sent.", x: L, y: 500, align: "left", tIn: 29.1, tOut: 30.4 },
  { id: "t8a", role: "centered", text: "Same pane. Every screen.", x: 960, y: 70, align: "center", tIn: 30.8, tOut: 33.2, delays: [0, 0.07, 0.4, 0.47] },
  { id: "t9a", role: "secondary", text: "One palette for every pane: Claude Code, Codex, omp, omo, gjc.", x: 960, y: 1000, align: "center", tIn: 36.4, tOut: 38.2 },
  { id: "t10a", role: "primary", text: "The real terminal.|One switch away.", x: L, y: 832, align: "left", tIn: 40.0, tOut: 41.8, rail: true, shade: true, shadeTop: 70, delays: [0, 0.07, 0.14, 0.4, 0.47, 0.54] },
  { id: "t10c", role: "secondary", text: "herdr terminal attach · shared with the TUI on your desk", x: 1760, y: 986, align: "right", tIn: 40.8, tOut: 42.3 },
  { id: "t11a", role: "primary", text: "In your pocket.", x: L, y: 400, align: "left", tIn: 42.8, tOut: 44.8, rail: true },
  { id: "t11b", role: "secondary", text: "Installable app · terminal key bar ·|push alerts when an agent needs you|or finishes.", x: L, y: 520, align: "left", tIn: 43.6, tOut: 45.4 },
  { id: "t12a", role: "primary", text: "No wrapper.", x: L, y: 440, align: "left", tIn: 46.4, tOut: 48.0, rail: true, cut: true },
  { id: "t12b", role: "primary", text: "No daemon.", x: L, y: 440, align: "left", tIn: 48.0, tOut: 49.6, rail: true, cut: true },
  { id: "t12c", role: "primary", text: "No account.", x: L, y: 440, align: "left", tIn: 49.6, tOut: 51.2, rail: true },
  { id: "t12d", role: "secondary", text: "127.0.0.1 by default. Yours only.", x: L, y: 560, align: "left", tIn: 50.4, tOut: 51.8 },
];

// ---- building a frame ----
function objDesc(layer: Layer, t: number, cam: Cam, extra: Partial<ObjDesc> = {}): { obj: ObjDesc; src: number; tk: Take } {
  const tk = take(layer.take);
  const src = srcTime(layer.map, t);
  const idx = frameAt(tk, src);
  let cursor: ObjDesc["cursor"] = null;
  if (layer.kind === "window" && layer.cursor) {
    const p = pointerAt(tk, src);
    if (p) {
      const a = layer.cursor(t, p);
      const down = tk.cues.filter((c) => c.kind === "down" && c.t <= src && src - c.t < 0.16).length > 0;
      if (a > 0) cursor = { x: p.x, y: p.y, a, press: down ? 0.8 : 1 };
    }
  }
  const rings = layer.kind === "window" && layer.cursor && layer.cursor(t, pointerAt(tk, src) ?? { x: 0, y: 0 }) > 0 ? pressesAt(tk, src, "down") : [];
  const touches = layer.kind === "phone" ? pressesAt(tk, src, "tap") : [];
  const { m } = place(layer.kind, cam);
  const obj: ObjDesc = {
    id: layer.id, kind: layer.kind, src: frameUrl(tk, idx), vp: tk.vp, dpr: tk.dpr, k: cam.k, u: layer.kind === "window" ? cam.k / 1.172 : cam.k,
    m, opacity: layer.opacity?.(t) ?? 1, dim: layer.dim?.(t) ?? 0, cursor, rings, touches, ...extra,
  };
  return { obj, src, tk };
}

function pool(layer: Layer, cam: Cam, a: number): FrameDesc["pools"][number] {
  const tk = take(layer.take);
  const b = box(layer.kind, tk.vp, cam.k);
  const { project } = place(layer.kind, cam);
  const [x0, y0] = project(0, b.h), [x1, y1] = project(b.w, b.h);
  const w = Math.abs(x1 - x0) * 1.25;
  return { x: (x0 + x1) / 2, y: Math.max(y0, y1) + w * 0.02, w, h: w * 0.3, a };
}

export function shotAt(t: number): Shot | undefined {
  return SHOTS.find((s) => t >= s.t0 && t < s.t1);
}

export function frame(t: number): FrameDesc {
  const f: FrameDesc = {
    t, fade: 0, reveal: null, lamp: 1, pools: [], objs: [], scrim: { left: 0, bottom: 0 },
    type: TYPE.filter((d) => t >= d.tIn - 0.25 && t < d.tOut + 0.2), keys: null, end: null, vignette: 1,
  };
  // cold open: black, then the lamp comes up over 1.2 s
  if (t < 1.6) { f.reveal = drift(clamp(t / 1.2)); f.lamp = drift(clamp(t / 1.2)); }
  for (const shot of SHOTS) for (const layer of shot.layers) {
    if (t < layer.t0 || t >= layer.t1) continue;
    const cam = layer.cam(t);
    f.objs.push(objDesc(layer, t, cam).obj);
    if (layer.pool) f.pools.push(pool(layer, cam, layer.pool * (1 - (layer.dim?.(t) ?? 0)) * (layer.opacity?.(t) ?? 1)));
  }
  // keycaps on the stage under the window, gone as the palette's own list settles
  if (t >= 35.2 && t < 36.3) f.keys = { t0: 35.2, labels: ["Ctrl", "Shift", "K"], press: [35.32, 35.38, 35.46], tOut: 36.3 };
  if (t >= 52) f.end = { t0: 52 };
  return f;
}

/** Per-shot report: source ranges, playback rates, and the largest magnification (output px per source px). */
export function report(): string[] {
  const out: string[] = [];
  for (const shot of SHOTS) {
    for (const layer of shot.layers) {
      const rates: string[] = [];
      for (let i = 1; i < layer.map.length; i++) {
        const [o0, s0] = layer.map[i - 1]!, [o1, s1] = layer.map[i]!;
        const lo = Math.max(o0, layer.t0), hi = Math.min(o1, layer.t1);
        if (hi <= lo) continue;
        rates.push(`${lo.toFixed(2)}-${hi.toFixed(2)} ${o1 === o0 ? "-" : ((s1 - s0) / (o1 - o0)).toFixed(3)}x`);
      }
      let mag = 0;
      const tk = take(layer.take);
      for (let t = layer.t0; t < layer.t1; t += 1 / FPS) mag = Math.max(mag, magnification(layer.kind, layer.cam(t), tk.vp, tk.dpr));
      out.push(`${shot.name.padEnd(28)} ${layer.id.padEnd(5)} out ${layer.t0.toFixed(2)}-${layer.t1.toFixed(2)}  ${layer.take.padEnd(22)} src ${srcTime(layer.map, layer.t0).toFixed(3)}-${srcTime(layer.map, layer.t1 - 1e-6).toFixed(3)}  rates [${rates.join(", ")}]  max mag ${mag.toFixed(3)}`);
    }
  }
  out.push("", "type (on screen from entry to fully gone, cap 2.0 s):");
  for (const d of TYPE) out.push(`  ${d.tIn.toFixed(2)}-${d.tOut.toFixed(2)}  ${(d.tOut - d.tIn).toFixed(2)} s  ${d.role.padEnd(9)} ${d.text.replace(/\|/g, " ")}`);
  const ev = (label: string, layerId: string, src: number) => {
    const layer = SHOTS.flatMap((s) => s.layers).find((l) => l.id === layerId)!;
    // invert the anchor map on its segment
    for (let i = 1; i < layer.map.length; i++) {
      const [o0, s0] = layer.map[i - 1]!, [o1, s1] = layer.map[i]!;
      if (s1 !== s0 && src >= Math.min(s0, s1) && src <= Math.max(s0, s1)) { out.push(`  ${(o0 + ((src - s0) / (s1 - s0)) * (o1 - o0)).toFixed(2)}  ${label}`); return; }
    }
  };
  out.push("", "key events (out time):");
  ev("S3 click Worked for 2m 36s (R2 down)", "r2", R2_EXPAND);
  ev("S3 fold click (R2 down)", "r2", R2_FOLD);
  ev("S4 Enter (R10)", "r10", R10_ENTER);
  ev("S4 todo 1/3", "r10", R10_T1);
  ev("S4 todo 2/3", "r10", R10_T2);
  ev("S4 todo 3/3", "r10", R10_T3);
  ev("S5 status DONE", "r10", R10_DONE);
  ev("S5 answer lands", "r10", R10_ANSWER);
  ev("S5 cursor leaves", "r10b", mark(R10, "cursor leaves"));
  ev("S7 tap Yes (R6 tap)", "r6", R6_TAP);
  ev("S8 desk DONE (R3)", "r3b", R3_DONE);
  ev("S8 phone DONE (R6)", "r6", R6_DONE);
  ev("S8 desk Pushed (R3)", "r3b", R3_PUSHED);
  ev("S8 phone Pushed (R6)", "r6", R6_PUSHED);
  ev("S9 palette opens (R4)", "r4", R4_OPEN);
  ev("S9 Enter (R4)", "r4", R4_ENTER);
  ev("S10 click shell pane (R5 down)", "r5", R5_CLICK);
  ev("S10 4 pass (R5)", "r5", mark(R5, "tests pass"));
  out.push("", `pulse: S1 from R12 ${S1_SRC.toFixed(3)} (trough ${ (S1_SRC + 0.8).toFixed(3)}), S12 from R13 ${S12_SRC.toFixed(3)}, loop from R11 L ${LOOP_L.toFixed(3)}`);
  return out;
}

// ---- the hero loop (brief section 7): R11 L .. L+6.4, whole window, closed camera path ----
export const LOOP_FPS = 30;
export const LOOP_LEN = 6.4;
export const LOOP_L = mark(R11, "L");
/**
 * Where the delivered loop starts inside its closed 6.4 s path (render.ts rotates the frames; the seam
 * moves inside the file, where it was checked). 2.4 s = the second status pulse's peak, 0.8 s after the
 * expand click: the first "Worked for 2m 36s" is open with its rows, Working… and the plan bar below,
 * the pointer on the header. So the poster, the first frame and the GIF's first frame are the busy
 * moment, not the folded chat; the fold click comes 1.6 s in.
 */
export const LOOP_START = 2.4;

export function loopFrame(t: number): FrameDesc {
  const w = (2 * Math.PI * t) / LOOP_LEN;
  // the brief's scale 0.84 +- 0.02, relative: R11 is 1280x1064 (so its chat fits with the block open),
  // so the window is ~60% of the frame wide instead of ~78%, to keep all of it inside 1080 px.
  // Angles: the brief's 9°/-9° (±1.5°/±3°) were eased to 5°/-5° (±1°/±2°): the site shows this window
  // 1200-1350 px wide as the hero, where the steeper angle skewed the UI text and dropped the window's
  // top-left corner ~40 px; the path keeps its depth and sway and stays closed. ay 546 lifts it 6 px.
  const k = (0.87 / 0.84) * (0.84 + 0.02 * Math.sin(w));
  const cam: Cam = { k, fx: 640, fy: 532, ax: 960, ay: 546, rx: 5 + 1 * Math.sin(w + Math.PI / 2), ry: -5 + 2 * Math.sin(w), d: 2400 };
  const layer: Layer = { id: "loop", kind: "window", take: R11.name, t0: 0, t1: LOOP_LEN, map: [[0, LOOP_L], [LOOP_LEN, LOOP_L + LOOP_LEN]], cam: () => cam, cursor: () => 1, pool: 1 };
  return {
    t, fade: 0, reveal: null, lamp: 1, pools: [pool(layer, cam, 1)], objs: [objDesc(layer, t, cam).obj],
    // the page shows this window at up to ~1.3x as the hero: a lighter screen falloff and half the room's
    // vignette keep the UI legible (the site's stage draws its own vignette around the video)
    scrim: { left: 0, bottom: 0 }, type: [], keys: null, end: null, vignette: 0.5, falloff: 0.35,
  };
}

export { lerp };
