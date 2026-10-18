/** Real-browser check of the custom color picker: drag, hue, HEX and RGB fields, persistence, and no overflow. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser.ts';

const root = resolve(import.meta.dir, '..');
const evidence = resolve(process.env.DOCK_EVIDENCE ?? resolve(root, 'evidence/color-picker'));
mkdirSync(evidence, { recursive: true });
const vite = await createServer({ root, configFile: false, esbuild: { jsx: 'automatic' }, server: { host: '127.0.0.1', port: 0 },
  plugins: [{ name: 'color-picker-fixture', configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url !== '/color-test') return next();
      void server.transformIndexHtml('/color-test', '<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><div id="root"></div><script type="module" src="/scripts/color-picker-fixture.tsx"></script></body></html>')
        .then(html => { response.setHeader('Content-Type', 'text/html'); response.end(html); });
    });
  } }] });
await vite.listen();
const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
try {
  const url = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/color-test`;
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR' });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  // seed the language once: an init script runs on every load and would wipe what the reload must keep
  await page.addInitScript(() => { if (!localStorage.getItem('termweave:settings')) localStorage.setItem('termweave:settings', JSON.stringify({ language: 'ko' })); });
  await page.goto(url);
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('termweave:settings') ?? '{}').customColors?.accent as string | undefined);
  // a preset becomes editable from its own colors
  await page.getByRole('button', { name: '이 색을 직접 조정' }).click();
  const square = page.getByRole('slider', { name: '채도와 명도' });
  await square.waitFor();
  // top-right of the square at hue 0 is pure red
  await page.getByLabel('색상', { exact: true }).fill('0');
  const box = (await square.boundingBox())!;
  // press inside, drag past the corner: pointer capture keeps the drag, values clamp at 100%
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5); await page.mouse.down();
  await page.mouse.move(box.x + box.width + 40, box.y - 40, { steps: 4 }); await page.mouse.up();
  assert.equal(await stored(), '#ff0000', 'dragging to the top-right corner at hue 0 must store pure red');
  // keyboard: down arrow lowers brightness
  await square.focus(); await page.keyboard.press('Shift+ArrowDown');
  assert.equal(await stored(), '#e60000');
  // HEX and RGB fields write through
  const hex = page.getByLabel('강조 색상 HEX');
  await hex.fill('#3366cc');
  assert.equal(await stored(), '#3366cc');
  await page.getByLabel('강조 색상 G').fill('200');
  assert.equal(await stored(), '#33c8cc');
  // the CSS variables follow the stored color, and a reload keeps it
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()), '#33c8cc');
  await page.reload(); await page.getByRole('slider', { name: '채도와 명도' }).waitFor();
  assert.equal(await page.getByLabel('강조 색상 HEX').inputValue(), '#33c8cc');
  // another color is edited by choosing its swatch
  await page.getByRole('radio', { name: /배경/ }).first().click();
  assert.match(await page.getByRole('group').first().getAttribute('aria-label') ?? '', /배경/);
  assert.equal(await page.locator('.appearance-panel').count(), 1, 'the panel renders once');
  for (const width of [320, 375, 768, 1280]) {
    await page.getByLabel('배경 색상 HEX').or(page.getByLabel(/배경 HEX$/)).first().waitFor();
    const clipped = await page.evaluate(() => [...document.querySelectorAll<HTMLInputElement>('.color-picker input.input')].filter(input => input.scrollWidth > input.clientWidth + 1).map(input => input.getAttribute('aria-label')));
    assert.deepEqual(clipped, [], `clipped values at ${width}px`);
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `horizontal overflow at ${width}px: ${overflow}`);
    await page.screenshot({ path: resolve(evidence, `color-picker-${width}.png`), fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log(`PASS color picker (evidence ${evidence})`);
} finally { await browser.close(); await vite.close(); }
