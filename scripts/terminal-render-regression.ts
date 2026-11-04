import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { OwnedCleanup } from './cleanup.ts';
import { chromiumExecutable } from './browser.ts';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createServer as createNetServer, type Socket as NetSocket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, normalizePath, type Plugin } from 'vite';
import { chromium, type Browser, type CDPSession, type Page } from 'playwright-core';
import { mirrorFrame, mirrorRows } from '../server/mirror.ts';
import { OUTPUT_HARD_BYTES, OUTPUT_HIGH_BYTES, OUTPUT_STALL_MS } from '../server/output-window.ts';
import { COMPOSITION_SETTLE_MS } from '../src/lib/mirrorInputPolicy.ts';

const root = resolve(import.meta.dir, '..');
const evidence = resolve(root, 'evidence/p2b', process.env.RENDER_LABEL ?? 'candidate');
// Reproduce the installed stack constraints without modifying any source CSS.
const stackBaseline = process.env.RENDER_STACK_BASELINE === '1';
const stackFix = '  flex: 1 1 0;\n  min-width: 0;\n  min-height: 0;\n  width: 100%;\n';
// Test-only modes: --input-policy runs the mirror input/IME guard lane instead of the render lane;
// --negative-control runs it against a PaneTerminal with those connections cut and expects them red.
// --input-policy --mirror-flow runs the lane of a mirror's output held while the IME composes instead.
const args = process.argv.slice(2);
const unknownArgs = args.filter(arg => !['--input-policy', '--negative-control', '--mirror-flow'].includes(arg));
if (unknownArgs.length) throw new Error(`Unknown arguments: ${unknownArgs.join(' ')}`);
if (args.includes('--negative-control') && !args.includes('--input-policy')) throw new Error('--negative-control applies to --input-policy only');
if (args.includes('--mirror-flow') && !args.includes('--input-policy')) throw new Error('--mirror-flow applies to --input-policy only');

async function renderRegression(): Promise<void> {
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
}

// --input-policy: the real PaneTerminal, mounted over a mock HerdrSocket transport as a mirror
// (pane-geometry fixed) or an attach grid. What reaches the socket as `input` frames is observed.
const INPUT_POLICY_PANE = 'policy-pane';
const INPUT_POLICY_QUERIES = '\x1b[?1004h\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b[5n\x1b[6n\x1b[?6n\x1b[c\x1b[>c';
/** what xterm 5.5 answers to the queries, a blur+focus and a middle click (attach keeps every one) */
const INPUT_POLICY_REPLIES = [/\x1b\[0n/, /\x1b\[\d+;\d+R/, /\x1b\[\?\d+;\d+R/, /\x1b\[\?1;2c/, /\x1b\[>0;276;0c/, /\x1b\[O/, /\x1b\[I/, /\x1b\[<1;\d+;\d+M/, /\x1b\[<1;\d+;\d+m/];
const INPUT_POLICY_PASTE = '붙여넣기 \x1b[I reply-shaped\nnext line';
/** abc, ArrowUp, Enter, Ctrl+C, Shift+F3 (a cursor report's shape), an IME-composed 한, a bracketed paste */
const INPUT_POLICY_TYPED = `abc\x1b[A\r\x03\x1b[1;2R한\x1b[200~${INPUT_POLICY_PASTE.replace(/\n/g, '\r')}\x1b[201~`;
/** the PaneTerminal connections the negative control cuts (Vite transform only; the source stays) */
const INPUT_POLICY_CUTS = [
  { name: 'mirror-filter', from: 'filterMirrorInput(mirrorInput, data)', to: '{ send: data, state: mirrorInput }' },
  { name: 'composition-guard', from: 'compositionSettled(compositionRef.current, performance.now())', to: 'true' },
] as const;
type InputPolicyCut = typeof INPUT_POLICY_CUTS[number]['name'];
type InputPolicyCheck = (name: string, cut: InputPolicyCut | null, ok: boolean, detail: unknown) => void;
const INPUT_POLICY_FIXTURE = `import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { PaneTerminal } from '../src/components/PaneTerminal.tsx';
import { SettingsProvider } from '../src/lib/settings.ts';
import '../src/styles.css';

const policy = (window as any).policy;
const open = Terminal.prototype.open;
Terminal.prototype.open = function (parent) { policy.terms.push(this); return open.call(this, parent); };
const reset = Terminal.prototype.reset;
Terminal.prototype.reset = function () { policy.resets++; return reset.call(this); };
function Fixture() {
  const [autoSelected, setAutoSelected] = useState(false);
  policy.setAutoSelected = setAutoSelected;
  useEffect(() => { policy.autoSelected.push(autoSelected); }, [autoSelected]);
  return <main style={{ height: '100dvh', width: '100%' }}><PaneTerminal paneId="${INPUT_POLICY_PANE}" view="terminal" terminalFontSize={14}
    terminalWheelSpeed={1} terminalLineHeight={1} terminalFontFamily="" theme="dark" palette="amber" role="interact" autoSelected={autoSelected} /></main>;
}
createRoot(document.getElementById('root')!).render(<SettingsProvider><Fixture /></SettingsProvider>);
`;

async function inputPolicyRegression(negative: boolean): Promise<void> {
  const out = resolve(root, 'evidence/input-policy', negative ? 'negative-control' : 'candidate');
  mkdirSync(out, { recursive: true });
  const fixtureId = normalizePath(resolve(root, 'scripts/input-policy-fixture.tsx'));
  const paneTerminalId = normalizePath(resolve(root, 'src/components/PaneTerminal.tsx'));
  const applied = new Set<InputPolicyCut>();
  const checks: { name: string; cut: InputPolicyCut | null; ok: boolean; detail: unknown }[] = [], errors: string[] = [];
  const check: InputPolicyCheck = (name, cut, ok, detail) => {
    checks.push({ name, cut, ok, detail });
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${cut ? ` [${cut}]` : ''} ${JSON.stringify(detail)}`);
  };
  const plugin: Plugin = { name: 'input-policy-fixture', enforce: 'pre',
    resolveId(id) { return id === '/scripts/input-policy-fixture.tsx' ? fixtureId : null; },
    load(id) { return id === fixtureId ? INPUT_POLICY_FIXTURE : null; },
    transform(source, id) {
      if (!negative || id.split('?')[0] !== paneTerminalId) return null;
      let cut = source;
      for (const { name, from, to } of INPUT_POLICY_CUTS) {
        const found = cut.split(from).length - 1;
        // a missing connection is a broken control, never a red
        if (found !== 1) throw new Error(`negative control: ${name} connection found ${found} times in PaneTerminal.tsx`);
        cut = cut.replace(from, to);
        applied.add(name);
      }
      return cut;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith('/input-policy-test')) return next();
        void server.transformIndexHtml(request.url, '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><div id="root"></div><script type="module" src="/scripts/input-policy-fixture.tsx"></script></body></html>')
          .then(html => { response.setHeader('Content-Type', 'text/html'); response.end(html); });
      });
    } };
  const cleanup = new OwnedCleanup();
  let failure: unknown = null;
  try {
    // its own dependency cache, like the mirror-flow lane: a shared one re-optimized by another lane's config reloads this lane's pages mid-guard
    const vite = await createServer({ root, configFile: false, logLevel: 'warn', cacheDir: join(root, 'node_modules', '.vite-input-policy'), esbuild: { jsx: 'automatic' }, server: { host: '127.0.0.1', port: 0 }, plugins: [plugin] });
    cleanup.add('vite', () => vite.close());
    await vite.listen();
    const port = (vite.httpServer!.address() as { port: number }).port;
    const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
    cleanup.add('browser', () => browser.close());
    for (const mode of ['mirror', 'attach'] as const) {
      const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
      cleanup.add(`context-${mode}`, () => context.close());
      const page = await context.newPage();
      page.on('pageerror', error => { errors.push(`${mode}: ${error.stack ?? error.message}`); console.error('FIXTURE_PAGE_ERROR', error.stack ?? error.message); });
      await page.addInitScript(inputPolicyInit, { pane: INPUT_POLICY_PANE, mirror: mode === 'mirror' });
      await page.route('**/api/**', route => route.fulfill({ json: { text: '', messages: [], prompt: null } }));
      await page.goto(`http://127.0.0.1:${port}/input-policy-test?mode=${mode}`);
      await until(page, () => { const policy = (window as any).policy; return policy.terms[0]?.buffer.active.getLine(0)?.translateToString().includes('POLICY') && policy.frames.some((frame: any) => frame.type === 'input-ready-sent'); }, `${mode} fixture screen`);
      const adopted = await page.locator('.pane-terminal').evaluate(node => node.hasAttribute('data-adopted-grid'));
      check(`${mode}-fixture-mode`, null, adopted === (mode === 'mirror'), { adopted });
      const textarea = page.locator('.xterm-helper-textarea');
      await textarea.focus();
      const cdp = await context.newCDPSession(page);

      // xterm's own answers: the queries in the screen, a blur+focus, a middle click
      let from = await frameCount(page);
      const pastesFrom = await page.evaluate(() => (window as any).policy.pastes.length as number);
      await emit(page, { type: 'pty-data', pane_id: INPUT_POLICY_PANE, data: INPUT_POLICY_QUERIES });
      await until(page, () => { const modes = (window as any).policy.terms[0].modes; return modes.sendFocusMode && modes.bracketedPasteMode && modes.mouseTrackingMode === 'vt200'; }, `${mode} query modes`);
      await page.evaluate(() => { const node = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')!; node.blur(); node.focus(); });
      const screen = await page.locator('.xterm-screen').boundingBox();
      assert.ok(screen, 'xterm screen has no box');
      await page.mouse.click(screen.x + 40, screen.y + 30, { button: 'middle' });
      await Bun.sleep(300);
      const replies = await sentSince(page, from);
      // Linux only: Chromium pastes the PRIMARY selection (empty here) on a middle click, xterm moving its textarea under the
      // pointer for it. That paste is the user's and passes in both modes, bracketed (2004 is on): it is the only input allowed.
      const pastes = await page.evaluate(start => (window as any).policy.pastes.slice(start) as { trusted: boolean; text: string }[], pastesFrom);
      const gesture = pastes.map(paste => `\x1b[200~${paste.text.replace(/\r?\n/g, '\r')}\x1b[201~`).join('');
      const gestureOk = pastes.every(paste => paste.trusted) && (process.platform === 'linux' ? pastes.length <= 1 : pastes.length === 0);
      if (mode === 'mirror') check('mirror-replies-dropped', 'mirror-filter', gestureOk && replies === gesture, { sent: replies, pastes });
      else {
        const missing = INPUT_POLICY_REPLIES.filter(reply => !reply.test(replies)).map(String);
        check('attach-replies-kept', null, missing.length === 0, { sent: replies, missing });
      }

      // typed input, the same in both modes
      from = await frameCount(page);
      await page.keyboard.type('abc');
      for (const key of ['ArrowUp', 'Enter', 'Control+c', 'Shift+F3']) await page.keyboard.press(key);
      for (const text of ['ㅎ', '하', '한']) await cdp.send('Input.imeSetComposition', { text, selectionStart: 1, selectionEnd: 1 });
      await cdp.send('Input.insertText', { text: '한' });
      await Bun.sleep(100);
      await textarea.evaluate((node, text) => {
        const data = new DataTransfer();
        data.setData('text/plain', text);
        node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      }, INPUT_POLICY_PASTE);
      await Bun.sleep(200);
      const typed = await sentSince(page, from);
      check(`${mode}-typed-input-identical`, null, typed === INPUT_POLICY_TYPED, { sent: typed, expected: INPUT_POLICY_TYPED });

      if (mode === 'mirror') await compositionGuard(page, cdp, check);
      await cdp.detach();
    }
    if (negative) assert.deepEqual([...applied].sort(), INPUT_POLICY_CUTS.map(cut => cut.name).sort(), 'negative control: every cut must reach the served PaneTerminal');
  } catch (error) {
    failure = error;
  } finally {
    const results = await cleanup.run();
    if (results.some(result => result.status === 'FAIL')) failure ??= new Error(`Owned input-policy cleanup failed: ${JSON.stringify(results)}`);
  }
  const red = checks.filter(entry => !entry.ok);
  // The control is red for the right reason: every check of a cut connection fails, everything else
  // (fixture mode, attach replies, typed input, the 350 ms release) still passes, and no page errors.
  const expectedRed = checks.filter(entry => entry.cut !== null);
  const status = failure !== null || errors.length ? 'ERROR'
    : negative ? (expectedRed.length > 0 && red.length === expectedRed.length && red.every(entry => entry.cut !== null) ? 'EXPECTED_RED' : 'CONTROL_FAILED')
      : red.length ? 'FAIL' : 'PASS';
  writeFileSync(resolve(out, 'result.json'), JSON.stringify({ status, negative, cuts: negative ? INPUT_POLICY_CUTS : [], applied: [...applied],
    checks, errors, failure: failure === null ? null : String(failure instanceof Error ? failure.stack : failure) }, null, 2));
  if (failure !== null) throw failure;
  assert.deepEqual(errors, [], 'input-policy fixture page errors');
  if (negative) {
    assert.equal(status, 'EXPECTED_RED', `negative control did not turn exactly the cut checks red: ${JSON.stringify(red.map(entry => entry.name))}`);
    console.log(`PASS input-policy negative control: red as expected ${red.map(entry => entry.name).join(', ')} (evidence ${out})`);
  } else {
    assert.deepEqual(red.map(entry => entry.name), [], 'input-policy checks failed');
    console.log(`PASS input policy: ${checks.length} checks (evidence ${out})`);
  }
}

/**
 * Inside the IME's span (compositionstart until compositionend + 350 ms) a reset and a real blur/focus
 * must wait; at 350 ms they run. Page time is a paused Playwright clock, so 349 and 350 are exact.
 */
async function compositionGuard(page: Page, cdp: CDPSession, check: InputPolicyCheck): Promise<void> {
  await emit(page, { type: 'error', code: 'output_stalled', message: 'synthetic stall', pane_id: INPUT_POLICY_PANE });
  // the stalled-output banner's Reconnect (its label follows the browser's language)
  const reconnect = page.locator('.terminal-banner-output-error button');
  await reconnect.waitFor();
  await page.locator('.xterm-helper-textarea').focus();
  // The typed input's composition armed PaneTerminal's settle timer on the real clock moments ago. Once the paused
  // clock replaces setTimeout/clearTimeout, the guard's compositionstart cannot cancel that timer: it would fire inside
  // the guard's own span and end it early. A real timer of the same delay set after it runs after it (HTML timer
  // ordering), so the clock is installed once every span the page had before is settled.
  await page.evaluate(ms => new Promise(settled => setTimeout(settled, ms)), COMPOSITION_SETTLE_MS);
  await page.clock.install();
  await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000);
  const base = await probe(page);
  const delta = async () => {
    const now = await probe(page);
    return { resets: now.resets - base.resets, attaches: now.attaches - base.attaches, focus: now.focus - base.focus, blur: now.blur - base.blur,
      synthetic: now.synthetic - base.synthetic, compositionEnds: now.compositionEnds - base.compositionEnds };
  };

  await cdp.send('Input.imeSetComposition', { text: '한', selectionStart: 1, selectionEnd: 1 });
  await reconnect.evaluate(node => (node as HTMLButtonElement).click()); // a click that leaves the IME's focus alone
  await requestFocus(page);
  const composing = await delta();
  check('guard-composing-no-reset', 'composition-guard', composing.resets === 0 && composing.attaches === 0, composing);
  check('guard-composing-no-real-blur-focus', 'composition-guard', composing.focus === 0 && composing.blur === 0, composing);
  check('guard-composing-synthetic-focus', 'composition-guard', composing.synthetic >= 1, composing);

  await cdp.send('Input.insertText', { text: '한' });
  const ended = await delta();
  check('guard-compositionend-seen', null, ended.compositionEnds === 1, ended);
  await page.clock.runFor(349);
  await requestFocus(page);
  const at349 = await delta();
  check('guard-349ms-no-reset', 'composition-guard', at349.resets === 0 && at349.attaches === 0, at349);
  check('guard-349ms-no-real-blur-focus', 'composition-guard', at349.focus === 0 && at349.blur === 0, at349);

  await page.clock.runFor(1);
  await requestFocus(page);
  const at350 = await delta();
  check('guard-350ms-reset-released', null, at350.resets === 1 && at350.attaches === 1, at350);
  check('guard-350ms-focus-released', null, at350.focus >= 1 && at350.blur === 0, at350);
}

/** Runs in the page before its scripts: a mock WebSocket transport and focus/blur/composition probes. */
function inputPolicyInit({ pane, mirror }: { pane: string; mirror: boolean }): void {
  localStorage.setItem('termweave:direct-typing', '1');
  const policy: any = { frames: [], sockets: [], terms: [], resets: 0, autoSelected: [], calls: { focus: 0, blur: 0, synthetic: 0 }, compositionEnds: 0, pastes: [] };
  (window as any).policy = policy;
  for (const name of ['focus', 'blur'] as const) {
    const original = HTMLElement.prototype[name];
    HTMLElement.prototype[name] = function (this: HTMLElement, ...rest: any[]) {
      if (this.classList.contains('xterm-helper-textarea')) policy.calls[name]++;
      return (original as any).apply(this, rest);
    };
  }
  document.addEventListener('focus', event => { if (!event.isTrusted && (event.target as Element)?.classList?.contains('xterm-helper-textarea')) policy.calls.synthetic++; }, true);
  document.addEventListener('compositionend', () => { policy.compositionEnds++; }, true);
  document.addEventListener('paste', event => { policy.pastes.push({ trusted: event.isTrusted, text: event.clipboardData?.getData('text/plain') ?? '' }); }, true);
  class MockSocket extends EventTarget {
    static OPEN = 1; static CONNECTING = 0; readyState = 0;
    constructor(public url: string) {
      super(); policy.sockets.push(this);
      queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); this.emit({ type: 'snapshot', features: ['input-ready'], panes: [], workspaces: [] }); });
    }
    emit(message: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })); }
    send(text: string) {
      const message = JSON.parse(text);
      policy.frames.push(message);
      if (message.type === 'role') this.emit({ type: 'role-ack', mode: message.mode });
      if (message.type === 'attach' && message.pane_id === pane) {
        this.emit({ type: 'input-ready', pane_id: pane, ready: true });
        policy.frames.push({ type: 'input-ready-sent' });
        // a mirror's grid is the pane's own in herdr: every client adopts it
        if (mirror) this.emit({ type: 'pane-geometry', pane_id: pane, cols: 100, rows: 30, fixed: true });
        this.emit({ type: 'pty-data', pane_id: pane, data: `\x1b[2J\x1b[HPOLICY ${mirror ? 'mirror' : 'attach'} screen 한국어` });
      }
    }
    close() { this.readyState = 3; }
  }
  Object.assign(window, { WebSocket: MockSocket });
}

// --input-policy --mirror-flow: a mirror's frames while the IME composes (src/lib/mirrorCompositionBuffer.ts), in the
// real PaneTerminal. Exact frames made by server/mirror.ts over a mock transport (a paused page clock for the 349/350 ms
// edge), then the real, unchanged server (createServer, OutputWindow, MirrorSession) behind Vite's /ws proxy, fed by a
// stand-in herdr on its own socket: no herdr is reached, the frames, stream ids, offsets and flow control are the
// server's own. --negative-control serves one cut connection at a time (a Vite transform; the sources stay as they are)
// and expects exactly the checks of that connection red.
const MIRROR_FLOW_PANE = 'mirror-pane';
const MIRROR_FLOW_OTHER_PANE = 'mirror-pane-two';
const MIRROR_FLOW_CUTS = [
  // frames are written straight into the grid while the IME composes, as before the hold
  { name: 'hold-guard', file: 'src/components/PaneTerminal.tsx', edits: [{ from: 'fixedGridRef.current && (heldScreenRef.current !== null || !imeSettled())', to: 'false' }] },
  // the hold keeps the last raw frame instead of the screen the frames make
  { name: 'last-raw', file: 'src/lib/mirrorCompositionBuffer.ts', edits: [
    { from: 'const frame = parseMirrorFrame(data);', to: '(this as any).lastRaw = data; return { ok: true };' },
    { from: 'const { whole, rows, last } = this;', to: "const lastRaw: string = (this as any).lastRaw ?? ''; (this as any).lastRaw = undefined; return lastRaw;" },
  ] },
  // a held frame is not acknowledged until it is written
  { name: 'ack-hold', file: 'src/components/PaneTerminal.tsx', edits: [{ from: 'if (result.ok) acknowledge?.();', to: 'if (result.ok) void acknowledge;' }] },
] as const;
type MirrorFlowCut = typeof MIRROR_FLOW_CUTS[number]['name'];
type MirrorFlowCheck = (name: string, cuts: readonly MirrorFlowCut[], ok: boolean, detail: unknown) => void;
type MirrorFlowEntry = { name: string; cuts: readonly MirrorFlowCut[]; ok: boolean; detail: any };
const MIRROR_FLOW_FIXTURE = `import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { PaneTerminal } from '../src/components/PaneTerminal.tsx';
import { SettingsProvider } from '../src/lib/settings.ts';
import { MirrorCompositionBuffer } from '../src/lib/mirrorCompositionBuffer.ts';
import '../src/styles.css';

const flow = (window as any).flow;
const open = Terminal.prototype.open;
Terminal.prototype.open = function (parent) { flow.terms.push(this); return open.call(this, parent); };
for (const name of ['write', 'writeln'] as const) {
  const original = Terminal.prototype[name] as any;
  (Terminal.prototype as any)[name] = function (data: any, callback?: () => void) {
    if (data !== '') flow.writes.push({ at: performance.now(), kind: name, data: typeof data === 'string' ? data : '[bytes]' });
    return original.call(this, data, callback);
  };
}
for (const name of ['reset', 'clear'] as const) {
  const original = Terminal.prototype[name];
  Terminal.prototype[name] = function () { flow.clears.push({ at: performance.now(), kind: name }); return original.call(this); };
}
const absorb = MirrorCompositionBuffer.prototype.absorb;
MirrorCompositionBuffer.prototype.absorb = function (data: string, gridRows: number) {
  const result = absorb.call(this, data, gridRows);
  flow.absorbs.push({ at: performance.now(), ok: result.ok, bytes: this.bytes, rows: this.heldRows, gridRows });
  return result;
};
/** resolves once xterm has parsed everything written before it (an empty write is not logged) */
flow.flush = () => new Promise<void>(resolve => flow.terms[0].write('', resolve));
/** the visible grid cell by cell: text, width, colours and attributes, and the cursor */
flow.dump = () => {
  const term = flow.terms[0];
  const buffer = term.buffer.active;
  const cell = buffer.getNullCell();
  const text: string[] = [], cells: string[] = [];
  for (let y = 0; y < term.rows; y++) {
    const line = buffer.getLine(buffer.baseY + y);
    text.push(line?.translateToString(true) ?? '');
    const row: string[] = [];
    for (let x = 0; x < term.cols; x++) {
      if (!line?.getCell(x, cell)) { row.push(''); continue; }
      row.push([cell.getChars(), cell.getWidth(), cell.getFgColorMode(), cell.getFgColor(), cell.getBgColorMode(), cell.getBgColor(), cell.isBold(), cell.isItalic(),
        cell.isDim(), cell.isUnderline(), cell.isInverse(), cell.isInvisible(), cell.isStrikethrough(), cell.isOverline?.()].join(','));
    }
    cells.push(row.join('|'));
  }
  return { cols: term.cols, rows: term.rows, cursorX: buffer.cursorX, cursorY: buffer.cursorY, text, cells };
};
function Fixture() {
  const [pane, setPane] = useState(flow.pane);
  flow.setPane = setPane;
  return <main style={{ height: '100dvh', width: '100%' }}><PaneTerminal paneId={pane} view="terminal" terminalFontSize={14}
    terminalWheelSpeed={1} terminalLineHeight={1} terminalFontFamily="" theme="dark" palette="amber" role="interact" /></main>;
}
createRoot(document.getElementById('root')!).render(<SettingsProvider><Fixture /></SettingsProvider>);
`;

type MirrorFlowConfig = { pane: string; mock: { cols: number; rows: number; screens: Record<string, string> } | null };

/** Runs in the page before its scripts: the probes, and a mock transport (`mock`) or the real WebSocket, recorded. */
function mirrorFlowInit({ pane, mock }: MirrorFlowConfig): void {
  localStorage.setItem('termweave:direct-typing', '1');
  const utf8 = (text: string) => new TextEncoder().encode(text).length;
  const flow: any = { pane, terms: [], writes: [], clears: [], absorbs: [], compositions: [], errors: [], frames: [], received: [], acks: [], closes: [], sockets: [], streams: 0,
    screens: mock?.screens ?? {} };
  (window as any).flow = flow;
  for (const type of ['compositionstart', 'compositionend']) document.addEventListener(type, () => flow.compositions.push({ type, at: performance.now() }), true);
  const consoleError = console.error.bind(console);
  console.error = (...rest: unknown[]) => { flow.errors.push(rest.map(String).join(' ')); consoleError(...rest); };
  if (mock === null) {
    const Native = window.WebSocket;
    class RecordedSocket extends Native {
      recorded = false;
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (new URL(String(url), location.href).pathname !== '/ws') return;
        this.recorded = true;
        flow.sockets.push(this);
        this.addEventListener('message', event => {
          const message = JSON.parse(String(event.data));
          if (message.type === 'pty-data' && message.flow) flow.received.push({ at: performance.now(), stream: message.flow.stream_id, offset: message.flow.offset, bytes: utf8(message.data) });
        });
        this.addEventListener('close', event => flow.closes.push({ at: performance.now(), code: event.code, reason: event.reason }));
      }
      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (this.recorded && typeof data === 'string') {
          const message = JSON.parse(data);
          if (message.type !== 'pty-ack') flow.frames.push({ ...message, at: performance.now() });
          else flow.acks.push({ at: performance.now(), stream: message.stream_id, offset: message.offset, socket: flow.sockets.indexOf(this) });
        }
        super.send(data);
      }
    }
    Object.assign(window, { WebSocket: RecordedSocket });
    return;
  }
  const grid = mock;
  class MockSocket extends EventTarget {
    static OPEN = 1; static CONNECTING = 0; readyState = 0; stream = ''; offset = 0;
    constructor(public url: string) {
      super(); flow.sockets.push(this);
      queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); this.emit({ type: 'snapshot', features: ['input-ready'], panes: [], workspaces: [] }); });
    }
    emit(message: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })); }
    /** a frame with its place in this connection's stream, as the server's OutputWindow numbers it */
    frame(paneId: string, data: string) {
      this.offset += utf8(data);
      this.emit({ type: 'pty-data', pane_id: paneId, data, flow: { stream_id: this.stream, offset: this.offset } });
      return { stream: this.stream, offset: this.offset, at: performance.now() };
    }
    send(text: string) {
      const message = JSON.parse(text);
      const socket = flow.sockets.indexOf(this);
      if (message.type === 'pty-ack') flow.acks.push({ at: performance.now(), stream: message.stream_id, offset: message.offset, socket });
      else flow.frames.push({ ...message, at: performance.now(), socket });
      if (message.type === 'role') this.emit({ type: 'role-ack', mode: message.mode });
      if (message.type === 'attach') {
        this.stream = `mock-stream-${++flow.streams}`;
        this.offset = 0;
        this.emit({ type: 'input-ready', pane_id: message.pane_id, ready: true });
        this.emit({ type: 'pane-geometry', pane_id: message.pane_id, cols: grid.cols, rows: grid.rows, fixed: true });
        const screen = flow.screens[message.pane_id];
        if (screen) this.frame(message.pane_id, screen);
      }
    }
    close() { this.readyState = 3; }
    /** the connection ends without a close from this side, as a network drop does */
    drop() { this.readyState = 3; this.dispatchEvent(new CloseEvent('close', { code: 1006 })); }
  }
  const terminalSocket = () => flow.sockets.filter((socket: MockSocket) => new URL(socket.url).pathname === '/ws').at(-1);
  flow.emitFrame = (data: string, paneId?: string) => terminalSocket().frame(paneId ?? pane, data);
  flow.drop = () => terminalSocket().drop();
  Object.assign(window, { WebSocket: MockSocket });
}

type FlowFrame = { stream: string; offset: number; at: number };
type FlowWrite = { at: number; kind: string; data: string };
const flowEmit = (page: Page, data: string, paneId: string | null = null) =>
  page.evaluate(([value, id]) => (window as any).flow.emitFrame(value, id ?? undefined), [data, paneId] as const) as Promise<FlowFrame>;
const composeStart = (cdp: CDPSession, text = '한') => cdp.send('Input.imeSetComposition', { text, selectionStart: 1, selectionEnd: 1 });
const composeEnd = (cdp: CDPSession, text = '한') => cdp.send('Input.insertText', { text });
const flowWrites = (page: Page, from = 0) => page.evaluate(start => (window as any).flow.writes.slice(start), from) as Promise<FlowWrite[]>;
const flowCount = (page: Page, key: string) => page.evaluate(name => (window as any).flow[name].length as number, key);
const flowList = (page: Page, key: string, from = 0) => page.evaluate(([name, start]) => (window as any).flow[name].slice(start), [key, from] as const) as Promise<any[]>;
const flowDump = (page: Page) => page.evaluate(async () => { await (window as any).flow.flush(); return (window as any).flow.dump(); }) as Promise<{ cols: number; rows: number; cursorX: number; cursorY: number; text: string[]; cells: string[] }>;
const lastComposition = async (page: Page, type: 'compositionstart' | 'compositionend') =>
  (await flowList(page, 'compositions')).filter(entry => entry.type === type).at(-1)?.at as number;
const flowScreen = (rows: readonly string[]) => rows.join('\n');
const rowsNamed = (name: string, count: number) => Array.from({ length: count }, (_, index) => `${name} ${index}`);
/** where two dumps first differ, for the evidence */
function dumpDifference(a: Awaited<ReturnType<typeof flowDump>>, b: Awaited<ReturnType<typeof flowDump>>) {
  const row = a.cells.findIndex((cells, index) => cells !== b.cells[index]);
  return { cursor: [[a.cursorX, a.cursorY], [b.cursorX, b.cursorY]], grid: [[a.cols, a.rows], [b.cols, b.rows]], row, text: row < 0 ? null : [a.text[row], b.text[row]] };
}

async function untilScreen(page: Page, text: string, label: string, timeout = 15_000): Promise<void> {
  const start = Date.now();
  while (!(await page.evaluate(value => {
    const term = (window as any).flow.terms[0];
    if (!term) return false;
    const buffer = term.buffer.active;
    for (let row = 0; row < term.rows; row++) if (buffer.getLine(buffer.baseY + row)?.translateToString(true).includes(value)) return true;
    return false;
  }, text))) {
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${label}: ${text}`);
    await Bun.sleep(25);
  }
}

async function openFlowPage(browser: Browser, url: string, config: MirrorFlowConfig, label: string, errors: string[], cleanup: OwnedCleanup) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  cleanup.add(`context-${label}`, () => context.close());
  const page = await context.newPage();
  page.on('pageerror', error => { errors.push(`${label}: ${error.stack ?? error.message}`); console.error('FIXTURE_PAGE_ERROR', label, error.stack ?? error.message); });
  await page.addInitScript(mirrorFlowInit, config);
  await page.route('**/api/**', route => route.fulfill({ json: { text: '', messages: [], prompt: null } }));
  await page.goto(url);
  const cdp = await context.newCDPSession(page);
  return { page, cdp };
}

/** the screens of regression 1: colours, a colour left on at a row's end, a cleared row, Korean, CJK, emoji */
const AB_ROWS = 12;
const AB_S0 = [
  '\x1b[1;31m빨강 bold\x1b[0m plain 한국어',
  '\x1b[44mopen blue background ',
  'inherits the blue 😀 👍🏽',
  '\x1b[38;5;208m주황 256\x1b[0m',
  ...Array.from({ length: 7 }, (_, index) => `row ${index + 4} 中文 \x1b[32mgreen\x1b[0m`),
  '$ prompt 한',
];
const AB_S1 = AB_S0.map((text, index) => index === 1 ? '\x1b[45mmagenta 바뀜\x1b[0m' : text);
const AB_S2 = AB_S1.slice(0, 10).map((text, index) => index === 5 ? '\x1b[33m노랑 🎉\x1b[0m' : index === 7 ? '' : text);

/**
 * Regression 1: a whole screen, row A, row B arrive while the IME composes. After the span the grid is the
 * one a terminal that wrote the same frames one by one shows, cell by cell (a second page, not composing).
 */
async function mirrorFlowScreens(browser: Browser, url: string, check: MirrorFlowCheck, errors: string[], cleanup: OwnedCleanup): Promise<void> {
  const config: MirrorFlowConfig = { pane: MIRROR_FLOW_PANE, mock: { cols: 60, rows: AB_ROWS, screens: { [MIRROR_FLOW_PANE]: mirrorFrame(flowScreen(rowsNamed('before', AB_ROWS)), AB_ROWS) } } };
  const subject = await openFlowPage(browser, url, config, 'screens-subject', errors, cleanup);
  const reference = await openFlowPage(browser, url, config, 'screens-reference', errors, cleanup);
  for (const { page } of [subject, reference]) await untilScreen(page, `before ${AB_ROWS - 1}`, 'regression 1 screen');
  await subject.page.locator('.xterm-helper-textarea').focus();
  await composeStart(subject.cdp);
  const frames = [mirrorFrame(flowScreen(AB_S0), AB_ROWS), mirrorRows(flowScreen(AB_S0), flowScreen(AB_S1), AB_ROWS), mirrorRows(flowScreen(AB_S1), flowScreen(AB_S2), AB_ROWS)];
  const held: FlowFrame[] = [];
  for (const frame of frames) {
    held.push(await flowEmit(subject.page, frame));
    await flowEmit(reference.page, frame);
  }
  await Bun.sleep(200);
  await composeEnd(subject.cdp);
  await Bun.sleep(800);
  const startAt = await lastComposition(subject.page, 'compositionstart'), endAt = await lastComposition(subject.page, 'compositionend');
  const writes = (await flowWrites(subject.page)).filter(write => write.at >= startAt);
  const during = writes.filter(write => write.at < endAt + COMPOSITION_SETTLE_MS), after = writes.filter(write => write.at >= endAt + COMPOSITION_SETTLE_MS);
  check('screens-no-write-while-composing', ['hold-guard'], during.length === 0, { during: during.length });
  check('screens-one-write-after-350ms', ['hold-guard'], after.length === 1, { after: after.map(write => ({ ms: Math.round(write.at - endAt), chars: write.data.length })) });
  const acks = await flowList(subject.page, 'acks');
  const unacked = held.filter(frame => !acks.some(ack => ack.stream === frame.stream && ack.offset >= frame.offset && ack.at <= endAt));
  check('screens-acknowledged-as-taken-in', ['ack-hold'], unacked.length === 0, { held: held.map(frame => frame.offset), acks: acks.map(ack => ack.offset), unacked: unacked.map(frame => frame.offset) });
  const [result, expected] = [await flowDump(subject.page), await flowDump(reference.page)];
  const visible = expected.text.join('\n');
  const exercised = ['빨강', '바뀜', '노랑 🎉', '😀', '中文'].every(text => visible.includes(text)) && expected.text[7] === '' && expected.text[11] === '' && expected.cursorY === 9;
  check('screens-equal-frames-written-one-by-one', ['last-raw'], exercised && JSON.stringify(result) === JSON.stringify(expected),
    { exercised, difference: dumpDifference(result, expected) });
}

/**
 * Regression 2 and the generation changes, on a paused page clock: rows coalesced by row, a whole screen dropping
 * the rows before it, the 349/350 ms edge, a new composition cancelling the release, an unknown frame never
 * acknowledged, and a held screen dropped by a disconnect and by a pane change.
 */
async function mirrorFlowCoalescing(browser: Browser, url: string, check: MirrorFlowCheck, errors: string[], cleanup: OwnedCleanup): Promise<void> {
  const grid = 12;
  const base = rowsNamed('base', grid);
  const screens = { [MIRROR_FLOW_PANE]: mirrorFrame(flowScreen(base), grid), [MIRROR_FLOW_OTHER_PANE]: mirrorFrame(flowScreen(rowsNamed('SECOND-PANE', grid)), grid) };
  const { page, cdp } = await openFlowPage(browser, url, { pane: MIRROR_FLOW_PANE, mock: { cols: 60, rows: grid, screens } }, 'coalescing', errors, cleanup);
  await untilScreen(page, `base ${grid - 1}`, 'regression 2 screen');
  await page.locator('.xterm-helper-textarea').focus();
  await page.clock.install();
  await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000);
  /** the composition ends, then the clock runs to just before, at and just after the release: writes counted from `from` */
  const release = async (from: number, text = '한') => {
    await composeEnd(cdp, text);
    await page.clock.runFor(COMPOSITION_SETTLE_MS - 1);
    const at349 = (await flowWrites(page, from)).length;
    await page.clock.runFor(1);
    const at350 = (await flowWrites(page, from)).length;
    // the first animation frame after 350 ms (the paused clock's frames are 16 ms apart)
    await page.clock.runFor(40);
    return { at349, at350, endAt: await lastComposition(page, 'compositionend') };
  };

  // rows only: each changed row once, its latest text
  const first = base.map((text, index) => index === 2 ? 'first A' : index === 4 ? 'only B 한글' : text);
  const second = first.map((text, index) => index === 2 ? 'second A 😀' : text);
  let from = await flowCount(page, 'writes');
  await composeStart(cdp);
  const rowFrames = [await flowEmit(page, mirrorRows(flowScreen(base), flowScreen(first), grid)), await flowEmit(page, mirrorRows(flowScreen(first), flowScreen(second), grid))];
  let edge = await release(from);
  let written = await flowWrites(page, from);
  const releasedAt = written.map(write => Math.round((write.at - edge.endAt) * 10) / 10);
  check('coalesce-no-write-at-349ms', ['hold-guard'], edge.at349 === 0, { at349: edge.at349, writes: releasedAt });
  check('coalesce-one-write-at-first-frame-after-350ms', ['hold-guard'], written.length === 1 && releasedAt[0]! >= COMPOSITION_SETTLE_MS && releasedAt[0]! <= COMPOSITION_SETTLE_MS + 17,
    { at350: edge.at350, writes: releasedAt });
  const latest = mirrorRows(flowScreen(base), flowScreen(second), grid);
  check('coalesce-latest-of-each-row', ['hold-guard', 'last-raw'], written.length === 1 && written[0]!.data === latest, { written: written.map(write => write.data), expected: latest });
  let acks = await flowList(page, 'acks');
  check('coalesce-acknowledged', ['ack-hold'], rowFrames.every(frame => acks.some(ack => ack.stream === frame.stream && ack.offset >= frame.offset)),
    { frames: rowFrames.map(frame => frame.offset), acks: acks.map(ack => ack.offset) });

  // rows, then a whole screen: the rows before it are gone
  const dropped = second.map((text, index) => index === 6 ? 'dropped patch' : text);
  const whole = rowsNamed('whole', grid).map(text => `${text} \x1b[36m청록\x1b[0m`);
  from = await flowCount(page, 'writes');
  await composeStart(cdp);
  await flowEmit(page, mirrorRows(flowScreen(second), flowScreen(dropped), grid));
  await flowEmit(page, mirrorFrame(flowScreen(whole), grid));
  await release(from);
  written = await flowWrites(page, from);
  check('patch-then-whole-keeps-the-whole', ['hold-guard'], written.length === 1 && written[0]!.data === mirrorFrame(flowScreen(whole), grid),
    { written: written.map(write => write.data.length), dropped: written.some(write => write.data.includes('dropped patch')) });

  // composing again inside the span: the release waits for the new span
  const again = rowsNamed('recompose', grid);
  from = await flowCount(page, 'writes');
  await composeStart(cdp, '가');
  await flowEmit(page, mirrorFrame(flowScreen(again), grid));
  await composeEnd(cdp, '가');
  await page.clock.runFor(200);
  await composeStart(cdp, '나');
  await page.clock.runFor(300);
  const recomposing = (await flowWrites(page, from)).length;
  await flowEmit(page, mirrorRows(flowScreen(again), flowScreen(again.map((text, index) => index === 3 ? 'recomposed 🎉' : text)), grid));
  edge = await release(from, '나');
  written = await flowWrites(page, from);
  check('recompose-cancels-the-release', ['hold-guard'], recomposing === 0 && edge.at349 === 0 && written.length === 1, { recomposing, at349: edge.at349, writes: written.length });

  // a frame of no mirror shape: not held, never acknowledged, said so; the frame after it is not acknowledged either
  const afterUnknown = rowsNamed('after unknown', grid);
  from = await flowCount(page, 'writes');
  const errorsFrom = await flowCount(page, 'errors'), acksFrom = await flowCount(page, 'acks');
  await composeStart(cdp);
  const unknown = await flowEmit(page, '\x1b[2J\x1b[Hraw unknown frame');
  await flowEmit(page, mirrorFrame(flowScreen(afterUnknown), grid));
  const acksWhileHeld = await flowList(page, 'acks', acksFrom);
  const diagnostics = await flowList(page, 'errors', errorsFrom);
  await release(from);
  written = await flowWrites(page, from);
  check('unknown-frame-never-acknowledged', ['hold-guard', 'last-raw'], acksWhileHeld.every(ack => ack.stream !== unknown.stream || ack.offset < unknown.offset)
    && diagnostics.some(text => text.includes('held unacknowledged')) && written.length === 1 && written[0]!.data === mirrorFrame(flowScreen(afterUnknown), grid),
  { acksWhileHeld: acksWhileHeld.map(ack => ack.offset), unknown: unknown.offset, diagnostics, written: written.map(write => write.data.slice(0, 40)) });

  // a disconnect while composing: the reconnect's whole screen is written, nothing of the old stream, no ACK into it
  from = await flowCount(page, 'writes');
  await composeStart(cdp);
  const old = await flowEmit(page, mirrorFrame(flowScreen(rowsNamed('GEN-ONE', grid)), grid));
  await page.evaluate(screen => { (window as any).flow.screens['mirror-pane'] = screen; }, mirrorFrame(flowScreen(rowsNamed('GEN-TWO', grid)), grid));
  const attaches = (await flowList(page, 'frames')).filter(frame => frame.type === 'attach').length;
  const acksBeforeDrop = await flowCount(page, 'acks');
  await page.evaluate(() => (window as any).flow.drop());
  await page.clock.runFor(300);
  const reattached = Date.now();
  while ((await flowList(page, 'frames')).filter(frame => frame.type === 'attach').length <= attaches) {
    if (Date.now() - reattached > 5000) throw new Error('the mock connection did not reconnect');
    await Bun.sleep(25);
  }
  await release(from);
  written = await flowWrites(page, from);
  const acksAfterDrop = await flowList(page, 'acks', acksBeforeDrop);
  check('disconnect-drops-the-held-screen', ['hold-guard'], written.length === 1 && written[0]!.data === mirrorFrame(flowScreen(rowsNamed('GEN-TWO', grid)), grid)
    && acksAfterDrop.every(ack => ack.stream !== old.stream),
  { written: written.map(write => write.data.slice(0, 60)), oldStream: old.stream, acksAfterDrop });

  // a pane change while composing: the next pane's screen, nothing of the held one
  from = await flowCount(page, 'writes');
  await composeStart(cdp);
  await flowEmit(page, mirrorFrame(flowScreen(rowsNamed('GEN-THREE', grid)), grid));
  await page.evaluate(next => (window as any).flow.setPane(next), MIRROR_FLOW_OTHER_PANE);
  const switched = Date.now();
  while (!(await flowList(page, 'frames')).some(frame => frame.type === 'attach' && frame.pane_id === MIRROR_FLOW_OTHER_PANE)) {
    if (Date.now() - switched > 5000) throw new Error('the pane change did not attach the next pane');
    await Bun.sleep(25);
  }
  await release(from);
  written = await flowWrites(page, from);
  check('pane-change-drops-the-held-screen', ['hold-guard'], !written.some(write => write.data.includes('GEN-THREE')) && written.some(write => write.data.includes('SECOND-PANE')),
    { written: written.map(write => write.data.slice(0, 60)) });

  // ACKs are cumulative and go out once: never the same or a smaller offset again on a stream
  acks = await flowList(page, 'acks');
  const repeated = acks.filter((ack, index) => acks.slice(0, index).some(earlier => earlier.socket === ack.socket && earlier.stream === ack.stream && earlier.offset >= ack.offset));
  check('acks-never-repeat', [], repeated.length === 0, { acks: acks.length, repeated });
}

/** A herdr as the server sees it over its socket: one pane whose screen changes on every read while `changing`. */
async function standInHerdr(address: string, cwd: string, cols: number, rows: number) {
  const row = (tick: number, index: number) => {
    let text = index === 0 ? `한글 입력 😀 👍🏽 tick ${tick} ` : `t${tick} r${index} `;
    // a coloured row of about 1.4 KB: the screen is about 33 KB, so five seconds of output pass 1 MiB
    for (let segment = 0; segment < 48; segment++) text += `\x1b[38;5;${(tick + index + segment) % 256}m${'가나다라마바사'.slice(0, 1 + (segment % 7))}${segment}\x1b[0m`;
    return text;
  };
  const state = { tick: 0, changing: false, reads: 0, lines: Array.from({ length: rows }, (_, index) => row(0, index)) };
  const snapshot = {
    version: '0.9.3', protocol: 1, agents: [], focused_pane_id: MIRROR_FLOW_PANE, focused_tab_id: 'tab-1', focused_workspace_id: 'ws-1',
    workspaces: [{ workspace_id: 'ws-1', label: 'mirror-flow', number: 1, focused: true, active_tab_id: 'tab-1', agent_status: 'idle', pane_count: 1, tab_count: 1 }],
    tabs: [{ tab_id: 'tab-1', workspace_id: 'ws-1', label: 'mirror-flow', number: 1, focused: true, agent_status: 'idle', pane_count: 1 }],
    panes: [{ pane_id: MIRROR_FLOW_PANE, tab_id: 'tab-1', workspace_id: 'ws-1', terminal_id: 'terminal-1', focused: true, agent_status: 'idle', revision: 1, cwd }],
    layouts: [{ workspace_id: 'ws-1', tab_id: 'tab-1', focused_pane_id: MIRROR_FLOW_PANE, zoomed: false, splits: [], area: { x: 0, y: 0, width: cols, height: rows },
      panes: [{ pane_id: MIRROR_FLOW_PANE, focused: true, rect: { x: 0, y: 0, width: cols, height: rows } }] }],
  };
  const answer = (method: string, params: any): object => {
    if (method === 'ping') return { result: { version: '0.9.3', protocol: 1, capabilities: { direct_terminal_attach: false } } };
    if (method === 'session.snapshot') return { result: { snapshot } };
    if (method === 'pane.send_text' || method === 'pane.send_keys') return { result: {} };
    if (method === 'pane.read' && params?.pane_id === MIRROR_FLOW_PANE) {
      if (state.changing && params.format === 'ansi') {
        state.tick++;
        // three reads in four change every row (a whole screen goes out), the fourth three rows (their rows go out)
        state.lines = state.lines.map((text, index) => state.tick % 4 !== 0 || index === 0 || index === state.tick % (rows - 1) || index === rows - 1 ? row(state.tick, index) : text);
      }
      state.reads++;
      const text = state.lines.join('\n');
      return { result: { read: { format: params.format, pane_id: MIRROR_FLOW_PANE, revision: state.tick, source: params.source, tab_id: 'tab-1', workspace_id: 'ws-1', truncated: false,
        text: params.format === 'ansi' ? text : text.replace(/\x1b\[[0-9;]*m/g, '') } } };
    }
    return { error: { code: method === 'pane.read' ? 'pane_not_found' : 'unsupported', message: `the stand-in herdr does not answer ${method}` } };
  };
  const open = new Set<NetSocket>();
  const server = createNetServer(socket => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    socket.on('error', () => undefined);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      const request = JSON.parse(buffer.slice(0, end)) as { id: string; method: string; params: unknown };
      buffer = buffer.slice(end + 1);
      // a subscription stays open and says nothing more
      if (request.method === 'events.subscribe') { socket.write(`${JSON.stringify({ id: request.id, result: { type: 'subscription_started' } })}\n`); return; }
      socket.end(`${JSON.stringify({ id: request.id, ...answer(request.method, request.params) })}\n`);
    });
  });
  await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(address, () => done()); });
  return {
    state,
    close: () => new Promise<void>(done => { for (const socket of open) socket.destroy(); server.close(() => done()); }),
  };
}

/**
 * Regressions 3 and 5 on the real server: viewer A composes for more than five seconds of mirror output past
 * high (256 KiB) and hard (1 MiB) while viewer B only watches. A acknowledges as it takes frames in, writes none,
 * stays connected, and after the span shows B's screen; B's output never waits on A.
 */
async function mirrorFlowServer(browser: Browser, url: string, check: MirrorFlowCheck, errors: string[], cleanup: OwnedCleanup, herdr: Awaited<ReturnType<typeof standInHerdr>>, gridRows: number): Promise<void> {
  const config: MirrorFlowConfig = { pane: MIRROR_FLOW_PANE, mock: null };
  const b = await openFlowPage(browser, url, config, 'viewer-b', errors, cleanup);
  await untilScreen(b.page, 'tick 0 ', 'viewer B screen', 30_000);
  const a = await openFlowPage(browser, url, config, 'viewer-a', errors, cleanup);
  await untilScreen(a.page, 'tick 0 ', 'viewer A screen', 30_000);
  await a.page.locator('.xterm-helper-textarea').focus();
  await composeStart(a.cdp);
  herdr.state.changing = true;
  await Bun.sleep(5500);
  herdr.state.changing = false;
  const finalTick = herdr.state.tick;
  // the output goes quiet: the mirror sends its screen whole once more after a second of rows
  await Bun.sleep(1500);
  await composeEnd(a.cdp);
  await Bun.sleep(1000);
  const log = (page: Page) => page.evaluate(() => {
    const flow = (window as any).flow;
    return { origin: performance.timeOrigin, writes: flow.writes.map((write: FlowWrite) => ({ at: write.at, chars: write.data.length })), clears: flow.clears, absorbs: flow.absorbs,
      compositions: flow.compositions, received: flow.received, acks: flow.acks, closes: flow.closes, errors: flow.errors };
  });
  const [aLog, bLog] = [await log(a.page), await log(b.page)];
  const startAt = aLog.compositions.find((entry: any) => entry.type === 'compositionstart').at as number;
  const endAt = aLog.compositions.filter((entry: any) => entry.type === 'compositionend').at(-1).at as number;
  const releaseAt = endAt + COMPOSITION_SETTLE_MS;
  const inSpan = (at: number) => at >= startAt && at < releaseAt;
  const ms = (at: number) => Math.round(at - startAt);
  const span = { composedMs: Math.round(endAt - startAt), outputMs: 5500 };

  const received = aLog.received.filter((entry: any) => inSpan(entry.at));
  const receivedBytes = received.reduce((sum: number, entry: any) => sum + entry.bytes, 0);
  check('flow-output-past-hard-while-composing', ['ack-hold'], receivedBytes > OUTPUT_HARD_BYTES, { ...span, receivedBytes, frames: received.length, high: OUTPUT_HIGH_BYTES, hard: OUTPUT_HARD_BYTES });

  // pending as the server counts it: sent offset minus acknowledged offset, at each frame A received
  let acked = 0, pendingMax = 0, highAt: number | null = null;
  const acks = [...aLog.acks].sort((x: any, y: any) => x.at - y.at);
  for (const entry of [...aLog.received].sort((x: any, y: any) => x.at - y.at)) {
    for (const ack of acks) if (ack.at <= entry.at && ack.stream === entry.stream) acked = Math.max(acked, ack.offset);
    const pending = entry.offset - acked;
    pendingMax = Math.max(pendingMax, pending);
    if (pending >= OUTPUT_HIGH_BYTES && highAt === null) highAt = entry.at;
  }
  const outputEnd = startAt + span.outputMs;
  const spanAcks = acks.filter((ack: any) => ack.at >= startAt && ack.at <= outputEnd).map((ack: any) => ack.at as number);
  const gaps = [startAt, ...spanAcks, outputEnd].slice(1).map((at, index, list) => at - (index === 0 ? startAt : list[index - 1]!));
  const ackGapMax = Math.round(Math.max(...gaps));
  check('flow-acks-keep-coming-while-composing', ['ack-hold'], ackGapMax < 1000 && pendingMax < OUTPUT_HIGH_BYTES,
    { acks: spanAcks.length, ackGapMax, stallMs: OUTPUT_STALL_MS, pendingMax, highAt: highAt === null ? null : ms(highAt), firstAcksMs: spanAcks.slice(0, 5).map(ms), lastAckMs: spanAcks.length ? ms(spanAcks.at(-1)!) : null });

  const absorbs = aLog.absorbs.filter((entry: any) => inSpan(entry.at));
  const heldBytes = Math.max(0, ...absorbs.map((entry: any) => entry.bytes)), heldRows = Math.max(0, ...absorbs.map((entry: any) => entry.rows));
  check('flow-held-screen-bounded', ['hold-guard'], absorbs.length > 0 && heldBytes <= 1024 * 1024 && heldRows <= gridRows,
    { absorbs: absorbs.length, refused: absorbs.filter((entry: any) => !entry.ok).length, heldBytes, heldRows, gridRows });
  const spanWrites = aLog.writes.filter((write: any) => inSpan(write.at));
  check('flow-no-write-while-composing', ['hold-guard'], spanWrites.length === 0, { writes: spanWrites.length });
  const spanClears = aLog.clears.filter((entry: any) => inSpan(entry.at));
  check('flow-no-reset-or-clear-while-composing', [], spanClears.length === 0, { clears: spanClears });

  const aClose = aLog.closes[0] ?? null;
  check('flow-no-close', ['ack-hold'], aLog.closes.length === 0 && bLog.closes.length === 0,
    { a: aLog.closes.map((entry: any) => ({ ...entry, ms: ms(entry.at) })), b: bLog.closes, highAt: highAt === null ? null : ms(highAt),
      stallMs: aClose && highAt !== null ? Math.round(aClose.at - highAt) : null, closeCode: aClose?.code ?? null });

  // B on the epoch clock: its writes while A composed and the output ran
  const epochStart = aLog.origin + startAt, epochEnd = aLog.origin + outputEnd;
  const bWrites = bLog.writes.map((write: any) => bLog.origin + write.at).filter((at: number) => at >= epochStart && at <= epochEnd);
  const bGaps = [epochStart, ...bWrites, epochEnd].slice(1).map((at, index) => at - [epochStart, ...bWrites][index]!);
  const bGapMax = Math.round(Math.max(...bGaps));
  check('flow-other-viewer-keeps-writing', ['ack-hold'], bWrites.length >= 20 && bGapMax < 1000, { writes: bWrites.length, gapMax: bGapMax });

  const released = aLog.writes.filter((write: any) => write.at >= releaseAt);
  check('flow-one-write-after-release', ['hold-guard', 'ack-hold'], released.length === 1, { writes: released.map((write: any) => ({ ms: Math.round(write.at - endAt), chars: write.chars })) });
  const [aDump, bDump] = [await flowDump(a.page), await flowDump(b.page)];
  const latest = bDump.text.some(text => text.includes(`tick ${finalTick} `));
  check('flow-latest-screen-after-release', ['ack-hold'], latest && JSON.stringify(aDump) === JSON.stringify(bDump), { finalTick, latest, difference: dumpDifference(aDump, bDump) });
}

function mirrorFlowPlugin(cut: MirrorFlowCut | null, applied: Set<MirrorFlowCut>): Plugin {
  const fixtureId = normalizePath(resolve(root, 'scripts/mirror-flow-fixture.tsx'));
  const control = MIRROR_FLOW_CUTS.find(entry => entry.name === cut) ?? null;
  const target = control ? normalizePath(resolve(root, control.file)) : null;
  return { name: 'mirror-flow-fixture', enforce: 'pre',
    resolveId(id) { return id === '/scripts/mirror-flow-fixture.tsx' ? fixtureId : null; },
    load(id) { return id === fixtureId ? MIRROR_FLOW_FIXTURE : null; },
    transform(source, id) {
      if (!control || id.split('?')[0] !== target) return null;
      let cutSource = source;
      for (const { from, to } of control.edits) {
        const found = cutSource.split(from).length - 1;
        // a missing connection is a broken control, never a red
        if (found !== 1) throw new Error(`negative control: ${control.name} connection found ${found} times in ${control.file}`);
        cutSource = cutSource.replace(from, () => to);
      }
      applied.add(control.name);
      return cutSource;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith('/mirror-flow-test')) return next();
        void server.transformIndexHtml(request.url, '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><div id="root"></div><script type="module" src="/scripts/mirror-flow-fixture.tsx"></script></body></html>')
          .then(html => { response.setHeader('Content-Type', 'text/html'); response.end(html); });
      });
    } };
}

/** One run of the lane against the sources, or against one cut connection. */
async function mirrorFlowPass(browser: Browser, cut: MirrorFlowCut | null, check: MirrorFlowCheck, errors: string[], applied: Set<MirrorFlowCut>): Promise<void> {
  const cleanup = new OwnedCleanup();
  let failure: unknown = null;
  try {
    const state = mkdtempSync(join(tmpdir(), 'termweave-mirror-flow-'));
    cleanup.add('state-dir', () => rmSync(state, { recursive: true, force: true }));
    const name = `termweave-mirror-flow-${process.pid}-${Date.now().toString(36)}`;
    const address = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : join(state, 'herdr.sock');
    const cols = 100, rows = 24;
    const herdr = await standInHerdr(address, state, cols, rows);
    cleanup.add('stand-in-herdr', () => herdr.close());
    const previousSocket = process.env.HERDR_SOCKET;
    process.env.HERDR_SOCKET = address;
    cleanup.add('herdr-socket-env', () => { if (previousSocket === undefined) delete process.env.HERDR_SOCKET; else process.env.HERDR_SOCKET = previousSocket; });
    const { createServer: createTermweaveServer } = await import('../server/index.ts');
    const { UsageService } = await import('../server/usage.ts');
    const server = createTermweaveServer({ port: 0, hostname: '127.0.0.1', token: '', stateDir: join(state, 'state'), terminalAttach: false, machines: false,
      tailscaleOwner: null, usage: new UsageService(undefined, []) });
    cleanup.add('termweave-server', () => server.stop());
    // its own dependency cache: a config unlike the other lanes' re-optimizes a shared one under their next pages
    const vite = await createServer({ root, configFile: false, logLevel: 'warn', cacheDir: join(root, 'node_modules', '.vite-mirror-flow'),
      esbuild: { jsx: 'automatic' }, plugins: [mirrorFlowPlugin(cut, applied)],
      // the page's /ws reaches the real server on the page's own origin, as a built app's does. No file watcher:
      // each pass serves its own Vite, and a second watcher in one process fails on Windows (EBADF)
      server: { host: '127.0.0.1', port: 0, watch: null, proxy: { '/ws': { target: `http://127.0.0.1:${server.port}`, ws: true } } } });
    cleanup.add('vite', () => vite.close());
    await vite.listen();
    const url = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/mirror-flow-test`;
    await mirrorFlowScreens(browser, url, check, errors, cleanup);
    await mirrorFlowCoalescing(browser, url, check, errors, cleanup);
    await mirrorFlowServer(browser, url, check, errors, cleanup, herdr, rows);
    if (cut !== null && !applied.has(cut)) throw new Error(`negative control: ${cut} never reached the served module`);
  } catch (error) {
    failure = error;
  } finally {
    const results = await cleanup.run();
    if (results.some(result => result.status === 'FAIL')) failure ??= new Error(`Owned mirror-flow cleanup failed: ${JSON.stringify(results)}`);
  }
  if (failure !== null) throw failure;
}

async function mirrorFlowRegression(negative: boolean): Promise<void> {
  const out = resolve(root, 'evidence/mirror-flow', negative ? 'negative-control' : 'candidate');
  mkdirSync(out, { recursive: true });
  const passes: { cut: MirrorFlowCut | null; status: string; red: string[]; expectedRed: string[]; checks: MirrorFlowEntry[]; errors: string[]; failure: string | null }[] = [];
  // One Chromium for every pass, each pass owning its contexts: on Windows a Chromium launched after another one
  // closed in the same Bun process loses its DevTools pipe or stops answering once the process collects garbage
  const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
  for (const cut of negative ? MIRROR_FLOW_CUTS.map(entry => entry.name) : [null]) {
    console.log(`== mirror-flow ${cut === null ? 'candidate' : `negative control: ${cut}`}`);
    const checks: MirrorFlowEntry[] = [], errors: string[] = [];
    const check: MirrorFlowCheck = (name, cuts, ok, detail) => {
      checks.push({ name, cuts, ok, detail });
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${cuts.length ? ` [${cuts.join(', ')}]` : ''} ${JSON.stringify(detail)}`);
    };
    const applied = new Set<MirrorFlowCut>();
    let failure: unknown = null;
    try { await mirrorFlowPass(browser, cut, check, errors, applied); } catch (error) { failure = error; console.error(error); }
    const red = checks.filter(entry => !entry.ok);
    const expectedRed = cut === null ? [] : checks.filter(entry => entry.cuts.includes(cut));
    // ACKs held until the write: the server's own stall policy closes the viewer, 4008 after 2 s past high
    const close = checks.find(entry => entry.name === 'flow-no-close')?.detail;
    const stalled = cut !== 'ack-hold' || (close?.closeCode === 4008 && close.stallMs >= OUTPUT_STALL_MS - 100);
    const status = failure !== null || errors.length ? 'ERROR'
      : cut === null ? (red.length ? 'FAIL' : 'PASS')
        : expectedRed.length > 0 && red.length === expectedRed.length && red.every(entry => entry.cuts.includes(cut)) && stalled ? 'EXPECTED_RED' : 'CONTROL_FAILED';
    passes.push({ cut, status, red: red.map(entry => entry.name), expectedRed: expectedRed.map(entry => entry.name), checks, errors,
      failure: failure === null ? null : String(failure instanceof Error ? failure.stack : failure) });
    console.log(`== ${status}${cut === null ? '' : ` (${cut}: red ${red.map(entry => entry.name).join(', ') || 'none'}${cut === 'ack-hold' ? `; stall close ${close?.closeCode ?? 'none'} after ${close?.stallMs ?? '?'} ms past high` : ''})`}`);
  }
  const browserClose = await browser.close().then(() => null, (error: unknown) => String(error));
  if (browserClose !== null) console.error(`Owned mirror-flow browser close failed: ${browserClose}`);
  const status = browserClose !== null ? 'ERROR'
    : passes.every(pass => pass.status === (negative ? 'EXPECTED_RED' : 'PASS')) ? (negative ? 'EXPECTED_RED' : 'PASS') : passes.find(pass => pass.status === 'ERROR') ? 'ERROR' : negative ? 'CONTROL_FAILED' : 'FAIL';
  writeFileSync(resolve(out, 'result.json'), JSON.stringify({ status, negative, cuts: negative ? MIRROR_FLOW_CUTS : [], passes, browserClose }, null, 2));
  if (status === (negative ? 'EXPECTED_RED' : 'PASS')) {
    console.log(negative ? `PASS mirror-flow negative control: each cut red as expected (evidence ${out})` : `PASS mirror flow: ${passes[0]!.checks.length} checks (evidence ${out})`);
    // the stopped server's mirror and services leave timers behind: the lane is done
    process.exit(0);
  }
  console.error(`mirror-flow ${status} (evidence ${out})`);
  process.exit(1);
}

async function until(page: Page, predicate: () => unknown, label: string, timeout = 15_000): Promise<void> {
  const start = Date.now();
  while (!(await page.evaluate(predicate))) {
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(25);
  }
}
/** to PaneTerminal's HerdrSocket only: Vite's own HMR socket is a MockSocket too */
function emit(page: Page, message: unknown) {
  return page.evaluate(value => { for (const socket of (window as any).policy.sockets) if (new URL(socket.url).pathname === '/ws') socket.emit(value); }, message);
}
function frameCount(page: Page) { return page.evaluate(() => (window as any).policy.frames.length as number); }
function sentSince(page: Page, from: number) {
  return page.evaluate(start => (window as any).policy.frames.slice(start).filter((frame: any) => frame.type === 'input').map((frame: any) => frame.text).join('') as string, from);
}
function probe(page: Page) {
  return page.evaluate(() => {
    const policy = (window as any).policy;
    return { resets: policy.resets as number, attaches: policy.frames.filter((frame: any) => frame.type === 'attach').length as number,
      focus: policy.calls.focus as number, blur: policy.calls.blur as number, synthetic: policy.calls.synthetic as number, compositionEnds: policy.compositionEnds as number };
  });
}
/** autoSelected true, then false: PaneTerminal's autoSelected effect gives the grid the keyboard */
async function requestFocus(page: Page): Promise<void> {
  for (const value of [true, false]) {
    const seen = await page.evaluate(() => (window as any).policy.autoSelected.length as number);
    await page.evaluate(next => (window as any).policy.setAutoSelected(next), value);
    const start = Date.now();
    while (!(await page.evaluate(([count, next]) => { const list = (window as any).policy.autoSelected; return list.length > count && list.at(-1) === next; }, [seen, value] as const))) {
      if (Date.now() - start > 5_000) throw new Error(`timed out waiting for autoSelected=${value}`);
      await Bun.sleep(10);
    }
  }
}

// last: the lanes read the constants above
if (args.includes('--mirror-flow')) await mirrorFlowRegression(args.includes('--negative-control'));
else if (args.includes('--input-policy')) await inputPolicyRegression(args.includes('--negative-control'));
else await renderRegression();
