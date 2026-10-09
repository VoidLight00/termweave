import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { herdrRpc, paneRead, paneSendKeys, paneSendText, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

/**
 * The chat lens leaves the shared terminal's size alone (#361): a desktop tab drives a pane's grid
 * from its terminal lens, a phone opens the same pane in the chat lens, and the program in the pane
 * still sees the desktop's size. Switching the phone to its terminal lens fits the grid to the phone.
 * The size is the one the pane's own shell reports (`stty size`), not what either browser thinks.
 */
export async function checkChatKeepsTerminalSize(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-chat-size-"));
  const cwd = join(root, "pane");
  mkdirSync(cwd);
  const created = await workspaceCreate({ cwd, label: "herdr-web-ui-test-chat-size" });
  const paneId = created.root_pane.pane_id;
  const contexts: BrowserContext[] = [];
  try {
    // an agent pane opens in the chat lens on a phone; the shell under it answers `stty size`
    await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "claude", state: "idle" });
    let asked = 0;
    const size = async (): Promise<string> => {
      const marker = `size-${++asked}`;
      await paneSendText(paneId, `echo ${marker} $(stty size)`);
      await paneSendKeys(paneId, ["Enter"]);
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const text = (await paneRead({ paneId, source: "recent", lines: 80, stripAnsi: true })).text;
        const found = [...text.matchAll(new RegExp(`^${marker} (\\d+ \\d+)\\s*$`, "gm"))].at(-1);
        if (found) return found[1]!;
        await Bun.sleep(100);
      }
      throw new Error(`no ${marker} answer from the pane`);
    };
    const open = async (options: Parameters<Browser["newContext"]>[0], settings: object): Promise<Page> => {
      const context = await browser.newContext({ locale: "en-US", ...options });
      contexts.push(context);
      await context.addInitScript((stored) => {
        localStorage.setItem("termweave:settings", JSON.stringify(stored));
        // every frame this page's socket sends and receives, to wait on the server's answers
        const frames: { dir: "in" | "out"; type: string; keep_size?: boolean }[] = [];
        (window as unknown as { frames_: typeof frames }).frames_ = frames;
        const Native = window.WebSocket;
        class Recording extends Native {
          constructor(url: string | URL, protocols?: string | string[]) {
            super(url, protocols);
            this.addEventListener("message", (event) => { try { frames.push({ dir: "in", type: JSON.parse(String(event.data)).type }); } catch {} });
          }
          override send(data: string): void { try { const frame = JSON.parse(data); frames.push({ dir: "out", type: frame.type, keep_size: frame.keep_size }); } catch {} super.send(data); }
        }
        Object.assign(window, { WebSocket: Recording });
      }, settings);
      const page = await context.newPage();
      await page.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`);
      await page.locator(".conn-live").waitFor();
      return page;
    };
    // the server answers an attach with input-ready, and resizes in the same step: once it is in,
    // the attach has done whatever it does to the grid
    const attached = (page: Page) => page.waitForFunction(() => (window as unknown as { frames_: { dir: string; type: string }[] }).frames_.some((f) => f.dir === "in" && f.type === "input-ready"), undefined, { timeout: 15_000 });
    const sent = (page: Page) => page.evaluate(() => (window as unknown as { frames_: { dir: string; type: string; keep_size?: boolean }[] }).frames_.filter((f) => f.dir === "out" && (f.type === "attach" || f.type === "resize")));

    const desktop = await open({ viewport: { width: 1280, height: 800 } }, { language: "en", defaultView: "terminal" });
    await attached(desktop);
    const desktopSize = await size();

    const phone = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, { language: "en", defaultView: "chat" });
    await phone.locator(".terminal-stack.is-chat").waitFor({ state: "attached" });
    await attached(phone);
    // the chat lens attaches without driving the grid, and sends no resize of its own
    assert.deepEqual(await sent(phone), [{ dir: "out", type: "attach", keep_size: true }]);
    assert.equal(await size(), desktopSize, "the phone's chat lens leaves the desktop's grid");
    if (process.env.UI_EVIDENCE_DIR) await desktop.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "chat-size-desktop.png") });
    console.log(`PASS a phone's chat lens leaves the shared grid at the desktop's ${desktopSize}`);

    // the phone's terminal lens fits the grid to the phone: the shell sees it change
    // on a phone the lens switch shows no label: the button is known by its title
    await phone.locator('button[title^="Live terminal"]').tap();
    await phone.waitForFunction(() => (window as unknown as { frames_: { dir: string; type: string }[] }).frames_.some((f) => f.dir === "out" && f.type === "resize"), undefined, { timeout: 10_000 });
    const deadline = Date.now() + 10_000;
    let phoneSize = desktopSize;
    while (phoneSize === desktopSize && Date.now() < deadline) phoneSize = await size();
    assert.notEqual(phoneSize, desktopSize, "the phone's terminal lens fits the grid to the phone");
    assert.ok(Number(phoneSize.split(" ")[1]) < Number(desktopSize.split(" ")[1]), `phone ${phoneSize} narrower than desktop ${desktopSize}`);
    console.log(`PASS the phone's terminal lens fits the grid to ${phoneSize}`);

    // the desktop's terminal lens ignored that resize: it drives the grid itself. Entering the chat
    // lens, its hidden screen takes the grid the pty has now, since what the chat reads there (a
    // masked prompt) is drawn for the phone's grid. xterm's DOM renderer keeps one element a row.
    const hiddenRows = () => desktop.locator(".pane-terminal .xterm-rows > div").count();
    const phoneRows = Number(phoneSize.split(" ")[0]);
    assert.notEqual(await hiddenRows(), phoneRows, "the desktop's terminal lens kept its own grid");
    await desktop.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
    await desktop.locator(".terminal-stack.is-chat").waitFor({ state: "attached" });
    const adopted = Date.now() + 10_000;
    while (await hiddenRows() !== phoneRows && Date.now() < adopted) await Bun.sleep(100);
    assert.equal(await hiddenRows(), phoneRows, "the desktop's chat lens draws its hidden screen for the shared grid");
    assert.equal(await size(), phoneSize, "entering the chat lens resizes nothing");
    console.log(`PASS the desktop's chat lens draws its hidden screen for the shared grid of ${phoneSize}`);
  } finally {
    for (const context of contexts) await context.close();
    await workspaceClose(created.workspace.workspace_id).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}
