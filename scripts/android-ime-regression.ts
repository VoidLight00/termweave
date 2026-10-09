/** Native Gboard taps on an owned API-36 Pixel 7 emulator. See docs/terminal-input.md. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _android } from "playwright-core";
import { createServer } from "../server/index.ts";
import { workspaceCreate, workspaceClose, paneSendText } from "../server/herdr/client.ts";

const serial = process.env.ANDROID_IME_SERIAL;
assert(serial && /^emulator-\d+$/.test(serial), "Set ANDROID_IME_SERIAL to an owned emulator (physical devices are deliberately refused)");
const adb = process.env.ANDROID_ADB ?? "adb";
const evidence = process.env.UI_EVIDENCE_DIR;
const device = (await _android.devices()).find((candidate) => candidate.serial() === serial);
assert(device, "owned emulator is not connected to adb");
const root = mkdtempSync(join(tmpdir(), "herdr-android-ime-"));
const received = join(root, "received.bin");
const ready = join(root, "ready");
const script = join(root, "capture.cjs");
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
writeFileSync(received, "");
writeFileSync(script, `const fs=require('node:fs'); process.stdin.setRawMode(true); process.stdout.write('Native IME capture ready\\r\\n'); fs.writeFileSync(${JSON.stringify(ready)},'ready'); process.stdin.on('data',b=>fs.appendFileSync(${JSON.stringify(received)},b));`);
const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state") });
let workspace: string | undefined;
let context: Awaited<ReturnType<typeof device.launchBrowser>> | undefined;
const results: Array<{ name: string; text: string }> = [];
const until = async (condition: () => boolean | Promise<boolean>, label: string) => {
  const deadline = Date.now() + 15_000;
  while (!(await condition())) { assert(Date.now() < deadline, label); await Bun.sleep(50); }
};
const adbRun = async (...args: string[]) => {
  const proc = Bun.spawn([adb, "-s", serial, ...args], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
  const output = await new Response(proc.stdout).text();
  assert.equal(await proc.exited, 0, await new Response(proc.stderr).text());
  return output;
};
// Coordinates are intentionally tied to this fixture, not claimed to work with arbitrary keyboards.
const keys: Record<string, [number, number]> = {};
for (const [i, key] of [..."qwertyuiop"].entries()) keys[key] = [[59,166,275,382,489,594,702,808,915,1023][i]!,1715];
for (const [i, key] of [..."asdfghjkl"].entries()) keys[key] = [[112,220,328,435,542,649,756,864,970][i]!,1871];
for (const [i, key] of [..."zxcvbnm"].entries()) keys[key] = [[219,326,435,542,649,756,864][i]!,2025];
Object.assign(keys, { _: [593,2177], "!": [997,2025], "@": [997,2177] });
const tap = async (sequence: string) => {
  for (const key of sequence) {
    const [x, y] = keys[key]!;
    await adbRun("shell", "input", "tap", String(x), String(y));
    // Input cadence, not a readiness wait: distinct native touches at a human typing rate.
    await Bun.sleep(120);
  }
};
const expectBytes = async (expected: string) => {
  await until(() => readFileSync(received).length >= Buffer.byteLength(expected), "PTY did not receive expected input");
  assert.equal(readFileSync(received, "utf8"), expected);
};
try {
  assert.match((await device.shell("wm size")).toString(), /Physical size: 1080x2400/);
  assert.match((await device.shell("wm density")).toString(), /Physical density: 420/);
  await device.shell("settings put secure show_ime_with_hard_keyboard 1");
  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-native-ime" });
  workspace = created.workspace.workspace_id;
  const pane = created.root_pane.pane_id;
  await paneSendText(pane, `exec ${quote(Bun.which("node")!)} ${quote(script)}\r`);
  await until(() => existsSync(ready), "capture process was not ready");
  await adbRun("reverse", `tcp:${server.port}`, `tcp:${server.port}`);
  context = await device.launchBrowser({ hasTouch: true, viewport: null, args: ["--no-first-run", "--disable-fre"] });
  const page = await context.newPage();
  await page.addInitScript((pane) => {
    localStorage.setItem("termweave:settings", JSON.stringify({ language: "en", terminalInputMode: "line" }));
    localStorage.setItem(`termweave:view:${pane}`, "terminal");
    (window as any).nativeImeEvents = [];
    for (const type of ["compositionstart", "compositionupdate", "compositionend", "keydown", "input"]) document.addEventListener(type, (event: any) => {
      if (event.target?.tagName === "TEXTAREA") (window as any).nativeImeEvents.push({ type, data: event.data, key: event.key, composing: event.isComposing, value: event.target.value });
    }, true);
  }, pane);
  await page.goto(`http://localhost:${server.port}/?pane=${encodeURIComponent(pane)}`);
  const keyboardReady = async () => {
    let previous = 0, stable = 0;
    await until(async () => {
      const height = await page.evaluate(() => visualViewport?.height ?? innerHeight);
      stable = height < 550 && Math.abs(height - previous) < 1 ? stable + 1 : 0;
      previous = height;
      return stable >= 5;
    }, "keyboard viewport did not settle");
  };
  const line = page.locator(".terminal-input-text");
  await line.waitFor();
  // A plain DOM editor is the control: a missing Gboard language model must not be blamed on xterm.
  await page.evaluate(() => {
    const box = document.createElement("textarea"); box.id = "native-ime-control";
    box.style.cssText = "position:fixed;top:80px;left:10px;width:350px;height:80px;z-index:99999;background:white;color:black";
    document.body.append(box);
  });
  await page.locator("#native-ime-control").tap();
  await keyboardReady();
  await tap("gksrmf_");
  await until(async () => (await page.locator("#native-ime-control").inputValue()) === "한글 ", "Gboard control failed: select Korean two-bulsik and finish language-model download first");
  await page.locator("#native-ime-control").evaluate((element) => element.remove());
  await line.tap(); await keyboardReady();
  await tap("gksrmf_");
  await until(async () => (await line.inputValue()) === "한글 ", "native input-line composition failed");
  results.push({ name: "input line", text: await line.inputValue() });
  if (evidence) { mkdirSync(evidence, { recursive: true }); await device.screenshot({ path: join(evidence, "android-gboard-line.png") }); }
  await page.reload(); await line.waitFor();
  assert.equal(await line.inputValue(), "한글 ");
  await page.getByRole("button", { name: "Type straight into the terminal", exact: true }).tap();
  await page.locator(".xterm-helper-textarea").tap();
  await keyboardReady();
  for (const [name, sequence, expected] of [
    ["word commit", "gksrmf_", "한글 "],
    ["final consonant", "rkqtk_", "갑사 "],
    ["delete during composition", "gksrm!mf_", "한글 "],
  ]) {
    writeFileSync(received, ""); await tap(sequence!); await expectBytes(expected!);
    results.push({ name: name!, text: readFileSync(received, "utf8") });
  }
  for (let trial = 0; trial < 3; trial++) {
    writeFileSync(received, "");
    await tap("rkskek_"); await expectBytes("가나다 ");
    await tap("!"); await expectBytes("가나다 \x7f");
    await tap("!"); await expectBytes("가나다 \x7f\x7f");
    await tap("gksrmf@"); await expectBytes("가나다 \x7f\x7f한글\r");
    results.push({ name: `delete then compose ${trial + 1}`, text: readFileSync(received, "utf8") });
  }
  const report = {
    android: (await device.shell("getprop ro.build.version.release")).toString().trim(),
    chrome: (await device.shell("dumpsys package com.android.chrome")).toString().match(/versionName=(.*)/)?.[1],
    gboard: (await device.shell("dumpsys package com.google.android.inputmethod.latin")).toString().match(/versionName=(.*)/)?.[1],
    results, events: await page.evaluate(() => (window as any).nativeImeEvents),
  };
  if (evidence) {
    writeFileSync(join(evidence, "android-native-ime.json"), JSON.stringify(report, null, 2));
    await device.screenshot({ path: join(evidence, "android-gboard-direct.png") });
  }
  console.log("PASS native Android/Gboard", JSON.stringify({ ...report, events: undefined }));
} finally {
  await context?.close().catch(() => {});
  await device.close().catch(() => {});
  await adbRun("reverse", "--remove", `tcp:${server.port}`).catch(() => {});
  try {
    server.stop();
  } finally {
    try {
      if (workspace) await workspaceClose(workspace).catch((error) => { if (error?.code !== "workspace_not_found") throw error; });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}
