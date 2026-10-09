import type { ServerWebSocket } from "bun";
import { PtySession } from "../pty/session.ts";
import { OutputWindow, OUTPUT_HARD_BYTES, OUTPUT_STALL_MS } from "../output-window.ts";

/** Each connection is a native tmux client. Closing it detaches, never kills its session. */
export class TmuxTerminal {
  private pty?: PtySession;
  private socket?: ServerWebSocket<unknown>;
  private closed = false;
  private credit = new OutputWindow();
  private timer?: ReturnType<typeof setInterval>;
  private blockedAt = 0;
  constructor(private readonly launch: { command: string; args: string[] }, private readonly readOnly: boolean) {}

  bind(socket: ServerWebSocket<unknown>): void {
    this.socket = socket;
    if (this.closed) { socket.close(); return; }
    this.pty = new PtySession({ ...this.launch, cols: 120, rows: 40,
      env: { TMUX: "", TMUX_PANE: "", HERDR_WEB_TOKEN: "", HERDR_BRIDGE_TOKEN: "" },
      onData: data => {
        if (this.closed) return;
        const offset = this.credit.write(Buffer.byteLength(data));
        if (this.credit.pending > OUTPUT_HARD_BYTES) { this.close(4008, "Terminal output stalled"); return; }
        this.send({ type: "output", data, id: this.credit.id, offset });
        if (this.credit.blocked) this.pty?.pause();
      },
      onExit: () => this.close(1000, "Detached from tmux"),
    });
    this.timer = setInterval(() => {
      if (!this.credit.blocked) this.blockedAt = 0;
      else if (!this.blockedAt) this.blockedAt = Date.now();
      if (this.blockedAt && Date.now() - this.blockedAt > OUTPUT_STALL_MS) this.close(4008, "Terminal output stalled");
    }, 100);
    this.timer.unref();
    this.send({ type: "ready", readOnly: this.readOnly });
  }

  private send(value: unknown): void {
    if (this.closed || !this.socket) return;
    const frame = JSON.stringify(value);
    if (this.socket.getBufferedAmount() + Buffer.byteLength(frame) > OUTPUT_HARD_BYTES || this.socket.send(frame) === 0)
      this.close(4008, "Terminal transport stalled");
  }

  message(raw: string | Buffer): void {
    if (this.closed) return;
    if (Buffer.byteLength(raw) > 65536) { this.close(1009, "Input too large"); return; }
    let message;
    try { message = JSON.parse(String(raw)); } catch { this.close(1008, "Invalid message"); return; }
    if (!message || typeof message !== "object") { this.close(1008, "Invalid message"); return; }
    if (message.type === "ack") {
      if (!this.credit.acknowledge(message.id, message.offset)) { this.close(1008, "Invalid acknowledgement"); return; }
      if (!this.credit.blocked) this.pty?.resume();
    } else if (message.type === "input") {
      if (this.readOnly) { this.close(1008, "Read only"); return; }
      if (typeof message.data !== "string" || !this.pty?.write(message.data)) this.close(1008, "Input unavailable");
    } else if (message.type === "resize") {
      if (this.readOnly) return;
      if (!Number.isInteger(message.cols) || !Number.isInteger(message.rows) || message.cols < 2 || message.rows < 2 || message.cols > 1000 || message.rows > 1000)
        { this.close(1008, "Invalid geometry"); return; }
      this.pty?.resize(message.cols, message.rows);
    } else this.close(1008, "Unknown message");
  }

  close(code = 1000, reason = "Detached"): void {
    if (this.closed) return;
    this.closed = true; clearInterval(this.timer); this.pty?.kill(); this.socket?.close(code, reason);
  }
}
