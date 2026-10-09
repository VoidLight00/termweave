import type { TerminalAnnouncement } from "../../shared/terminal-notifications.ts";

const MAX_SEQUENCE = 8192;
const MAX_TEXT = 4096;
/** Remove terminal controls and invisible direction overrides; render the rest as text. */
export function notificationText(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim();
}
type Pending = { title: string; body: string; at: number; invalid?: boolean };
/** Bounded streaming parser. It never writes responses or changes the terminal output. */
export class NotificationParser {
  private state: "text" | "escape" | "osc" | "end" = "text";
  private value = "";
  private overflow = false;
  private pending = new Map<string, Pending>();
  constructor(private emit: (item: TerminalAnnouncement) => void, private now = Date.now) {}
  feed(chunk: string): void {
    for (const ch of chunk) {
      if (this.state === "text") { if (ch === "\x1b") this.state = "escape"; else if (ch === "\x9d") this.begin(); continue; }
      if (this.state === "escape") { if (ch === "]") this.begin(); else this.state = ch === "\x1b" ? "escape" : "text"; continue; }
      if (this.state === "end") {
        if (ch === "\\") { this.finish(); continue; }
        // An embedded escape is invalid. Discard until a terminator, including nested OSCs.
        this.overflow = true; this.state = "osc";
      }
      if (ch === "\x07" || ch === "\x9c") { this.finish(); continue; }
      if (ch === "\x1b") { this.state = "end"; continue; }
      if (!this.overflow) { this.value += ch; if (this.value.length > MAX_SEQUENCE) { this.value = ""; this.overflow = true; this.pending.clear(); } }
    }
  }
  private begin(): void { this.state = "osc"; this.value = ""; this.overflow = false; }
  private finish(): void {
    const value = this.value; const valid = !this.overflow;
    this.state = "text"; this.value = ""; this.overflow = false;
    if (valid) this.parse(value);
  }
  private publish(protocol: TerminalAnnouncement["protocol"], title: string, body = ""): void {
    if (title.length + body.length > MAX_TEXT) return;
    title = notificationText(title); body = notificationText(body);
    if (!title) { title = body; body = ""; }
    if (title) this.emit({ protocol, title, body });
  }
  private parse(value: string): void {
    if (value.startsWith("9;")) {
      const text = value.slice(2);
      // OSC 9;4 is progress reporting, not a desktop notification.
      if (!/^\d+;/.test(text)) this.publish("9", text);
      return;
    }
    if (value.startsWith("777;notify;")) {
      const content = value.slice(11); const split = content.indexOf(";");
      if (split >= 0) this.publish("777", content.slice(0, split), content.slice(split + 1));
      return;
    }
    if (!value.startsWith("99;")) return;
    const split = value.indexOf(";", 3); if (split < 0) return;
    const raw = value.slice(3, split); if (raw.length > 512) return;
    const fields = new Map<string, string>();
    if (raw) for (const part of raw.split(":")) { const match = /^([a-zA-Z])=([^\s:;=]*)$/.exec(part); if (!match || fields.has(match[1]!)) return; fields.set(match[1]!, match[2]!); }
    const id = fields.get("i") ?? "";
    if (id && !/^[a-zA-Z0-9_+.-]{1,128}$/.test(id)) return;
    const type = fields.get("p") ?? "title";
    // No callbacks, icon downloads, commands, buttons, or protocol query responses.
    if (type !== "title" && type !== "body") { this.pending.delete(id); return; }
    if (fields.has("e") && fields.get("e") !== "0") { this.pending.delete(id); return; } // encoded payloads are not supported
    const done = fields.get("d") ?? "1"; if (done !== "0" && done !== "1") return;
    const now = this.now(); for (const [key, item] of this.pending) if (now - item.at > 30000) this.pending.delete(key);
    if (done === "0" && !id) return;
    const item = this.pending.get(id) ?? { title: "", body: "", at: now };
    item[type] += value.slice(split + 1);
    if (item.title.length + item.body.length > MAX_TEXT) { item.title = ""; item.body = ""; item.invalid = true; }
    if (done === "0") { if (this.pending.size >= 32 && !this.pending.has(id)) this.pending.delete(this.pending.keys().next().value!); this.pending.set(id, item); }
    else { this.pending.delete(id); if (!item.invalid) this.publish("99", item.title, item.body); }
  }
}
