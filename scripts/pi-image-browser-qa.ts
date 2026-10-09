import { chromiumExecutable } from './browser.ts';
/** A pi tool result's picture, end to end in Chrome: parsed page -> work row -> <img> bytes. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { transcriptPage } from "../server/conversation.ts";
import type { ConversationResponse } from "../shared/protocol.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-image-browser-"));
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
// real 1x1 files, so Chrome decodes them: a naturalWidth of 1 proves the bytes that arrived
// are a picture, not a broken-image placeholder
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const GIF = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
// pi's own record shapes: the picture sits in the tool result, beside the text it returns
const entries = [
  { type: "session", version: 3, id: "s", timestamp: "2026-09-30T00:00:00Z", cwd: root },
  { type: "model_change", id: "m1", parentId: null, timestamp: "2026-09-30T00:00:00Z", provider: "test", modelId: "qwen-test" },
  { type: "message", id: "u1", parentId: "m1", timestamp: "2026-09-30T00:00:01Z", message: { role: "user", content: "what is in this screenshot?" } },
  { type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-30T00:00:02Z", message: {
    role: "assistant", model: "qwen-test", provider: "test", stopReason: "toolUse", usage: { input: 10, output: 4 },
    content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "shot.png" } }],
  } },
  { type: "message", id: "r1", parentId: "a1", timestamp: "2026-09-30T00:00:03Z", message: {
    role: "toolResult", toolCallId: "call-1", toolName: "read", content: [
      { type: "text", text: "read 2 images" },
      { type: "image", mimeType: "image/png", data: PNG },
      { type: "image", mimeType: "image/gif", data: GIF },
    ],
  } },
];
let conversation: ConversationResponse;
const bytes = new Map<string, { data: Buffer; type: string }>();
try {
  const build = await Bun.build({ entrypoints: ["scripts/chat-history-fixture.tsx"], outdir: root, target: "browser", define: { "process.env.NODE_ENV": '"development"' } });
  assert.ok(build.success, String(build.logs));
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/pane/conversation/image") {
      // served for real rather than by page.route: a fulfilled binary body is the harness's
      // business, and the point here is that the browser decodes the bytes the endpoint gives
      const image = bytes.get(url.searchParams.get("ref") ?? "");
      served.push(url.searchParams.get("ref") ?? "");
      return image ? new Response(new Uint8Array(image.data), { headers: { "content-type": image.type } }) : new Response(JSON.stringify({ error: { code: "image_not_found" } }), { status: 404 });
    }
    const path = url.pathname;
    return path === "/" ? new Response('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/chat-history-fixture.css"></head><body><div id="root"></div><script type="module" src="/chat-history-fixture.js"></script></body></html>', { headers: { "Content-Type": "text/html" } }) : new Response(Bun.file(join(root, path.slice(1))));
  } });
  const write = (rows: unknown[]) => {
    const path = join(root, "session.jsonl");
    writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const { source, turns, metadata } = transcriptPage("pi-transcript", path);
    conversation = { source, history_id: "fixture", cursor: null, turns, metadata, version: 1 };
  };
  write(entries);
  for (const part of conversation.turns.flatMap((turn) => turn.parts)) {
    if (part.kind !== "tool" || part.images === undefined) continue;
    for (const image of part.images) bytes.set(image.ref, image.media_type === "image/png" ? { data: Buffer.from(PNG, "base64"), type: "image/png" } : { data: Buffer.from(GIF, "base64"), type: "image/gif" });
  }
  assert.equal(bytes.size, 2, "the page should address both pictures");

  browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors: string[] = [];
  const served: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/pane/conversation?*", (route) => route.fulfill({ json: conversation }));
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.getByText("what is in this screenshot?").waitFor();

  // the row shows a picture only once opened: a base64 blob must not arrive on every poll
  assert.equal(await page.locator(".chat-tool-images img").count(), 0, "a closed row fetches nothing");
  assert.deepEqual(served, [], "a closed row fetches nothing");
  await page.locator(".work-row-head").first().click();
  assert.equal(await page.locator(".chat-tool-images img").count(), 2);
  // loading="lazy" means the fetch is deferred until the picture is near the viewport, and
  // naturalWidth only settles once Chrome has decoded what came back
  await page.locator(".chat-tool-images img").first().scrollIntoViewIfNeeded();
  for (let attempt = 0; attempt < 100; attempt++) {
    const loaded = await page.locator(".chat-tool-images img").evaluateAll((imgs) => imgs.every((img) => img.complete && img.naturalWidth > 0));
    if (loaded) break;
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.deepEqual(served.sort(), ["pi:call-1:0", "pi:call-1:1"]);
  // the bytes round-tripped: Chrome decoded them, so they are the file and not a broken icon
  const sizes = await page.locator(".chat-tool-images img").evaluateAll((imgs) => imgs.map((img) => [img.naturalWidth, img.naturalHeight]));
  assert.deepEqual(sizes, [[1, 1], [1, 1]], "Chrome decoded both pictures from the served bytes");
  assert.equal(await page.locator(".chat-tool-output pre").textContent(), "read 2 images", "the text answer stays beside the pictures");
  assert.deepEqual(errors, []);

  // a result whose pictures vanish (the branch moved, the file changed) must not strand an <img>
  const kept = entries.filter((entry) => (entry as { id?: string }).id !== "r1");
  write(kept);
  await page.evaluate(() => window.qa.refresh());
  await page.locator(".work-block-head").click(); // fold, then unfold, so the row re-renders
  await page.locator(".work-block-head").click();
  assert.equal(await page.locator(".chat-tool-images").count(), 0, "no image, no container");
  console.log("pi tool images: browser OK (2 pictures served, none fetched while folded, text answer intact)");
} finally {
  await browser?.close();
  server?.stop();
  rmSync(root, { recursive: true, force: true });
}
