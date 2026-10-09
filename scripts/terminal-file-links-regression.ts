import { chromiumExecutable } from './browser.ts';
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { paneSendText, workspaceCreate, workspaceClose } from "../server/herdr/client.ts";

const cwd = process.cwd();
const fixtureRoot=mkdtempSync(join(process.env.TERMWEAVE_TEST_ROOT!,"l"));const fixture=join(fixtureRoot,"f.txt");writeFileSync(fixture,"synthetic fixture content");mkdirSync(join(fixtureRoot,"scripts"));writeFileSync(join(fixtureRoot,"scripts/test-herdr.ts"),"synthetic script");writeFileSync(join(fixtureRoot,"README.md"),"synthetic readme");const shortUri="./f.txt";
const workspace = await workspaceCreate({ cwd:fixtureRoot, label: "herdr-web-ui-test-file-links" });
const pane = workspace.root_pane.pane_id;
// its own state dir: the default is the user's real devices and push registry
const stateDir = mkdtempSync(join(tmpdir(), "herdr-file-links-"));
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir });
  browser = await chromium.launch({
    executablePath: chromiumExecutable(),
    headless: true,
  });
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: width === 390, isMobile: width === 390 });
    await context.addInitScript((id) => {localStorage.setItem(`termweave:view:${id}`, "terminal");localStorage.setItem("termweave:settings",JSON.stringify({language:"en",terminalInputMode:"direct"}));}, pane);
    const page = await context.newPage();let ready=false;page.on("websocket",socket=>socket.on("framereceived",({payload})=>{try{const m=JSON.parse(String(payload));if(m.type==="input-ready"&&m.pane_id===pane)ready=true;}catch{}}));const reads:string[]=[];page.on("request",request=>{if(request.url().includes("/api/file"))reads.push(request.url());});
    page.setDefaultTimeout(15_000);
    await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`);
    await page.locator(".conn-live").waitFor();
    await page.waitForFunction(()=>document.querySelector(".xterm-screen")?.getBoundingClientRect().width!>200);
    const deadline=Date.now()+15000;while(!ready&&Date.now()<deadline)await Bun.sleep(20);assert.equal(ready,true);
    await paneSendText(pane,"stty cols 160; PS1=synthetic; PROMPT=synthetic\r");
    await page.waitForTimeout(300);
    await page.locator(".xterm-helper-textarea").focus();await page.keyboard.type(`PS1="synthetic> "; PROMPT="synthetic> "; printf '\\033[2J\\033[HFILELINK ${shortUri}\\n'\r`);
    const row = page.locator(".xterm-rows > div", { hasText: /^FILELINK \.\// }).first();
    await row.waitFor();
    await page.waitForFunction(uri=>document.querySelector(".xterm-rows")?.textContent?.includes(uri),shortUri);
    await page.waitForFunction(uri => document.querySelector(".xterm-rows")?.textContent?.includes(uri),shortUri);
    const span = row.locator("span").filter({ hasText: "./f.txt" }).first();
    const box = await span.boundingBox();
    assert.ok(box);
    // The output's prefix is nine cells; xterm links use character-cell coordinates.
    const rowBox = await row.boundingBox();
    assert.ok(rowBox);
    const cols = await row.evaluate((el) => el.textContent?.length ?? 0);
    assert.ok(cols > 0);
    const cellWidth = await row.evaluate((el) => {
      const range = document.createRange();
      const text = el.querySelector("span")?.firstChild;
      if (!text) throw new Error("missing terminal text");
      range.setStart(text, 0); range.setEnd(text, 1);
      return range.getBoundingClientRect().width;
    });
    if (width === 390) {
      await page.touchscreen.tap(rowBox.x + cellWidth * 10.5, rowBox.y + rowBox.height / 2);
    } else {
      await page.mouse.move(rowBox.x + cellWidth * 10.5, rowBox.y + rowBox.height / 2);
      await page.waitForFunction(() => document.querySelector(".xterm-cursor-pointer") !== null);
      await page.mouse.click(rowBox.x + cellWidth * 10.5, rowBox.y + rowBox.height / 2);
    }
    await page.locator(".file-viewer").waitFor();
    console.log(`VIEWER ${width}: ${await page.locator(".file-viewer").innerText()}`);
    writeFileSync(join(process.env.DOCK_EVIDENCE!,"file-link-diagnostic.txt"),JSON.stringify({viewer:await page.locator(".file-viewer").innerText(),reads,uri:shortUri},null,2));await page.locator(".file-viewer-text").waitFor();
    assert.match(await page.locator(".file-viewer-text").innerText(), /synthetic fixture content/);
    if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.UI_EVIDENCE_DIR}/terminal-file-link-${width}.png` });
    console.log(`PASS terminal file click opens viewer at ${width}px`);
    if (width === 1280) {
      await page.locator(".file-viewer-header button").last().click();
      await page.locator(".file-viewer").waitFor({ state: "hidden" });
      // one row with a path and a bare name: `MIXED ` is six cells, the path the next 21, the name from cell 28
      await paneSendText(pane, `printf '\\033[2J\\033[HMIXED scripts/test-herdr.ts README.md\\n'\r`);
      const mixed = page.locator(".xterm-rows > div", { hasText: /^MIXED scripts\// }).first();
      await mixed.waitFor();
      const mixedBox = await mixed.boundingBox();
      assert.ok(mixedBox);
      const y = mixedBox.y + mixedBox.height / 2;
      const pointer = (shown: boolean) => page.waitForFunction((want) => (document.querySelector(".xterm-cursor-pointer") !== null) === want, shown);
      // off the row first, so xterm reads its links anew; its pointer says when it has
      await page.mouse.move(mixedBox.x + cellWidth * 10.5, mixedBox.y + mixedBox.height * 6.5);
      await pointer(false);
      await page.mouse.move(mixedBox.x + cellWidth * 10.5, y);
      await pointer(true);
      // A bare name is what a terminal is full of: it is no link, so the pointer goes and a
      // click opens nothing.
      await page.mouse.move(mixedBox.x + cellWidth * 31.5, y);
      await pointer(false);
      await page.mouse.click(mixedBox.x + cellWidth * 31.5, y);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))));
      assert.equal(await page.locator(".file-viewer").count(), 0, "a bare file name in the terminal opened the file viewer");
      console.log("PASS a path with a folder is a link and a bare name beside it stays text");
    }
    await context.close();
  }
} finally {
  try {
    await browser?.close();
  } finally {
    try {
      server?.stop();
    } finally {
      await workspaceClose(workspace.workspace.workspace_id);
      rmSync(stateDir, { recursive: true, force: true });rmSync(fixtureRoot,{recursive:true,force:true});
    }
  }
}
