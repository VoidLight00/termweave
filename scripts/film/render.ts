/**
 * Renders the brand film and the hero loop from the raw takes (capture.ts) — every output frame
 * drawn deterministically by the compositor page (stage.ts) in headless Chrome from the timeline
 * (timeline.ts), screenshotted, and piped to ffmpeg. Frames render in parallel chunks, one Chrome
 * per chunk, each into a lossless segment; the segments are joined, grained and encoded once.
 *
 *   bun scripts/film/render.ts report                      shot table: source ranges, rates, max magnification
 *   bun scripts/film/render.ts stills 0.8 8 13.6 [--scale 0.5] [--loop]   PNG frames + a contact sheet (_film/renders/stills/)
 *     (with --loop the times are path times: the delivered file's frame 0 is path time LOOP_START, 2.4 s)
 *   bun scripts/film/render.ts film [--workers 16] [--scale 1] [--from 0 --to 56] [--encode-only]
 *   bun scripts/film/render.ts loop [--start 2.4]          site/media/chat-loop.{mp4,jpg} + docs/media/chat-loop.gif
 *   bun scripts/film/render.ts check                       acceptance grabs, sizes, seam PSNR, duplicate frames
 *
 * `film` writes _film/renders/film-master.mp4 (CRF 10, animated grain) and site/media/herdr-web-ui-film.mp4
 * (CRF 19, preset veryslow, no grain, ≤ 20 MB): at a web bitrate x264 freezes per-frame grain into blocky
 * mottle that only refreshes on I-frames (a visible 2 s pulse), and even a static grain field costs ~3 MB
 * that the UI text needs more; the site draws its own static grain over the stage.
 * and the poster site/media/herdr-web-ui-film.jpg (the frame at 34.40 s). A full render takes a few
 * minutes on 32 cores. Needs /usr/bin/google-chrome (CHROME_PATH) and ffmpeg; the brand mark comes
 * from _film/brand/mark-paper.png, made by the brief's ffmpeg derivation from docs/brand/icon-source.png
 * (`render.ts` runs it when the file is missing).
 *
 * Decisions (see timeline.ts for the numbers): every take is 2x, so no desktop framing is tighter
 * than 960 CSS px (the brief's 3x macro framings are re-blocked at <= 2.0 output px per CSS px);
 * continuity comes from capture.ts's `story` staging: S1/S2 use R12 (the first task running), S3 R2,
 * S4/S5 R10, S9-S11 the "after" takes, S12 R13 (the next ask running); the hero loop is R11 (the demo's
 * own opening state, recorded 1280x1064 so nothing scrolls under the plan bar). Grain is ffmpeg's
 * luma noise (deterministic seed): temporal in the master, static in the web file and the loop.
 *
 * After a re-capture, re-check what was measured by hand on the frames: the S8 status/Pushed times
 * (R3_DONE… in timeline.ts), the per-shot camera anchors (fx/fy/ax/ay) and the type positions against
 * the new layout (`stills` at --scale 1 at every type entry). Pulse phases and every mark/cue-based
 * time are read from the takes and follow a re-capture on their own.
 */
import { chromium, type Browser, type CDPSession, type Page } from "playwright-core";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "./footage.ts";
import { STAGE_HTML, type FrameDesc } from "./stage.ts";
import { DURATION, FPS, LOOP_FPS, LOOP_LEN, LOOP_START, frame, loopFrame, report } from "./timeline.ts";

const CHROME = process.env["CHROME_PATH"] ?? "/usr/bin/google-chrome";
const RENDERS = join(REPO, "_film/renders");
const FILM_MP4 = join(REPO, "site/media/herdr-web-ui-film.mp4");
const FILM_JPG = join(REPO, "site/media/herdr-web-ui-film.jpg");
const LOOP_MP4 = join(REPO, "site/media/chat-loop.mp4");
const LOOP_JPG = join(REPO, "site/media/chat-loop.jpg");
const LOOP_GIF = join(REPO, "docs/media/chat-loop.gif");
const MARK = join(REPO, "_film/brand/mark-paper.png");
const POSTER_T = 34.4;
/** grain: ffmpeg temporal luma noise; strength tuned against the 20 MB cap */
const GRAIN = Number(process.env["FILM_GRAIN"] ?? 3);
const CRF = Number(process.env["FILM_CRF"] ?? 19);
const COLOR = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"];
const TO_YUV = "scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int";

const args = process.argv.slice(2);
const opt = (name: string, dflt: number): number => { const i = args.indexOf("--" + name); return i >= 0 ? Number(args[i + 1]) : dflt; };
const flag = (name: string): boolean => args.includes("--" + name);

// ---- serving the repo's _film/ to the compositor page ----
function serve(): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname);
      if (path === "/") return new Response(STAGE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
      if (!path.startsWith("/_film/") || path.includes("..")) return new Response("no", { status: 404 });
      const file = Bun.file(join(REPO, path));
      return (await file.exists()) ? new Response(file) : new Response("missing", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/`, stop: () => server.stop(true) };
}

interface Stage { browser: Browser; page: Page; cdp: CDPSession }

async function stage(url: string, scale: number): Promise<Stage> {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--hide-scrollbars", "--disable-lcd-text", "--force-color-profile=srgb"] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: scale });
  await page.goto(url);
  await page.evaluate(() => (window as any).filmReady);
  const cdp = await page.context().newCDPSession(page);
  return { browser, page, cdp };
}

async function shoot(s: Stage, f: FrameDesc): Promise<Buffer> {
  await s.page.evaluate((f) => (window as any).film.draw(f), f);
  const shot = await s.cdp.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true } as never) as { data: string };
  return Buffer.from(shot.data, "base64");
}

async function ffmpeg(argv: string[], input?: AsyncIterable<Uint8Array>): Promise<void> {
  const proc = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", ...argv], { stdin: input ? "pipe" : "ignore", stderr: "pipe" });
  if (input) {
    for await (const chunk of input) { proc.stdin!.write(chunk); await proc.stdin!.flush(); }
    await proc.stdin!.end();
  }
  if ((await proc.exited) !== 0) throw new Error(`ffmpeg ${argv.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
}

async function run(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return out + err;
}

function ensureMark(): Promise<void> | void {
  if (existsSync(MARK)) return;
  mkdirSync(join(REPO, "_film/brand"), { recursive: true });
  return ffmpeg(["-i", join(REPO, "docs/brand/icon-source.png"), "-vf", "crop=1040:1040:145:127,scale=512:512:flags=lanczos,format=rgba,geq=r=242:g=235:b=223:a='clip((200-r(X,Y))*2.5,0,255)'", MARK]);
}

/** Renders frames [a, b) of a builder into a lossless RGB segment. */
async function segment(url: string, scale: number, build: (i: number) => FrameDesc, fps: number, a: number, b: number, out: string, onFrame: () => void): Promise<void> {
  const s = await stage(url, scale);
  try {
    async function* frames(): AsyncGenerator<Uint8Array> { for (let i = a; i < b; i++) { yield await shoot(s, build(i)); onFrame(); } }
    await ffmpeg(["-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "-", "-c:v", "libx264rgb", "-qp", "0", "-preset", "ultrafast", "-pix_fmt", "rgb24", out], frames());
  } finally { await s.browser.close(); }
}

/** All frames of a builder in parallel chunks, joined into one lossless file. */
async function renderAll(name: string, build: (i: number) => FrameDesc, fps: number, first: number, last: number, workers: number, scale: number): Promise<string> {
  const dir = join(RENDERS, "seg", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const srv = serve();
  const n = last - first;
  const size = Math.ceil(n / workers);
  let done = 0;
  const t0 = performance.now();
  const tick = () => { done++; if (done % 60 === 0 || done === n) process.stdout.write(`\r${name}: ${done}/${n} frames, ${((performance.now() - t0) / 1000).toFixed(0)} s   `); };
  const parts: string[] = [];
  const jobs: Promise<void>[] = [];
  for (let w = 0; w < workers; w++) {
    const a = first + w * size, b = Math.min(last, a + size);
    if (a >= b) break;
    const out = join(dir, `${String(w).padStart(3, "0")}.mkv`);
    parts.push(out);
    jobs.push(segment(srv.url, scale, build, fps, a, b, out, tick));
  }
  try { await Promise.all(jobs); } finally { srv.stop(); }
  process.stdout.write("\n");
  const list = join(dir, "list.txt");
  writeFileSync(list, parts.map((p) => `file '${p}'`).join("\n") + "\n");
  const joined = join(RENDERS, `${name}-lossless.mkv`);
  await ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", joined]);
  return joined;
}

const mb = (p: string): string => (statSync(p).size / 1e6).toFixed(2) + " MB";

async function film(): Promise<void> {
  await ensureMark();
  if (flag("encode-only")) return deliver(join(RENDERS, "film-lossless.mkv"));
  const scale = opt("scale", 1), workers = opt("workers", 16);
  const first = Math.round(opt("from", 0) * FPS), last = Math.round(opt("to", DURATION) * FPS);
  mkdirSync(RENDERS, { recursive: true });
  const lossless = await renderAll("film", (i) => frame(i / FPS), FPS, first, last, workers, scale);
  const vf = `${TO_YUV},format=yuv420p,noise=c0s=${GRAIN}:c0f=t`;
  const master = join(RENDERS, "film-master.mp4");
  await ffmpeg(["-i", lossless, "-vf", vf, "-c:v", "libx264", "-profile:v", "high", "-preset", "slow", "-crf", "10", "-r", String(FPS), ...COLOR, "-an", "-movflags", "+faststart", master]);
  if (first !== 0 || last !== DURATION * FPS || scale !== 1) { console.log(`partial render: ${master} (${mb(master)})`); return; }
  await deliver(lossless);
  console.log(`master ${master} ${mb(master)}`);
}

/** The web file and its poster from the lossless render. */
async function deliver(lossless: string): Promise<void> {
  mkdirSync(join(REPO, "site/media"), { recursive: true });
  await ffmpeg(["-i", lossless, "-vf", `${TO_YUV},format=yuv420p`, "-c:v", "libx264", "-profile:v", "high", "-preset", "veryslow", "-crf", String(CRF), "-g", "120", "-r", String(FPS), ...COLOR, "-an", "-movflags", "+faststart", FILM_MP4]);
  if (statSync(FILM_MP4).size > 20e6) console.warn(`film is ${mb(FILM_MP4)}: over the 20 MB cap, raise FILM_CRF`);
  // the poster from the lossless render (grain-free, like the web file), not from the delivery encode
  await poster(lossless, POSTER_T, FILM_JPG, 85, 250_000, 0);
  console.log(`film ${FILM_MP4} ${mb(FILM_MP4)}\nposter ${FILM_JPG} ${mb(FILM_JPG)}`);
}

async function poster(src: string, t: number, out: string, quality: number, cap: number, grain = GRAIN): Promise<void> {
  // ffmpeg's -q:v 2..31 scale; walk it down from the q85-ish setting until the byte cap holds
  for (let q = Math.round((100 - quality) / 5) + 1; q <= 12; q++) {
    await ffmpeg(["-ss", t.toFixed(3), "-i", src, "-frames:v", "1", "-vf", `${TO_YUV},format=yuv420p${grain ? `,noise=c0s=${grain}:c0f=u` : ""}`, "-q:v", String(q), out]);
    if (statSync(out).size <= cap) return;
  }
}

/**
 * The path is closed, so the file may start anywhere on it: output frame i is path frame (i + s) mod n,
 * rotated in whole frames (a float modulo can land a hair under 6.4 s and repeat a frame at the wrap).
 * The path's own seam (6.4 s -> 0) then sits inside the file at frame n - s; `check` measures it.
 */
const loopShift = (): number => Math.round(opt("start", LOOP_START) * LOOP_FPS);

async function loop(): Promise<void> {
  const n = Math.round(LOOP_LEN * LOOP_FPS), s = loopShift();
  const lossless = await renderAll("loop", (i) => loopFrame(((i + s) % n) / LOOP_FPS), LOOP_FPS, 0, n, opt("workers", 12), 1);
  // static grain (no temporal flag: one fixed noise field), so the seam stays invisible
  const vf = `${TO_YUV},format=yuv420p,noise=c0s=${GRAIN}:c0f=u`;
  mkdirSync(join(REPO, "site/media"), { recursive: true });
  mkdirSync(join(REPO, "docs/media"), { recursive: true });
  await ffmpeg(["-i", lossless, "-vf", vf, "-c:v", "libx264", "-profile:v", "high", "-preset", "slow", "-crf", "23", "-g", String(n), "-r", String(LOOP_FPS), ...COLOR, "-an", "-movflags", "+faststart", LOOP_MP4]);
  await ffmpeg(["-i", lossless, "-frames:v", "1", "-vf", vf, "-q:v", "4", LOOP_JPG]);
  await gif(lossless);
  console.log(`loop ${LOOP_MP4} ${mb(LOOP_MP4)}\nposter ${LOOP_JPG} ${mb(LOOP_JPG)}\ngif ${LOOP_GIF} ${mb(LOOP_GIF)}`);
}

/** README GIF: the brief's 880 px / 15 fps first; while over 5 MB, 12 fps, then a 128-colour palette, then 800 px. */
async function gif(src: string): Promise<void> {
  const tries = [[15, 880, 256, 3], [12, 880, 256, 3], [12, 880, 128, 4], [12, 800, 128, 4]] as const;
  for (const [fps, width, colors, bayer] of tries) {
    const h = Math.round((width * 9) / 16);
    await ffmpeg(["-i", src, "-vf", `fps=${fps},scale=${width}:${h}:flags=lanczos,split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=${bayer}:diff_mode=rectangle`, "-loop", "0", LOOP_GIF]);
    console.log(`gif ${fps} fps ${width}x${h} ${colors} colours: ${mb(LOOP_GIF)}`);
    if (statSync(LOOP_GIF).size <= 5e6) return;
  }
}

async function stills(): Promise<void> {
  await ensureMark();
  const times = args.slice(1).filter((a) => !a.startsWith("--") && !isNaN(Number(a)) && args[args.indexOf(a) - 1] !== "--scale").map(Number);
  const scale = opt("scale", 0.5);
  const dir = join(RENDERS, "stills");
  mkdirSync(dir, { recursive: true });
  const srv = serve();
  const s = await stage(srv.url, scale);
  const files: string[] = [];
  try {
    for (const t of times) {
      const png = await shoot(s, flag("loop") ? loopFrame(t) : frame(t));
      const f = join(dir, `${flag("loop") ? "loop-" : ""}${t.toFixed(2)}.png`);
      writeFileSync(f, png);
      files.push(f);
    }
  } finally { await s.browser.close(); srv.stop(); }
  if (files.length > 1) {
    const cols = Math.min(3, files.length);
    const sheet = join(dir, "sheet.png");
    await ffmpeg([...files.flatMap((f) => ["-i", f]), "-filter_complex", `${files.map((_, i) => `[${i}:v]scale=640:-1,drawtext=text='${times[i]!.toFixed(2)}':x=8:y=8:fontsize=20:fontcolor=white:box=1:boxcolor=black@0.6[v${i}]`).join(";")};${files.map((_, i) => `[v${i}]`).join("")}xstack=inputs=${files.length}:layout=${files.map((_, i) => `${(i % cols) * 640}_${Math.floor(i / cols) * 360}`).join("|")}:fill=black`, "-frames:v", "1", sheet]);
    console.log(sheet);
  } else console.log(files[0]);
}

async function check(): Promise<void> {
  const dir = join(RENDERS, "check");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const grabs = [0.8, 8.0, 13.6, 18.4, 21.6, 26.0, 29.6, 33.9, 37.6, 40.5, 44.0, 48.0, 53.8];
  for (const t of grabs) await ffmpeg(["-ss", t.toFixed(3), "-i", FILM_MP4, "-frames:v", "1", join(dir, `${t.toFixed(1).padStart(4, "0")}.png`)]);
  console.log("acceptance grabs:", readdirSync(dir).join(" "));
  console.log(await run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,profile,width,height,r_frame_rate,pix_fmt,nb_frames,color_space:format=duration,size", "-of", "compact", FILM_MP4]));
  for (const f of [FILM_MP4, FILM_JPG, LOOP_MP4, LOOP_JPG, LOOP_GIF]) console.log(f.replace(REPO + "/", ""), existsSync(f) ? mb(f) : "MISSING");
  console.log(await run(["ffprobe", "-v", "error", "-show_entries", "stream=width,height,r_frame_rate,nb_frames:format=duration", "-of", "compact", LOOP_MP4]));
  // the loop's seam: path frame 0 against path frame 192 (t = 6.4 s, one past the last), both rendered
  // fresh; in the rotated file that wrap is between output frames n - s - 1 and n - s. Then the file's
  // frame 0 against a fresh render of the start, to prove the rotation is the one asked for.
  const lossless = join(RENDERS, "loop-lossless.mkv");
  if (existsSync(lossless)) {
    const n = Math.round(LOOP_LEN * LOOP_FPS), sh = loopShift();
    const p0 = join(dir, "seam-path0.png"), p192 = join(dir, `seam-path${n}.png`), start = join(dir, `start-path${sh}.png`), out0 = join(dir, "loop-out0.png");
    const srv = serve(); const s = await stage(srv.url, 1);
    writeFileSync(p0, await shoot(s, loopFrame(0)));
    writeFileSync(p192, await shoot(s, loopFrame(LOOP_LEN)));
    writeFileSync(start, await shoot(s, loopFrame(sh / LOOP_FPS)));
    await s.browser.close(); srv.stop();
    await ffmpeg(["-i", lossless, "-vf", "select=eq(n\\,0)", "-frames:v", "1", out0]);
    const psnr = async (a: string, b: string) => (await run(["ffmpeg", "-hide_banner", "-i", a, "-i", b, "-lavfi", "psnr", "-f", "null", "-"])).match(/average:[^ ]+/)?.[0];
    console.log(`seam PSNR path frame 0 vs ${n} (output frames ${n - sh - 1}|${n - sh}):`, await psnr(p0, p192));
    console.log(`start: output frame 0 = path frame ${sh} (${(sh / LOOP_FPS).toFixed(2)} s), PSNR vs fresh render:`, await psnr(out0, start));
  }
  // duplicate frames in the grain-free render (camera moves must never hold a frame)
  const fl = join(RENDERS, "film-lossless.mkv");
  if (existsSync(fl)) {
    const md = await run(["ffmpeg", "-hide_banner", "-i", fl, "-f", "framemd5", "-"]);
    const hashes = md.split("\n").filter((l) => /^0,/.test(l)).map((l) => l.split(",").pop()!.trim());
    const dups: number[] = [];
    for (let i = 1; i < hashes.length; i++) if (hashes[i] === hashes[i - 1]) dups.push(i);
    const runs: string[] = [];
    for (let i = 0; i < dups.length; i++) { let j = i; while (j + 1 < dups.length && dups[j + 1] === dups[j]! + 1) j++; runs.push(`${(dups[i]! / FPS).toFixed(2)}-${((dups[j]! + 1) / FPS).toFixed(2)}s`); i = j; }
    console.log(`identical consecutive frames (grain-free render): ${dups.length}; runs: ${runs.join(" ") || "none"}`);
  }
}

const cmd = args[0];
if (cmd === "report") console.log(report().join("\n"));
else if (cmd === "stills") await stills();
else if (cmd === "film") await film();
else if (cmd === "loop") await loop();
else if (cmd === "check") await check();
else { console.log("usage: bun scripts/film/render.ts report | stills <t…> [--scale s] [--loop] | film [--workers n] | loop | check"); process.exit(1); }
