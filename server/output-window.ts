// Count UTF-8 payload bytes, not JSON framing or UTF-16 string length. A fresh
// subscription id keeps delayed callbacks from acknowledging a later attach.
export const OUTPUT_HIGH_BYTES = 256 * 1024;
export const OUTPUT_LOW_BYTES = 64 * 1024;
export const OUTPUT_HARD_BYTES = 1024 * 1024;
export const OUTPUT_STALL_MS = 2000;

export class OutputWindow {
  readonly id = crypto.randomUUID();
  sent = 0;
  acknowledged = 0;
  blocked = false;

  get pending(): number { return this.sent - this.acknowledged; }

  write(bytes: number): number {
    this.sent += bytes;
    if (this.pending >= OUTPUT_HIGH_BYTES) this.blocked = true;
    return this.sent;
  }

  acknowledge(id: string, offset: number): boolean {
    if (id !== this.id || !Number.isSafeInteger(offset) || offset < 0 || offset > this.sent) return false;
    // Duplicate and out-of-order ACKs cannot release credit twice.
    this.acknowledged = Math.max(this.acknowledged, offset);
    if (this.pending <= OUTPUT_LOW_BYTES) this.blocked = false;
    return true;
  }
}

/** DEC private mode switches (CSI ? Pm h / CSI ? Pm l): alternate screen, mouse reporting, ... */
const PRIVATE_MODES = /\x1b\[\?([\d;]+)([hl])/g;
/** An ESC, or a CSI still missing its final byte. */
const INCOMPLETE_CSI = /^\x1b(\[[\x30-\x3f]*[\x20-\x2f]*)?$/;

/**
 * What a client joining a live attachment is sent: the bounded tail of the stream,
 * led by the private modes set by output that has already fallen out of it.
 *
 * `herdr terminal attach` switches the alternate screen and mouse reporting on once,
 * at the start of the stream. A busy pane pushes that start out of the tail, and a
 * late joiner (a phone opening a pane a desktop tab holds) then got a terminal with
 * mouse reporting off: xterm turns a wheel there into arrow keys, so scrolling walked
 * the agent's prompt history instead of herdr's scrollback.
 */
export class ReplayBuffer {
  private tail = "";
  /**
   * Each mode's last switch in the output before the tail, in the order of those last
   * switches: order matters (1016l after 1006h leaves xterm's mouse encoding at the default).
   */
  private readonly modes = new Map<string, "h" | "l">();

  constructor(private readonly limit: number) {}

  /** Keeps a bounded UTF-8 tail, never starting in the middle of a code point. */
  append(data: string): void {
    const bytes = Buffer.from(this.tail + data);
    let start = Math.max(0, bytes.length - this.limit);
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
    // never cut a control sequence in two: its switch would be lost to both halves
    const escape = start > 0 ? bytes.lastIndexOf(0x1b, start - 1) : -1;
    if (escape >= 0 && INCOMPLETE_CSI.test(bytes.subarray(escape, start).toString("latin1"))) start = escape;
    if (start === 0) {
      this.tail += data;
      return;
    }
    for (const [, params, state] of bytes.subarray(0, start).toString("utf8").matchAll(PRIVATE_MODES)) {
      for (const mode of params!.split(";").filter(Boolean)) {
        this.modes.delete(mode);
        this.modes.set(mode, state as "h" | "l");
      }
    }
    this.tail = bytes.subarray(start).toString("utf8");
  }

  /** The stream as seen by a client joining now. Empty until the pane has written anything. */
  text(): string {
    if (!this.tail) return "";
    return [...this.modes].map(([mode, state]) => `\x1b[?${mode}${state}`).join("") + this.tail;
  }

  /** The raw tail, for matching herdr's own error text. */
  get recent(): string {
    return this.tail;
  }
}
