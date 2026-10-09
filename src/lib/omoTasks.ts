import type { OmoRun, OmoTask } from "../../shared/protocol.ts";

/** How long something has run: until now while it runs, until it ended otherwise; null when unknown. */
export function spanMs(startedAt: string | null, endedAt: string | null, running: boolean, now: number): number | null {
  const started = startedAt === null ? NaN : Date.parse(startedAt);
  const ended = running ? now : endedAt === null ? NaN : Date.parse(endedAt);
  return Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? ended - started : null;
}

export function taskElapsedMs(task: OmoTask, now: number): number | null {
  return spanMs(task.started_at, task.ended_at, task.status === "running", now);
}

/** A workflow that has not ended: waiting and paused ones still have steps to run. */
export function runGoing(run: OmoRun): boolean {
  return run.status === "running" || run.status === "pending" || run.status === "paused";
}

/**
 * What the folded line says of everything that ended: how many, and how many of those went
 * wrong (a failed or lost task, a failed workflow), so a failure is seen without opening it.
 */
export function endedSummary(tasks: OmoTask[], runs: OmoRun[]): { ended: number; failed: number } {
  const endedTasks = tasks.filter((task) => task.status !== "running");
  const endedRuns = runs.filter((run) => !runGoing(run));
  return {
    ended: endedTasks.length + endedRuns.length,
    failed: endedTasks.filter((task) => task.status === "failed" || task.status === "lost").length + endedRuns.filter((run) => run.status === "failed").length,
  };
}

/** How far the PC's clock is ahead of this browser's, from the time it answered with; 0 when unknown. */
export function clockOffsetMs(serverTime: string | null, receivedAt: number): number {
  const server = serverTime === null ? NaN : Date.parse(serverTime);
  return Number.isFinite(server) ? server - receivedAt : 0;
}

/** `8s`, `4m 12s`, `1h 3m` */
export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
