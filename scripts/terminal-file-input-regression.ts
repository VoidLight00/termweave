import assert from "node:assert/strict";
import type { Page, WebSocket } from "playwright-core";

/** Checks real xterm input frames, clipboard text, and the pane's file upload API. */
export async function checkTerminalFileInput(page: Page, socket: WebSocket): Promise<void> {
  const input = (): Promise<string> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error("No terminal input arrived")); }, 10_000);
    const listener = ({ payload }: { payload: string | Buffer }): void => {
      const frame = JSON.parse(String(payload));
      if (frame.type !== "input") return;
      clearTimeout(timer);
      off();
      resolve(frame.text);
    };
    const off = (): void => { socket.off("framesent", listener); };
    socket.on("framesent", listener);
  });
  await page.locator(".conn-live").waitFor();
  const host = page.locator(".pane-terminal");
  const path = "/Users/test/Downloads/monthly-report.json"; // leakscan:allow: test fixture
  const unbracket = (text: string): string => text.replace(/^\x1b\[200~/, "").replace(/\x1b\[201~$/, "");
  const dropped = input();
  await host.evaluate((element, text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
  }, path);
  assert.equal(unbracket(await dropped), path);

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
  await page.evaluate((text) => navigator.clipboard.writeText(text), path);
  await page.locator(".xterm-helper-textarea").focus();
  const pasted = input();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+v" : "Control+v");
  assert.equal(unbracket(await pasted), path);

  for (const eventType of ["drop", "paste"] as const) {
    const uploaded = page.waitForResponse((response) => response.url().endsWith("/api/pane/image") && response.request().method() === "POST");
    const fileInput = input();
    await host.evaluate((element, type) => {
      const data = new DataTransfer();
      data.items.add(new File(['{"month":"2026-09"}'], "monthly-report.json", { type: "application/json" }));
      const event = type === "drop"
        ? new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data })
        : new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data });
      element.querySelector(".xterm-helper-textarea")!.dispatchEvent(event);
    }, eventType);
    const response = await uploaded;
    assert.equal(response.status(), 200);
    const body: { path: string } = await response.json();
    assert.equal(unbracket(await fileInput), `'${body.path.replaceAll("'", "'\\''")}' `, "file input pastes only the quoted path, with no Enter");
    assert.match(body.path, /monthly-report-.*\.json$/);
  }
  console.log("PASS terminal path drop, native path paste and JSON file drop/paste");
}
