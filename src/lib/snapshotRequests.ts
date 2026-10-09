/** Events and newer requests supersede in-flight HTTP snapshots, including their errors. */
export class SnapshotRequests {
  private revision = 0;

  invalidate(): void { this.revision++; }

  async read<T>(fetch: () => Promise<T>, commit: (value: T) => void): Promise<void> {
    const revision = ++this.revision;
    try {
      const value = await fetch();
      if (revision === this.revision) commit(value);
    } catch (error) {
      if (revision === this.revision) throw error;
    }
  }
}
