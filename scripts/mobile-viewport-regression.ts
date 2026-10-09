import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright-core";

type ViewportQA = Window & { viewportQA: { resize: (height: number) => void; pointer: (touch: boolean) => void } };

/** Real DOM/focus lifecycle with controlled browser APIs; this does not emulate an iOS keyboard or status bar. */
export async function checkMobileViewport(browser: Browser, origin: string, paneId: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
  try {
    await context.addInitScript(() => {
      const viewport = window.visualViewport!;
      let height = 795; // a standalone app's idle visual viewport can exclude its status bar
      Object.defineProperty(viewport, "height", { get: () => height });
      const query = "(pointer: coarse)";
      let touch = true;
      const media = new EventTarget();
      Object.defineProperty(media, "matches", { get: () => touch });
      const matchMedia = window.matchMedia.bind(window);
      window.matchMedia = (value) => value === query ? media as MediaQueryList : matchMedia(value);
      (window as ViewportQA).viewportQA = {
        resize: (value) => { height = value; viewport.dispatchEvent(new Event("resize")); },
        pointer: (value) => { touch = value; media.dispatchEvent(new MediaQueryListEvent("change", { matches: value, media: query })); },
      };
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`);
    await page.locator(".conn-live").waitFor();
    await page.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    await composer.waitFor();
    const blur = () => page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); });
    const height = (value: number) => page.evaluate((value) => (window as ViewportQA).viewportQA.resize(value), value);
    const shell = async (keyboard: boolean, appHeight: string, pixels: number) => {
      try {
        await page.waitForFunction(({ keyboard, appHeight, pixels }) => {
          const root = document.documentElement;
          return root.hasAttribute("data-keyboard") === keyboard
            && root.style.getPropertyValue("--app-height") === appHeight
            && Math.round(document.querySelector(".app")!.getBoundingClientRect().height) === pixels;
        }, { keyboard, appHeight, pixels }, { timeout: 5_000 });
      } catch (cause) {
        const actual = await page.evaluate(() => ({ keyboard: document.documentElement.hasAttribute("data-keyboard"),
          appHeight: document.documentElement.style.getPropertyValue("--app-height"), pixels: document.querySelector(".app")?.getBoundingClientRect().height,
          active: document.activeElement?.className, touch: window.matchMedia("(pointer: coarse)").matches, visualHeight: window.visualViewport?.height }));
        throw new Error(`Viewport expected ${JSON.stringify({ keyboard, appHeight, pixels })}; observed ${JSON.stringify(actual)}`, { cause });
      }
    };

    await blur();
    await shell(false, "", 844);
    await height(780);
    await shell(false, "", 844);
    // focused with the keyboard down (back from a dictation app, or closed by its own key):
    // no keyboard sizing, so no status-bar band under the composer
    await composer.focus();
    await shell(false, "", 844);
    await height(500);
    await shell(true, "500px", 500);
    await height(795);
    await shell(false, "", 844);
    await height(500);
    await shell(true, "500px", 500);
    // The delayed focusout check must see the next text field, not clear the keyboard flag.
    await page.evaluate(() => {
      const next = document.createElement("input");
      next.id = "qa-next-field";
      next.type = "password";
      document.body.append(next);
      next.focus();
    });
    await page.waitForTimeout(20);
    await shell(true, "500px", 500);
    await blur();
    await shell(false, "", 844);
    await page.locator("#qa-next-field").evaluate((node) => node.remove());
    // WebKit need not report focusout when a focused field leaves the page with its pane:
    // the keyboard closing (a viewport resize) must still clear keyboard sizing.
    await page.evaluate(() => {
      const field = document.createElement("textarea");
      document.body.append(field);
      field.focus();
    });
    await shell(true, "500px", 500);
    await page.evaluate(() => {
      const swallow = (event: Event) => event.stopImmediatePropagation();
      window.addEventListener("focusout", swallow, { capture: true });
      document.activeElement!.remove();
      window.removeEventListener("focusout", swallow, { capture: true });
    });
    await height(795);
    await shell(false, "", 844);
    await height(500);
    // Rotation without a keyboard uses the dynamic viewport even if visualViewport differs.
    await page.setViewportSize({ width: 844, height: 390 });
    await height(365);
    await shell(false, "", 390);
    await page.setViewportSize({ width: 390, height: 844 });
    await height(500);

    await page.getByTitle("Live terminal (⌘⇧J)", { exact: true }).click();
    const terminal = page.locator(".xterm-helper-textarea");
    await terminal.focus();
    await shell(false, "", 844);
    const direct = page.getByRole("button", { name: "Type straight into the terminal", exact: true });
    await direct.click();
    await page.locator("[data-direct-typing]").waitFor();
    await shell(true, "500px", 500);
    if (process.env.UI_EVIDENCE_DIR) {
      mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "viewport-direct-typing.png") });
    }
    await direct.click();
    await shell(false, "", 844);
    await page.getByRole("textbox", { name: "Terminal input line", exact: true }).focus();
    await shell(true, "500px", 500);
    await blur();
    await shell(false, "", 844);

    await page.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
    await composer.focus();
    await shell(true, "500px", 500);
    // Switching to a hardware pointer must clear sizing even when the text field keeps focus.
    await page.evaluate(() => (window as ViewportQA).viewportQA.pointer(false));
    await shell(false, "", 844);
    await page.evaluate(() => (window as ViewportQA).viewportQA.pointer(true));
    await shell(true, "500px", 500);
    await blur();
    await height(795);
    await shell(false, "", 844);
    if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "viewport-idle.png") });
    assert.deepEqual(errors, []);
    console.log("PASS viewport contract: idle, keyboard resize, field handoff, blur, rotation, xterm modes and pointer changes");
  } finally { await context.close(); }
}
