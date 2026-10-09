import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { OwnedCleanup } from './cleanup.ts';
import { chromiumExecutable } from './browser.ts';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const root = resolve(import.meta.dir, '..');
const evidence = resolve(root, 'evidence/p2b', process.env.RENDER_LABEL ?? 'candidate');
// Reproduce the installed stack constraints without modifying any source CSS.
const stackBaseline = process.env.RENDER_STACK_BASELINE === '1';
const stackFix = '  flex: 1 1 0;\n  min-width: 0;\n  min-height: 0;\n  width: 100%;\n';
mkdirSync(evidence, { recursive: true });
const cleanup = new OwnedCleanup();
try {
const vite = await createServer({ root, configFile: false, esbuild: { jsx: 'automatic' },
  server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'installed-stack-baseline', enforce: 'pre',
    transform(source, id) {
      if (!stackBaseline || !id.endsWith('/src/components/PaneTerminal.css')) return null;
      assert.ok(source.includes(stackFix), 'Expected stack fix must exist for the controlled baseline');
      return source.replace(stackFix, '');
    },
  }, { name: 'synthetic-terminal-render', configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url !== '/render-test') return next();
      void server.transformIndexHtml('/render-test', '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><div id="root"></div><script type="module" src="/scripts/terminal-render-fixture.tsx"></script></body></html>').then(html => { response.setHeader('Content-Type', 'text/html'); response.end(html); });
    });
  } }] });
cleanup.add('vite', () => vite.close());
await vite.listen();
const address = vite.httpServer!.address() as { port: number };
const executablePath = chromiumExecutable();
if (!executablePath) throw new Error('Set CHROME_PATH to an installed Chromium executable');
const browser = await chromium.launch({ executablePath, headless: true });
cleanup.add('browser', () => browser.close());
const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, deviceScaleFactor: Number(process.env.RENDER_DPR ?? 1) });
const errors: string[] = [], measurements: unknown[] = [], failures: string[] = [];
page.on('pageerror', error => { errors.push(error.message); console.error('FIXTURE_PAGE_ERROR', error.message); });
await page.addInitScript(() => {
  localStorage.setItem('termweave:direct-typing', '1');
  const frames: any[] = [], sockets: any[] = [];
  class MockSocket extends EventTarget {
    static OPEN = 1; static CONNECTING = 0; readyState = 0;
    constructor(public url: string) { super(); sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); this.emit({ type: 'snapshot', features: ['input-ready'], panes: [], workspaces: [] }); }); }
    emit(message: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })); }
    send(text: string) {
      const message = JSON.parse(text); frames.push({ ...message, at: performance.now() });
      if (message.type === 'role') this.emit({ type: 'role-ack', mode: message.mode });
      if (message.type === 'attach' || message.type === 'resize') {
        this.emit({ type: 'input-ready', pane_id: message.pane_id, ready: true });
        const cols = message.cols, rows = message.rows;
        let data = '\x1b[2J\x1b[HASCII 한국어 中文 日本語 😀 \x1b[31mANSI\x1b[0m';
        for (let row = 2; row <= rows; row++) data += `\x1b[${row};1H${row === rows ? 'LAST-ROW' : 'synthetic multiline'}\x1b[${row};${cols}H#`;
        this.emit({ type: 'pty-data', pane_id: message.pane_id, data });
      }
    }
    close() { this.readyState = 3; }
  }
  Object.assign(window, { WebSocket: MockSocket, renderFrames: frames, renderSockets: sockets });
});
await page.route('**/api/**', route => route.fulfill({ json: { text: '', messages: [], prompt: null } }));
const measure = async (label: string, settled = true) => {
  if (settled) await page.waitForTimeout(500);
  const result = await page.evaluate(() => {
    const rect = (node: Element) => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth }; };
    return Array.from(document.querySelectorAll('.dock-group')).map(group => {
      const body = group.querySelector('.dock-drop-body')!, stack = group.querySelector('.terminal-stack')!, mount = group.querySelector('.pane-terminal')!, screen = group.querySelector('.xterm-screen')!;
      const term = (window as any).renderTerms.find((term: any) => term.element?.isConnected && group.contains(term.element));
      const pane = group.getAttribute('data-fixture-pane');
      const geometry = (window as any).renderFrames.filter((frame: any) => ['resize', 'attach'].includes(frame.type) && frame.pane_id === pane).at(-1);
      return { pane, body: rect(body), stack: rect(stack), mount: rect(mount), screen: rect(screen), cols: term?.cols, rows: term?.rows, geometry,
        lastLine: term?.buffer.active.getLine(term.buffer.active.baseY + term.rows - 1)?.translateToString(true), adopted: mount.hasAttribute('data-adopted-grid') };
    });
  });
  measurements.push({ label, result });
  if (settled) for (const value of result) {
    if (!value.adopted && (value.stack.right > value.body.right + 1 || value.stack.bottom > value.body.bottom + 1 || value.mount.right > value.body.right + 1 || value.mount.bottom > value.body.bottom + 1 || value.screen.right > value.mount.right + 1 || value.screen.bottom > value.mount.bottom + 1)) failures.push(`${label}: clipped ${value.pane}`);
    if (!value.adopted && (value.cols !== value.geometry?.cols || value.rows !== value.geometry?.rows)) failures.push(`${label}: grid frame mismatch`);
    if (!value.lastLine?.includes('#')) failures.push(`${label}: last column sentinel missing`);
    if (!value.lastLine?.startsWith('LAST-ROW')) failures.push(`${label}: dynamic last row missing`);
  }
  await page.screenshot({ path: resolve(evidence, `${label}.png`) });
};
  await page.goto(`http://127.0.0.1:${address.port}/render-test`);
  await page.locator('.xterm-screen').waitFor(); await page.evaluate(() => document.fonts.ready);
  await measure('single-initial');
  await page.setViewportSize({ width: 650, height: 800 }); await measure('single-shrink');
  await page.setViewportSize({ width: 1440, height: 950 }); await measure('single-expand');
  await page.getByRole('button', { name: 'Columns', exact: true }).click(); await measure('columns-initial');
  for (const ratio of [0.8, 0.2, 0.5]) {
    const divider = page.locator('.dock-divider'); const bounds = await page.locator('.dock-split').boundingBox(); const box = await divider.boundingBox(); assert.ok(bounds && box);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * ratio, box.y + box.height / 2); await page.mouse.up();
    await measure(`slider-${ratio}-immediate`, false); await page.waitForTimeout(150); await measure(`slider-${ratio}-150ms`, false); await measure(`slider-${ratio}-settled`);
  }
  await page.getByRole('button', { name: 'Single', exact: true }).click(); await measure('split-to-single');
  await page.getByRole('button', { name: 'Tab', exact: true }).click(); await measure('tab-change');
  await page.getByRole('button', { name: 'Font', exact: true }).click(); await measure('font-change');
  await page.getByRole('button', { name: 'Rows', exact: true }).click(); await measure('rows-initial');
  for (const ratio of [0.8, 0.2, 0.5]) {
    const divider = page.locator('.dock-divider'), bounds = await page.locator('.dock-split').boundingBox(), box = await divider.boundingBox(); assert.ok(bounds && box);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2, bounds.y + bounds.height * ratio); await page.mouse.up(); await measure(`rows-${ratio}`);
  }
  await page.getByRole('button', { name: 'Zoom', exact: true }).click(); await measure('zoom');
  await page.getByRole('button', { name: 'Zoom', exact: true }).click(); await measure('zoom-return');
  await page.getByRole('button', { name: 'Single', exact: true }).click(); await page.setViewportSize({ width: 390, height: 844 }); await measure('mobile-single');
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('synthetic-input'); await page.keyboard.press('Enter'); await page.keyboard.type('second-line');
  const sentInput = await page.evaluate(() => (window as any).renderFrames.filter((frame: any) => frame.type === 'input').map((frame: any) => frame.text).join(''));
  assert.ok(sentInput.includes('synthetic-input\rsecond-line'));
  const localCols = await page.evaluate(() => (window as any).renderTerms.find((term: any) => term.element?.isConnected)?.cols);
  const sharedBefore = await page.evaluate(() => (window as any).renderFrames.filter((frame: any) => frame.type === 'resize').length);
  await page.evaluate(() => { for (const socket of (window as any).renderSockets) { socket.emit({ type: 'pane-geometry', pane_id: 'synthetic-b', cols: 160, rows: 45 }); socket.emit({ type: 'pty-data', pane_id: 'synthetic-b', data: '\x1b[2J\x1b[45;1HLAST-ROW\x1b[45;160H#' }); } });
  await page.waitForTimeout(200);
  const interactShared = await page.evaluate(() => ({ cols: (window as any).renderTerms.find((term: any) => term.element?.isConnected)?.cols,
    frames: (window as any).renderFrames.filter((frame: any) => frame.type === 'resize').length }));
  assert.equal(interactShared.cols, localCols); assert.equal(interactShared.frames, sharedBefore);
  measurements.push({ label: 'interact-shared-geometry-policy', interactShared });
  await page.getByRole('button', { name: 'Role', exact: true }).click();
  const before = await page.evaluate(() => (window as any).renderFrames.filter((frame: any) => frame.type === 'resize').length);
  await page.evaluate(() => { for (const socket of (window as any).renderSockets) { socket.emit({ type: 'pane-geometry', pane_id: 'synthetic-b', cols: 160, rows: 45 }); socket.emit({ type: 'pty-data', pane_id: 'synthetic-b', data: '\x1b[2J\x1b[45;1HLAST-ROW\x1b[45;160H#' }); } });
  await page.waitForTimeout(200);
  const observe = await page.evaluate(() => ({ frames: (window as any).renderFrames.filter((frame: any) => frame.type === 'resize').length,
    cols: (window as any).renderTerms.find((term: any) => term.element?.isConnected)?.cols,
    overflow: getComputedStyle(document.querySelector('.pane-terminal')!).overflow }));
  assert.equal(observe.frames, before); assert.equal(observe.cols, 160); assert.equal(observe.overflow, 'auto');
  const scroll = await page.locator('.pane-terminal').evaluate(node => { node.scrollLeft = node.scrollWidth; return { left: node.scrollLeft, width: node.clientWidth, total: node.scrollWidth }; });
  if (!(scroll.left > 0 && scroll.left + scroll.width >= scroll.total - 1)) failures.push('observe: adopted last column is not scroll-accessible');
  const observeCell = await page.evaluate(() => { const term = (window as any).renderTerms.find((term: any) => term.element?.isConnected); const node = document.querySelector('.pane-terminal')!; node.scrollTop = node.scrollHeight; return { cell: term.buffer.active.getLine(term.buffer.active.baseY + 44)?.getCell(159)?.getChars(), row: term.buffer.active.getLine(term.buffer.active.baseY + 44)?.translateToString(true), bottom: node.scrollTop + node.clientHeight >= node.scrollHeight - 1 }; });
  if (observeCell.cell !== '#' || !observeCell.row.startsWith('LAST-ROW') || !observeCell.bottom) failures.push('observe: adopted last row/cell not reachable');
  measurements.push({ label: 'observe-adopted-grid', observe, scroll, observeCell });
  await page.getByRole('button', { name: 'Role', exact: true }).click(); await measure('interact-return');
  const fixedBefore = await page.evaluate(() => (window as any).renderFrames.filter((frame: any) => frame.type === 'resize').length);
  await page.evaluate(() => { for (const socket of (window as any).renderSockets) { socket.emit({ type: 'pane-geometry', pane_id: 'synthetic-b', cols: 140, rows: 40, fixed: true }); socket.emit({ type: 'pty-data', pane_id: 'synthetic-b', data: '\x1b[2J\x1b[40;1HLAST-ROW\x1b[40;140H#' }); } });
  await page.waitForTimeout(200); await page.setViewportSize({ width: 420, height: 844 }); await page.waitForTimeout(500);
  const fixed = await page.evaluate(() => ({ cols: (window as any).renderTerms.find((term: any) => term.element?.isConnected)?.cols,
    frames: (window as any).renderFrames.filter((frame: any) => frame.type === 'resize').length, overflow: getComputedStyle(document.querySelector('.pane-terminal')!).overflow }));
  assert.equal(fixed.cols, 140); assert.equal(fixed.frames, fixedBefore); assert.equal(fixed.overflow, 'auto');
  const fixedLastCell = await page.evaluate(() => { const term = (window as any).renderTerms.find((term: any) => term.element?.isConnected); const node = document.querySelector('.pane-terminal')!; node.scrollLeft = node.scrollWidth; node.scrollTop = node.scrollHeight; return { cell: term.buffer.active.getLine(term.buffer.active.baseY + 39)?.getCell(139)?.getChars(), row: term.buffer.active.getLine(term.buffer.active.baseY + 39)?.translateToString(true), rightReachable: node.scrollLeft + node.clientWidth >= node.scrollWidth - 1, bottomReachable: node.scrollTop + node.clientHeight >= node.scrollHeight - 1 }; });
  if (fixedLastCell.cell !== '#' || !fixedLastCell.row.startsWith('LAST-ROW') || !fixedLastCell.rightReachable || !fixedLastCell.bottomReachable) failures.push('fixed: adopted last cell not reachable');
  measurements.push({ label: 'fixed-mirror-grid-preserved', fixed, fixedLastCell });
  assert.deepEqual(errors, []);
  writeFileSync(resolve(evidence, 'execution-manifest.json'), JSON.stringify(Object.fromEntries(['scripts/terminal-render-fixture.tsx', 'scripts/terminal-render-regression.ts', 'src/components/PaneTerminal.tsx', 'src/components/PaneTerminal.css', 'src/components/DockLayout.css', 'src/components/SplitTerminals.css', 'src/lib/terminalWidths.ts', 'src/lib/terminalGlyphs.ts'].map(path => [path, createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')])), null, 2));
  writeFileSync(resolve(evidence, 'result.json'), JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', stackBaseline, effectiveCssSha256: createHash('sha256').update(stackBaseline ? readFileSync(resolve(root, 'src/components/PaneTerminal.css'), 'utf8').replace(stackFix, '') : readFileSync(resolve(root, 'src/components/PaneTerminal.css'))).digest('hex'), failures, errors, measurements }, null, 2));
  assert.deepEqual(failures, [], 'terminal bounds must contain the last row and column');
  console.log('PASS synthetic terminal render: single/split/slider/tab/font/zoom/mobile/observe');
} finally {
  const results = await cleanup.run();
  writeFileSync(resolve(evidence, 'cleanup.json'), JSON.stringify(results, null, 2));
  if (results.some(result => result.status === 'FAIL')) throw new Error('Owned render cleanup failed');
}
