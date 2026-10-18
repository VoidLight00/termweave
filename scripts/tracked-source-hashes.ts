import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

/** Keep caller Git overrides from redirecting repository inspection. */
export const gitEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Hash every tracked working-tree file, only from the actual repository root. */
export function trackedHashes(repo: string): Record<string, string> {
  repo = realpathSync(repo);
  const options = { cwd: repo, env: gitEnvironment(), encoding: 'utf8' as const };
  if (realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], options).trim()) !== repo) throw new Error('Repository root mismatch');
  const names = execFileSync('git', ['ls-files', '-z'], options).split('\0').filter(Boolean).sort();
  return Object.fromEntries(names.map(name => [name, sha(readFileSync(resolve(repo, name)))]));
}
