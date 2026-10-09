/** Held messages are explicitly sent, never dispatched by reconnects or status changes. */
export interface HeldMessage { id: string; text: string }
type QueueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const newId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** Target-scoped cache also lets an ACK remove its own item after the user switches panes. */
export class MessageQueueStore {
  private saved = new Map<string, string | null>();
  private unsaved = new Set<string>();
  isUnsaved(owner: string): boolean { return this.unsaved.has(owner); }
  private queues = new Map<string, HeldMessage[]>();
  private listeners = new Set<() => void>();
  private pending = new Set<string>();
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  hasPendingInput(): boolean { return this.pending.size > 0; }
  hasDrafts(): boolean { return [...this.queues.values()].some(queue => queue.length > 0); }
  isSending(id: string): boolean { return this.pending.has(id); }
  beginSend(owner: string, id: string): boolean {
    if (this.pending.has(id)) return false;
    this.pending.add(id);
    this.queues.set(owner, [...this.read(owner)]);
    for (const listener of this.listeners) listener();
    return true;
  }
  endSend(owner: string, id: string): void {
    this.pending.delete(id);
    this.queues.set(owner, [...this.read(owner)]);
    for (const listener of this.listeners) listener();
  }
  constructor(private storage: () => QueueStorage = () => window.localStorage) {}

  /** Reconcile storage before mutation; another tab may have written since our last render. */
  refresh(owner: string): void {
    if (this.unsaved.has(owner)) return;
    try {
      const raw = this.storage().getItem(`termweave:queue:${owner}`);
      if (this.saved.has(owner) && raw === this.saved.get(owner)) return;
      this.queues.delete(owner);
      this.read(owner);
      for (const listener of this.listeners) listener();
    } catch { /* keep in-memory messages when storage cannot be read */ }
  }

  read(owner: string): HeldMessage[] {
    const cached = this.queues.get(owner);
    if (cached) return cached;
    let raw: string | null = null;
    try { raw = this.storage().getItem(`termweave:queue:${owner}`); } catch { /* private mode */ }
    let messages: HeldMessage[] = raw ? [{ id: newId(), text: raw }] : [];
    try {
      const data = JSON.parse(raw ?? "null");
      if (data?.version === 1 && Array.isArray(data.messages)) {
        const ids = new Set<string>();
        messages = data.messages.filter((item: unknown): item is HeldMessage => {
          if (!item || typeof item !== "object") return false;
          const value = item as HeldMessage;
          if (typeof value.id !== "string" || typeof value.text !== "string" || ids.has(value.id)) return false;
          ids.add(value.id); return true;
        });
      }
    } catch { /* previous versions stored a single plain-text message */ }
    this.saved.set(owner, raw);
    this.queues.set(owner, messages);
    return messages;
  }

  private write(owner: string, messages: HeldMessage[]): void {
    this.queues.set(owner, messages);
    try {
      const key = `termweave:queue:${owner}`;
      const raw = messages.length ? JSON.stringify({ version: 1, messages }) : null;
      if (raw !== null) this.storage().setItem(key, raw);
      else this.storage().removeItem(key);
      this.saved.set(owner, raw);
      this.unsaved.delete(owner);
    } catch { this.unsaved.add(owner); }
    for (const listener of this.listeners) listener();
  }

  add(owner: string, text: string): void {
    this.refresh(owner);
    this.write(owner, [...this.read(owner), { id: newId(), text }]);
  }
  edit(owner: string, id: string, text: string): void {
    this.refresh(owner);
    this.write(owner, this.read(owner).map((message) => message.id === id ? { ...message, text } : message));
  }
  remove(owner: string, id: string): void {
    this.refresh(owner);
    this.write(owner, this.read(owner).filter((message) => message.id !== id));
  }
}

// Machine switches remount the terminal; outstanding sends must share the same owner cache.
export const messageQueues = new MessageQueueStore();

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    const prefix = "termweave:queue:";
    if (event.key?.startsWith(prefix)) messageQueues.refresh(event.key.slice(prefix.length));
  });
}
