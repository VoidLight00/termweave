/**
 * Turns recordings (record.ts) into the README's videos and framed stills, the way screen
 * recorders like Screen Studio do, but from code: every output frame is drawn on a canvas
 * in Chrome — a backdrop, the browser window or phone the app sits in, the recorded frame
 * under an eased camera, and the cursor, clicks and taps from the recorded cues — then
 * piped to ffmpeg. Stills get the same window or phone on a transparent background.
 */
import { chromium, type Browser, type Page } from "playwright-core";
import type { Cue, Recording } from "./record.ts";

export type Frame = "window" | "phone";

const FPS = 30;
const CAMERA_MS = 900;
const ease = (s: number): number => (s <= 0 ? 0 : s >= 1 ? 1 : s < 0.5 ? 4 * s * s * s : 1 - (-2 * s + 2) ** 3 / 2);

/** Where everything goes on the canvas, in canvas pixels. `scale` is canvas px per CSS px. */
interface Layout {
  frame: Frame;
  canvas: { w: number; h: number };
  /** the window or phone body */
  body: { x: number; y: number; w: number; h: number; r: number };
  /** where the page's content lands */
  screen: { x: number; y: number; w: number; h: number; r: number };
  scale: number;
  /** the page's size in CSS px, and the recorded frames' px per CSS px */
  content: { w: number; h: number; dpr: number };
  backdrop: boolean;
}

function layout(frame: Frame, content: { w: number; h: number }, opts: { canvasW?: number; canvasH?: number; scale: number; margin: number; backdrop: boolean }): Layout {
  const k = opts.scale;
  if (frame === "window") {
    const bar = 38 * k;
    const w = content.w * k;
    const h = content.h * k + bar;
    const cw = opts.canvasW ?? Math.round(w + opts.margin * 2);
    const ch = opts.canvasH ?? Math.round(h + opts.margin * 2);
    const x = Math.round((cw - w) / 2);
    const y = Math.round((ch - h) / 2);
    return { frame, canvas: { w: cw, h: ch }, body: { x, y, w, h, r: 12 * k }, screen: { x, y: y + bar, w, h: h - bar, r: 12 * k }, scale: k, content: { ...content, dpr: 2 }, backdrop: opts.backdrop };
  }
  const bezel = 13 * k;
  const w = content.w * k + bezel * 2;
  const h = content.h * k + bezel * 2;
  const cw = opts.canvasW ?? Math.round(w + opts.margin * 2);
  const ch = opts.canvasH ?? Math.round(h + opts.margin * 2);
  const x = Math.round((cw - w) / 2);
  const y = Math.round((ch - h) / 2);
  return { frame, canvas: { w: cw, h: ch }, body: { x, y, w, h, r: 58 * k }, screen: { x: x + bezel, y: y + bezel, w: content.w * k, h: content.h * k, r: 46 * k }, scale: k, content: { ...content, dpr: 2 }, backdrop: opts.backdrop };
}

interface State {
  src: number;
  zoom: number;
  cx: number;
  cy: number;
  cursor: { x: number; y: number; pressed: boolean } | null;
  ripples: { x: number; y: number; age: number }[];
  touches: { x: number; y: number; age: number }[];
}

/** Runs in the compositor page: draws one frame. */
const PAGE = `<!doctype html><html><body style="margin:0;background:transparent"><canvas id="c"></canvas><script>
const c = document.getElementById("c"), g = c.getContext("2d");
const bitmaps = new Map();
window.setup = (w, h) => { c.width = w; c.height = h; };
window.load = async (id, b64, mime = "image/jpeg") => {
  const blob = await (await fetch("data:" + mime + ";base64," + b64)).blob();
  bitmaps.set(id, await createImageBitmap(blob));
  for (const key of [...bitmaps.keys()]) if (key < id - 2) bitmaps.delete(key);
};
function rr(x, y, w, h, r) { g.beginPath(); g.roundRect(x, y, w, h, r); }
window.draw = (L, S, type, quality) => {
  const k = L.scale;
  g.clearRect(0, 0, c.width, c.height);
  if (L.backdrop) {
    g.fillStyle = "#15130f"; g.fillRect(0, 0, c.width, c.height);
    let grad = g.createRadialGradient(c.width * 0.15, -c.height * 0.1, 0, c.width * 0.15, -c.height * 0.1, c.width * 0.95);
    grad.addColorStop(0, "rgba(240,168,48,0.34)"); grad.addColorStop(1, "rgba(240,168,48,0)");
    g.fillStyle = grad; g.fillRect(0, 0, c.width, c.height);
    grad = g.createRadialGradient(c.width, c.height, 0, c.width, c.height, c.width * 0.8);
    grad.addColorStop(0, "rgba(147,195,107,0.14)"); grad.addColorStop(1, "rgba(147,195,107,0)");
    g.fillStyle = grad; g.fillRect(0, 0, c.width, c.height);
  }
  const B = L.body, V = L.screen;
  // the body, with its shadow
  g.save();
  g.shadowColor = "rgba(0,0,0,0.5)"; g.shadowBlur = 48 * k; g.shadowOffsetY = 18 * k;
  rr(B.x, B.y, B.w, B.h, B.r); g.fillStyle = L.frame === "window" ? "#1d1b17" : "#0a0a0b"; g.fill();
  g.restore();
  if (L.frame === "window") {
    // title bar: traffic lights and the address
    g.save(); rr(B.x, B.y, B.w, B.h, B.r); g.clip();
    g.fillStyle = "#262320"; g.fillRect(B.x, B.y, B.w, V.y - B.y);
    g.fillStyle = "rgba(255,255,255,0.06)"; g.fillRect(B.x, V.y - 1, B.w, 1);
    g.restore();
    ["#ff5f57", "#febc2e", "#28c840"].forEach((color, i) => { g.beginPath(); g.arc(B.x + (20 + i * 20) * k, B.y + 19 * k, 6 * k, 0, Math.PI * 2); g.fillStyle = color; g.fill(); });
    const pw = 300 * k, ph = 24 * k, px = B.x + (B.w - pw) / 2, py = B.y + 7 * k;
    rr(px, py, pw, ph, 7 * k); g.fillStyle = "#1a1815"; g.fill();
    g.fillStyle = "#a79e92"; g.font = (12.5 * k) + "px -apple-system, 'Segoe UI', Roboto, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText("localhost:7317", px + pw / 2, py + ph / 2 + 0.5 * k);
    g.strokeStyle = "rgba(255,255,255,0.08)"; g.lineWidth = 1; rr(B.x + 0.5, B.y + 0.5, B.w - 1, B.h - 1, B.r); g.stroke();
  } else {
    // side buttons and the frame's edge
    g.fillStyle = "#1c1c1e";
    rr(B.x - 3 * k, B.y + 150 * k, 3 * k, 60 * k, 1.5 * k); g.fill();
    rr(B.x + B.w, B.y + 120 * k, 3 * k, 36 * k, 1.5 * k); g.fill();
    rr(B.x + B.w, B.y + 170 * k, 3 * k, 60 * k, 1.5 * k); g.fill();
    g.strokeStyle = "#3a3a3d"; g.lineWidth = 2 * k; rr(B.x + k, B.y + k, B.w - 2 * k, B.h - 2 * k, B.r - k); g.stroke();
  }
  // the page, under the camera
  const src = bitmaps.get(S.src);
  if (src) {
    const Wc = L.content.w, Hc = L.content.h, z = S.zoom;
    const sw = Wc / z, sh = Hc / z;
    const sx = Math.min(Math.max(S.cx - sw / 2, 0), Wc - sw), sy = Math.min(Math.max(S.cy - sh / 2, 0), Hc - sh);
    g.save();
    if (L.frame === "window") { g.beginPath(); g.roundRect(V.x, V.y, V.w, V.h, [0, 0, V.r, V.r]); } else rr(V.x, V.y, V.w, V.h, V.r);
    g.clip();
    g.imageSmoothingQuality = "high";
    g.drawImage(src, sx * L.content.dpr, sy * L.content.dpr, sw * L.content.dpr, sh * L.content.dpr, V.x, V.y, V.w, V.h);
    const at = (x, y) => [V.x + (x - sx) / sw * V.w, V.y + (y - sy) / sh * V.h];
    for (const r of S.ripples) {
      const [x, y] = at(r.x, r.y), p = r.age / 0.45;
      g.beginPath(); g.arc(x, y, (8 + 26 * p) * k, 0, Math.PI * 2);
      g.strokeStyle = "rgba(240,168,48," + (0.85 * (1 - p)) + ")"; g.lineWidth = 3 * k; g.stroke();
    }
    for (const t of S.touches) {
      const [x, y] = at(t.x, t.y), p = Math.min(t.age / 0.35, 1);
      g.beginPath(); g.arc(x, y, 19 * k * (1 + 0.25 * p), 0, Math.PI * 2);
      g.fillStyle = "rgba(255,255,255," + (0.32 * (1 - p)) + ")"; g.fill();
      g.strokeStyle = "rgba(255,255,255," + (0.8 * (1 - p)) + ")"; g.lineWidth = 2 * k; g.stroke();
    }
    g.restore();
    if (S.cursor) {
      const [x, y] = at(S.cursor.x, S.cursor.y), s = k * 1.15 * (S.cursor.pressed ? 0.86 : 1);
      g.save(); g.translate(x, y); g.scale(s, s);
      g.shadowColor = "rgba(0,0,0,0.45)"; g.shadowBlur = 4; g.shadowOffsetY = 1.5;
      g.beginPath(); g.moveTo(0, 0); g.lineTo(0, 17); g.lineTo(4.2, 13); g.lineTo(7.2, 19.6); g.lineTo(10, 18.4); g.lineTo(7.1, 12); g.lineTo(12.6, 12); g.closePath();
      g.fillStyle = "#fff"; g.fill(); g.shadowColor = "transparent"; g.strokeStyle = "#111"; g.lineWidth = 1.3; g.lineJoin = "round"; g.stroke();
      g.restore();
    }
  }
  if (L.frame === "phone") {
    // the camera, in the top bezel
    g.beginPath(); g.arc(B.x + B.w / 2, B.y + (V.y - B.y) / 2, 3.2 * L.scale, 0, Math.PI * 2); g.fillStyle = "#1f2a33"; g.fill();
  }
  return c.toDataURL(type, quality);
};
</script></body></html>`;

let shared: Browser | null = null;
async function compositor(): Promise<Page> {
  shared ??= await chromium.launch({ executablePath: process.env["CHROME_PATH"] ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
  const page = await shared.newPage();
  await page.setContent(PAGE);
  return page;
}

export async function closeCompositor(): Promise<void> {
  await shared?.close();
  shared = null;
}

/** The camera, cursor and effects at time `t` (seconds since the epoch, as the cues). */
function stateAt(rec: Recording, t: number, frame: Frame, frameIndex: number): State {
  const cues = rec.cues.filter((cue) => cue.t <= t);
  // camera: each cue eases from where the camera was when it came
  let from = { zoom: 1, cx: rec.width / 2, cy: rec.height / 2 };
  let target = from;
  let since = -Infinity;
  const at = (moment: number) => {
    const s = ease((moment - since) * 1000 / CAMERA_MS);
    return { zoom: from.zoom + (target.zoom - from.zoom) * s, cx: from.cx + (target.cx - from.cx) * s, cy: from.cy + (target.cy - from.cy) * s };
  };
  for (const cue of cues) {
    if (cue.kind !== "camera") continue;
    from = at(cue.t);
    target = { zoom: cue.zoom, cx: cue.x, cy: cue.y };
    since = cue.t;
  }
  const camera = since === -Infinity ? from : at(t);
  // cursor: between the last move and the next, so it glides at the output's frame rate
  let cursor: State["cursor"] = null;
  if (frame === "window") {
    const moves = rec.cues.filter((cue): cue is Extract<Cue, { x: number }> => cue.kind === "move" || cue.kind === "down" || cue.kind === "up");
    const before = [...moves].reverse().find((cue) => cue.t <= t) ?? moves[0];
    const after = moves.find((cue) => cue.t > t);
    if (before) {
      let x = before.x, y = before.y;
      if (after && after.kind === "move" && after.t - before.t < 0.2) {
        const s = (t - before.t) / (after.t - before.t);
        x += (after.x - x) * s; y += (after.y - y) * s;
      }
      const downs = cues.filter((cue) => cue.kind === "down");
      const lastDown = downs[downs.length - 1];
      const pressed = lastDown !== undefined && t - lastDown.t < 0.16;
      cursor = { x, y, pressed };
    }
  }
  const ripples = cues.filter((cue) => cue.kind === "down" && t - cue.t < 0.45).map((cue) => ({ x: (cue as { x: number }).x, y: (cue as { y: number }).y, age: t - cue.t }));
  const touches = cues.filter((cue) => cue.kind === "tap" && t - cue.t < 0.35).slice(-6).map((cue) => ({ x: (cue as { x: number }).x, y: (cue as { y: number }).y, age: t - cue.t }));
  return { src: frameIndex, zoom: camera.zoom, cx: camera.cx, cy: camera.cy, cursor, ripples, touches };
}

async function ffmpeg(args: string[], input?: AsyncIterable<Uint8Array>): Promise<void> {
  const proc = Bun.spawn(["ffmpeg", "-loglevel", "error", "-y", ...args], { stdin: input ? "pipe" : "ignore", stderr: "pipe" });
  if (input) {
    for await (const chunk of input) { proc.stdin!.write(chunk); await proc.stdin!.flush(); }
    await proc.stdin!.end();
  }
  if ((await proc.exited) !== 0) throw new Error(`ffmpeg failed: ${await new Response(proc.stderr).text()}`);
}

/**
 * The recording as an MP4 in a window or a phone on the backdrop, from `skip` seconds in,
 * holding the last frame `hold` seconds; and the same as a GIF `gifWidth` wide.
 */
export async function composeVideo(rec: Recording, frame: Frame, out: { mp4: string; gif: string; gifWidth: number }, opts: { skip?: number; hold?: number } = {}): Promise<void> {
  const L = frame === "window"
    ? layout("window", { w: rec.width, h: rec.height }, { canvasW: 1920, canvasH: 1200, scale: 1.25, margin: 0, backdrop: true })
    : layout("phone", { w: rec.width, h: rec.height }, { canvasW: 1080, canvasH: 1920, scale: 2, margin: 0, backdrop: true });
  const page = await compositor();
  await page.evaluate(([w, h]) => (window as any).setup(w, h), [L.canvas.w, L.canvas.h]);
  const frames = rec.frames.sort((a, b) => a.t - b.t);
  const begin = rec.start + (opts.skip ?? 0);
  const total = Math.round((rec.end - begin + (opts.hold ?? 0.8)) * FPS);
  let loaded = -1;
  async function* images(): AsyncGenerator<Uint8Array> {
    for (let i = 0; i < total; i++) {
      const t = Math.min(begin + i / FPS, rec.end);
      let index = 0;
      for (let j = 0; j < frames.length; j++) { if (frames[j]!.t <= t) index = j; else break; }
      if (index !== loaded) {
        await page.evaluate(([id, b64]) => (window as any).load(id, b64), [index, frames[index]!.jpeg.toString("base64")] as const);
        loaded = index;
      }
      const url = await page.evaluate(([L, S]) => (window as any).draw(L, S, "image/jpeg", 0.93), [L, stateAt(rec, t, frame, index)] as const) as string;
      yield Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
    }
  }
  await ffmpeg(["-f", "image2pipe", "-framerate", String(FPS), "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out.mp4], images());
  // a README GIF stays under a few MB: 12 fps, and a palette per clip
  const gifFilter = `fps=12,scale=${out.gifWidth}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
  await ffmpeg(["-i", out.mp4, "-vf", gifFilter, out.gif]);
  await page.close();
}

/** A 2x screenshot in a window or a phone, on a transparent background, as a PNG. */
export async function composeStill(png: Buffer, frame: Frame, content: { w: number; h: number }, out: string): Promise<void> {
  // drawn at 2 canvas px per CSS px, so the screenshot keeps its 2x pixels
  const L = layout(frame, content, { scale: 2, margin: frame === "window" ? 72 : 64, backdrop: false });
  const page = await compositor();
  await page.evaluate(([w, h]) => (window as any).setup(w, h), [L.canvas.w, L.canvas.h]);
  await page.evaluate(([b64]) => (window as any).load(0, b64, "image/png"), [png.toString("base64")] as const);
  const state: State = { src: 0, zoom: 1, cx: content.w / 2, cy: content.h / 2, cursor: null, ripples: [], touches: [] };
  const url = await page.evaluate(([L, S]) => (window as any).draw(L, S, "image/png"), [L, state] as const) as string;
  await Bun.write(out, Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));
  await page.close();
}
