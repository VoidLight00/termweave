/**
 * Camera maths shared by the timeline and the checks: the one easing, keyframed camera paths,
 * the matrix3d that places a window or phone on the stage, and how much it magnifies.
 *
 * An object's camera: `k` output px per CSS px of the recorded viewport, the content point
 * (fx, fy) in CSS px that lands on the frame point (ax, ay), and a rotation about that point
 * (rotateX then rotateY, perspective d px). Zooming about a fixed content point with `at`
 * moving is what makes pushes and pull-backs feel like one move.
 */

export interface Cam { k: number; fx: number; fy: number; ax: number; ay: number; rx: number; ry: number; d: number }

/** cubic-bezier(0.2, 0, 0, 1) */
export function ease(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const X = (u: number) => 3 * (1 - u) * (1 - u) * u * 0.2 + u * u * u;
  const Y = (u: number) => 3 * (1 - u) * u * u + u * u * u;
  let lo = 0, hi = 1;
  for (let i = 0; i < 48; i++) { const m = (lo + hi) / 2; if (X(m) < x) lo = m; else hi = m; }
  return Y((lo + hi) / 2);
}
/** symmetric ease for slow drifts that should not lurch (sine in-out) */
export const drift = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * x));
export const clamp = (v: number, a = 0, b = 1): number => Math.min(b, Math.max(a, v));
export const lerp = (a: number, b: number, s: number): number => a + (b - a) * s;

export const CAM0: Cam = { k: 1, fx: 0, fy: 0, ax: 960, ay: 540, rx: 0, ry: 0, d: 2200 };

export function mixCam(a: Cam, b: Cam, s: number): Cam {
  return {
    k: Math.exp(lerp(Math.log(a.k), Math.log(b.k), s)),
    fx: lerp(a.fx, b.fx, s), fy: lerp(a.fy, b.fy, s), ax: lerp(a.ax, b.ax, s), ay: lerp(a.ay, b.ay, s),
    rx: lerp(a.rx, b.rx, s), ry: lerp(a.ry, b.ry, s), d: lerp(a.d, b.d, s),
  };
}

export type Key = { t: number; cam: Partial<Cam>; curve?: (x: number) => number };

/** A camera path through keyframes: each segment eases (cubic-bezier(0.2,0,0,1) unless `curve`) into its end key. */
export function path(keys: Key[]): (t: number) => Cam {
  const full: { t: number; cam: Cam; curve: (x: number) => number }[] = [];
  let prev = CAM0;
  for (const key of keys) { prev = { ...prev, ...key.cam }; full.push({ t: key.t, cam: prev, curve: key.curve ?? ease }); }
  return (t) => {
    if (t <= full[0]!.t) return full[0]!.cam;
    for (let i = 1; i < full.length; i++) {
      const a = full[i - 1]!, b = full[i]!;
      if (t < b.t) return mixCam(a.cam, b.cam, b.curve((t - a.t) / (b.t - a.t)));
    }
    return full[full.length - 1]!.cam;
  };
}

type M4 = number[][];
const mul = (a: M4, b: M4): M4 => a.map((row) => [0, 1, 2, 3].map((j) => row.reduce((s, v, i) => s + v * b[i]![j]!, 0)));
const T = (x: number, y: number, z = 0): M4 => [[1, 0, 0, x], [0, 1, 0, y], [0, 0, 1, z], [0, 0, 0, 1]];
const P = (d: number): M4 => [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, -1 / d, 1]];
const RX = (deg: number): M4 => { const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a); return [[1, 0, 0, 0], [0, c, -s, 0], [0, s, c, 0], [0, 0, 0, 1]]; };
const RY = (deg: number): M4 => { const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a); return [[c, 0, s, 0], [0, 1, 0, 0], [-s, 0, c, 0], [0, 0, 0, 1]]; };

export type Kind = "window" | "phone";

/** Chrome unit: the window's 38 px bar at a 1500 px wide window; the phone's 10 px bezel at 1 px per CSS px. */
export const unit = (kind: Kind, k: number): number => (kind === "window" ? k / 1.172 : k);

/** Local px (the object's own box) of a content point in CSS px. */
export function local(kind: Kind, k: number, x: number, y: number): [number, number] {
  const u = unit(kind, k);
  return kind === "window" ? [x * k, 38 * u + y * k] : [10 * u + x * k, 10 * u + y * k];
}

/** Size of the object's box in local px. */
export function box(kind: Kind, vp: { w: number; h: number }, k: number): { w: number; h: number } {
  const u = unit(kind, k);
  return kind === "window" ? { w: vp.w * k, h: vp.h * k + 38 * u } : { w: vp.w * k + 20 * u, h: vp.h * k + 20 * u };
}

export interface Placed { m: number[]; project: (lx: number, ly: number) => [number, number] }

export function place(kind: Kind, cam: Cam): Placed {
  const [Fx, Fy] = local(kind, cam.k, cam.fx, cam.fy);
  const M = mul(mul(mul(mul(T(cam.ax, cam.ay), P(cam.d)), RX(cam.rx)), RY(cam.ry)), T(-Fx, -Fy));
  const m: number[] = [];
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) m.push(+M[r]![c]!.toFixed(9));
  const project = (lx: number, ly: number): [number, number] => {
    const q = [0, 1, 3].map((r) => M[r]![0]! * lx + M[r]![1]! * ly + M[r]![3]!);
    return [q[0]! / q[2]!, q[1]! / q[2]!];
  };
  return { m, project };
}

/**
 * The most a source pixel is magnified anywhere the screen is in frame: the largest singular value
 * of the local Jacobian (output px per source px), sampled on a grid over the recorded viewport.
 */
export function magnification(kind: Kind, cam: Cam, vp: { w: number; h: number }, dpr: number, frame = { w: 1920, h: 1080 }): number {
  const { project } = place(kind, cam);
  const step = 1 / dpr; // one source px in CSS px
  let max = 0;
  for (let i = 0; i <= 12; i++) for (let j = 0; j <= 12; j++) {
    const x = (vp.w * i) / 12, y = (vp.h * j) / 12;
    const [px, py] = project(...local(kind, cam.k, x, y));
    if (px < -2 || py < -2 || px > frame.w + 2 || py > frame.h + 2) continue;
    const [ax, ay] = project(...local(kind, cam.k, x + step, y));
    const [bx, by] = project(...local(kind, cam.k, x, y + step));
    const a = ax - px, b = bx - px, c = ay - py, d = by - py;
    const s1 = a * a + b * b + c * c + d * d, det = a * d - b * c;
    const sv = Math.sqrt((s1 + Math.sqrt(Math.max(0, s1 * s1 - 4 * det * det))) / 2);
    max = Math.max(max, sv);
  }
  return max;
}
