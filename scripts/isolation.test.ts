import { expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isolateTestEnvironment } from './test-isolation.ts';
it('refuses live-mode and inherited runtime socket without contacting either', () => {
  const values = Object.fromEntries(['HERDR_TEST_LIVE', 'HERDR_SOCKET', 'TERMWEAVE_TEST_ROOT'].map(name => [name, process.env[name]]));
  try {
    process.env.HERDR_TEST_LIVE = '1'; expect(() => isolateTestEnvironment()).toThrow('forbidden');
    delete process.env.HERDR_TEST_LIVE; delete process.env.TERMWEAVE_TEST_ROOT;
    process.env.HERDR_SOCKET = '/not-owned/herdr.sock'; expect(() => isolateTestEnvironment()).toThrow('refused');
  } finally { for (const [name, value] of Object.entries(values)) if (value === undefined) delete process.env[name]; else process.env[name] = value; }
});

it('existing isolated root rejects traversal sessions and symlink socket parents', () => {
  const root = mkdtempSync('/tmp/twi-'), outside = mkdtempSync('/tmp/two-');
  const keys = ['TERMWEAVE_TEST_ROOT', 'HERDR_TEST_SESSION', 'HERDR_SOCKET', 'HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME'];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const [key, name] of [['HOME','h'],['XDG_CONFIG_HOME','c'],['XDG_STATE_HOME','s'],['XDG_DATA_HOME','d']]) { mkdirSync(join(root,name)); process.env[key] = join(root,name); }
    process.env.TERMWEAVE_TEST_ROOT = root; delete process.env.HERDR_SOCKET;
    process.env.HERDR_TEST_SESSION = '../escape'; expect(() => isolateTestEnvironment()).toThrow('session');
    mkdirSync(join(root,'c','herdr')); symlinkSync(outside, join(root,'c','herdr','sessions'));
    process.env.HERDR_TEST_SESSION = 'qa'; expect(() => isolateTestEnvironment()).toThrow('escapes');
    expect(readdirSync(outside)).toEqual([]);
  } finally {
    for (const [key,value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});
  }
});
