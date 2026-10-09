/**
 * Raw footage for the brand film and the site: stills and screen recordings of the REAL client,
 * running on the browser demo's fixtures (_site/demo/app/, site/demo/transport.ts), at 2x.
 *
 * - The built site is served under /herdr-web-ui/ by a small Bun.serve, like GitHub Pages does.
 * - The app page itself is recorded (demo/app/), not the framed demo/index.html: no demo banner.
 * - Chrome gets the brand fonts (Pretendard Variable, JetBrains Mono) as local fonts through its own
 *   fontconfig, downloaded once to _film/fonts: the app names them first but ships no webfont, and a
 *   local font is there before xterm measures its cells.
 * - Recordings use hand.ts (CDP screencast frames with paint times, cue log of the hand; the README's
 *   scripts/readme-media/record.ts with a device scale, a clock-driven glide, place and press). Each one is kept raw (JPEG frames, frames.json, cues.json, marks) and turned into a
 *   constant 60 fps MP4 by holding every frame until the next one was painted.
 * - A few takes change what the fixtures say, never how the app behaves, through a wrapper around the
 *   transport's fetch (see `mods`): `todo` pins a todo list to the Claude chat, `real` drops the
 *   fixture's own copy of the message typed in R1 and turns the demo's "nothing ran" reply into the
 *   answer Claude gave in the fixture, `stream` (R10) shows the turn in progress step by step (Read, Edit,
 *   Edit, Bash, each with its TodoWrite plan update) while the demo's answer is held, and `story` sets the
 *   Claude chat to the moment of the film a take belongs to (opening / before / after / next), so no shot
 *   contradicts another. Takes set after S8 also answer the Codex card before they record (never on camera).
 *   INDEX.md says which takes use them.
 * - filmHold (every page; holds nothing until armed): a setTimeout with an armed delay waits for
 *   `__herdrFilm.release()`. 4500 ms = the demo's end of the Claude turn (R11-R13 keep it running),
 *   2400 ms = the demo's chat answer (R10 holds it until the plan reaches 3/3). The app uses neither delay.
 * - Scale: FILM_SCALE (default 2) sets R10/R11's device scale factor. 3x was tried and the screencast
 *   painted ~13 fps (the brief asks for 40), so every take is 2x (crop limit: >= 960 CSS px of width).
 * - R5 keeps the pointer off the terminal: the recorded screen turns on mouse reporting (?1003h) and the
 *   pretend shell would echo the reports as text; the take fails if any reach the terminal.
 *
 * - Scroll shots are also rendered frame-stepped (S takes): posed and screenshotted 60 times a second.
 * - Chrome runs with --hide-scrollbars: no scrollbar shows in any shot.
 *
 *   bun run build:site && bun scripts/film/capture.ts [stills] [rec] [stepped] [R1 R1b … S1 … | still names]
 *
 * Nothing selected runs everything. Writes _film/footage/ (stills/, rec/<name>/, <name>.mp4,
 * sheets/<name>.png, manifest.json, INDEX.md). Needs ffmpeg. FILM_DEBUG=1 logs the eased scroll.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hand, type Recording } from "./hand.ts";
import panes from "../../site/demo/fixtures/panes.json";

const REPO = join(import.meta.dir, "../..");
const SITE = join(REPO, "_site");
const FILM = join(REPO, "_film");
const OUT = join(FILM, "footage");
const FONTS = join(FILM, "fonts");
const CHROME = process.env["CHROME_PATH"] ?? "/usr/bin/google-chrome";
const FPS = 60;

const DESKTOP = { width: 1440, height: 900 };
const VIDEO_DESKTOP = { width: 1280, height: 800 };
/** the hero loop's take (R11): tall enough that the Claude chat fits with its first block open (see its note) */
const LOOP_DESKTOP = { width: 1280, height: 1064 };
const PHONE = { width: 390, height: 844 };
const PANE = panes as Record<"api" | "web" | "infra" | "docs" | "shell", string>;
const MESSAGE = "Nice. Now add a metric for replayed requests.";
/** device scale factor of the R10/R11 takes (FILM_SCALE=3 for 3x; 2x unless the screencast keeps up) */
const FILM_SCALE = Number(process.env["FILM_SCALE"] ?? 2);

const args = process.argv.slice(2);
const want = (group: string, name: string) => args.length === 0 || args.includes(group) || args.includes(name);

// ---- the site, the fonts, the browser ----------------------------------------------------------

if (!existsSync(join(SITE, "demo/app/index.html"))) {
  const built = Bun.spawnSync(["bun", "run", "build:site"], { cwd: REPO, stdout: "inherit", stderr: "inherit" });
  if (built.exitCode !== 0) throw new Error("bun run build:site failed");
}

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/herdr-web-ui/")) return new Response("not found", { status: 404 });
    let file = decodeURIComponent(path.slice("/herdr-web-ui".length));
    if (file.endsWith("/")) file += "index.html";
    if (file.includes("..")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(SITE, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  },
});
const APP = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`;

const FONT_FILES: Record<string, string> = {
  "PretendardVariable.ttf": "https://cdn.jsdelivr.net/npm/pretendard@1.3.9/dist/public/variable/PretendardVariable.ttf",
  "JetBrainsMono-Regular.ttf": "https://cdn.jsdelivr.net/gh/JetBrains/JetBrainsMono@v2.304/fonts/ttf/JetBrainsMono-Regular.ttf",
  "JetBrainsMono-Medium.ttf": "https://cdn.jsdelivr.net/gh/JetBrains/JetBrainsMono@v2.304/fonts/ttf/JetBrainsMono-Medium.ttf",
  "JetBrainsMono-Bold.ttf": "https://cdn.jsdelivr.net/gh/JetBrains/JetBrainsMono@v2.304/fonts/ttf/JetBrainsMono-Bold.ttf",
};
mkdirSync(FONTS, { recursive: true });
for (const [name, url] of Object.entries(FONT_FILES)) {
  if (existsSync(join(FONTS, name))) continue;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`font ${name}: ${response.status}`);
  await Bun.write(join(FONTS, name), response);
}
const fontconfig = join(FONTS, "fonts.conf");
writeFileSync(fontconfig, `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <dir>${FONTS}</dir>
  <cachedir>${join(FONTS, "cache")}</cachedir>
</fontconfig>
`);

// headless screencasts come at 1x unless the whole browser renders at 2x (or 3x): one browser per scale
const browsers = new Map<number, Browser>();
async function browserAt(scale: number): Promise<Browser> {
  let browser = browsers.get(scale);
  if (!browser) {
    browser = await chromium.launch({
      executablePath: CHROME,
      headless: true,
      args: ["--no-sandbox", `--force-device-scale-factor=${scale}`, "--hide-scrollbars", "--font-render-hinting=none"],
      env: { ...process.env, FONTCONFIG_FILE: fontconfig } as Record<string, string>,
    });
    browsers.set(scale, browser);
  }
  return browser;
}

// ---- opening the app ---------------------------------------------------------------------------

interface Open {
  pane: keyof typeof PANE;
  phone?: boolean;
  viewport?: { width: number; height: number };
  theme?: "dark" | "light";
  language?: "en" | "ko";
  /** fixture changes: see the header */
  mods?: { todo?: boolean; real?: boolean; worked?: boolean; stream?: boolean; story?: "opening" | "before" | "after" | "after-plain" | "next" };
  /** ms after the app is up before the caller takes over; the Claude turn ends 4.5 s after load */
  settle?: number;
  /** device scale factor (default 2) */
  scale?: number;
  /** timer delays held from the start (see filmHold); 4500 keeps the Claude turn running */
  hold?: number[];
  /** Settings > terminal font size (px) */
  terminalFont?: number;
}

/**
 * Runs in the page before the demo transport: a setTimeout whose delay is armed is kept instead of
 * scheduled, until `__herdrFilm.release()` runs it. The demo schedules its scripted events with
 * fixed delays (the Claude turn ends at 4500 ms, a chat answer comes 2400 ms after sending) and the
 * app uses neither, so arming one holds exactly that event: a turn stays running as long as a take
 * needs. `caught()` counts what was held, per delay, for the take's notes.
 */
function filmHold(initial: number[]): void {
  const native = window.setTimeout.bind(window);
  const armed = new Set<number>(initial);
  const held: (() => void)[] = [];
  const caught: Record<string, number> = {};
  const wrapped = (handler: TimerHandler, ms?: number, ...rest: unknown[]): number => {
    if (typeof handler === "function" && typeof ms === "number" && armed.has(ms)) {
      held.push(() => (handler as (...a: unknown[]) => void)(...rest));
      caught[ms] = (caught[ms] ?? 0) + 1;
      return -held.length;
    }
    return native(handler, ms, ...rest) as unknown as number;
  };
  (window as unknown as { setTimeout: unknown }).setTimeout = wrapped;
  (window as unknown as { __herdrFilm: unknown }).__herdrFilm = {
    arm: (ms: number) => { armed.add(ms); },
    release: () => { armed.clear(); for (const run of held.splice(0)) run(); },
    caught: () => ({ ...caught }),
  };
}

/**
 * Runs in the page before the demo transport: when the transport installs its fetch, it gets
 * wrapped, and the Claude chat's answers are edited on their way to the app.
 */
function fetchMods(options: { api: string; message: string; todo: boolean; real: boolean; worked: boolean; stream: boolean; story: string }): void {
  const native = window.fetch;
  let inner: typeof fetch | null = null;
  const tool = (name: string, summary: string, input: unknown, output: string) => ({ kind: "tool", name, summary, input: JSON.stringify(input, null, 2), output });
  const textOf = (turn: any): string => turn.parts?.find((part: any) => part.kind === "text")?.text ?? "";
  // the plan of the streamed turn (stream): one TodoWrite per step, the whole list each time
  const PLAN = [
    ["Add the replay counter to src/metrics.ts", "Adding the replay counter"],
    ["Count a replay where a stored response is returned", "Counting replays"],
    ["Cover the replay count with a test", "Testing the replay count"],
  ];
  const plan = (statuses: string[]) => tool("TodoWrite", "", { todos: PLAN.map(([content, activeForm], i) => ({ content, status: statuses[i], activeForm })) }, "Todos have been modified successfully.");
  const INTRO = "Adding a `payments_idempotent_replays_total` counter next to the existing request metrics.";
  const DONE_TEXT = "Added `payments_idempotent_replays_total`, incremented where a stored response is replayed, and exposed with the other counters on `/metrics`. 6 tests pass.";
  // every step R10's turn streamed, plan updates included: the turn as it lands at the end of that take
  const streamed = () => [
    { kind: "text", text: INTRO },
    plan(["in_progress", "pending", "pending"]),
    tool("Read", "src/metrics.ts", { file_path: "src/metrics.ts" }, "export const requests = new Counter({ … })"),
    tool("Edit", "src/metrics.ts", { file_path: "src/metrics.ts" }, "Updated src/metrics.ts"),
    plan(["completed", "in_progress", "pending"]),
    tool("Edit", "src/lib/idempotency.ts", { file_path: "src/lib/idempotency.ts" }, "Updated src/lib/idempotency.ts"),
    plan(["completed", "completed", "in_progress"]),
    tool("Bash", "bun test metrics", { command: "bun test metrics" }, " 6 pass\n 0 fail\nRan 6 tests across 1 file. [201ms]"),
    plan(["completed", "completed", "completed"]),
    { kind: "text", text: DONE_TEXT },
  ];
  const todos = (items: [string, string, string][]) => tool("TodoWrite", "", { todos: items.map(([content, status, activeForm]) => ({ content, status, activeForm })) }, "Todos have been modified successfully.");
  const later = (iso: string, seconds: number) => new Date(Date.parse(iso) + seconds * 1000).toISOString();
  /**
   * story: the Claude chat as it stands at one point of the film, so every shot agrees with the one
   * before it (the fixture itself sits between two of them: the metric turn already asked and running).
   * - opening: the first task still running (no end, its Bash and answer not written yet), its plan pinned;
   * - before: the first task done, nothing asked since (the chat R10 types into);
   * - after: the metric turn asked and done exactly as R10 recorded it ("Worked for 9s");
   * - next: after, plus the next thing asked and running.
   */
  const story = (all: any[], stage: string): any[] => {
    const u1 = all.findIndex((turn) => turn.role === "user");
    const a1 = all[u1 + 1];
    const nice = all.find((turn) => turn.role === "user" && textOf(turn) === options.message);
    if (u1 < 0 || a1?.role !== "assistant" || !nice) return all;
    const done = all.slice(0, u1 + 2);
    if (stage === "before") return done;
    if (stage === "opening") {
      const { end_ts: _end, ...running } = a1;
      const steps = a1.parts.filter((part: any) => part.kind === "tool" && part.name !== "Bash");
      const intro = a1.parts.find((part: any) => part.kind === "text");
      return [...all.slice(0, u1 + 1), { ...running, parts: [intro, todos([
        ["Find where POST /payments creates a charge", "completed", "Finding where a charge is created"],
        ["Store the first response per Idempotency-Key", "completed", "Storing the first response"],
        ["Replay it for a repeated key, 409 while in flight", "in_progress", "Replaying the stored response"],
        ["Cover retries and a changed body with tests", "pending", "Testing retries"],
      ]), ...steps] }];
    }
    const answered = { role: "assistant", ts: nice.ts, end_ts: later(nice.ts, 9), parts: streamed() };
    const after = [...done, nice, answered];
    if (stage === "after") return after;
    // the same turn without its plan updates (same header: a TodoWrite is not an edit), so no plan bar
    // is pinned: on a phone scroll the bar's uncovered strip and the "jump to latest" button over it
    // (app layout, reported) would sit on every frame
    if (stage === "after-plain") return [...done, nice, { ...answered, parts: answered.parts.filter((part: any) => part.name !== "TodoWrite") }];
    const asked = { role: "user", ts: later(nice.ts, 40), parts: [{ kind: "text", text: "Document the Idempotency-Key header in docs/api.md." }] };
    const working = { role: "assistant", ts: later(nice.ts, 42), parts: [
      { kind: "text", text: "Adding an Idempotency-Key section to the `POST /payments` reference." },
      todos([
        ["Find the POST /payments reference in docs/api.md", "completed", "Finding the reference"],
        ["Document the Idempotency-Key header", "completed", "Documenting the header"],
        ["List the 409 and 422 responses", "in_progress", "Listing the responses"],
        ["Mention the replay counter on /metrics", "pending", "Mentioning the counter"],
      ]),
      tool("Read", "docs/api.md", { file_path: "docs/api.md" }, "## POST /payments\n…"),
      tool("Edit", "docs/api.md", { file_path: "docs/api.md" }, "Updated docs/api.md"),
    ] };
    return [...after, asked, working];
  };
  const edit = (body: any, api: boolean): void => {
    let turns: any[] = body.turns ?? [];
    // replaces the chat wholesale on every poll: the demo's own end of the running turn never shows
    if (options.story && api) turns = story(turns, options.story);
    if (options.real && api) {
      // the fixture already holds this exchange; the take types it anew
      const first = turns.findIndex((turn) => turn.role === "user" && textOf(turn) === options.message);
      if (first >= 0) turns = turns.filter((turn, index) => index !== first && !(index === first + 1 && turn.role === "assistant"));
      for (const turn of turns) {
        if (turn.role !== "assistant" || !textOf(turn).startsWith("This is the demo")) continue;
        // worked from the moment the message was sent
        const asked = turns[turns.indexOf(turn) - 1];
        if (asked?.ts) turn.ts = asked.ts;
        // with stream: every step the turn streamed, plan updates included, so nothing jumps as it lands
        turn.parts = options.stream ? streamed() : streamed().filter((part: any) => part.name !== "TodoWrite");
      }
    }
    if (options.stream && api) {
      // the answer is held (filmHold 2400): the turn in progress, revealed step by step as the
      // seconds since sending pass, so each step lands on the chat's own 2 s poll
      const last = turns[turns.length - 1];
      if (last?.role === "user" && textOf(last) === options.message && last.ts) {
        const since = (Date.now() - Date.parse(last.ts)) / 1000;
        const parts: any[] = [{ kind: "text", text: INTRO }, plan(["in_progress", "pending", "pending"])];
        if (since >= 2) parts.push(tool("Read", "src/metrics.ts", { file_path: "src/metrics.ts" }, "export const requests = new Counter({ … })"));
        if (since >= 4) parts.push(tool("Edit", "src/metrics.ts", { file_path: "src/metrics.ts" }, "Updated src/metrics.ts"), plan(["completed", "in_progress", "pending"]));
        if (since >= 6) parts.push(tool("Edit", "src/lib/idempotency.ts", { file_path: "src/lib/idempotency.ts" }, "Updated src/lib/idempotency.ts"), plan(["completed", "completed", "in_progress"]));
        if (since >= 8) parts.push(tool("Bash", "bun test metrics", { command: "bun test metrics" }, " 6 pass\n 0 fail\nRan 6 tests across 1 file. [201ms]"), plan(["completed", "completed", "completed"]));
        turns.push({ role: "assistant", ts: last.ts, parts });
      }
    }
    if (options.todo && api) {
      const turn = [...turns].reverse().find((candidate) => candidate.role === "assistant" && textOf(candidate).startsWith("Adding a `payments_idempotent_replays_total`"));
      if (turn && !turn.parts.some((part: any) => part.name === "TodoWrite")) {
        const done = typeof turn.end_ts === "string";
        const todos = [
          { content: "Find where a stored response is replayed", status: "completed", activeForm: "Finding where a stored response is replayed" },
          { content: "Add the payments_idempotent_replays_total counter", status: "completed", activeForm: "Adding the counter" },
          { content: "Expose it on /metrics with the other counters", status: done ? "completed" : "in_progress", activeForm: "Exposing it on /metrics" },
          { content: "Cover the replay count with a test", status: done ? "completed" : "pending", activeForm: "Testing the replay count" },
        ];
        turn.parts.splice(1, 0, tool("TodoWrite", "", { todos }, "Todos have been modified successfully."));
      }
    }
    if (options.worked) {
      // an answer the demo writes in one go has ts === end_ts: "Worked for 0s"; it took the demo's 2.6 s
      for (const turn of turns) if (turn.role === "assistant" && turn.ts && turn.ts === turn.end_ts) turn.ts = new Date(Date.parse(turn.end_ts) - 2600).toISOString();
    }
    body.turns = turns;
  };
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await inner!(input, init);
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (url.pathname !== "/api/pane/conversation" || !response.ok) return response;
    if (url.searchParams.get("pane_id") !== options.api && !options.worked) return response;
    const body = await response.clone().json();
    edit(body, url.searchParams.get("pane_id") === options.api);
    return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
  };
  // the transport keeps the native fetch for everything else, so hand it the native one to bind
  Object.defineProperty(window, "fetch", { configurable: true, get: () => (inner ? wrapped : native), set: (value) => { inner = value; } });
}

async function open(options: Open): Promise<{ context: BrowserContext; page: Page; loadedAt: number }> {
  const phone = options.phone ?? false;
  const viewport = options.viewport ?? (phone ? PHONE : DESKTOP);
  const scale = options.scale ?? 2;
  const browser = await browserAt(scale);
  const context = await browser.newContext({
    viewport, deviceScaleFactor: scale, colorScheme: options.theme ?? "dark", locale: options.language === "ko" ? "ko-KR" : "en-US",
    ...(phone ? { isMobile: true, hasTouch: true } : {}),
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.warn(`  page error: ${error.message}`));
  const settings = { theme: options.theme ?? "dark", language: options.language ?? "en", ...(options.terminalFont ? { terminalFontSize: options.terminalFont } : {}) };
  await page.addInitScript((value) => { try { localStorage.setItem("herdr-web-ui:settings", value); } catch { /* no storage */ } }, JSON.stringify(settings));
  // the hook goes in whenever a take may arm it; it holds nothing until armed
  await page.addInitScript(filmHold, options.hold ?? []);
  if (options.mods?.todo || options.mods?.real || options.mods?.worked || options.mods?.stream || options.mods?.story) {
    await page.addInitScript(fetchMods, { api: PANE.api, message: MESSAGE, todo: options.mods.todo ?? false, real: options.mods.real ?? false, worked: options.mods.worked ?? false, stream: options.mods.stream ?? false, story: options.mods.story ?? "" });
  }
  await page.goto(`${APP}?pane=${encodeURIComponent(PANE[options.pane])}`, { waitUntil: "networkidle" });
  const loadedAt = Date.now();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForSelector(".pane-select", { state: "attached", timeout: 10_000 });
  const fonts = await page.evaluate(() => [document.fonts.check('16px "Pretendard Variable"'), document.fonts.check('13px "JetBrains Mono"')]);
  if (!fonts.every(Boolean)) console.warn(`  fonts missing: ${JSON.stringify(fonts)}`);
  await Bun.sleep(options.settle ?? 6000);
  return { context, page, loadedAt };
}

/** the scrollable element around the chat */
async function chatScroller(page: Page): Promise<string> {
  return page.evaluate(() => {
    const start = document.querySelector(".chat-transcript") ?? document.querySelector(".chat-view");
    let node: Element | null = start;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 4) break;
      node = node.parentElement;
    }
    if (!node || node === document.body) {
      // the transcript's children may scroll instead
      node = [...document.querySelectorAll(".chat-view *")].find((el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 4) ?? null;
    }
    if (!node) return "";
    node.setAttribute("data-film-scroller", "");
    return "[data-film-scroller]";
  });
}

/** eased scroll of the chat, painted every frame (a hand on a trackpad, minus the jitter) */
async function easedScroll(page: Page, selector: string, to: number | "bottom", ms: number): Promise<void> {
  const trace = await page.evaluate(async ({ selector, to, ms }) => {
    const log: string[] = [];
    const el = document.querySelector(selector)!;
    const from = el.scrollTop;
    // fixed at the start: a turn that settles its height mid-way must not pull the scroll back
    const target = to === "bottom" ? el.scrollHeight - el.clientHeight : to;
    let last = from;
    const ease = (s: number) => (s < 0.5 ? 4 * s * s * s : 1 - (-2 * s + 2) ** 3 / 2);
    const t0 = performance.now();
    await new Promise<void>((resolve) => {
      const step = (now: number) => {
        const s = Math.min(1, (now - t0) / ms);
        const want = from + (target - from) * ease(s);
        const before = el.scrollTop;
        el.scrollTop = target >= from ? Math.max(last, want) : Math.min(last, want);
        last = el.scrollTop;
        log.push(`${Math.round(now - t0)} before=${Math.round(before)} want=${Math.round(want)} got=${Math.round(el.scrollTop)} h=${el.scrollHeight}`);
        if (s < 1) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
    return log;
  }, { selector, to, ms });
  if (process.env["FILM_DEBUG"]) console.log(trace.filter((_, i) => i % 10 === 0).join("\n"));
}

/** human typing: 12–18 characters a second, a beat longer after a word or a sentence */
async function typeHuman(page: Page, text: string, marks?: Marks, pace = 1): Promise<void> {
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  marks?.add("typing starts");
  for (const ch of text) {
    await page.keyboard.type(ch);
    let ms = pace * 1000 / (12 + random() * 6);
    if (ch === " ") ms *= 1.35;
    if (ch === "." || ch === ",") ms *= 2.6;
    await Bun.sleep(ms);
  }
  marks?.add("typing ends");
}

// ---- stills ------------------------------------------------------------------------------------

interface Entry { file: string; kind: "still" | "recording"; shows: string; resolution: string; duration?: number; marks?: { label: string; t: number }[]; notes?: string }
const manifestPath = join(OUT, "manifest.json");
mkdirSync(OUT, { recursive: true });
const manifest: Record<string, Entry> = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
const save = () => writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

async function still(name: string, shows: string, options: Open, then?: (page: Page) => Promise<void | "shot">, notes?: string): Promise<void> {
  if (!want("stills", name)) return;
  console.log(`still ${name}`);
  const { context, page } = await open(options);
  mkdirSync(join(OUT, "stills"), { recursive: true });
  const own = await then?.(page);
  const viewport = page.viewportSize()!;
  if (own !== "shot") await page.screenshot({ path: join(OUT, "stills", `${name}.png`) });
  await context.close();
  // the PNG's own size (a clipped shot is smaller than the window)
  const png = readFileSync(join(OUT, "stills", `${name}.png`));
  const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
  const resolution = w === viewport.width * 2 && h === viewport.height * 2 ? `${w}x${h} (${viewport.width}x${viewport.height} @2x)` : `${w}x${h} (@2x clip)`;
  manifest[`stills/${name}.png`] = { file: `stills/${name}.png`, kind: "still", shows, resolution, ...(notes ? { notes } : {}) };
  save();
}

const row = (key: keyof typeof PANE) => `.pane-select[title^="${PANE[key]} "]`;

async function stills(): Promise<void> {
  await still("01-desktop-chat-claude", "Claude pane (api), chat, dark: Worked-for blocks, Markdown answer with code block and link, model + reasoning in the composer", { pane: "api" });
  await still("02-desktop-chat-worked-open", "Claude pane with the first \"Worked for 2m 36s\" block expanded: Grep / Read / Edit / Write / Bash rows", { pane: "api" }, async (page) => {
    await page.locator(".work-block-head").first().click();
    await Bun.sleep(700);
    const scroller = await chatScroller(page);
    if (scroller) await page.evaluate(({ scroller }) => {
      const el = document.querySelector(scroller)!;
      const head = document.querySelector(".work-block-head")!;
      el.scrollTop += head.getBoundingClientRect().top - el.getBoundingClientRect().top - 90;
    }, { scroller });
    await Bun.sleep(500);
  });
  await still("03-desktop-todo-open", "Claude pane mid-turn (RUN) with the pinned todo list opened under the chat: 2 done, 1 in progress, 1 to do", { pane: "api", mods: { todo: true }, settle: 1200 }, async (page) => {
    await page.locator(".todo-panel-head").click();
    await Bun.sleep(600);
  }, "fixture has no todo list: a TodoWrite call is added to the running Claude turn (mods.todo); taken at ~2.5 s after load, while the turn still runs");
  await still("04-desktop-codex-approval", "Codex pane (web): the \"Allow command?\" approval card for git push origin feat/export-guard, answerable from the chat", { pane: "web" });
  await still("05-desktop-codex-working", "Codex pane right after answering Yes: card gone, status RUN / working", { pane: "web" }, async (page) => {
    await page.locator(".prompt-card-options button").first().click();
    await Bun.sleep(900);
  });
  await still("06-desktop-palette", "Command palette (Ctrl+Shift+K) open over the Claude chat with \"backup\" typed", { pane: "api" }, async (page) => {
    await page.keyboard.press("Control+Shift+K");
    await Bun.sleep(400);
    await page.keyboard.type("backup", { delay: 70 });
    await Bun.sleep(500);
  });
  await still("07-desktop-terminal", "Shell pane (release) in the live terminal after the git log --graph + bun test replay", { pane: "shell", settle: 7000 });
  await still("08-desktop-slash-menu", "Claude composer with \"/\" typed: the slash command menu open", { pane: "api" }, async (page) => {
    await page.locator(".composer-text").click();
    await page.keyboard.type("/");
    await Bun.sleep(700);
  });
  await still("09-desktop-sidebar-statuses", "Full window while Claude still runs: sidebar shows RUN (Claude), INPUT (Codex), READY (gjc, omo)", { pane: "api", settle: 1500 }, undefined, "taken ~1.5 s after load, before the Claude turn ends at 4.5 s");
  await still("09b-sidebar-statuses-crop", "Sidebar close-up (clip of 09): RUN / INPUT / READY badges", { pane: "api", settle: 1500 }, async (page) => {
    const box = (await page.locator(".sidebar").first().boundingBox())!;
    await page.screenshot({ path: join(OUT, "stills", "09b-sidebar-statuses-crop.png"), clip: { x: box.x, y: 0, width: box.width, height: 700 } });
    return "shot";
  }, "clip 0,0 to sidebar width x 700 CSS px");
  await still("10-desktop-chat-light", "Claude chat in the light (ledger paper) theme", { pane: "api", theme: "light" });
  await still("11-desktop-chat-korean", "Claude chat with the UI in Korean (Settings > language: ko)", { pane: "api", language: "ko" });
  await still("11b-desktop-codex-korean", "Codex approval card with the UI in Korean", { pane: "web", language: "ko" });
  await still("12-phone-chat", "Phone: Claude chat", { pane: "api", phone: true });
  await still("13-phone-sessions-drawer", "Phone: the sessions drawer open (every agent with its status)", { pane: "api", phone: true }, async (page) => {
    await page.locator(".drawer-toggle").tap();
    await Bun.sleep(800);
  });
  await still("14-phone-codex-approval", "Phone: the Codex approval card", { pane: "web", phone: true });
  await still("15-phone-terminal", "Phone: shell terminal with the key bar", { pane: "shell", phone: true, settle: 7000 }, undefined, "default 13 px: the recorded 80-column screen (auto-wrap off) cuts every long git log line and overwrites its last cell (\"--decorate8\", \"chore(re0\"). Use 15b instead");
  await still("15b-phone-terminal-font10", "Phone: shell terminal with the key bar, terminal font 10 px (Settings > terminal font size, the smallest)", { pane: "shell", phone: true, settle: 7000, terminalFont: 10 }, undefined, "the recorded screen is 80 columns with auto-wrap off (?7l), so on a phone at the default 13 px (still 15) lines longer than the phone's ~47 columns are cut and overwrite their last cell; at 10 px about 62 columns fit and only the two longest git log lines are cut");
  await still("16-phone-chat-light", "Phone: Claude chat, light theme", { pane: "api", phone: true, theme: "light" });
}

// ---- recordings --------------------------------------------------------------------------------

class Marks {
  readonly list: { label: string; at: number }[] = [];
  add(label: string): void { this.list.push({ label, at: Date.now() / 1000 }); }
}

interface Take { shows: string; open: Open; notes?: string; prepare?: (page: Page, hand: Hand) => Promise<void>; run: (page: Page, hand: Hand, marks: Marks) => Promise<void>; check?: (page: Page) => Promise<string | void> }

async function record(name: string, take: Take): Promise<void> {
  console.log(`recording ${name}`);
  const { context, page } = await open(take.open);
  const viewport = page.viewportSize()!;
  const scale = take.open.scale ?? 2;
  const hand = new Hand(page, viewport.width, viewport.height, scale);
  await take.prepare?.(page, hand);
  const marks = new Marks();
  await hand.begin();
  await Bun.sleep(700);
  await take.run(page, hand, marks);
  const recording = await hand.end();
  // a take may check the page it leaves (and say what it saw)
  const checked = await take.check?.(page);
  if (checked) console.log(`  ${name}: ${checked}`);
  await context.close();
  const entry = await writeRecording(name, recording, marks, scale);
  const notes = [take.notes, checked].filter(Boolean).join(" · ");
  manifest[`${name}.mp4`] = { ...entry, shows: take.shows, ...(notes ? { notes } : {}) };
  save();
}

async function writeRecording(name: string, recording: Recording, marks: Marks, scale = 2): Promise<Entry> {
  const dir = join(OUT, "rec", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "frames"), { recursive: true });
  const frames = [...recording.frames].sort((a, b) => a.t - b.t);
  if (frames.length === 0) throw new Error(`${name}: no frames`);
  // the lead-in: from the first painted frame (the page is settled before recording starts)
  const t0 = frames[0]!.t;
  const end = recording.end;
  const files: { file: string; t: number }[] = [];
  frames.forEach((frame, index) => {
    const file = `${String(index + 1).padStart(6, "0")}.jpg`;
    writeFileSync(join(dir, "frames", file), frame.jpeg);
    files.push({ file, t: frame.t - t0 });
  });
  const rel = (t: number) => Math.round((t - t0) * 1000) / 1000;
  writeFileSync(join(dir, "frames.json"), JSON.stringify({ t0, end: rel(end), viewport: { width: recording.width, height: recording.height }, scale, fps: paintFps(files), frames: files }, null, 1));
  writeFileSync(join(dir, "cues.json"), JSON.stringify(recording.cues.map((cue) => ({ ...cue, t: rel(cue.t) })), null, 1));
  const markList = marks.list.map((mark) => ({ label: mark.label, t: rel(mark.at) }));
  writeFileSync(join(dir, "marks.json"), JSON.stringify(markList, null, 1));

  // constant 60 fps: every frame held until the next one was painted
  const lines = ["ffconcat version 1.0"];
  files.forEach((frame, index) => {
    const next = index + 1 < files.length ? files[index + 1]!.t : rel(end);
    lines.push(`file 'frames/${frame.file}'`, `duration ${Math.max(1 / FPS, next - frame.t).toFixed(6)}`);
  });
  lines.push(`file 'frames/${files[files.length - 1]!.file}'`);
  writeFileSync(join(dir, "concat.txt"), lines.join("\n") + "\n");
  const mp4 = join(OUT, `${name}.mp4`);
  const w = recording.width * scale, h = recording.height * scale;
  run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(dir, "concat.txt"),
    "-vf", `scale=${w}:${h}:flags=lanczos,fps=${FPS}`, "-fps_mode", "cfr", "-r", String(FPS),
    "-c:v", "libx264", "-preset", "slow", "-crf", "12", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4]);
  const duration = Number(run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4]).trim());
  sheet(name, mp4, recording.width, duration);
  return { file: `${name}.mp4`, kind: "recording", shows: "", resolution: `${w}x${h} (${recording.width}x${recording.height} @${scale}x), ${FPS} fps (screencast painted ${paintFps(files)})`, duration: Math.round(duration * 100) / 100, marks: markList };
}

/** screencast paint rate while something moves: median frames/s over intervals under 250 ms (a still page paints nothing) */
function paintFps(files: { t: number }[]): string {
  const gaps = files.slice(1).map((f, i) => f.t - files[i]!.t).filter((g) => g > 0 && g < 0.25).sort((a, b) => a - b);
  if (gaps.length === 0) return "n/a";
  return `~${Math.round(1 / gaps[Math.floor(gaps.length / 2)]!)} fps while moving`;
}

function run(cmd: string[]): string {
  const result = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${cmd[0]} failed: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

/** waits until `predicate` holds in the page, polling each 50 ms, then marks it */
async function until(page: Page, marks: Marks, label: string, predicate: string | (() => boolean), timeout = 8000): Promise<void> {
  await page.waitForFunction(predicate, undefined, { polling: 50, timeout }).catch(() => console.warn(`  never: ${label}`));
  marks.add(label);
}

// ---- staging a take before it records (never on camera) ----

/** Answers the Codex card (Yes) from its chat and waits for the push to land: the film has done that by S8. */
async function answerCodex(page: Page): Promise<void> {
  await page.waitForSelector(".prompt-card-options button", { timeout: 10_000 });
  await page.locator(".prompt-card-options button").first().click();
  await page.waitForFunction(() => /Pushed/.test([...document.querySelectorAll(".chat-turn-agent")].map((el) => el.textContent ?? "").join("")), undefined, { polling: 100, timeout: 10_000 });
}

/** Opens another pane from the sidebar and lets its chat settle. */
async function selectPane(page: Page, key: keyof typeof PANE): Promise<void> {
  await page.locator(row(key)).first().click();
  await Bun.sleep(1800);
}

/** Folds a work block ("first" or "last") if it is open. */
async function fold(page: Page, which: "first" | "last"): Promise<void> {
  await page.evaluate((which) => {
    const heads = [...document.querySelectorAll<HTMLElement>(".work-block-head")];
    const head = which === "first" ? heads[0] : heads[heads.length - 1];
    if (head?.getAttribute("aria-expanded") === "true") head.click();
  }, which);
  await Bun.sleep(400);
}

/** Keeps the chat at its end (where it opens), for takes that must not show the "jump to latest" button. */
async function chatToEnd(page: Page): Promise<void> {
  const scroller = await chatScroller(page);
  if (scroller) await page.evaluate(({ scroller }) => { const el = document.querySelector(scroller)!; el.scrollTop = el.scrollHeight; }, { scroller });
  await Bun.sleep(300);
}

/**
 * Where the status dots' 1.6 s pulse is (CSS `pulse`, opacity 1 -> 0.35 at 50% -> 1): a mark per
 * dot "pulse <class> <ms into its cycle>", so a cut can start on a trough (800 ms into a cycle).
 */
async function markPulse(page: Page, marks: Marks): Promise<number> {
  const dots = await page.evaluate(() => document.getAnimations().filter((a: any) => a.animationName === "pulse").map((a: any) => ({
    what: String((a.effect?.target as Element | null)?.className ?? "?").split(" ")[0] ?? "?", ms: Math.round(Number(a.currentTime) % 1600),
  })));
  for (const dot of dots) marks.add(`pulse ${dot.what} ${dot.ms}`);
  return dots.find((dot) => /working|dot/.test(dot.what))?.ms ?? dots[0]?.ms ?? 0;
}

/** Waits until the dots' next trough (all pulse dots of a page mounted together share a phase). */
async function toTrough(page: Page): Promise<void> {
  const ms = await page.evaluate(() => {
    const a: any = document.getAnimations().find((x: any) => x.animationName === "pulse");
    return a ? Number(a.currentTime) % 1600 : 800;
  });
  await Bun.sleep((800 - ms + 1600) % 1600);
}

async function sendTake(page: Page, hand: Hand, marks: Marks): Promise<void> {
  const before = await page.evaluate(() => document.querySelectorAll(".chat-turn").length);
  await hand.click(".composer-text");
  marks.add("composer clicked");
  await Bun.sleep(450);
  await typeHuman(page, MESSAGE, marks);
  await Bun.sleep(550);
  await page.keyboard.press("Enter");
  marks.add("Enter (sent)");
  await until(page, marks, "user turn shows", `document.querySelectorAll(".chat-turn").length > ${before}`);
  await until(page, marks, "status RUN (working)", () => /RUN/.test(document.querySelector(".composer-status")?.textContent ?? ""), 3000);
  await until(page, marks, "status DONE", () => /DONE/.test(document.querySelector(".composer-status")?.textContent ?? ""), 6000);
  await until(page, marks, "answer lands (next chat poll)", `document.querySelectorAll(".chat-turn").length > ${before + 1}`, 8000);
  await Bun.sleep(1500);
}

/** An untouched take: pulse phases marked, then `seconds` with nothing done. */
function stillTake(seconds: number): Take["run"] {
  return async (page, _hand, marks) => {
    const start = Date.now() - 700;
    await markPulse(page, marks);
    await Bun.sleep(Math.max(0, start + seconds * 1000 - Date.now()));
    marks.add("end");
  };
}
function runningCheck(name: string): NonNullable<Take["check"]> {
  return async (page) => {
    const seen = await page.evaluate(() => ({
      status: document.querySelector(".composer-status")?.textContent ?? "",
      todo: document.querySelector(".todo-panel-head")?.textContent ?? "",
      demo: /This is the demo/.test(document.body.textContent ?? ""),
      caught: (window as any).__herdrFilm.caught(),
    }));
    if (!/RUN/.test(seen.status)) throw new Error(`${name}: status is not RUN at the end: ${seen.status}`);
    if (seen.demo) throw new Error(`${name}: the demo notice is on screen`);
    return `status "${seen.status.trim()}", plan "${seen.todo.trim()}", held ${JSON.stringify(seen.caught)}`;
  };
}

const TAKES: Record<string, Take> = {
  "R1-chat-send": {
    shows: "Claude pane: click composer, type the follow-up at human speed, Enter, RUN, the demo's answer lands",
    open: { pane: "api", viewport: VIDEO_DESKTOP },
    notes: "as the demo ships: the fixture already holds this exact message (its earlier copy is visible above), and the answer is the demo's own notice (\"This is the demo, so nothing ran…\")",
    run: sendTake,
  },
  "R1b-chat-send-real": {
    shows: "Same take, film version: the chat ends at the first answer, the typed message is new, and Claude's answer lands with its work folded (Read/Edit/Edit/Bash) under \"Worked for\"",
    open: { pane: "api", viewport: VIDEO_DESKTOP, mods: { real: true } },
    notes: "mods.real: fixture's earlier copy of the message dropped; demo notice replaced by the fixture's own metric answer. \"Worked for\" reads a couple of seconds (the demo's timing)",
    run: sendTake,
  },
  "R2-fold": {
    shows: "Claude pane, first task done and nothing asked since: open the \"Worked for 2m 36s\" block, read the rows, fold it 4 s later",
    open: { pane: "api", viewport: VIDEO_DESKTOP, mods: { story: "before" } },
    notes: "mods.story before: the chat ends at the first answer (the metric turn is asked in R10), so the first block is the last one and opens by default; it is folded before recording. No scroll: the chat fits, so no \"jump to latest\" button",
    prepare: async (page, hand) => {
      await fold(page, "first");
      await chatToEnd(page);
      await hand.place(VIDEO_DESKTOP.width * 0.62, VIDEO_DESKTOP.height * 0.62);
      await Bun.sleep(600);
    },
    run: async (page, hand, marks) => {
      const start = Date.now() - 700;
      const at = (s: number) => Bun.sleep(Math.max(0, start + s * 1000 - Date.now()));
      const head = await hand.center(".work-block-head");
      await at(1.2);
      await hand.moveTo(head.x - 40, head.y, 800);
      await at(2.4);
      await hand.press();
      marks.add("expanded");
      // reading: the pointer drifts beside the rows, then back to the header
      await at(3.0);
      await hand.moveTo(head.x + 150, head.y + 120, 1100);
      await at(5.3);
      await hand.moveTo(head.x - 40, head.y, 800);
      await at(6.4);
      await hand.press();
      marks.add("collapsed");
      await at(8.4);
    },
  },
  "R3-approve": {
    shows: "Codex pane: the Allow command? card, pointer to Yes, click, RUN, the turn ends with the push and Codex's answer",
    open: { pane: "web", viewport: VIDEO_DESKTOP, mods: { worked: true } },
    notes: "mods.worked: the pushed turn reads \"Worked for 3s\" instead of the demo's \"Worked for 0s\"",
    run: async (page, hand, marks) => {
      await page.waitForSelector(".prompt-card-options button");
      await Bun.sleep(600);
      await hand.moveTo(700, 420, 700);
      await Bun.sleep(250);
      await hand.click(".prompt-card-options button");
      marks.add("click Yes");
      await until(page, marks, "card gone / working", () => document.querySelector(".prompt-card") === null, 3000);
      await until(page, marks, "turn ends (Pushed…)", () => /Pushed `?feat\/export-guard/.test([...document.querySelectorAll(".chat-turn-agent")].map((el) => el.textContent ?? "").join("")), 6000);
      await Bun.sleep(1400);
    },
  },
  "R4-palette": {
    shows: "Ctrl+Shift+K opens the command palette over the Claude chat, \"backup\" typed slowly, Enter jumps to the gjc pane",
    open: { pane: "web", viewport: VIDEO_DESKTOP, mods: { story: "after" } },
    notes: "mods.story after (the metric turn done as R10 recorded it, \"Worked for 9s\"); before recording, the Codex card is answered (as in S7/S8) and the Claude pane opened from the sidebar, its last block folded: every status matches the film at S9",
    prepare: async (page, hand) => {
      await answerCodex(page);
      await selectPane(page, "api");
      await fold(page, "last");
      await chatToEnd(page);
      await hand.place(VIDEO_DESKTOP.width + 60, VIDEO_DESKTOP.height * 0.8);
      await Bun.sleep(500);
    },
    run: async (page, hand, marks) => {
      await Bun.sleep(300);
      await page.keyboard.press("Control+Shift+K");
      marks.add("palette opens");
      await Bun.sleep(700);
      await typeHuman(page, "backup", marks, 2.4);
      await Bun.sleep(700);
      await page.keyboard.press("Enter");
      marks.add("Enter (jump)");
      await Bun.sleep(2000);
    },
  },
  "R5-terminal": {
    shows: "From the gjc chat (where S9 lands): click the shell pane in the sidebar, the terminal attaches and the git log --graph + bun test replay plays out",
    open: { pane: "web", viewport: VIDEO_DESKTOP, mods: { story: "after" } },
    notes: "mods.story after; before recording, the Codex card is answered and the gjc pane (infra) opened, so the take starts where R4 ends. The replay starts when the pane attaches. The pointer then rests on the empty sidebar: the recorded screen turns on mouse reporting (?1003h), so a pointer over the terminal would be typed into the pretend shell as [<35;…M",
    prepare: async (page, hand) => {
      await answerCodex(page);
      await selectPane(page, "infra");
      await chatToEnd(page);
      await hand.place(VIDEO_DESKTOP.width * 0.5, VIDEO_DESKTOP.height * 0.72);
      await Bun.sleep(500);
    },
    run: async (page, hand, marks) => {
      await Bun.sleep(900);
      await hand.click(row("shell"));
      marks.add("shell pane opened (replay starts)");
      // off the row (its hover actions clear) and never over the terminal
      await hand.moveTo(160, 590, 800);
      await until(page, marks, "tests pass line", () => /4 pass/.test(document.querySelector(".xterm-rows")?.textContent ?? ""), 8000);
      await Bun.sleep(3000);
    },
    check: async (page) => {
      const text = await page.evaluate(() => document.querySelector(".xterm-rows")?.textContent ?? "");
      if (/\[<\d+;\d+;\d+[Mm]/.test(text)) throw new Error("R5: mouse reports reached the terminal");
    },
  },
  "R6-phone-approve": {
    shows: "Phone: open the sessions drawer, tap Codex, tap Yes on the approval card, hold through RUN until the turn ends",
    open: { pane: "api", phone: true, mods: { worked: true } },
    notes: "mods.worked, as R3",
    run: async (page, hand, marks) => {
      await Bun.sleep(400);
      await hand.tap(".drawer-toggle");
      marks.add("drawer tap");
      await Bun.sleep(1200);
      await hand.tap(row("web"));
      marks.add("Codex tapped");
      await page.waitForSelector(".prompt-card-options button");
      await Bun.sleep(1500);
      await page.locator(".prompt-card-options button").first().scrollIntoViewIfNeeded();
      await hand.tap(".prompt-card-options button");
      marks.add("tap Yes");
      await until(page, marks, "working", () => document.querySelector(".prompt-card") === null, 3000);
      await until(page, marks, "turn ends", () => /Pushed/.test([...document.querySelectorAll(".chat-turn-agent")].map((el) => el.textContent ?? "").join("")), 6000);
      await Bun.sleep(1400);
    },
  },
  "R7-phone-chat": {
    shows: "Phone: the Claude chat scrolled slowly from the first message to the latest answer",
    open: { pane: "api", phone: true },
    notes: "scrolling is an eased scrollTop animation (smoother than synthetic touch); no touch cues. Screencast fps: S1-phone-chat-scroll is the exact 60 fps version",
    prepare: async (page) => { await primeScroller(page); await Bun.sleep(1200); },
    run: async (page, hand, marks) => {
      await Bun.sleep(500);
      marks.add("at top, scroll starts");
      await easedScroll(page, "[data-film-scroller]", await primedBottom(page), 8000);
      marks.add("at bottom");
      await Bun.sleep(1500);
    },
  },
  "R8-switch": {
    shows: "Desktop: clicking through the sidebar, Claude → Codex → gjc → omo → Claude",
    notes: "1.2 s dwell after each click; with the 0.65 s eased move to the next row, clicks land ~2.3 s apart. The hovered row shows its rename/close actions (app hover state)",
    open: { pane: "api", viewport: VIDEO_DESKTOP },
    run: async (page, hand, marks) => {
      await Bun.sleep(500);
      for (const key of ["web", "infra", "docs", "api"] as const) {
        await hand.click(row(key));
        marks.add(`${key} selected`);
        await Bun.sleep(1200);
      }
    },
  },
  "R9-chat-terminal-toggle": {
    shows: "Claude pane: Chat → Terminal → Chat through the view switch",
    open: { pane: "api", viewport: VIDEO_DESKTOP },
    notes: "the demo has no agent TUI: Terminal shows the demo's boxed notice (\"This is the demo… Switch back to Chat above\"); not film material",
    run: async (page, hand, marks) => {
      await hand.click(".view-switch button:nth-child(2)");
      marks.add("Terminal");
      await Bun.sleep(1600);
      await hand.click(".view-switch button:nth-child(1)");
      marks.add("Chat");
      await Bun.sleep(1400);
    },
  },
  "R10-stream": {
    shows: "Claude pane: click the composer, type the follow-up, Enter; the turn streams in (Read, Edit, Edit, Bash) with its plan pinned below going 0/3 → 3/3, RUN → DONE, the answer lands folded under \"Worked for\"; the pointer leaves",
    open: { pane: "api", viewport: VIDEO_DESKTOP, mods: { real: true, stream: true }, settle: 6000, scale: FILM_SCALE },
    notes: "mods.real + mods.stream, filmHold arms 2400 just before Enter (the demo's answer is held until \"released\"). The turn's steps are revealed by the seconds since sending and land on the chat's own 2 s poll. \"Worked for\" is the true take time. Pointer starts off-screen bottom-right",
    prepare: async (_page, hand) => { await hand.place(VIDEO_DESKTOP.width + 60, VIDEO_DESKTOP.height + 40); },
    run: async (page, hand, marks) => {
      const before = await page.evaluate(() => document.querySelectorAll(".chat-turn").length);
      const { x, y } = await hand.center(".composer-text");
      await hand.moveTo(x - 180, y, 1100);
      await Bun.sleep(150);
      await hand.press();
      marks.add("composer clicked");
      await Bun.sleep(450);
      await typeHuman(page, MESSAGE, marks);
      await Bun.sleep(550);
      await page.evaluate(() => (window as any).__herdrFilm.arm(2400));
      await page.keyboard.press("Enter");
      marks.add("Enter (sent)");
      await until(page, marks, "user turn shows", `document.querySelectorAll(".chat-turn").length > ${before}`);
      await until(page, marks, "status RUN", () => /RUN/.test(document.querySelector(".composer-status")?.textContent ?? ""), 3000);
      for (const n of [0, 1, 2, 3]) {
        await until(page, marks, `todo ${n}/3`, `(document.querySelector(".todo-panel-count")?.textContent ?? "") === "${n}/3"`, 14_000);
      }
      await Bun.sleep(1000);
      await page.evaluate(() => (window as any).__herdrFilm.release());
      marks.add("released");
      await until(page, marks, "status DONE", () => /DONE/.test(document.querySelector(".composer-status")?.textContent ?? ""), 3000);
      await until(page, marks, "answer lands", () => /6 tests pass\./.test([...document.querySelectorAll(".chat-turn")].pop()?.textContent ?? ""), 6000);
      await Bun.sleep(1500);
      marks.add("cursor leaves");
      await hand.moveTo(VIDEO_DESKTOP.width + 20, 640, 1200);
      await Bun.sleep(2500);
    },
    check: async (page) => {
      const seen = await page.evaluate(() => ({
        demo: /This is the demo/.test(document.body.textContent ?? ""),
        head: [...document.querySelectorAll(".work-block-head")].pop()?.textContent ?? "",
        todo: document.querySelector(".todo-panel")?.textContent ?? "",
        caught: (window as any).__herdrFilm.caught(),
      }));
      if (seen.demo) throw new Error("R10: the demo notice is on screen");
      return `last header "${seen.head.replace(/\s+/g, " ").trim()}", plan "${seen.todo.trim()}", held ${JSON.stringify(seen.caught)}`;
    },
  },
  "R11-live": {
    shows: "Hero loop: the Claude pane as the demo opens it (the metric turn running: RUN, Working…, plan 2/4 pinned), the pointer at rest opens the first \"Worked for 2m 36s\", folds it, and comes back to rest",
    open: { pane: "api", viewport: LOOP_DESKTOP, mods: { todo: true }, hold: [4500], settle: 1500, scale: FILM_SCALE },
    notes: "mods.todo, filmHold holds 4500 from load: the Claude turn never ends. 1280x1064, not 1280x800: the plan bar is sticky inside the chat's scroller, so whatever is scrolled under it shows in the scroller's bottom padding (an app bug, reported), and at 800 px the opened rows push Working… under the bar and the metric message into that strip. At 1064 px the whole chat fits with the block open (907 of 923 px), nothing scrolls, and Working…, its dot and the plan stay in view the whole loop. The running turn is folded before recording. Loop section from mark \"L\" (a pulse trough): pointer at rest P (62%, 58%), glides to the header at L+0.8, click L+1.6, fold L+4.0, back at P by L+6.0, rests to L+6.4 and beyond",
    prepare: async (page, hand) => {
      await fold(page, "last");
      await chatToEnd(page);
      await hand.place(LOOP_DESKTOP.width * 0.62, LOOP_DESKTOP.height * 0.58);
      await Bun.sleep(900);
    },
    run: async (page, hand, marks) => {
      const start = Date.now() - 700;
      const at = (s: number) => Bun.sleep(Math.max(0, start + s * 1000 - Date.now()));
      const P = { x: LOOP_DESKTOP.width * 0.62, y: LOOP_DESKTOP.height * 0.58 };
      const layout = () => page.evaluate(() => {
        const scroller = document.querySelector("[data-film-scroller]") ?? document.querySelector(".chat-transcript");
        const heads = [...document.querySelectorAll(".work-block-head")].map((el) => Math.round(el.getBoundingClientRect().top));
        const bar = document.querySelector(".todo-panel")?.getBoundingClientRect();
        return `scroll ${scroller ? `${scroller.scrollTop}/${scroller.scrollHeight - scroller.clientHeight}` : "?"}, first header y ${heads[0]}, Working… y ${heads[heads.length - 1]}, plan bar y ${bar ? Math.round(bar.top) : "none"}`;
      });
      await at(0.4);
      marks.add(`folded layout (${await layout()})`);
      await markPulse(page, marks);
      await at(1.0);
      await toTrough(page);
      const L = (Date.now() - start) / 1000;
      marks.add("L");
      await at(L + 0.8);
      const head = await hand.center(".work-block-head");
      await hand.moveTo(head.x, head.y, 650);
      await at(L + 1.6);
      await hand.press();
      marks.add("L+1.6 expand click");
      await Bun.sleep(400);
      marks.add(`open layout (${await layout()})`);
      await at(L + 4.0);
      await hand.press();
      marks.add("L+4.0 fold click");
      await at(L + 4.8);
      marks.add("L+4.8 back to P");
      await hand.moveTo(P.x, P.y, 1200);
      marks.add("at P");
      await at(L + 6.4);
      marks.add("L+6.4 loop end");
      await at(L + 7.6);
      marks.add("end");
    },
    check: async (page) => {
      const seen = await page.evaluate(() => ({
        status: document.querySelector(".composer-status")?.textContent ?? "",
        todo: document.querySelector(".todo-panel-head")?.textContent ?? "",
        caught: (window as any).__herdrFilm.caught(),
      }));
      if (!/RUN/.test(seen.status)) throw new Error(`R11: status is not RUN at the end: ${seen.status}`);
      return `status "${seen.status.trim()}", plan "${seen.todo.trim()}", held ${JSON.stringify(seen.caught)}`;
    },
  },
  "R12-opening": {
    shows: "Film S1/S2: the Claude pane on its first task, still running (RUN, Working… with its dot, the Grep/Read/Edit/Write rows, plan 2/4 pinned), untouched, no pointer",
    open: { pane: "api", viewport: VIDEO_DESKTOP, mods: { story: "opening" }, hold: [4500], settle: 1500, scale: FILM_SCALE },
    notes: "mods.story opening (the first task before its Bash and answer, with a plan), filmHold holds 4500 from load: RUN all take. Codex still asks (INPUT): the film answers it at S7. Pulse marks give each dot's phase",
    prepare: async (page, hand) => {
      await chatToEnd(page);
      await hand.place(VIDEO_DESKTOP.width + 60, VIDEO_DESKTOP.height * 0.8);
      await Bun.sleep(900);
    },
    run: stillTake(11),
    check: runningCheck("R12"),
  },
  "R13-next": {
    shows: "Film S12: the Claude pane after the metric turn (\"Worked for 9s\", as R10 recorded it), the next ask running (Working…, plan 2/4), Codex answered (DONE), untouched, no pointer",
    open: { pane: "web", viewport: VIDEO_DESKTOP, mods: { story: "next" }, hold: [4500], settle: 1500, scale: FILM_SCALE },
    notes: "mods.story next, filmHold holds 4500 from load: RUN all take. Before recording, the Codex card is answered and the Claude pane opened from the sidebar. Pulse marks give each dot's phase",
    prepare: async (page, hand) => {
      await answerCodex(page);
      await selectPane(page, "api");
      await chatToEnd(page);
      await hand.place(VIDEO_DESKTOP.width + 60, VIDEO_DESKTOP.height * 0.8);
      await Bun.sleep(900);
    },
    run: stillTake(11),
    check: runningCheck("R13"),
  },
};


/**
 * Walks the whole chat once so every turn has been laid out (content-visibility keeps the real
 * heights afterwards) and no turn changes size under a scroll; notes where the bottom is when
 * resting there (the chat is a little taller while scrolled away); leaves it at the top.
 */
async function primeScroller(page: Page): Promise<void> {
  const scroller = await chatScroller(page);
  if (!scroller) throw new Error("no chat scroller");
  await page.evaluate(async ({ scroller }) => {
    const el = document.querySelector(scroller)!;
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (let y = el.scrollHeight; y >= 0; y -= el.clientHeight / 2) { el.scrollTop = y; await wait(120); }
    for (let y = 0; y <= el.scrollHeight; y += el.clientHeight / 2) { el.scrollTop = y; await wait(120); }
    el.scrollTop = el.scrollHeight;
    await wait(600);
    el.scrollTop = el.scrollHeight;
    el.setAttribute("data-film-bottom", String(el.scrollTop));
    el.scrollTop = 0;
  }, { scroller });
}
const primedBottom = async (page: Page) => Number(await page.getAttribute("[data-film-scroller]", "data-film-bottom"));

// ---- stepped takes -----------------------------------------------------------------------------

/**
 * Motion the screencast cannot paint at 60 fps (it delivers 25–45 fps at 2x): the page is posed
 * frame by frame and screenshotted, so every one of the 60 frames a second is exact. Only for
 * takes where the page does nothing on its own while posed (a scroll).
 */
interface Stepped { shows: string; open: Open; seconds: number; hold: [number, number]; notes?: string; pose: (page: Page, s: number) => Promise<void>; prepare: (page: Page) => Promise<void> }

async function stepped(name: string, take: Stepped): Promise<void> {
  console.log(`stepped ${name}`);
  const { context, page } = await open(take.open);
  await take.prepare(page);
  const viewport = page.viewportSize()!;
  const dir = join(OUT, "rec", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "frames"), { recursive: true });
  const [lead, tail] = take.hold;
  const total = Math.round((lead + take.seconds + tail) * FPS);
  const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
  const positions: number[] = [];
  for (let i = 0; i < total; i++) {
    const t = i / FPS;
    const s = Math.min(1, Math.max(0, (t - lead) / take.seconds));
    await take.pose(page, ease(s));
    await page.screenshot({ path: join(dir, "frames", `${String(i + 1).padStart(6, "0")}.png`), animations: "disabled", caret: "hide" });
    positions.push(await page.evaluate(() => document.querySelector("[data-film-scroller]")?.scrollTop ?? -1));
  }
  const backwards = positions.filter((y, i) => i > 0 && y < positions[i - 1]! - 0.5).length;
  if (backwards) console.warn(`  ${name}: the scroll went back on ${backwards} frames`);
  await context.close();
  writeFileSync(join(dir, "frames.json"), JSON.stringify({ stepped: true, fps: FPS, viewport, scale: 2, frames: total, scrollTop: positions, move: { from: lead, to: lead + take.seconds, easing: "easeInOutCubic" } }, null, 1));
  const mp4 = join(OUT, `${name}.mp4`);
  run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", String(FPS), "-i", join(dir, "frames", "%06d.png"), "-c:v", "libx264", "-preset", "slow", "-crf", "12", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4]);
  const duration = total / FPS;
  sheet(name, mp4, viewport.width, duration);
  manifest[`${name}.mp4`] = {
    file: `${name}.mp4`, kind: "recording", shows: take.shows, resolution: `${viewport.width * 2}x${viewport.height * 2} (${viewport.width}x${viewport.height} @2x), ${FPS} fps, frame-stepped`,
    duration: Math.round(duration * 100) / 100, marks: [{ label: "scroll starts", t: lead }, { label: "scroll ends", t: lead + take.seconds }],
    ...(take.notes ? { notes: take.notes } : {}),
  };
  save();
}

function sheet(name: string, mp4: string, width: number, duration: number): void {
  mkdirSync(join(OUT, "sheets"), { recursive: true });
  const tileWidth = width > 600 ? 640 : 300;
  run(["ffmpeg", "-y", "-loglevel", "error", "-i", mp4, "-vf", `fps=${(16 / duration).toFixed(5)},scale=${tileWidth}:-2,drawtext=text='%{pts\\:hms}':x=8:y=8:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.6,tile=4x4:padding=6:margin=6:color=0x12100e`, "-frames:v", "1", join(OUT, "sheets", `${name}.png`)]);
}

const scrollPose = async (page: Page, s: number) => {
  await page.evaluate(({ s }) => {
    const el = document.querySelector("[data-film-scroller]")!;
    el.scrollTop = Number(el.getAttribute("data-film-bottom")) * s;
  }, { s });
};

const STEPPED: Record<string, Stepped> = {
  "S1-phone-chat-scroll": {
    shows: "Phone: the Claude chat from the first message to the latest answer, one eased scroll, exact 60 fps",
    open: { pane: "api", phone: true, mods: { story: "after-plain" } }, seconds: 7, hold: [0.8, 1.2],
    notes: "mods.story after-plain (film S11 comes after the metric turn: \"Worked for 9s · 2 edits · 1 file read · 1 command\", as R10 recorded it, without its TodoWrite parts so no plan bar is pinned), its block folded",
    prepare: async (page) => { await fold(page, "last"); await primeScroller(page); await Bun.sleep(800); },
    pose: scrollPose,
  },
  "S2-desktop-chat-scroll": {
    shows: "Desktop 1280x800: the Claude chat from the first message to the latest answer, one eased scroll, exact 60 fps",
    open: { pane: "api", viewport: VIDEO_DESKTOP }, seconds: 6, hold: [0.8, 1.2],
    prepare: async (page) => { await primeScroller(page); await Bun.sleep(800); },
    pose: scrollPose,
  },
  "S3-desktop-chat-scroll-worked-open": {
    shows: "Desktop 1280x800: same scroll with the first \"Worked for 2m 36s\" block expanded (every folded command/edit passes by)",
    open: { pane: "api", viewport: VIDEO_DESKTOP }, seconds: 7, hold: [0.8, 1.2],
    prepare: async (page) => { await page.locator(".work-block-head").first().click(); await page.mouse.move(0, 0); await Bun.sleep(600); await primeScroller(page); await Bun.sleep(800); },
    pose: scrollPose,
  },
};

// ---- INDEX.md ----------------------------------------------------------------------------------

function writeIndex(): void {
  const lines = [
    "# Raw footage",
    "",
    "Made by `bun scripts/film/capture.ts` from the real client on the demo fixtures (`_site/demo/app/`),",
    "dark theme at 2x unless noted. Brand fonts (Pretendard Variable, JetBrains Mono) are installed for Chrome only.",
    "Recordings: `<name>.mp4` (constant 60 fps, x264 crf 12, yuv420p) and the raw take in `rec/<name>/`",
    "(`frames/*.jpg` screencast frames, `frames.json` paint times in s from the first frame, `cues.json` pointer/tap",
    "cues in viewport CSS px and s, `marks.json` key moments). Contact sheets in `sheets/`. No cursor is drawn.",
    "",
    "- R takes are live screencasts: Chrome paints 25-45 fps at 2x, so fast motion (scrolls, expands) is held",
    "  frame to frame in the 60 fps MP4. S takes are frame-stepped (the page posed and screenshotted 60 times",
    "  a second): exact 60 fps, for the scroll shots; their `rec/<name>/` holds PNG frames and a `frames.json` with",
    "  the per-frame `scrollTop` (checked monotonic) instead of paint times, and no `cues.json`.",
    "- Chrome runs with `--hide-scrollbars`: no scrollbar in any shot. The round \"jump to latest\" button over the",
    "  chat whenever it is scrolled away from the end is the app's own.",
    "- The demo's timing: a chat answer or a Codex turn is written 2.4 s / 2.6 s after sending, the status flips",
    "  at once, and the chat shows the new turn on its next 2 s poll, so DONE shows ~1.6 s before the answer paints.",
    "- mods (fixture edits, never app behaviour): `todo` (still 03, R11), `real` (R1b, R10), `worked` (R3, R6), `story` (below),",
    "  `stream` (R10: the turn in progress, step by step, while the answer is held); see each note.",
    "- filmHold (R10, R11, R12, R13): a setTimeout with an armed delay is kept until released. 4500 = the demo's end of the",
    "  Claude turn (R11 holds it: RUN all take), 2400 = the demo's chat answer (R10 holds it until \"released\").",
    "  Each take's note says what was held (`held {\"delay\": count}`); the app itself uses neither delay.",
    "- Scale: everything is 2x. 3x was tried for R10/R11 (FILM_SCALE=3): the screencast painted ~13 fps (the",
    "  brief's bar is 40), so they are 2x like the rest (~33-36 fps while anything moves). Crop limit: VW >= 960.",
    "- Marks: `rec/<name>/marks.json` (and the key moments below) are the timings of these files. The marks",
    "  quoted in brief.md section 5 were taken from an earlier capture run and no longer match; use these.",
    "- Counts: since f1ef2f8 a `TodoWrite` is not an edit, so R10's header reads \"Worked for 9s · 2 edits · 1 file read ·",
    "  1 command\" and the running turn of still 03 / R11 \"Working… · 1 edit · 1 file read\".",
    "- story (film continuity): the fixture opens between two moments of the film (the metric turn asked and running,",
    "  the Codex card open). `mods.story` sets the Claude chat to the film's moment: opening (R12: the first task running),",
    "  before (R2: first task done, nothing asked; R10's `real` does the same), after (R4, R5, S1-phone: the metric turn",
    "  done as R10 recorded it) and next (R13: after, plus the next ask running). Takes after S8 answer the Codex card",
    "  before recording. R11 (hero loop, a standalone asset) keeps the demo's own opening state.",
    "- App bug seen while framing: the plan bar (`.todo-panel`, sticky bottom inside the chat scroller) leaves the",
    "  scroller's bottom padding uncovered, so text scrolled under the bar shows in a strip between it and the status",
    "  line (also in /demo/). R11 is recorded tall enough that nothing scrolls; other takes keep the chat at its end.",
    "- DO NOT USE: R1 (demo \"nothing ran\" answer), R9 (agent-pane terminal notice). R1b is superseded by R10.",
    "- Pane ids: api=w1C:p1 (Claude), web=w1D:p1 (Codex), infra=w1E:p1 (gjc), docs=w1F:p1 (omo), shell=w1G:p1.",
    "",
    "## Stills",
    "",
    "| File | Shows | Resolution | Notes |",
    "|------|-------|------------|-------|",
    ...Object.values(manifest).filter((e) => e.kind === "still").sort((a, b) => a.file.localeCompare(b.file)).map((e) => `| \`${e.file}\` | ${e.shows} | ${e.resolution} | ${e.notes ?? ""} |`),
    "",
    "## Recordings",
    "",
  ];
  for (const e of Object.values(manifest).filter((e) => e.kind === "recording").sort((a, b) => a.file.localeCompare(b.file))) {
    const name = e.file.replace(/\.mp4$/, "");
    lines.push(`### ${name}`, "", `- File: \`${e.file}\` · raw: \`rec/${name}/\` · sheet: \`sheets/${name}.png\``, `- Shows: ${e.shows}`, `- ${e.duration}s, ${e.resolution}`);
    if (e.marks?.length) lines.push(`- Key moments: ${e.marks.map((m) => `${m.label} @ ${m.t.toFixed(2)}s`).join("; ")}`);
    if (e.notes) lines.push(`- Note: ${e.notes}`);
    lines.push("");
  }
  writeFileSync(join(OUT, "INDEX.md"), lines.join("\n"));
}

// ---- run ---------------------------------------------------------------------------------------

try {
  if (args.length === 0 || args.includes("stills") || args.some((a) => /^\d\d/.test(a))) {
    await stills();
  }
  for (const [name, take] of Object.entries(TAKES)) {
    const short = name.split("-")[0]!;
    if (args.length === 0 || args.includes("rec") || args.includes(name) || args.includes(short)) await record(name, take);
  }
  for (const [name, take] of Object.entries(STEPPED)) {
    const short = name.split("-")[0]!;
    if (args.length === 0 || args.includes("stepped") || args.includes(name) || args.includes(short)) await stepped(name, take);
  }
  writeIndex();
} finally {
  for (const browser of browsers.values()) await browser.close();
  server.stop();
}
process.exit(0);
