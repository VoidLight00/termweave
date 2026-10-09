export class OwnedCleanup {
  private readonly tasks: { name: string; run: () => unknown | Promise<unknown> }[] = [];
  add(name: string, run: () => unknown | Promise<unknown>) { this.tasks.push({ name, run }); }
  async run() {
    const results: { name: string; status: string; error?: string }[] = [];
    for (const task of this.tasks.reverse()) {
      try { await task.run(); results.push({ name: task.name, status: 'PASS' }); }
      catch (error) { results.push({ name: task.name, status: 'FAIL', error: String(error) }); }
    }
    return results;
  }
}
