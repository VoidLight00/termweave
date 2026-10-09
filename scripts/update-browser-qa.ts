import { chromiumExecutable } from './browser.ts';
/** End-to-end update QA: private Git remote/install + owned herdr pane, never the live app. */
import "./test-herdr.ts"; // a herdr session of its own: nothing shows in the user's
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { runCommand } from "../server/updater.ts";
import { workspaceCreate, workspaceClose, sessionSnapshot } from "../server/herdr/client.ts";
import type { UpdateStatus } from "../shared/update.ts";

const source = resolve(import.meta.dir, "..");
const temp = mkdtempSync(join(tmpdir(), "herdr-update-browser-"));
const upstream = join(temp, "upstream"), install = join(temp, "install");
const evidence = join(source, "evidence", "updates");
mkdirSync(upstream); mkdirSync(evidence, { recursive: true });
const git = (cwd: string, ...args: string[]) => runCommand(cwd, ["git", ...args]);
let supervisor: ReturnType<typeof Bun.spawn> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let workspaceId: string | undefined;
const log = openSync(join(evidence, "supervisor.log"), "w");

async function until(check: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 60_000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(message);
    await Bun.sleep(200);
  }
}

try {
  const files = await git(source, "ls-files", "--cached", "--others", "--exclude-standard", "-z");
  for (const file of new Set(files.split("\0").filter(Boolean))) {
    mkdirSync(dirname(join(upstream, file)), { recursive: true });
    copyFileSync(join(source, file), join(upstream, file));
  }
  await git(upstream, "init", "-q", "-b", "main");
  await git(upstream, "config", "user.name", "Update browser QA");
  await git(upstream, "config", "user.email", "qa@example.invalid");
  await git(upstream, "add", "."); await git(upstream, "commit", "-qm", "QA baseline");
  await git(temp, "clone", "-q", upstream, install);
  await runCommand(install, [process.execPath, "install", "--frozen-lockfile"], undefined, 180_000);
  await runCommand(install, [process.execPath, "run", "build"], undefined, 120_000);
  const reserve = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = reserve.port!; reserve.stop(true);
  const origin = `http://127.0.0.1:${port}`;
  supervisor = Bun.spawn([process.execPath, "server/managed.ts"], {
    cwd: install, stdout: log, stderr: log,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), HERDR_WEB_TOKEN: "",
      HERDR_WEB_AUTO_UPDATE: "0", HERDR_WEB_STATE_DIR: join(temp, "state") },
  });
  const status = async (): Promise<UpdateStatus | null> => {
    try { return await (await fetch(`${origin}/api/updates`)).json() as UpdateStatus; } catch { return null; }
  };
  await until(async () => (await status())?.managed === true, "Managed server never became ready");
  const workspace = await workspaceCreate({ cwd: temp, label: "herdr-web-ui-test-update-browser" });
  workspaceId = workspace.workspace.workspace_id;
  const paneId = workspace.root_pane.pane_id;
  browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(60_000);
  await page.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`);
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  await draft.fill("Unsent draft preserved across update");
  await page.locator(".sidebar-footer").getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("heading", { name: "Updates", exact: true }).scrollIntoViewIfNeeded();

  writeFileSync(join(upstream, "qa-revision.txt"), "second build\n");
  await git(upstream, "add", "."); await git(upstream, "commit", "-qm", "QA update"); await git(upstream, "tag", "v99.0.0");
  const next = await git(upstream, "rev-parse", "HEAD");
  await page.getByRole("button", { name: "Check for updates", exact: true }).click();
  const installButton = page.getByRole("button", { name: "Update and restart", exact: true });
  await until(() => installButton.isEnabled(), "Update never became installable");
  await page.screenshot({ path: join(evidence, "available-desktop.png"), fullPage: true });
  await installButton.click();
  await until(async () => (await status())?.current_revision === next, "Updated process never became active");
  await page.locator(".update-notice").getByRole("button", { name: "Reload app" }).waitFor();
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  assert.equal(await draft.inputValue(), "Unsent draft preserved across update");
  assert.ok((await sessionSnapshot()).panes.some(pane => pane.pane_id === paneId));
  await page.screenshot({ path: join(evidence, "updated-draft-desktop.png"), fullPage: true });
  console.log("PASS browser check/install/restart, reload notice, unsent draft and herdr pane preserved");

  // A reload is explicit. The new frontend's build revision must match the server.
  await page.locator(".update-notice").getByRole("button", { name: "Reload app" }).click();
  await page.locator(".sidebar-footer").getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("heading", { name: "Updates", exact: true }).scrollIntoViewIfNeeded();
  await page.getByText(new RegExp(`^Running (v[0-9.]+ \\()?${next.slice(0, 12)}\\)?$`)).waitFor();
  assert.equal(await page.locator(".update-notice").count(), 0);

  writeFileSync(join(upstream, "server/index.ts"), `throw new Error('QA startup failure');\n${readFileSync(join(upstream, "server/index.ts"), "utf8")}`);
  await git(upstream, "add", "."); await git(upstream, "commit", "-qm", "QA failed startup"); await git(upstream, "tag", "v99.0.1");
  await page.getByRole("button", { name: "Check for updates", exact: true }).click();
  await until(() => installButton.isEnabled(), "Rollback candidate never became available");
  await installButton.click();
  await page.getByText(/Previous version restored/).waitFor();
  assert.equal((await status())?.current_revision, next);
  await page.locator(".conn-live").waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("heading", { name: "Updates", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(evidence, "rollback-mobile.png"), fullPage: true });
  const updateBounds = await page.locator(".settings-updates").boundingBox();
  assert.ok(updateBounds && updateBounds.x >= 0 && updateBounds.x + updateBounds.width <= 390);
  assert.equal(await page.locator(".settings-updates").evaluate(element => element.scrollWidth > element.clientWidth), false);
  assert.deepEqual(errors, []);
  console.log("PASS failed startup restored previous version; mobile update controls fit; no browser errors");
} finally {
  await browser?.close();
  if (supervisor) { supervisor.kill("SIGTERM"); await supervisor.exited; }
  closeSync(log);
  if (workspaceId) await workspaceClose(workspaceId);
  rmSync(temp, { recursive: true, force: true });
}
