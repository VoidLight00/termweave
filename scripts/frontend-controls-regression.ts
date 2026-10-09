import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createServer, transformWithEsbuild } from 'vite';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser.ts';

const root = resolve(import.meta.dir, '..'), oldId = 'a'.repeat(64), newId = 'b'.repeat(64);
let deployed = oldId, status = 200, swVersion = 1;
const fixture = `
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FrontendControls } from '/src/components/FrontendControls.tsx';
import { SettingsProvider } from '/src/lib/settings.ts';
import { composerDrafts } from '/src/lib/composerDraft.ts';
import { protectFrontendInput } from '/src/lib/frontendReloadSafety.ts';
import '/src/styles.css';
window.mounts = 0;
function Terminal() { useEffect(() => { window.mounts++; }, []); return <div data-testid="terminal">existing synthetic terminal session</div>; }
function Fixture() {
 const [draft, setDraft] = useState(composerDrafts.read('termweave:composer-draft:synthetic').text);
 const input = value => { composerDrafts.set('termweave:composer-draft:synthetic', value); setDraft(value); };
 window.beginInput = () => protectFrontendInput(() => new Promise(resolve => { window.finishInput = resolve; }));
 return <><header className="app-header"><span className="context">Terminal</span><div className="header-meta"><FrontendControls/><span>live</span></div></header>
 <Terminal/><textarea aria-label="Draft" value={draft} onChange={e => input(e.target.value)}/></>;
}
createRoot(document.getElementById('root')).render(<SettingsProvider><Fixture/></SettingsProvider>);
`;
const vite = await createServer({ root, configFile: false, esbuild: { jsx: 'automatic' },
 optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react'] },
 server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'frontend-controls-fixture',
 resolveId(id) { if (id === 'virtual:frontend-controls-fixture') return '\0frontend-controls-fixture.tsx'; },
 async load(id) { if (id === '\0frontend-controls-fixture.tsx') return (await transformWithEsbuild(fixture, 'frontend-controls-fixture.tsx', { loader: 'tsx', jsx: 'automatic' })).code; },
 configureServer(server) { server.middlewares.use((request, response, next) => {
   if (request.url?.startsWith('/?frontend-build-check=')) {
     response.statusCode = status; response.setHeader('Content-Type', 'text/html');
     response.end(`<meta name="frontend-build-id" content="${deployed}">`); return;
   }
   if (request.url === '/sw-test.js') {
     response.setHeader('Content-Type', 'text/javascript'); response.setHeader('Cache-Control', 'no-store');
     response.end(`// version ${swVersion}\nself.addEventListener('message',e=>{if(e.data?.type==='SKIP_WAITING')self.skipWaiting()}); self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));`); return;
   }
   if (request.url !== '/controls-test') return next();
   void server.transformIndexHtml('/controls-test', `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="frontend-build-id" content="${oldId}"></head><body><div id="root"></div><script type="module" src="/@id/virtual:frontend-controls-fixture"></script></body></html>`)
    .then(html => { response.setHeader('Content-Type', 'text/html'); response.end(html); });
 }); },
 }] });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
 await vite.listen(); const port = (vite.httpServer!.address() as { port: number }).port;
 const origin = `http://127.0.0.1:${port}`;
 browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
 const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
 await context.addInitScript(() => { if (!localStorage.getItem('termweave:settings')) {
   localStorage.setItem('termweave:settings', JSON.stringify({ language: 'ko' }));
   localStorage.setItem('termweave:dock:test', 'keep'); localStorage.setItem('termweave:selection', 'keep');
   sessionStorage.setItem('fixture-auth', 'synthetic');
 } });
 const page = await context.newPage(), errors: string[] = []; let loads = 0, unsafeRequests = 0;
 page.on('pageerror', error => errors.push(error.message));
 page.on('request', request => { if (/\/api\/.*update|install|workspace\/create/.test(request.url())) unsafeRequests++; });
 page.on('load', () => { loads++; });
 await page.goto(`${origin}/controls-test`);
 const refresh = page.getByRole('button', { name: '새로고침', exact: true }), update = page.getByRole('button', { name: '업데이트 하기', exact: true });
 await refresh.waitFor(); assert.equal(await update.count(), 0);
 deployed = newId; await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await update.waitFor();
 assert.equal(await refresh.count(), 1); assert.ok(await update.getAttribute('title'));
 await page.evaluate(() => window.dispatchEvent(new Event('focus')));
 assert.equal(await page.evaluate(() => (window as any).mounts), 1, 'detection never recreates terminals'); assert.equal(loads, 1);
 assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'mobile fits');
 const draft = page.getByRole('textbox', { name: 'Draft' }); await draft.fill('saved draft');
 page.once('dialog', dialog => dialog.dismiss()); await refresh.click(); assert.equal(loads, 1);
 await page.evaluate(() => { void (window as any).beginInput(); });
 await update.click(); await page.getByRole('status').filter({ hasText: '입력을 전송 중입니다' }).waitFor();
 await refresh.click(); assert.equal(loads, 1); await page.evaluate(() => (window as any).finishInput());
 page.once('dialog', dialog => dialog.accept()); await Promise.all([page.waitForEvent('load'), update.click()]);
 assert.equal(await draft.inputValue(), 'saved draft');
 assert.deepEqual(await page.evaluate(() => [localStorage.getItem('termweave:dock:test'),localStorage.getItem('termweave:selection'),sessionStorage.getItem('fixture-auth')]), ['keep','keep','synthetic']);
 await draft.fill(''); status = 403; await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await update.waitFor({ state: 'detached' });
 status = 200; deployed = oldId; await Promise.all([page.waitForEvent('load'), refresh.click()]); assert.equal(await update.count(), 0);
 await context.setOffline(true); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); assert.equal(await update.count(), 0); await context.setOffline(false);
 assert.equal(unsafeRequests, 0); assert.deepEqual(errors, []); await context.close();
 // A real waiting worker: no reload on discovery or updatefound, one reload after user consent.
 const swContext = await browser.newContext();
 await swContext.addInitScript(() => localStorage.setItem('termweave:settings', JSON.stringify({ language: 'ko' })));
 const swPage = await swContext.newPage(); await swPage.goto(`${origin}/controls-test`);
 await swPage.evaluate(async () => { await navigator.serviceWorker.register('/sw-test.js'); await navigator.serviceWorker.ready; });
 await swPage.waitForFunction(() => !!navigator.serviceWorker.controller);
 swVersion = 2; await swPage.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())!.update(); });
 await swPage.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting);
 deployed = newId; await swPage.evaluate(() => window.dispatchEvent(new Event('focus')));
 const swUpdate = swPage.getByRole('button', { name: '업데이트 하기', exact: true }); await swUpdate.waitFor();
 let swLoads = 0; swPage.on('load', () => swLoads++);
 await Promise.all([swPage.waitForEvent('load'), swUpdate.click()]);
 await swPage.waitForTimeout(300); assert.equal(swLoads, 1);
 assert.equal(await swPage.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting), false);
 await swContext.close();
 console.log('PASS frontend controls: separate Korean buttons, mobile fit, detection/no remount, no-SW reload, draft consent/persistence, in-flight block, auth/layout preservation, 403/offline, real waiting-SW single reload, no native update requests');
} finally { await browser?.close(); await vite.close(); }
