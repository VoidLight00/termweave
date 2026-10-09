/**
 * Regenerates the README media in docs/screenshots from a staged demo session (stage.ts):
 * stills in a browser window or a phone (transparent PNGs), and a desktop and a phone
 * walkthrough, recorded at 2x (record.ts) and composed with a camera, a cursor and taps
 * (compose.ts) into MP4 and GIF. Needs ffmpeg.
 *
 *   bun run build && bun scripts/readme-media/capture.ts [shots] [video]
 */
import { stage } from "./stage.ts";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Recorder } from "./record.ts";
import { closeCompositor, composeStill, composeVideo } from "./compose.ts";
const { herdrRpc } = await import("../../server/herdr/client.ts");

const OUT = join(import.meta.dir, "../../docs/screenshots");
const what = process.argv.slice(2);
const want = (part: string) => what.length === 0 || what.includes(part);
mkdirSync(OUT, { recursive: true });
const demo = await stage();
// headless screencasts come at 1x unless the whole browser renders at 2x
const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox", "--force-device-scale-factor=2"] });
const views = Object.fromEntries(demo.panes.map((x) => ["herdr-web-ui:view:" + x.pane, x.agent ? "chat" : "terminal"]));
const DESKTOP = { width: 1440, height: 900 };
const VIDEO_DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

async function open(key: string, viewport: { width: number; height: number }, phone: boolean): Promise<{ context: BrowserContext; page: Page }> {
  await demo.reset();
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: "dark", ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  const page = await context.newPage();
  await demo.routes(page);
  await page.addInitScript((items) => { for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v as string); }, views);
  await page.goto(`${demo.base}/?pane=${encodeURIComponent(demo.pane(key).pane)}`);
  await Bun.sleep(4000);
  return { context, page };
}

async function shots() {
  await herdrRpc("pane.send_text", { pane_id: demo.pane("shell").pane, text: `git log --oneline --graph --decorate --color=always | cat && bun test\n` });
  const shot = async (name: string, key: string, phone: boolean, then?: (page: Page) => Promise<void>) => {
    const viewport = phone ? PHONE : DESKTOP;
    const { context, page } = await open(key, viewport, phone);
    await then?.(page);
    await composeStill(await page.screenshot(), phone ? "phone" : "window", { w: viewport.width, h: viewport.height }, join(OUT, `${name}.png`));
    await context.close();
  };
  await shot("desktop-chat", "api", false);
  await shot("desktop-terminal", "shell", false);
  await shot("desktop-prompt", "web", false);
  await shot("mobile-chat", "api", true);
  await shot("mobile-terminal", "shell", true);
  await shot("mobile-sessions", "api", true, async (page) => { await page.locator(".drawer-toggle").tap(); await Bun.sleep(800); });
}

const row = (key: string) => `.pane-select[title^="${demo.pane(key).pane} "]`;

async function desktopVideo() {
  const { context, page } = await open("api", VIDEO_DESKTOP, false);
  const hand = new Recorder(page, VIDEO_DESKTOP.width, VIDEO_DESKTOP.height);
  await hand.begin();
  await Bun.sleep(1400);
  // the folded work of a turn: look closer, open it
  const work = await hand.center(".work-block-head");
  hand.camera(1.45, work.x + 260, work.y + 120);
  await Bun.sleep(500);
  await hand.click(".work-block-head"); await Bun.sleep(1900);
  hand.camera(1);
  await hand.moveTo(900, 420); await page.mouse.wheel(0, -260); await Bun.sleep(1100);
  // Codex asks: answer it from the chat
  await hand.click(row("web")); await hand.moveTo(760, 300, 450); await Bun.sleep(500);
  const card = await hand.center(".prompt-card");
  hand.camera(1.5, card.x, card.y);
  await Bun.sleep(1100);
  await hand.click(".prompt-card-options button"); await Bun.sleep(1300);
  hand.camera(1);
  // the real terminal, typed into
  await hand.click(row("shell")); await hand.moveTo(1040, 620, 450); await Bun.sleep(500);
  // the terminal's top left (the prompt of a fresh pane) just inside the view, where the output will run
  const screen = (await page.locator(".xterm-screen").boundingBox())!;
  const zoom = 1.55;
  hand.camera(zoom, screen.x - 16 + VIDEO_DESKTOP.width / zoom / 2, screen.y - 16 + VIDEO_DESKTOP.height / zoom / 2);
  await Bun.sleep(700);
  await page.keyboard.type("git tag --list && bun test", { delay: 55 }); await page.keyboard.press("Enter"); await Bun.sleep(2200);
  hand.camera(1);
  await Bun.sleep(600);
  // jump anywhere from the palette
  await page.keyboard.press("Control+Shift+K"); await Bun.sleep(700);
  await page.keyboard.type("backup", { delay: 90 }); await Bun.sleep(600); await page.keyboard.press("Enter"); await Bun.sleep(2200);
  const recording = await hand.end();
  await context.close();
  await composeVideo(recording, "window", { mp4: join(OUT, "demo-desktop.mp4"), gif: join(OUT, "demo-desktop.gif"), gifWidth: 880 });
}

async function phoneVideo() {
  const { context, page } = await open("api", PHONE, true);
  const hand = new Recorder(page, PHONE.width, PHONE.height);
  await hand.begin();
  await Bun.sleep(1200);
  await hand.drag(200, 380, 700); await Bun.sleep(1200);                 // read back
  await hand.tap(".drawer-toggle"); await Bun.sleep(1300);               // every agent
  await hand.tap(row("web")); await Bun.sleep(2000);                     // Codex asks
  await hand.tap(".prompt-card-options button"); await Bun.sleep(1600);
  await hand.tap(".drawer-toggle"); await Bun.sleep(1000);
  await hand.tap(row("shell")); await Bun.sleep(1400);                   // the terminal, with a key bar
  await herdrRpc("pane.send_text", { pane_id: demo.pane("shell").pane, text: `git log --oneline --graph --decorate --color=always | cat\n` }); await Bun.sleep(1800);
  await hand.tap(".drawer-toggle"); await Bun.sleep(900);
  await hand.tap(row("api")); await Bun.sleep(1400);
  await hand.tap(".composer-text"); await page.keyboard.type("Ship it, then tag v1.4.1", { delay: 60 }); await Bun.sleep(1600);
  const recording = await hand.end();
  await context.close();
  await composeVideo(recording, "phone", { mp4: join(OUT, "demo-mobile.mp4"), gif: join(OUT, "demo-mobile.gif"), gifWidth: 320 });
}

try {
  if (want("shots")) await shots();
  if (want("video")) { await desktopVideo(); await phoneVideo(); }
} finally {
  await browser.close();
  await closeCompositor();
  await demo.teardown();
}
process.exit(0);
