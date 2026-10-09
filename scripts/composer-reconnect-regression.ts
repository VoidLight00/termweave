import assert from "node:assert/strict";
import type { Browser, WebSocketRoute } from "playwright-core";

/**
 * A phone's dictation keyboard (Typeless, Wispr Flow, ...) opens its own app to start the
 * microphone and comes straight back. The app was in the background meanwhile, so its socket
 * may have dropped. The message box must keep its focus and take the dictated text while the
 * socket reconnects: a disabled box loses focus, and the keyboard's text goes nowhere.
 */
export async function checkComposerReconnect(browser: Browser, origin: string, paneId: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
  try {
    await context.addInitScript((pane) => {
      localStorage.setItem("termweave:settings", JSON.stringify({ language: "en" }));
      localStorage.setItem(`termweave:view:${pane}`, "chat");
    }, paneId);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // the socket the page has now, and whether a new one is let through to the server yet
    let live: WebSocketRoute | null = null;
    let admit = true;
    await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
      if (!admit) { void socket.close(); return; }
      socket.connectToServer();
      live = socket;
    });
    await page.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`);
    await page.locator(".conn-live").waitFor();
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    await composer.tap();
    await composer.fill("dictated ");
    // off to the keyboard's app and back: the socket dropped, and the next one is slow
    admit = false;
    await live!.close();
    await page.waitForFunction(() => document.querySelector(".conn-live") === null);
    assert.equal(await composer.isDisabled(), false, "the message box stays editable while reconnecting");
    assert.equal(await composer.evaluate((el) => el === document.activeElement), true, "and keeps its focus");
    await page.keyboard.insertText("while reconnecting");
    assert.equal(await composer.inputValue(), "dictated while reconnecting");
    // nothing is sent until the socket is back
    await page.keyboard.press("Enter");
    assert.equal(await composer.inputValue(), "dictated while reconnecting", "Enter sends nothing while offline");
    admit = true;
    await page.locator(".conn-live").waitFor();
    assert.equal(await composer.inputValue(), "dictated while reconnecting", "the draft survives the reconnect");
    await composer.fill("");
    assert.deepEqual(errors, []);
    console.log("PASS the message box keeps its focus and takes dictated text while the socket reconnects");
  } finally {
    await context.close();
  }
}
