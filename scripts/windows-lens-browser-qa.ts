import { chromiumExecutable } from './browser.ts';
/** What a PC without terminal attach (Windows, herdrdev/herdr#4821) looks like in the browser:
 * the server answers as a Windows herdr would (`terminalAttach: false`) over a real pane of
 * the test herdr, and the terminal lens shows that pane's screen, mirrored. A grid that is not
 * the browser's own (a mirror's, an observer's) must pan to every cell on a small screen. Run after
 * `bun run build`; UI_EVIDENCE_DIR saves screenshots. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import { workspaceCreate, workspaceClose } from "../server/herdr/client.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-winlens-"));
const evidence = process.env["UI_EVIDENCE_DIR"];
if (evidence) mkdirSync(evidence, { recursive: true });
const workspaces: string[] = [];
let server: ReturnType<typeof createServer> | undefined;
let attachServer: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

async function until(done: () => Promise<boolean>, label: string, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await done()) return; await Bun.sleep(100); }
  throw new Error(`Timed out: ${label}`);
}
const screen = (page: Page) => page.locator(".xterm-rows").innerText();

/** Where `text` sits against the terminal mount: each side's distance inside it, negative when cut off. */
const inset = (page: Page, text: string) => page.evaluate((needle) => {
  const host = document.querySelector(".pane-terminal");
  const rows = host?.querySelector(".xterm-rows");
  if (!host || !rows) return null;
  const box = host.getBoundingClientRect();
  const walker = document.createTreeWalker(rows, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const at = node.data.indexOf(needle);
    if (at < 0) continue;
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + needle.length);
    const rect = range.getBoundingClientRect();
    return { left: rect.left - box.left, right: box.left + host.clientWidth - rect.right, top: rect.top - box.top, bottom: box.top + host.clientHeight - rect.bottom };
  }
  return null;
}, text);
const shown = (at: Awaited<ReturnType<typeof inset>>): boolean => at !== null && Math.min(at.left, at.right, at.top, at.bottom) > -1;
const scrollOf = (page: Page) => page.evaluate(() => {
  const host = document.querySelector(".pane-terminal")!;
  return { left: host.scrollLeft, top: host.scrollTop, width: host.scrollWidth - host.clientWidth, height: host.scrollHeight - host.clientHeight, adopted: host.hasAttribute("data-adopted-grid") };
});
/** One finger dragged across the terminal, as real touch events (CDP), from the middle of the mount. */
async function drag(page: Page, dx: number, dy: number): Promise<void> {
  const box = (await page.locator(".pane-terminal").boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const x = box.x + box.width / 2 - dx / 2;
  const y = box.y + box.height / 2 - dy / 2;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let step = 1; step <= 10; step++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + dx * step / 10, y: y + dy * step / 10 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}
/** Drags until `done`, a few times at most: one drag is shorter than a wide grid. */
async function dragUntil(page: Page, dx: number, dy: number, done: () => Promise<boolean>, label: string): Promise<void> {
  for (let tries = 0; tries < 8 && !(await done()); tries++) await drag(page, dx, dy);
  assert.equal(await done(), true, label);
}

try {
  const cwd = join(root, "pane"); mkdirSync(cwd);
  const created = await workspaceCreate({ cwd, label: "herdr-web-ui-test-winlens" });
  workspaces.push(created.workspace.workspace_id);
  const paneId = created.root_pane.pane_id;
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), terminalAttach: false });
  const origin = `http://127.0.0.1:${server.port}`;
  const health = await (await fetch(`${origin}/api/health`)).json() as { herdr: { terminal_attach?: boolean; terminal_mirror?: boolean } };
  assert.deepEqual([health.herdr.terminal_attach, health.herdr.terminal_mirror], [false, true]);
  browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(10_000);
  await page.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`);
  const terminal = page.getByRole("button", { name: /^Terminal/ });
  await terminal.waitFor();
  assert.equal(await terminal.getAttribute("aria-pressed"), "true", "a shell pane opens in the terminal lens");
  assert.equal(await terminal.locator(".pill-soon").count(), 0, "no soon pill: the lens works");
  assert.equal(await page.locator(".terminal-banner-soon").count(), 0);
  // typed in the page, run by the pane's shell, read back from herdr's screen
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("echo mirror-ok-$((40+2))");
  await page.keyboard.press("Enter");
  await until(async () => (await screen(page)).includes("mirror-ok-42"), "the command's output reaches the mirrored terminal");
  // colour survives: herdr's read keeps the escape sequences
  await page.keyboard.type("printf '\\033[31mred-cell\\033[0m\\n'");
  await page.keyboard.press("Enter");
  await until(async () => await page.locator(".xterm-rows span[class*='xterm-fg-1']", { hasText: "red-cell" }).count() > 0, "a red cell is painted red");
  if (evidence) await page.screenshot({ path: join(evidence, "windows-mirror-desktop.png") });
  console.log("PASS the terminal lens of a PC without attach shows the pane's screen, typed input included");

  // the chat lens and back: the mirror is still there, and the grid is the pane's own
  await page.getByRole("button", { name: /^Chat/ }).click();
  await terminal.click();
  await until(async () => (await screen(page)).includes("mirror-ok-42"), "the screen is back after a lens switch");
  console.log("PASS the mirrored screen survives a lens switch");

  // a screen that fills the pane: a line that ends in the grid's last column, and the prompt on its last row
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("for i in $(seq 1 60); do echo hist-$i; done; printf '%*s\\n' $COLUMNS right-edge");
  await page.keyboard.press("Enter");
  await page.keyboard.type("tail-marker");
  await until(async () => /right-edge[\s\S]*tail-marker/.test(await screen(page)), "the full screen reaches the mirrored terminal");

  // #230: the grid is the pane's own, wider and taller than a phone. Every cell can be reached.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const small = await phone.newPage();
  small.on("pageerror", (error) => errors.push(error.message));
  small.setDefaultTimeout(10_000);
  await small.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`);
  await until(async () => (await screen(small)).includes("tail-marker"), "a second, phone-sized viewer gets the current screen");
  if (evidence) await small.screenshot({ path: join(evidence, "windows-mirror-phone.png") });
  console.log("PASS a phone-sized second viewer sees the same screen");
  await until(async () => shown(await inset(small, "tail-marker")), "the view opens on the rows with the prompt");
  assert.equal(shown(await inset(small, "right-edge")), false, "the grid is wider than the phone");
  await dragUntil(small, -300, 0, async () => shown(await inset(small, "right-edge")), "a drag to the left brings the last column in");
  assert.equal(shown(await inset(small, "tail-marker")), false, "the prompt's start went out to the left");
  if (evidence) await small.screenshot({ path: join(evidence, "windows-mirror-phone-panned-right.png") });
  const right = await scrollOf(small);
  assert.equal(Math.abs(right.left - right.width) <= 1, true, "panned to the grid's right edge");
  await dragUntil(small, 300, 300, async () => { const at = await scrollOf(small); return at.left === 0 && at.top === 0; }, "a drag back reaches the first row and column");
  if (evidence) await small.screenshot({ path: join(evidence, "windows-mirror-phone-panned-top.png") });
  if (right.height > 0) assert.equal(shown(await inset(small, "tail-marker")), false, "at the top the last row is below the mount");
  await dragUntil(small, 0, -300, async () => shown(await inset(small, "tail-marker")), "a drag up brings the last row back");
  assert.equal(await small.evaluate(() => document.documentElement.scrollWidth <= innerWidth && scrollY === 0), true, "the page itself never scrolls");
  console.log("PASS on a phone a drag pans a mirrored grid to its last column and its last row");
  await phone.close();

  // a small desktop window: the wheel pans, and a scrollbar is there
  const narrow = await browser.newContext({ viewport: { width: 700, height: 420 } });
  const windowed = await narrow.newPage();
  windowed.on("pageerror", (error) => errors.push(error.message));
  await windowed.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`);
  await until(async () => shown(await inset(windowed, "tail-marker")), "a small window opens on the prompt's row");
  await windowed.locator(".pane-terminal").hover();
  await windowed.mouse.wheel(4000, 0);
  await until(async () => shown(await inset(windowed, "right-edge")), "the wheel pans to the last column");
  if (evidence) await windowed.screenshot({ path: join(evidence, "windows-mirror-small-window.png") });
  await windowed.mouse.wheel(-4000, -4000);
  await until(async () => { const at = await scrollOf(windowed); return at.left === 0 && at.top === 0; }, "the wheel pans back to the first cell");
  console.log("PASS in a small desktop window the wheel pans a mirrored grid");
  await narrow.close();

  // A herdr that attaches: an interact client's grid is its own and fits, so nothing pans and a
  // vertical drag still scrolls herdr's history. An observer adopts the operator's grid and pans it.
  const second = await workspaceCreate({ cwd, label: "herdr-web-ui-test-winlens-attach" });
  workspaces.push(second.workspace.workspace_id);
  const attached = second.root_pane.pane_id;
  attachServer = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state-attach") });
  const attachOrigin = `http://127.0.0.1:${attachServer.port}`;
  const own = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const mine = await own.newPage();
  mine.on("pageerror", (error) => errors.push(error.message));
  mine.setDefaultTimeout(10_000);
  await mine.goto(`${attachOrigin}/?pane=${encodeURIComponent(attached)}`);
  const line = mine.getByRole("textbox", { name: "Terminal input line", exact: true });
  await line.fill("for i in $(seq 1 200); do echo hist-$i; done");
  await line.press("Enter");
  await until(async () => (await screen(mine)).includes("hist-200"), "the attached pane's output");
  const fitted = await scrollOf(mine);
  assert.deepEqual([fitted.adopted, fitted.width, fitted.height], [false, 0, 0], "a grid of this browser's own fits: nothing to pan");
  assert.equal(await mine.locator(".pane-terminal").evaluate((host) => getComputedStyle(host).overflow), "hidden");
  await dragUntil(mine, 0, 300, async () => !(await screen(mine)).includes("hist-200"), "a drag down still scrolls herdr's history");
  assert.deepEqual(await scrollOf(mine), fitted, "and pans nothing");
  if (evidence) await mine.screenshot({ path: join(evidence, "attach-phone-history.png") });
  console.log("PASS a phone's own grid fits as before, and a drag scrolls herdr's history");
  await own.close();

  const operator = await context.newPage();
  operator.on("pageerror", (error) => errors.push(error.message));
  await operator.goto(`${attachOrigin}/?pane=${encodeURIComponent(attached)}`);
  // typed before the terminal is attached, it would be held as a draft
  await operator.locator(".conn-live").waitFor();
  await until(async () => (await screen(operator)).includes("hist-"), "the operator's terminal is attached");
  await operator.locator(".xterm-helper-textarea").focus();
  await operator.keyboard.type("clear; for i in $(seq 1 60); do echo hist-$i; done; printf '%*s\\n' $COLUMNS right-edge");
  await operator.keyboard.press("Enter");
  await until(async () => (await screen(operator)).includes("right-edge"), "the operator's screen");
  const watch = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const observer = await watch.newPage();
  observer.on("pageerror", (error) => errors.push(error.message));
  observer.setDefaultTimeout(10_000);
  // the app has no control for the role: the role frame its socket opens with is sent as an observer's
  await observer.routeWebSocket(/\/ws(\?|$)/, (socket) => {
    const upstream = socket.connectToServer();
    socket.onMessage((message) => {
      const role = typeof message === "string" && (JSON.parse(message) as { type?: string }).type === "role";
      upstream.send(role ? JSON.stringify({ type: "role", mode: "observe" }) : message);
    });
  });
  await observer.goto(`${attachOrigin}/?pane=${encodeURIComponent(attached)}`);
  await observer.locator(".terminal-banner-observe").waitFor();
  await until(async () => (await screen(observer)).includes("right-edge"), "the observer gets the operator's screen");
  await until(async () => (await scrollOf(observer)).adopted, "the observer's mount pans");
  if (evidence) await observer.screenshot({ path: join(evidence, "observe-phone.png") });
  // the cursor's row (the operator's prompt) is what the view opens on
  await until(() => observer.locator(".xterm-cursor").first().evaluate((cursor) => {
    const host = document.querySelector(".pane-terminal")!.getBoundingClientRect();
    const at = cursor.getBoundingClientRect();
    return at.top >= host.top - 1 && at.bottom <= host.bottom + 1;
  }), "an observer's view opens on the cursor's row");
  assert.equal(shown(await inset(observer, "right-edge")), false, "the operator's grid is wider than the phone");
  await dragUntil(observer, -300, 0, async () => shown(await inset(observer, "right-edge")), "an observer pans to the operator's last column");
  if (evidence) await observer.screenshot({ path: join(evidence, "observe-phone-panned-right.png") });
  await dragUntil(observer, 300, 300, async () => { const at = await scrollOf(observer); return at.left === 0 && at.top === 0; }, "and back to the first cell");
  console.log("PASS an observer on a phone pans the operator's grid");
  await watch.close();
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  server?.stop();
  attachServer?.stop();
  for (const id of workspaces) await workspaceClose(id);
  rmSync(root, { recursive: true, force: true });
}
