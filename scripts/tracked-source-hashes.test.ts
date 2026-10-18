import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gitEnvironment, trackedHashes } from './tracked-source-hashes.ts';

test('tracked hashes bind bytes and inventory, reject nested roots and ignore Git overrides', () => {
  const root = mkdtempSync(join(tmpdir(), 'tracked-source-'));
  const previous = process.env.GIT_DIR;
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env: gitEnvironment(), stdio: 'ignore' });
    git('init');
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'nested', 'sample.txt'), 'synthetic');
    writeFileSync(join(root, 'untracked.txt'), 'excluded');
    git('add', 'nested/sample.txt');
    const expected = { 'nested/sample.txt': createHash('sha256').update('synthetic').digest('hex') };
    expect(trackedHashes(root)).toEqual(expected);
    process.env.GIT_DIR = '/nonexistent-synthetic-git';
    expect(gitEnvironment()).not.toHaveProperty('GIT_DIR');
    expect(trackedHashes(root)).toEqual(expected);
    expect(() => trackedHashes(join(root, 'nested'))).toThrow('root mismatch');
    writeFileSync(join(root, 'nested', 'sample.txt'), 'changed');
    expect(trackedHashes(root)).not.toEqual(expected);
    rmSync(join(root, 'nested', 'sample.txt'));
    expect(() => trackedHashes(root)).toThrow();
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('verifier hash import runs in an export-like fixture without operations tooling', () => {
  const root = mkdtempSync(join(tmpdir(), 'public-hash-import-'));
  try {
    const verifier = readFileSync(join(import.meta.dir, 'verify-isolated.ts'), 'utf8');
    const match = verifier.match(/const \{ trackedHashes \} = await import\('([^']+)'\);/);
    expect(match?.[1]).toBe('./tracked-source-hashes.ts');
    const scripts = join(root, 'scripts');
    mkdirSync(scripts);
    const helper = resolve(scripts, match![1]!);
    copyFileSync(join(import.meta.dir, 'tracked-source-hashes.ts'), helper);
    const imports = new Bun.Transpiler({ loader: 'ts' }).scanImports(readFileSync(helper, 'utf8'));
    expect(imports.every(entry => entry.path.startsWith('node:'))).toBe(true);
    expect(existsSync(join(root, 'tools', 'operations'))).toBe(false);
    execFileSync('git', ['init'], { cwd: root, env: gitEnvironment(), stdio: 'ignore' });
    execFileSync('git', ['add', 'scripts/tracked-source-hashes.ts'], { cwd: root, env: gitEnvironment(), stdio: 'ignore' });
    const code = `const { trackedHashes } = await import(${JSON.stringify(helper)}); process.stdout.write(JSON.stringify(Object.keys(trackedHashes(${JSON.stringify(root)}))));`;
    const output = execFileSync(process.execPath, ['-e', code], { cwd: root, env: gitEnvironment(), encoding: 'utf8' });
    expect(JSON.parse(output)).toEqual(['scripts/tracked-source-hashes.ts']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
