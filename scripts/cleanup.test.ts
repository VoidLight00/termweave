import { expect, it } from 'bun:test';
import { OwnedCleanup } from './cleanup.ts';
it('runs every owned cleanup independently after a cleanup failure', async () => {
  const cleanup = new OwnedCleanup(); const called: string[] = [];
  cleanup.add('server', () => { called.push('server'); });
  cleanup.add('browser', () => { called.push('browser'); throw new Error('injected close failure'); });
  cleanup.add('workspace', () => { called.push('workspace'); });
  expect((await cleanup.run()).map(result => result.status)).toEqual(['PASS', 'FAIL', 'PASS']);
  expect(called).toEqual(['workspace', 'browser', 'server']);
});
it('cleans resources acquired before an injected startup failure', async () => {
  const cleanup = new OwnedCleanup(); let stopped = false;
  try { cleanup.add('owned-server', () => { stopped = true; }); throw new Error('injected launch failure'); }
  catch {} finally { await cleanup.run(); }
  expect(stopped).toBe(true);
});
