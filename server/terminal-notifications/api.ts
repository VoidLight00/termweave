import { nativeBatch } from "./native.ts";
import { NotificationParser } from "./parser.ts";
import { TerminalNotificationStore, type CurrentPane } from "./store.ts";
/** Mount AFTER global authentication and same-origin checks. No terminal mutation exists here. */
export class TerminalNotifications {
  private store: TerminalNotificationStore;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private sourceStatus: "unavailable" | "available" = "unavailable";
  /** Read-only cursor polling; old runtimes fail locally without adding terminal attachments. */
  startNative(read: (after: number) => Promise<unknown>): void {
    if (this.timer || this.stopped) return;
    const poll = async () => {
      let delay = 1000;
      try {
        const cursor = this.store.nativeCursor(); let batch = nativeBatch(await read(cursor.cursor));
        if (this.stopped) return;
        if (cursor.epoch && cursor.epoch !== batch.epoch) batch = nativeBatch(await read(0));
        if (this.stopped) return;
        this.store.ingestNative(batch); this.sourceStatus = "available";
        if (batch.truncated) delay = 50;
      } catch { this.sourceStatus = "unavailable"; delay = 30000; }
      if (!this.stopped) this.timer = setTimeout(() => void poll(), delay);
    };
    this.timer = setTimeout(() => void poll(), 0);
  }
  constructor(directory: string, private snapshot: () => Promise<{ panes: readonly CurrentPane[] }>) { this.store = new TerminalNotificationStore(directory); }
  /** One parser per native attach stream. Do not feed mirror screens or replay buffers. */
  stream(terminalId: string): (data: string) => void {
    const parser = new NotificationParser(item => { try { this.store.add(terminalId, item); } catch { /* inbox I/O must not break terminal transport */ } });
    return data => parser.feed(data);
  }
  async handle(request: Request, readOnly: boolean): Promise<Response | null> {
    const path = new URL(request.url).pathname; const base = "/api/terminal-notifications";
    if (path !== base && !path.startsWith(`${base}/`)) return null;
    const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
    try {
      if (request.method === "GET" && path === base) {
        const items = this.store.list((await this.snapshot()).panes);
        return json({ items, unread: items.filter(i => !i.read).length, checkedAt: Date.now(), collection: "native-live-output", sourceStatus: this.sourceStatus });
      }
      const match = /^\/api\/terminal-notifications\/([1-9][0-9]*)\/(target|read)$/.exec(path);
      const id = match ? Number(match[1]) : NaN;
      if (match && !Number.isSafeInteger(id)) return json({ error: "invalid_id" }, 400);
      if (match?.[2] === "target" && request.method === "GET") {
        const target = this.store.target(id, (await this.snapshot()).panes);
        return target ? json(target) : json({ error: "terminal_unavailable" }, 410);
      }
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      if (readOnly) return json({ error: "read_only" }, 403);
      if (path === `${base}/clear`) this.store.clear();
      else if (match?.[2] === "read") this.store.read(id);
      else return json({ error: "not_found" }, 404);
      return json({ ok: true });
    } catch { return json({ error: "notifications_unavailable" }, 503); }
  }
  close(): void { this.stopped = true; clearTimeout(this.timer); this.store.close(); }
}
