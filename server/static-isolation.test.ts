import { expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedStaticRoot } from './static.ts';
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
