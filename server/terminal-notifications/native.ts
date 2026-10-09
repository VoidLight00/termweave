import type { TerminalAnnouncement } from "../../shared/terminal-notifications.ts";
export type NativeAnnouncement = TerminalAnnouncement & { terminal_id: string; sequence: number };
export type NativeBatch = { source: "live-pty-notifications-v1"; epoch: string; cursor: number; truncated: boolean; items: NativeAnnouncement[] };
export function nativeBatch(value: unknown): NativeBatch {
  const batch = value as NativeBatch;
  if (!batch || batch.source !== "live-pty-notifications-v1" || typeof batch.epoch !== "string" || !/^[a-zA-Z0-9_.-]{1,128}$/.test(batch.epoch) || !Number.isSafeInteger(batch.cursor) || batch.cursor < 0 || typeof batch.truncated !== "boolean" || !Array.isArray(batch.items) || batch.items.length > 100) throw new Error("invalid_notification_batch");
  let previous = 0;
  for (const item of batch.items) {
    if (!item || !Number.isSafeInteger(item.sequence) || item.sequence <= previous || item.sequence > batch.cursor || typeof item.terminal_id !== "string" || !item.terminal_id || item.terminal_id.length > 256 || /[\x00-\x20\x7f]/.test(item.terminal_id) || !["9", "99", "777"].includes(item.protocol) || typeof item.title !== "string" || typeof item.body !== "string" || item.title.length + item.body.length > 4096) throw new Error("invalid_notification_record");
    previous = item.sequence;
  }
  return batch;
}
