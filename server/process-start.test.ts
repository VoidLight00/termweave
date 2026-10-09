import { expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { processStartedAt } from './process-start.ts';
import { parseGjcPs } from './gjc-runtime.ts';
it('parses locale-stable UTC process dates independently of local TZ', () => {
  const old = process.env.TZ;
  try {
    for (const zone of ['Asia/Seoul', 'America/Los_Angeles', 'UTC']) {
      process.env.TZ = zone;
      expect(parseGjcPs('ttys001 Sun Oct 4 10:00:00 2026')).toEqual({ id: 'ttys001', startedAt: Date.parse('2026-10-04T10:00:00Z') });
    }
  } finally { if (old === undefined) delete process.env.TZ; else process.env.TZ = old; }
});
it('explicit owned process start is not shifted by a non-UTC ps timezone', () => {
  const value = processStartedAt(process.pid);
  expect(value).not.toBeNull();
  expect(value!).toBeLessThanOrEqual(Date.now());
  // The shared test runner may have been alive for minutes before this test runs.
  // Compare the observed start with its real uptime, not the total suite duration.
  expect(Math.abs(value! - (Date.now() - process.uptime() * 1000))).toBeLessThan(2000);
  if (process.platform === 'darwin') {
    const out = execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } }).trim();
    expect(value).toBe(Date.parse(out + ' UTC'));
  }
});
it('invalid or exited PID never widens discovery', () => {
  expect(processStartedAt(-1)).toBeNull(); expect(processStartedAt(NaN)).toBeNull();
});
