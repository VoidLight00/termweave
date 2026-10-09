import { expect, it } from 'bun:test';
import { parseLsofNames, processOpenFiles } from './process-files.ts';
it('parses only absolute file names, excludes deleted/malformed entries and bounds output', () => {
  expect(parseLsofNames('p123\nf4\nn/tmp/synthetic.jsonl\nnrelative\nn/tmp/deleted (deleted)\nn/tmp/synthetic.jsonl\n')).toEqual(['/tmp/synthetic.jsonl']);
  expect(parseLsofNames('n/' + 'x'.repeat(1_048_576))).toEqual([]);
});
it('queries an explicit valid macOS PID through bounded argv, not shell discovery', () => {
  const calls: unknown[] = [];
  const result = processOpenFiles(123, 'darwin', ((...args: unknown[]) => { calls.push(args); return { status: 0, stdout: 'p123\nn/tmp/owned.jsonl\n' }; }) as any);
  expect(result).toEqual(['/tmp/owned.jsonl']);
  expect(calls).toEqual([['/usr/sbin/lsof', ['-a', '-p', '123', '-Fn'], { encoding: 'utf8', timeout: 1500, maxBuffer: 1_048_576 }]]);
});
it('returns no evidence for invalid PID, missing lsof, timeout, process exit and malformed output', () => {
  for (const pid of [-1, 0, NaN, 1.5, Infinity]) expect(processOpenFiles(pid, 'darwin', (() => { throw new Error('must not invoke'); }) as any)).toEqual([]);
  for (const result of [{ error: new Error('ENOENT') }, { error: new Error('ETIMEDOUT'), signal: 'SIGTERM' }, { status: 1, stdout: '' }, { status: 0, stdout: 'garbage' }]) {
    expect(processOpenFiles(123, 'darwin', (() => result) as any)).toEqual([]);
  }
});
