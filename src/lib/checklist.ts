/**
 * Agent checklist payloads -> uniform rows. Four tools carry a plan in four
 * different shapes and the chat lens draws them all the same way:
 * - omp `todo` init: `list: [{ phase, items: [...] }]`, phases become headings;
 * - Claude Code `TodoWrite`: `todos: [{ content, status }]`, where `status`
 *   distinguishes the done rows from the one in flight;
 * - Codex `update_plan`: `plan: [{ step, status }]`, the same statuses; its
 *   answer is only "Plan updated", so the input is the only list there is;
 * - `task`/`Task` fan-outs: `tasks: [...]`, named or anonymous.
 * The input is `unknown` on purpose: these are provider transcripts, not our own
 * wire types, so every field is narrowed and a malformed entry is skipped rather
 * than rendered as junk.
 */

/** one checklist row shared by the todo/task renderers */
export interface ChecklistRow {
  label: string;
  done: boolean;
  active?: boolean;
  heading?: boolean;
}

export function phaseRows(list: unknown[]): ChecklistRow[] {
  const rows: ChecklistRow[] = [];
  for (const phase of list) {
    if (typeof phase !== "object" || phase === null) continue;
    if ("phase" in phase && typeof phase.phase === "string") {
      rows.push({ label: phase.phase, done: false, heading: true });
    }
    if ("items" in phase && Array.isArray(phase.items)) {
      for (const item of phase.items) {
        if (typeof item === "string") rows.push({ label: item, done: false });
      }
    }
  }
  return rows;
}

export function todoRows(todos: unknown[]): ChecklistRow[] {
  const rows: ChecklistRow[] = [];
  for (const todo of todos) {
    if (typeof todo !== "object" || todo === null) continue;
    if (!("content" in todo) || typeof todo.content !== "string") continue;
    const status = "status" in todo ? todo.status : undefined;
    rows.push({ label: todo.content, done: status === "completed", active: status === "in_progress" });
  }
  return rows;
}

export function planRows(plan: unknown[]): ChecklistRow[] {
  const rows: ChecklistRow[] = [];
  for (const entry of plan) {
    if (typeof entry !== "object" || entry === null) continue;
    if (!("step" in entry) || typeof entry.step !== "string") continue;
    const status = "status" in entry ? entry.status : undefined;
    rows.push({ label: entry.step, done: status === "completed", active: status === "in_progress" });
  }
  return rows;
}

export function taskRows(tasks: unknown[]): ChecklistRow[] {
  const rows: ChecklistRow[] = [];
  for (const [index, task] of tasks.entries()) {
    if (typeof task === "string") {
      rows.push({ label: task, done: false });
      continue;
    }
    if (typeof task !== "object" || task === null) continue;
    const name = "name" in task && typeof task.name === "string" ? task.name : "";
    rows.push({ label: name.length > 0 ? name : `task ${index + 1}`, done: false });
  }
  return rows;
}
