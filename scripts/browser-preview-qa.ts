import { chromiumExecutable } from './browser.ts';
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const evidence = `${root}preview-evidence`;
await mkdir(evidence, { recursive: true });
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  const headers: Record<string, string> = { "Content-Type": "text/html" };
  if (path === "/denied") { headers["X-Frame-Options"] = "DENY"; headers["Content-Security-Policy"] = "frame-ancestors 'none'"; }
  return new Response(`<html><body><h1>${path === "/denied" ? "Denied fixture" : "Allowed fixture"}</h1><script>try { parent.document.body.dataset.escaped = 'yes'; } catch {}</script></body></html>`, { headers });
} });
const vite = await createServer({ root, server: { host: "127.0.0.1", port: 0 }, configFile: false, esbuild: { jsx: "automatic" },
  plugins: [{ name: "isolated-preview-fixture", configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url !== "/preview-test") return next();
      void server.transformIndexHtml("/preview-test", '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/scripts/browser-preview-fixture.tsx"></script></body></html>').then(html => { response.setHeader("Content-Type", "text/html"); response.end(html); });
    });
  } }],
});
await vite.listen();
const port = (vite.httpServer!.address() as { port: number }).port;
const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
page.on("pageerror", error => console.error(error.message));
let checks: string[] = [];
function check(value: unknown, name: string) { if (!value) throw new Error(name); checks = [...checks, name]; }
try {
  await page.goto(`http://127.0.0.1:${port}/preview-test`);
  const sentinel = page.locator("#terminal-sentinel");
  const layout = await sentinel.getAttribute("data-layout");
  await page.getByRole("button", { name: "웹 미리보기 열기" }).click();
  const address = page.getByLabel("웹 주소", { exact: true });
  check(await address.evaluate(element => element === document.activeElement), "open focuses URL field");
  await address.press("Tab");
  check(await page.getByRole("button", { name: "주소 확인" }).evaluate(element => element === document.activeElement), "Tab reaches URL action");
  await page.getByRole("button", { name: "주소 확인" }).press("Control+l");
  check(await address.evaluate(element => element === document.activeElement), "Control+L focuses address from panel controls");
  await address.dispatchEvent("keydown", { key: "Escape", isComposing: true, bubbles: true });
  check(await address.isVisible(), "IME composition Escape does not close panel");
  await address.fill("javascript:alert(1)"); await address.press("Enter");
  check(await page.getByRole("alert").count() === 1 && await page.locator("iframe").count() === 0, "invalid schemes never create a frame");
  await address.fill(`http://localhost:${fixture.port}/allowed`); await address.press("Enter");
  const link = page.getByRole("link", { name: "새 탭에서 열기" });
  check(await link.getAttribute("rel") === "noopener noreferrer" && await link.getAttribute("target") === "_blank", "safe explicit external link");
  check(await page.locator("iframe").count() === 0, "URL check does not navigate iframe");
  await page.getByRole("button", { name: "제한된 내부 표시 시도" }).click();
  await page.frameLocator("iframe").getByRole("heading", { name: "Allowed fixture" }).waitFor();
  check(await page.locator("iframe").getAttribute("sandbox") === "allow-scripts", "opaque-origin iframe sandbox");
  check(!(await page.locator("body").getAttribute("data-escaped")), "frame cannot access parent DOM");
  await page.screenshot({ path: `${evidence}/preview-allowed.png` });
  await page.getByRole("button", { name: "내부 표시 중지" }).click();
  const blockedResponse = await fetch(`http://localhost:${fixture.port}/denied`);
  check(blockedResponse.headers.get("x-frame-options") === "DENY" && blockedResponse.headers.get("content-security-policy") === "frame-ancestors 'none'", "framing security headers preserved");
  const blocked = page.waitForEvent("console", { predicate: message => /frame-ancestors|X-Frame-Options|Refused to frame/.test(message.text()), timeout: 10000 });
  await address.fill(`http://localhost:${fixture.port}/denied`); await address.press("Enter");
  await page.getByRole("button", { name: "제한된 내부 표시 시도" }).click(); await blocked;
  check(await page.getByText(/표시 성공을 보장하지 않습니다/).count() === 1, "blocked framing remains honest, external fallback visible");
  await page.screenshot({ path: `${evidence}/preview-framing-denied.png` });
  await address.focus(); await address.press("Escape");
  check(await page.getByRole("button", { name: "웹 미리보기 열기" }).evaluate(element => element === document.activeElement), "Escape closes and restores focus");
  check(await page.locator("iframe").count() === 0 && await sentinel.getAttribute("data-layout") === layout, "close removes frame and preserves terminal layout");
  await page.getByRole("button", { name: "웹 미리보기 열기" }).click();
  await address.fill("http://localhost:3000/"); await address.press("Enter");
  await page.getByRole("button", { name: "Switch test PC" }).click();
  check(await page.locator("iframe").count() === 0 && await page.locator(".browser-preview").getAttribute("data-preview-machine") === "remote-b", "machine switch clears preview identity");
  await page.getByRole("button", { name: "웹 미리보기 열기" }).click();
  check(await address.inputValue() === "", "remote switch does not reuse local URL");
  await address.fill("http://localhost:3000/"); await address.press("Enter");
  check(await page.getByRole("button", { name: "제한된 내부 표시 시도" }).isDisabled(), "remote localhost not mistaken for selected host");
  await page.getByLabel("로컬 개발 포트", { exact: true }).fill("3000");
  await page.getByRole("button", { name: "포트 주소 만들기" }).click();
  check(await page.getByRole("alert").count() === 1, "remote development port helper rejects host ambiguity");
  await page.setViewportSize({ width: 390, height: 844 });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "phone width has no horizontal page overflow");
  await page.screenshot({ path: `${evidence}/preview-phone-remote.png` });
  await Bun.write(`${evidence}/acceptance.json`, JSON.stringify({ exitCode: 0, checks, limits: ["Sentinel fixture checks layout non-mutation; actual PTY integration is not exercised.", "Cross-origin framing failure has no reliable JS signal; permanent notice is intentional.", "Remote forwarding/HMR and authenticated applications not supported."] }, null, 2));
  console.log(`PASS ${checks.length} browser acceptance checks`);
} finally { await browser.close(); await vite.close(); fixture.stop(true); }
