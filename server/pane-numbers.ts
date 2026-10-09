import { Database } from "bun:sqlite";
import { mkdirSync, lstatSync, chmodSync } from "node:fs";
import { join } from "node:path";

/** AUTOINCREMENT retains tombstones and serializes allocation across bridge processes. */
export class PaneNumbers {
  private db?: Database;
  constructor(private directory: string) {}
  private database(): Database {
    if (this.db) return this.db;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, "pane-numbers.sqlite");
    for (const candidate of [this.directory, path]) {
      try { const info = lstatSync(candidate); if (info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new Error("Untrusted pane number store"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const db = new Database(path, { create: true });
    chmodSync(path, 0o600);
    try { db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS pane_numbers (number INTEGER PRIMARY KEY AUTOINCREMENT, terminal_id TEXT NOT NULL UNIQUE)"); }
    catch (error) { db.close(); throw error; }
    this.db = db; return db;
  }
  annotate<T extends { panes: readonly { terminal_id: string }[] }>(snapshot: T): T {
    const db = this.database();
    const find = db.query<{ number: number }, [string]>("SELECT number FROM pane_numbers WHERE terminal_id = ?");
    const insert = db.query("INSERT INTO pane_numbers (terminal_id) VALUES (?)");
    return db.transaction(() => ({ ...snapshot, panes: snapshot.panes.map(pane => {
      if (!pane.terminal_id) return pane;
      let row = find.get(pane.terminal_id);
      if (!row) { insert.run(pane.terminal_id); row = find.get(pane.terminal_id); }
      if (!row || !Number.isSafeInteger(row.number)) throw new Error("Invalid pane number");
      return { ...pane, global_pane_number: row.number };
    }) })).immediate() as T;
  }
  close(): void { this.db?.close(); this.db = undefined; }
}
