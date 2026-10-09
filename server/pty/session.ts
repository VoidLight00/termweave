import { join } from "node:path";

const HOST_SCRIPT = join(import.meta.dir, "pty-host.mjs");

export interface PtySessionOptions {
  command: string;
  args: string[];
  cols: number;
  rows: number;
  onData: (data: string) => void;
  onExit: (code: number | null) => void;
  /** Extra environment for the command, on top of this process's own. */
  env?: Record<string, string>;
}

/**
 * A command running on a real PTY, hosted by a Node sidecar (see pty-host.mjs for
 * why output flow control currently needs node-pty, and why it is the prebuilt
 * @lydell/node-pty distribution of it).
 */
export class PtySession {
  readonly exited: Promise<void>;
  private readonly proc: ReturnType<typeof Bun.spawn>;
  private closed = false;
  private paused = false;

  constructor(private readonly options: PtySessionOptions) {
    this.proc = Bun.spawn(
      ["node", HOST_SCRIPT, String(options.cols), String(options.rows), options.command, ...options.args],
      { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: { ...process.env, ...options.env } },
    );

    // Process exit can precede the final stdout read. Deliver every byte before
    // onExit lets the server remove the attachment.
    this.exited = Promise.all([this.proc.exited, this.pump()]).then(([code]) => {
      if (this.closed) return;
      this.closed = true;
      options.onExit(code ?? null);
    });
  }

  private async pump(): Promise<void> {
    const stream = this.proc.stdout;
    if (!(stream instanceof ReadableStream)) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        // stream:true keeps a multi-byte character split across reads intact
        const text = decoder.decode(value, { stream: true });
        if (text) this.options.onData(text);
      }
      const tail = decoder.decode();
      if (tail) this.options.onData(tail);
    } catch {
      /* the pty closed underneath us; onExit reports it */
    } finally {
      reader.releaseLock();
    }
  }

  private send(frame: Record<string, unknown>): boolean {
    if (this.closed) return false;
    const sink = this.proc.stdin;
    if (!sink || typeof sink === "number" || !("write" in sink)) return false;
    try {
      sink.write(`${JSON.stringify(frame)}\n`);
      sink.flush();
      return true;
    } catch {
      return false; // host already gone
    }
  }

  write(data: string): boolean {
    return this.send({ t: "i", d: data });
  }

  resize(cols: number, rows: number): void {
    this.send({ t: "r", c: cols, r: rows });
  }

  pause(): void {
    if (this.paused || this.closed) return;
    this.paused = true;
    this.send({ t: "p", paused: true });
  }

  resume(): void {
    if (!this.paused || this.closed) return;
    this.paused = false;
    this.send({ t: "p", paused: false });
  }

  kill(): void {
    if (this.closed) return;
    this.closed = true;
    const sink = this.proc.stdin;
    try {
      if (sink && typeof sink !== "number" && "end" in sink) sink.end();
    } catch {
      /* ignore */
    }
    try {
      this.proc.kill();
    } catch {
      /* ignore */
    }
  }
}
