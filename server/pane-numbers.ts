import { Database } from "bun:sqlite";
import { mkdirSync, lstatSync, chmodSync } from "node:fs";
import { join } from "node:path";

type NumberSnapshot = {
  panes: readonly { terminal_id: string; pane_id?: string }[];
  layouts?: readonly { panes: readonly { pane_id: string }[] }[];
};

/** Display numbers are reusable. Native terminal identities are not. */
export class PaneNumbers {
  private db?: Database;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private directory: string, private scope = "default") {}
  private database(): Database {
    if (this.closed) throw new Error("Pane number store is closed");
    if (this.db) return this.db;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, "pane-numbers.sqlite");
    for (const candidate of [this.directory, path]) {
      try { const info = lstatSync(candidate); if (info.isSymbolicLink() || (process.getuid !== undefined && info.uid !== process.getuid())) throw new Error("Untrusted pane number store"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const db = new Database(path, { create: true });
    chmodSync(path, 0o600);
    try {
      db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS pane_numbers (number INTEGER PRIMARY KEY AUTOINCREMENT, terminal_id TEXT NOT NULL UNIQUE); CREATE TABLE IF NOT EXISTS pane_number_owner (slot INTEGER PRIMARY KEY, scope TEXT NOT NULL, pid INTEGER NOT NULL)");
      db.transaction(() => {
        const owner = db.query<{ scope: string; pid: number }, []>("SELECT scope,pid FROM pane_number_owner WHERE slot=1").get();
        if (owner && owner.scope !== this.scope) throw new Error("Pane number socket scope changed");
        if (owner && owner.pid !== 0) {
          if (owner.pid === process.pid) throw new Error("Pane number store already has an active writer");
          try { process.kill(owner.pid, 0); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return void db.query("UPDATE pane_number_owner SET pid=? WHERE slot=1").run(process.pid); throw error; }
          throw new Error("Pane number store already has an active writer");
        }
        db.query("INSERT OR REPLACE INTO pane_number_owner(slot,scope,pid) VALUES(1,?,?)").run(this.scope, process.pid);
      }).immediate();
    } catch (error) { db.close(); throw error; }
    this.db = db; return db;
  }
  /** Acquire native snapshots in order, before completion presentation can filter them. */
  read<T extends NumberSnapshot>(read: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Pane number store is closed"));
    const result = this.queue.then(async () => {
      if (this.closed) throw new Error("Pane number store is closed");
      return this.annotate(await read());
    });
    this.queue = result.catch(() => {});
    return result;
  }
  annotate<T extends NumberSnapshot>(snapshot: T): T {
    if (this.closed) throw new Error("Pane number store is closed");
    const ids = snapshot.panes.map(pane => pane.terminal_id);
    if (ids.some(id => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) throw new Error("Invalid pane identities");
    const panes = new Set(snapshot.panes.map(pane => pane.pane_id));
    const layoutPanes = snapshot.layouts?.flatMap(layout => layout.panes.map(pane => pane.pane_id));
    const complete = layoutPanes !== undefined && layoutPanes.length === panes.size
      && new Set(layoutPanes).size === layoutPanes.length
      && snapshot.panes.every(pane => typeof pane.pane_id === "string" && !!pane.pane_id)
      && panes.size === snapshot.panes.length && layoutPanes.every(id => panes.has(id));
    const db = this.database();
    const find = db.query<{ number: number }, [string]>("SELECT number FROM pane_numbers WHERE terminal_id = ?");
    const insert = db.query("INSERT INTO pane_numbers (number,terminal_id) VALUES (?,?)");
    return db.transaction(() => {
      if (complete) {
        const live = new Set(ids);
        for (const row of db.query<{ terminal_id: string }, []>("SELECT terminal_id FROM pane_numbers").all()) {
          if (!live.has(row.terminal_id)) db.query("DELETE FROM pane_numbers WHERE terminal_id=?").run(row.terminal_id);
        }
      }
      const used = new Set(db.query<{ number: number }, []>("SELECT number FROM pane_numbers").all().map(row => row.number));
      return { ...snapshot, panes: snapshot.panes.map(pane => {
        let row = find.get(pane.terminal_id);
        if (!row) {
          let number = 1; while (used.has(number)) number++;
          insert.run(number, pane.terminal_id); used.add(number); row = { number };
        }
        if (!Number.isSafeInteger(row.number) || row.number <= 0) throw new Error("Invalid pane number");
        return { ...pane, global_pane_number: row.number };
      }) };
    }).immediate() as T;
  }
  close(): void {
    this.closed = true;
    const db = this.db;
    if (!db) return;
    try {
      // Keep the durable socket scope; pid=0 marks a voluntarily released writer.
      db.query("UPDATE pane_number_owner SET pid=0 WHERE slot=1 AND scope=? AND pid=?").run(this.scope, process.pid);
    } finally { db.close(); this.db = undefined; }
  }
}
