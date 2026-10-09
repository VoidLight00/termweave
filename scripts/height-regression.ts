import { chromiumExecutable } from './browser.ts';
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { workspaceCreate, workspaceClose } from "../server/herdr/client.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UsageService } from "../server/usage.ts";
const root = mkdtempSync(join(tmpdir(), "herdr-height-test-"));
const created = await workspaceCreate({ cwd: root, label: "height-test-owned" });
const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: root, usage: new UsageService(undefined, []) });
const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript(() => localStorage.setItem("termweave:settings", JSON.stringify({ language: "en", terminalInputMode: "direct" })));
  const geometries: { rows: number; cols: number }[] = [], inputs: { pane_id: string }[] = [];
  page.on("websocket", socket => socket.on("framesent", ({ payload }) => { const m = JSON.parse(String(payload)); if (m.type === "resize" || m.type === "attach") geometries.push(m); if (m.type === "input") inputs.push(m); }));
  await page.goto(`http://127.0.0.1:${server.port}/?pane=${created.root_pane.pane_id}`); await page.locator(".conn-live").waitFor();
  const measure = async (label: string, minimumRows: number) => {
    await page.waitForTimeout(350);
    const size = await page.locator(".terminal-host").evaluate(node => {
      const outer=node.getBoundingClientRect(); const child=node.querySelector(".split-workspace")!.getBoundingClientRect(); const screen=node.querySelector(".xterm-screen")!.getBoundingClientRect();
      return { host:outer.height, workspace:child.height, screen:screen.height, bottom:screen.bottom, viewport:innerHeight };
    });
    console.log(label,size,"last geometry",geometries.filter((item: any) => item.pane_id === created.root_pane.pane_id).at(-1));
    assert.ok(size.workspace >= size.host - 2, "workspace must fill terminal host");
    assert.ok(size.screen > size.host * 0.55, "terminal screen lost bottom half");
    assert.ok(size.bottom <= size.viewport + 1, "bottom prompt clipped below viewport");
    assert.ok((geometries.filter((item: any) => item.pane_id === created.root_pane.pane_id).at(-1)?.rows ?? 0) >= minimumRows, "backend rows must fit visible terminal");
    const start=inputs.length; await page.locator(".xterm-helper-textarea").first().focus(); await page.keyboard.type("#bottom-visible-input"); await page.waitForTimeout(100);
    assert.ok(inputs.slice(start).some(m=>m.pane_id===created.root_pane.pane_id));
  };
  await measure("fresh-single-desktop",30);
  await page.getByRole("button",{name:"좌우 2분할",exact:true}).click(); await page.getByRole("button",{name:"단일",exact:true}).click(); await measure("split-to-single-desktop",30);
  await page.setViewportSize({width:390,height:844}); await measure("single-phone",20);
  await page.getByRole("button",{name:"4분할",exact:true}).click(); await page.getByRole("button",{name:"단일",exact:true}).click(); await measure("split-to-single-phone",20);
  await page.setViewportSize({width:1100,height:700}); await measure("viewport-resize",20);
  console.log("PASS height: fresh/split-return desktop+phone, viewport resize, bottom bounds/input and backend geometry");
} finally { await browser.close();server.stop();await workspaceClose(created.workspace.workspace_id);rmSync(root,{recursive:true,force:true}); }
