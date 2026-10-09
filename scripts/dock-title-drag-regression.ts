import { chromiumExecutable } from './browser.ts';
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { workspaceCreate, workspaceClose, sessionSnapshot, herdrRpc, paneSendText } from "../server/herdr/client.ts";
import { UsageService } from "../server/usage.ts";
import { checkTerminalFileInput } from "./terminal-file-input-regression.ts";

assert.ok(process.env.HERDR_STAGING_DIST && process.env.HERDR_TEST_SESSION && !process.env.HERDR_TEST_LIVE, "isolated staging only");
const evidence = resolve(process.env.DOCK_EVIDENCE ?? "evidence/title-drag-20261004");
const root = mkdtempSync(join(tmpdir(), "herdr-title-owned-"));
const owned: string[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof createServer> | undefined;
const passed: string[] = [];
try {
  const created = await workspaceCreate({ cwd: root, label: "title-drag-owned" }); owned.push(created.workspace.workspace_id);
  const other = await workspaceCreate({ cwd: root, label: "title-drag-foreign-owned" }); owned.push(other.workspace.workspace_id);
  const ids = [created.root_pane.pane_id];
  for (let i = 0; i < 3; i++) ids.push((await herdrRpc<{ pane: { pane_id: string } }>("pane.split", { target_pane_id: ids[0], direction: "right", cwd: root, focus: false })).pane.pane_id);
  // Only our just-created panes receive commands. Record each live shell's actual PID.
  for (const [i, id] of ids.entries()) {
    await paneSendText(id, `printf '%s' $$ > '${root}/pid-${i}'\n`);
    const deadline = Date.now() + 10000;
    while (!existsSync(join(root, `pid-${i}`))) { assert.ok(Date.now() < deadline, "shell PID not recorded"); await Bun.sleep(50); }
  }
  const pids = ids.map((_, i) => Number(readFileSync(join(root, `pid-${i}`), "utf8")));
  pids.forEach(pid => { assert.ok(pid > 1); process.kill(pid, 0); });
  const processIdentity = async () => {
    const result = await Bun.$`ps -o pid=,ppid=,lstart= -p ${pids.join(",")}`.quiet();
    assert.equal(result.exitCode, 0); return result.text();
  };
  const processesBefore = await processIdentity();
  const before = await sessionSnapshot();
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: root, usage: new UsageService(undefined, []) });
  browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const page = await context.newPage();
  const errors: string[] = [], inputs: { pane_id: string; text: string }[] = [], mutations: string[] = [];
  let socket: import("playwright-core").WebSocket | undefined;
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (request.method() === "POST" && /\/api\/pane\/(split|move)/.test(request.url())) mutations.push(request.url()); });
  page.on("websocket", ws => { socket = ws; ws.on("framesent", ({ payload }) => { const frame = JSON.parse(String(payload)); if (frame.type === "input") inputs.push(frame); }); });
  await page.addInitScript(() => localStorage.setItem("termweave:settings", JSON.stringify({ language: "en", terminalInputMode: "direct" })));
  const origin = `http://127.0.0.1:${server.port}`;
  await page.goto(`${origin}/?pane=${ids[0]}`); await page.locator(".conn-live").waitFor();
  const key = `termweave:dock:workspace:v3:local:${encodeURIComponent(created.workspace.workspace_id)}`;
  const group = (id: string, tabs: string[]) => ({ kind: "group", id, tabs, active: tabs[0] });
  const initial = () => ({ kind: "split", id: "s", axis: "columns", ratio: .5, first: group("a", ids.slice(0, 3)), second: group("b", [ids[3]!]) });
  const stored = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)!).tree, key);
  const reset = async () => {
    await page.evaluate(({ key, tree, workspace, primary }) => localStorage.setItem(key, JSON.stringify({tree, workspace, primary})), { key, tree: initial(), workspace: created.workspace.workspace_id, primary: ids[0]! });
    await page.goto(`${origin}/?pane=${ids[0]}`); try { await page.locator('.dock-group[data-group-id="a"]').waitFor(); } catch (error) { console.log(await page.evaluate(() => ({groups: Array.from(document.querySelectorAll('.dock-group')).map(g=>g.outerHTML.slice(0,250)),storage:Object.fromEntries(Object.keys(localStorage).filter(k=>k.includes('dock:')).map(k=>[k,localStorage.getItem(k)]))}))); await page.screenshot({path:join(evidence,'workspace-reset-failure.png')}); throw error; }
    await page.waitForTimeout(250);
  };
  const invariant = async () => {
    const tabs = await page.locator('[role="tab"][data-tab-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute("data-tab-id")));
    assert.deepEqual([...tabs].sort(), [...ids].sort());
    assert.equal(await page.locator(".dock-drop-hint, [data-insert], .dock-insert-end").count(), 0);
  };
  const start = async (id: string) => {
    const title = page.locator(`[data-tab-id="${id}"]`); await title.scrollIntoViewIfNeeded();
    const box = await title.boundingBox(); assert.ok(box);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2, { steps: 6 });
  };
  const drag = async (id: string, selector: string, x: number, y: number) => {
    const count = inputs.length;
    await start(id);
    const box = await page.locator(selector).boundingBox(); assert.ok(box);
    await page.mouse.move(box.x + box.width * x, box.y + box.height * y, { steps: 25 });
    await page.mouse.move(box.x + box.width * x, box.y + box.height * y);
    assert.ok(await page.locator(".dock-drop-hint, [data-insert], .dock-insert-end").count(), "real drag preview absent");
    await page.mouse.up(); await page.waitForTimeout(350);
    assert.equal(inputs.length, count, "drag must send no terminal input");
    await invariant();
  };
  const focus = async (id: string) => {
    await page.waitForFunction(id => document.activeElement?.matches(".xterm-helper-textarea") && document.activeElement.closest<HTMLElement>(".dock-group")?.dataset.paneId === id, id);
    const count = inputs.length; await page.keyboard.type("#title-drag-test"); await page.waitForTimeout(100);
    assert.ok(inputs.length > count); assert.ok(inputs.slice(count).every(frame => frame.pane_id === id));
    await page.keyboard.press("Control+c");
  };
  for (const [edge, x, y, axis, first] of [["left", .03, .5, "columns", true], ["right", .97, .5, "columns", false],
    ["top", .5, .03, "rows", true], ["bottom", .5, .97, "rows", false]] as const) {
    await reset(); await drag(ids[1]!, '[data-group-id="b"] .dock-drop-body', x, y);
    const tree = await stored(); assert.equal(tree.second.axis, axis);
    assert.deepEqual((first ? tree.second.first : tree.second.second).tabs, [ids[1]]);
    await focus(ids[1]!); passed.push(`real-title-${edge}-nested-focus`);
  }
  await reset(); await drag(ids[3]!, '[data-group-id="a"] .dock-drop-body', .5, .5);
  assert.equal(await page.locator(".dock-group").count(), 1); assert.deepEqual((await stored()).tabs, ids);
  await focus(ids[3]!); passed.push("center-empty-source-collapse-focus");
  await drag(ids[1]!, '.dock-drop-body', .03, .5); assert.equal(await page.locator(".dock-group").count(), 2);
  passed.push("self-group-multi-tab-split");
  await reset();
  await drag(ids[0]!, `[data-tab-id="${ids[2]}"]`, .8, .5); assert.deepEqual((await stored()).first.tabs, [ids[1], ids[2], ids[0]]);
  await focus(ids[0]!);
  await drag(ids[0]!, `[data-tab-id="${ids[1]}"]`, .2, .5); assert.deepEqual((await stored()).first.tabs, ids.slice(0, 3));
  await drag(ids[1]!, '[data-group-id="a"] .dock-strip-end', .7, .5); assert.deepEqual((await stored()).first.tabs, [ids[0], ids[2], ids[1]]);
  const self = JSON.stringify(await stored()); await drag(ids[2]!, `[data-tab-id="${ids[2]}"]`, .8, .5); assert.equal(JSON.stringify(await stored()), self);
  passed.push("before-after-bidirectional-strip-append-self-noop");
  await reset(); await drag(ids[3]!, '[data-group-id="a"] .dock-strip-end', .6, .5); assert.deepEqual((await stored()).tabs, ids);
  const persisted = JSON.stringify(await stored()); await page.reload(); await page.locator(".conn-live").waitFor(); assert.equal(JSON.stringify(await stored()), persisted);
  passed.push("cross-group-strip-append-order-active-persistence");
  await reset();
  for (const cancel of ["escape", "outside"] as const) {
    const saved = JSON.stringify(await stored()); await start(ids[1]!);
    const box = await page.locator('[data-group-id="b"] .dock-drop-body').boundingBox(); assert.ok(box);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 20 }); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    assert.equal(await page.locator(".dock-drop-hint").count(), 1);
    if (cancel === "escape") await page.keyboard.press("Escape"); else await page.mouse.move(3, 3, { steps: 20 });
    await page.mouse.up(); await page.waitForTimeout(200); assert.equal(JSON.stringify(await stored()), saved); await invariant();
    passed.push(`real-${cancel}-cancel-cleanup`);
  }
  // Switching the mounted workspace during a real active drag clears its authority.
  await start(ids[1]!);
  const switchBox = await page.locator('[data-group-id="b"] .dock-drop-body').boundingBox(); assert.ok(switchBox);
  await page.mouse.move(switchBox.x + switchBox.width / 2, switchBox.y + switchBox.height / 2, { steps: 20 });
  await page.mouse.move(switchBox.x + switchBox.width / 2, switchBox.y + switchBox.height / 2);
  assert.equal(await page.locator('.dock-drop-hint').count(), 1);
  await page.goto(`${origin}/?pane=${other.root_pane.pane_id}`); await page.mouse.up(); await page.locator('.conn-live').waitFor();
  assert.equal(await page.locator('.dock-group').count(), 1);
  assert.equal(await page.locator('.dock-drop-hint, [data-insert], .dock-insert-end').count(), 0);
  await reset(); passed.push('workspace-switch-active-drag-cleanup');
  const saved = JSON.stringify(await stored());
  for (const payload of [ids[1]!, other.root_pane.pane_id, "invalid"]) {
    await page.locator('.dock-drop-body').first().evaluate((host, payload) => {
      const data = new DataTransfer(); data.setData("application/x-herdr-pane", payload);
      for (const type of ["dragover", "drop"]) host.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data, clientX: 10, clientY: 10 }));
    }, payload);
    assert.equal(JSON.stringify(await stored()), saved); await invariant();
  }
  passed.push("foreign-and-forged-payload-rejected");
  await page.locator('[data-group-id="a"] .xterm-helper-textarea').focus(); await page.waitForTimeout(500);
  // The existing file-input helper expects a single visible terminal and its socket.
  await page.locator('[data-group-id="a"]').getByRole("button", { name: "Zoom", exact: true }).click();
  await page.waitForTimeout(500); assert.ok(socket); await checkTerminalFileInput(page, socket);
  await page.getByRole("button", { name: "Restore layout", exact: true }).click();
  assert.equal(JSON.stringify(await stored()), saved); await invariant(); passed.push("native-text-file-drop-and-paste-preserved");
  const divider = page.locator('.dock-divider').first(); await divider.focus(); await page.keyboard.press("ArrowRight");
  const ratio = (await stored()).ratio; assert.ok(ratio > .5);
  await page.setViewportSize({ width: 1250, height: 950 });
  const bounds = await page.locator('.dock-group').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().bottom)); assert.ok(bounds.every(bottom => bottom <= 950));
  const nested = JSON.stringify(await stored()); await page.reload(); await page.locator('.conn-live').waitFor(); assert.equal(JSON.stringify(await stored()), nested);
  passed.push("ratio-direction-active-order-resize-reload-bottom-bounds");
  await page.locator('[data-group-id="a"] .xterm-helper-textarea').focus();
  const count = inputs.length; await page.keyboard.press("Meta+ArrowRight"); await page.waitForTimeout(100);
  assert.equal(inputs.length, count); await page.waitForFunction(() => document.activeElement?.closest<HTMLElement>('.dock-group')?.dataset.groupId === "b");
  passed.push("command-arrow-navigation-no-input");
  const after = await sessionSnapshot();
  for (const [i, id] of ids.entries()) {
    const old = before.panes.find(pane => pane.pane_id === id)!, next = after.panes.find(pane => pane.pane_id === id)!;
    for (const field of ["pane_id", "terminal_id", "workspace_id", "tab_id", "cwd"] as const) assert.equal(next[field], old[field]);
    process.kill(pids[i]!, 0);
  }
  const processesAfter = await processIdentity(); assert.equal(processesAfter, processesBefore, 'shell PID, parent and start time unchanged');
  assert.equal(after.panes.length, before.panes.length); assert.deepEqual(mutations, []); assert.deepEqual(errors, []);
  passed.push("unchanged-terminal-workspace-cwd-shell-pids-no-mutation-errors");
  await page.screenshot({ path: join(evidence, "title-drag-final.png") });
  await context.tracing.stop({ path: join(evidence, "title-drag-trace.zip") });
  await Bun.write(join(evidence, "title-drag-results.json"), JSON.stringify({ passed, shellPids: pids, processesBefore, processesAfter, identity: ids.map(id => after.panes.find(p => p.pane_id === id)), errors, mutations }, null, 2));
  console.log(`PASS title drag: ${passed.length} checks; ${passed.join(", ")}`);
} catch (error) {
  await Bun.write(join(evidence, "title-drag-failure.json"), JSON.stringify({ passed, error: String(error) }, null, 2));
  throw error;
} finally {
  await browser?.close(); server?.stop();
  for (const id of owned) await workspaceClose(id);
  rmSync(root, { recursive: true, force: true });
}
