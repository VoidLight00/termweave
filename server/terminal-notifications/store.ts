import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync, lstatSync } from "node:fs";
import { join } from "node:path";
import type { TerminalAnnouncement, TerminalNotification, NotificationTarget } from "../../shared/terminal-notifications.ts";
import { nativeBatch, type NativeBatch } from "./native.ts";
import { notificationText } from "./parser.ts";
type Row = TerminalAnnouncement & { id: number; terminalId: string; createdAt: number; read: number };
export type CurrentPane = { terminal_id: string; pane_id: string; workspace_id: string; global_pane_number?: number; restore_error?: string | null };
export function currentTarget(terminalId: string, panes: readonly CurrentPane[]): NotificationTarget | null {
  const found = panes.filter(p => p.terminal_id === terminalId && !p.restore_error);
  if (found.length !== 1) return null;
  const pane = found[0]!; const number = pane.global_pane_number;
  if (!pane.pane_id || !pane.workspace_id || !Number.isSafeInteger(number) || number! <= 0) return null;
  return { terminalId, paneId: pane.pane_id, workspaceId: pane.workspace_id, paneNumber: number! };
}
export class TerminalNotificationStore {
  private db: Database;
  constructor(directory: string, private now = Date.now) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "terminal-notifications.sqlite");
    for (const entry of [directory, path, `${path}-wal`, `${path}-shm`]) {
      try { const stat = lstatSync(entry); if (stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw new Error("Untrusted notification store"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    this.db = new Database(path, { create: true }); chmodSync(path, 0o600);
    this.db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, terminalId TEXT NOT NULL, protocol TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, createdAt INTEGER NOT NULL, read INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS notification_terminal ON notifications(terminalId,createdAt)");
  }
  nativeCursor(): { epoch: string; cursor: number } {
    this.db.exec("CREATE TABLE IF NOT EXISTS native_notification_cursor(slot INTEGER PRIMARY KEY, epoch TEXT NOT NULL, cursor INTEGER NOT NULL)");
    return this.db.query<{epoch:string;cursor:number}, []>("SELECT epoch,cursor FROM native_notification_cursor WHERE slot=1").get() ?? {epoch:"",cursor:0};
  }
  ingestNative(value: NativeBatch): void {
    const batch = nativeBatch(value); const before = this.nativeCursor();
    if (before.epoch === batch.epoch && batch.cursor < before.cursor) throw new Error("stale_notification_cursor");
    this.db.transaction(() => {
      for (const item of batch.items) {
        if (before.epoch === batch.epoch && item.sequence <= before.cursor) continue;
        this.insert(item.terminal_id, item);
      }
      this.db.query("INSERT INTO native_notification_cursor(slot,epoch,cursor) VALUES(1,?,?) ON CONFLICT(slot) DO UPDATE SET epoch=excluded.epoch,cursor=excluded.cursor").run(batch.epoch,batch.cursor);
    }).immediate();
  }
  add(terminalId: string, item: TerminalAnnouncement): boolean {
    return this.db.transaction(() => this.insert(terminalId, item)).immediate();
  }
  private insert(terminalId: string, item: TerminalAnnouncement): boolean {
    if (!terminalId || terminalId.length > 256 || /[\x00-\x20\x7f]/.test(terminalId) || !["9", "99", "777"].includes(item.protocol) || item.title.length + item.body.length > 4096) return false;
    const title = notificationText(item.title), body = notificationText(item.body); if (!title && !body) return false;
    const now = this.now();
      const recent = this.db.query<{ count: number }, [string, number]>("SELECT count(*) AS count FROM notifications WHERE terminalId=? AND createdAt>=?").get(terminalId, now - 60000)!;
      if (recent.count >= 20) return false;
      if (this.db.query("SELECT id FROM notifications WHERE terminalId=? AND title=? AND body=? AND createdAt>=? LIMIT 1").get(terminalId, title, body, now - 10000)) return false;
      this.db.query("INSERT INTO notifications(terminalId,protocol,title,body,createdAt) VALUES(?,?,?,?,?)").run(terminalId, item.protocol, title, body, now);
      this.db.exec("DELETE FROM notifications WHERE id NOT IN (SELECT id FROM notifications ORDER BY id DESC LIMIT 200)");
      return true;
  }
  list(panes: readonly CurrentPane[]): TerminalNotification[] {
    return this.db.query<Row, []>("SELECT * FROM notifications ORDER BY id DESC LIMIT 200").all().map(row => ({ ...row, read: row.read === 1, target: currentTarget(row.terminalId, panes) }));
  }
  target(id: number, panes: readonly CurrentPane[]): NotificationTarget | null {
    const row = this.db.query<{ terminalId: string }, [number]>("SELECT terminalId FROM notifications WHERE id=?").get(id);
    return row ? currentTarget(row.terminalId, panes) : null;
  }
  read(id: number): void { this.db.query("UPDATE notifications SET read=1 WHERE id=?").run(id); }
  clear(): void { this.db.exec("DELETE FROM notifications"); }
  close(): void { this.db.close(); }
}
