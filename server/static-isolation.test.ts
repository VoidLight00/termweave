import { expect, it } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, sep } from 'node:path';
import { hash, files, type ReleaseManifest } from '../scripts/release/manifest.ts';
import { activateRelease } from '../scripts/release/activate.ts';
import { isolatedStaticRoot, serveStatic } from './static.ts';
it('refuses staging outside the owned root, traversal and symlink escapes', () => {
  const root = mkdtempSync(join(tmpdir(), 'tw-static-')), outside = mkdtempSync(join(tmpdir(), 'tw-outside-'));
  try {
    mkdirSync(join(root, 'dist')); symlinkSync(outside, join(root, 'escape'));
    expect(isolatedStaticRoot(join(root, 'dist'), root)).toContain('dist');
    expect(() => isolatedStaticRoot(outside, root)).toThrow('escapes');
    expect(() => isolatedStaticRoot(join(root, 'escape'), root)).toThrow('escapes');
    expect(() => isolatedStaticRoot(join(root, '..'), root)).toThrow('escapes');
    expect(() => isolatedStaticRoot(join(root, 'dist'), undefined)).toThrow('owned');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
it('bounds staging by canonical identity and the platform separator, not a string prefix', () => {
  const root = mkdtempSync(join(tmpdir(), 'tw-static-')), sibling = `${root}x`, outside = mkdtempSync(join(tmpdir(), 'tw-outside-'));
  try {
    mkdirSync(join(root, 'dist', 'nested'), { recursive: true }); mkdirSync(join(sibling, 'dist'), { recursive: true });
    // A junction needs no privilege on Windows; on POSIX the type is ignored and a directory symlink is made.
    symlinkSync(outside, join(root, 'junction-escape'), 'junction'); symlinkSync(join(root, 'dist'), join(root, 'junction-alias'), 'junction');
    expect(isolatedStaticRoot(join(root, 'dist', 'nested'), root)).toBe(isolatedStaticRoot(join(root, 'dist'), root) + sep + 'nested');
    expect(isolatedStaticRoot(join(root, 'dist'), root + sep)).toBe(isolatedStaticRoot(join(root, 'dist'), root));
    expect(isolatedStaticRoot(join(root, 'junction-alias'), root)).toBe(isolatedStaticRoot(join(root, 'dist'), root));
    expect(() => isolatedStaticRoot(root, root)).toThrow('escapes');
    expect(() => isolatedStaticRoot(sibling, root)).toThrow('escapes');
    expect(() => isolatedStaticRoot(join(sibling, 'dist'), root)).toThrow('escapes');
    expect(() => isolatedStaticRoot(join(root, 'dist', '..', '..', parse(sibling).base, 'dist'), root)).toThrow('escapes');
    expect(() => isolatedStaticRoot(join(root, 'junction-escape'), root)).toThrow('escapes');
  } finally { for (const path of [root, sibling, outside]) rmSync(path, { recursive: true, force: true }); }
});
const ownDrive = parse(tmpdir()).root;
const otherDrive = process.platform === 'win32' ? [...'CDEFGHIJKLMNOPQRSTUVWXYZ'].map(letter => `${letter}:\\`).find(drive => drive.toUpperCase() !== ownDrive.toUpperCase() && existsSync(drive)) : undefined;
it.skipIf(!otherDrive)('refuses a staging root on another drive', () => {
  const root = mkdtempSync(join(tmpdir(), 'tw-static-'));
  try { expect(() => isolatedStaticRoot(otherDrive!, root)).toThrow('escapes'); } finally { rmSync(root, { recursive: true, force: true }); }
});
function release(root: string, id: string) {
  const dist = join(root, 'releases', id, 'dist'); mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), `<script type="module" src="/assets/${id}.js"></script>`); writeFileSync(join(dist, 'assets', `${id}.js`), `export const version='${id}';`); writeFileSync(join(dist, 'sw.js'), `// worker ${id}`);
  const assets = files(dist);
  const manifest: ReleaseManifest = { schema: 1, id, deployment: 'frontend', source: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), lock: hash('lock'), upstreamLock: hash('upstream') }, tools: { bun: '1', node: '1' }, native: { version: 'test', checksum: hash('native') }, compatibility: { backend: '1', storage: 'v1-v3', protocol: '22' }, tests: { status: 'PASS', hash: hash('tests') }, assets, frontend: hash(JSON.stringify(Object.entries(assets).sort())), backend: hash('backend') };
  writeFileSync(join(dist, '..', 'manifest.json'), JSON.stringify(manifest));
}
it('serves active-release files by the active manifest and old lazy assets from the retained root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tw-static-release-'));
  try {
    release(root, 'A'); release(root, 'B'); await activateRelease(root, 'A', async () => true); await activateRelease(root, 'B', async () => true);
    // sw.js is not under assets/, so only the active manifest (never retained-digests.json) carries its digest.
    const worker = await serveStatic('/sw.js', root); expect(worker.status).toBe(200); expect(await worker.text()).toBe('// worker B');
    expect(await (await serveStatic('/assets/B.js', root)).text()).toContain("version='B'");
    expect(await (await serveStatic('/assets/A.js', root)).text()).toContain("version='A'");
    expect((await serveStatic('/assets/missing.js', root)).status).toBe(404);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
