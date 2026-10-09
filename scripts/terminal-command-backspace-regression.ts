import assert from "node:assert/strict";
import type { Browser } from "playwright-core";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneRead, paneSendKeys, paneSendText } from "../server/herdr/client.ts";

/** Mac keyboard events in an isolated context, against a pane owned by the UI suite. */
export async function checkCommandBackspace(browser: Browser, origin: string, paneId: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1100, height: 650 } });
  await context.addInitScript((id) => {
    Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
    localStorage.setItem("termweave:settings", JSON.stringify({ language: "en" }));
    localStorage.setItem(`termweave:view:${id}`, "terminal");
  }, paneId);
  try {
    const page = await context.newPage();
    const inputs: Array<{ pane_id: string; text: string }> = [];
    page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.type === "input") inputs.push(message);
    }));
    await page.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`);
    await page.locator(".conn-live").waitFor();
    const input = page.locator(".xterm-helper-textarea");
    await input.waitFor();
    for (const [shortcut, expected] of [
      ["Backspace", "\x7f"],
      ["Meta+Backspace", "\x15"],
      ["Control+Backspace", "\b"],
      ["Alt+Backspace", "\x1b\x7f"],
      ["Meta+Shift+Backspace", "\x7f"],
      ["Meta+Alt+Backspace", "\x1b\x7f"],
      ["Meta+Control+Backspace", "\b"],
    ]) {
      const before = inputs.length;
      await input.press(shortcut!);
      await page.waitForTimeout(300);
      assert.deepEqual(inputs.slice(before).map(({ pane_id, text }) => ({ pane_id, text })),
        [{ pane_id: paneId, text: expected }], `${shortcut} must send its sequence exactly once`);
    }
    // compositionend's timer is still pending when the deletion key arrives.
    const beforeCommit = inputs.length;
    await input.evaluate(async (element) => {
      const textarea = element as HTMLTextAreaElement;
      textarea.value = "";
      textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      textarea.value = "한";
      textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: "한", bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      textarea.dispatchEvent(new CompositionEvent("compositionend", { data: "한", bubbles: true }));
      const backspace = { key: "Backspace", code: "Backspace", keyCode: 8, which: 8,
        metaKey: true, bubbles: true, cancelable: true };
      textarea.dispatchEvent(new KeyboardEvent("keydown", backspace));
      textarea.dispatchEvent(new KeyboardEvent("keyup", backspace));
    });
    await page.waitForTimeout(300);
    assert.deepEqual(inputs.slice(beforeCommit).map(({ pane_id, text }) => ({ pane_id, text })),
      [{ pane_id: paneId, text: "한" }, { pane_id: paneId, text: "\x15" }],
      "pending IME text must precede line deletion without duplicates");
    for (const composition of [{ isComposing: true, keyCode: 8 }, { isComposing: false, keyCode: 229 }]) {
      const before = inputs.length;
      await input.dispatchEvent("keydown", {
        key: "Backspace", code: "Backspace", metaKey: true, ...composition, bubbles: true, cancelable: true,
      });
      await page.waitForTimeout(300);
      assert.equal(inputs.slice(before).some(({ text }) => text === "\x15"), false,
        "an active composition must not receive a line-deletion sequence");
    }
    // Also verify the effect in a real readline process inside the owned pane.
    const fixture = mkdtempSync(join(tmpdir(), "herdr-command-backspace-"));
    const result = join(fixture, "line.txt");
    const script = join(fixture, "readline.cjs");
    writeFileSync(script, `const fs = require("node:fs");
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on("SIGINT", () => process.exit(0));
process.stdout.write("\\x1b[2J\\x1b[HOwned Cmd+Backspace readline test\\r\\n");
process.stdin.on("data", (data) => {
  if (data.includes(7)) fs.writeFileSync(${JSON.stringify(result)}, rl.line);
});
`);
    try {
      await paneSendKeys(paneId, ["ctrl+c"]);
      await paneSendText(paneId, `node ${script}`);
      await paneSendKeys(paneId, ["Enter"]);
      const deadline = Date.now() + 10_000;
      while (!(await paneRead({ paneId, source: "visible" })).text.includes("Owned Cmd+Backspace readline test")) {
        if (Date.now() > deadline) throw new Error("readline fixture did not start");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const probe = async (expected: string): Promise<void> => {
        await input.press("Control+g");
        const deadline = Date.now() + 5_000;
        while (!existsSync(result) || readFileSync(result, "utf8") !== expected) {
          if (Date.now() > deadline) throw new Error(`readline did not contain ${JSON.stringify(expected)}`);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      };
      await input.pressSequentially("remove this entire input");
      await probe("remove this entire input");
      await input.press("Meta+Backspace");
      await probe("");
    } finally {
      await paneSendKeys(paneId, ["ctrl+c"]);
      rmSync(fixture, { recursive: true, force: true });
    }
    console.log("PASS Cmd+Backspace clears the entire input in a real owned readline PTY");
    console.log("PASS macOS Cmd+Backspace sends Ctrl+U once and preserves other Backspace combinations");
    console.log("PASS pending IME text precedes Cmd+Backspace without duplicates; active composition stays native");
  } finally {
    await context.close();
  }
  const nonMac = await browser.newContext();
  await nonMac.addInitScript((id) => {
    Object.defineProperty(navigator, "platform", { get: () => "Linux x86_64" });
    localStorage.setItem(`termweave:view:${id}`, "terminal");
  }, paneId);
  try {
    const page = await nonMac.newPage();
    const inputs: string[] = [];
    page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.type === "input") inputs.push(message.text);
    }));
    await page.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`);
    await page.locator(".conn-live").waitFor();
    await page.locator(".xterm-helper-textarea").press("Meta+Backspace");
    await page.waitForTimeout(300);
    assert.deepEqual(inputs, ["\x7f"], "non-macOS Meta+Backspace keeps its native sequence");
    console.log("PASS non-macOS Meta+Backspace keeps native DEL");
  } finally {
    await nonMac.close();
  }
}
