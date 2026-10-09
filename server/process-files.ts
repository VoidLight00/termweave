import { readdirSync, readlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export function parseLsofNames(output: string): string[] {
  if (output.length > 1_048_576) return [];
  return [...new Set(output.split('\n').filter(line => line.startsWith('n/')).map(line => line.slice(1))
    .filter(path => !path.includes('\0') && !path.includes('\r') && !path.endsWith(' (deleted)')).slice(0, 1024))];
}
/** Queries one explicit runtime PID only. Failure/exit is absence of evidence, never wider discovery. */
export function processOpenFiles(pid: number, platform = process.platform,
  run = spawnSync): string[] {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647) return [];
  if (platform === 'linux') {
    try { return readdirSync(`/proc/${pid}/fd`).slice(0, 1024).flatMap(fd => {
      try { return [readlinkSync(`/proc/${pid}/fd/${fd}`)]; } catch { return []; }
    }); } catch { return []; }
  }
  if (platform !== 'darwin') return [];
  const result = run('/usr/sbin/lsof', ['-a', '-p', String(pid), '-Fn'], { encoding: 'utf8', timeout: 1500, maxBuffer: 1_048_576 });
  if (result.error || result.signal || result.status !== 0 || typeof result.stdout !== 'string') return [];
  return parseLsofNames(result.stdout);
}
