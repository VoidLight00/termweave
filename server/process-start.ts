import { readFileSync } from "node:fs";
import { execFileSync } from 'node:child_process';

/**
 * When a process started, in ms since the epoch: Linux counts it in /proc (USER_HZ
 * ticks after boot). null where that is not readable, as on macOS.
 */
export function processStartedAt(pid: number): number | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'darwin') {
      const value = Date.parse(execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 1500, maxBuffer: 4096, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).trim() + ' UTC');
      return Number.isFinite(value) ? value : null;
    }
    const ticks = Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop()!.split(" ")[19]);
    const boot = Number(readFileSync("/proc/stat", "utf8").match(/^btime (\d+)$/m)?.[1]);
    return Number.isFinite(ticks) && Number.isFinite(boot) ? boot * 1000 + ticks * 10 : null;
  } catch {
    return null;
  }
}
