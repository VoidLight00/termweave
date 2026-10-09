import { chromiumExecutable } from './browser.ts';
/** Real xterm + real herdr; only delays outgoing ACKs to exercise a suspended consumer. */
import "./test-herdr.ts"; // a herdr session of its own: nothing shows in the user's
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { herdrRpc, paneSendText, paneSendKeys } from "../server/herdr/client.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-output-browser-"));
const workspaces: string[] = [];
const panes: string[] = [];
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
async function until(check: () => boolean, label: string, ms = 15000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(20);
  }
}

try {
  for (const suffix of ["a", "b"]) {
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create", { label: `herdr-web-ui-test-output-browser-${suffix}`, cwd: root, focus: false },
    );
    workspaces.push(created.workspace.workspace_id);
    panes.push(created.root_pane.pane_id);
  }
  const [paneA, paneB] = panes as [string, string];
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "push") });
  browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript((ids) => {
    for (const id of ids) localStorage.setItem(`termweave:view:${id}`, "terminal");
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (typeof data === "string" && JSON.parse(data).type === "pty-ack"
        && (window as unknown as { holdAcks?: boolean }).holdAcks) return;
      send.call(this, data);
    };
  }, panes);
  const page = await context.newPage();
  const errors: string[] = [];
  const acks = new Map<string, number>();
  let connections = 0;
  let initialAttaches = 0;
  page.on("pageerror", error => errors.push(error.message));
  page.on("websocket", ws => {
    connections++;
    ws.on("framesent", ({ payload }) => {
      const frame = JSON.parse(String(payload));
      if (frame.type === "attach") initialAttaches++;
      if (frame.type === "pty-ack") acks.set(frame.pane_id, (acks.get(frame.pane_id) ?? 0) + 1);
    });
  });
  await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(paneA)}`);
  await until(() => (acks.get(paneA) ?? 0) > 0, "xterm parser ACK");
  assert.equal(initialAttaches, 1, "connect must attach once");
  await page.evaluate(() => { (window as unknown as { holdAcks: boolean }).holdAcks = true; });
  await Bun.sleep(200);
  await paneSendText(paneA, `python3 -u -c 'import sys,time; [(sys.stdout.write("\\033[H"+(str(i%10)*79+"\\n")*23),sys.stdout.flush(),time.sleep(.01)) for i in range(1500)]'`);
  await paneSendKeys(paneA, ["Enter"]);
  await page.getByText("Terminal output stopped because this device could not keep up.", { exact: false }).waitFor({ timeout: 20000 });
  await Bun.sleep(750);
  assert.equal(connections, 1, "overload must not start an automatic reconnect loop");
  assert.equal(await page.locator(".conn-text").textContent(), "disconnected");
  mkdirSync(".omo/evidence/output-flow", { recursive: true });
  await page.screenshot({ path: ".omo/evidence/output-flow/stopped.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await Bun.sleep(350); // finish the sidebar's responsive transition before visual QA
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: ".omo/evidence/output-flow/stopped-mobile.png" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await Bun.sleep(350);
  await paneSendKeys(paneA, ["C-c"]);
  await page.evaluate(() => { (window as unknown as { holdAcks: boolean }).holdAcks = false; });
  const beforeReconnect = acks.get(paneA)!;
  await page.getByRole("link", { name: "Reconnect", exact: true }).click();
  await until(() => (acks.get(paneA) ?? 0) > beforeReconnect, "explicit reconnect action");
  await page.locator(`.pane-select[title^="${paneB} —"]`).click();
  await until(() => (acks.get(paneB) ?? 0) > 0, "manual pane switch reconnects");
  const previousAcks = acks.get(paneA)!;
  await page.locator(`.pane-select[title^="${paneA} —"]`).click();
  await until(() => (acks.get(paneA) ?? 0) > previousAcks, "reopened pane ACK");
  assert.equal(await page.getByText("Terminal output stopped because this device could not keep up.", { exact: false }).count(), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ parserAcks: Object.fromEntries(acks), connections, overloadNotice: true, reconnectAction: true, manualRecovery: true, browserErrors: errors }));
} finally {
  await browser?.close();
  server?.stop();
  for (const workspace of workspaces) await herdrRpc("workspace.close", { workspace_id: workspace });
  rmSync(root, { recursive: true, force: true });
  await until(() => Bun.spawnSync(["pgrep", "-P", String(process.pid), "-f", "pty-host.mjs"]).stdout.length === 0, "sidecars reaped", 5000);
}
