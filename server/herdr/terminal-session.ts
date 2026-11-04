/**
 * A pane's terminal streamed through herdr's own bridge CLI, `herdr terminal session control`,
 * where `herdr terminal attach` is not there (Windows, herdrdev/herdr#4821) or cannot run (a
 * runtime without the PTY sidecar). Measured on herdr 0.9.5 under Windows: no PTY is needed, the
 * CLI talks JSON lines on its pipes.
 *
 * Out: `terminal.frame` {seq, width, height, full, encoding: "base64", bytes}. A frame's bytes are
 * a whole ANSI frame, synchronized output around it; a full one clears and paints every row, and
 * every frame ends with the program's cursor placed and shown or hidden (a hidden cursor still
 * sits where the program left it, so the browser's IME box does too). `terminal.closed` {reason}
 * ends the stream: herdr's refusal ("... already has an attached client; retry with --takeover",
 * "... has a read in progress; retry") or the terminal's end, with exit code 0 either way.
 *
 * In: `terminal.input` (base64 bytes, Esc and Ctrl+C included, as typed), `terminal.resize`
 * (herdr resizes the pane's runtime and paints a full frame of the new size, a same-size one
 * included), `terminal.scroll` (a wheel at a 1-based cell: herdr makes it mouse reports, alternate
 * scroll or its own scrollback, as the program in the pane wants) and `terminal.release`.
 *
 * The stream carries no terminal modes (no alternate screen, mouse reporting or bracketed paste),
 * titles, bells or OSC 52. It stands where a PtySession stands, so the attach lifecycle and the
 * output window are the same; a late joiner gets the frames since the last full one (`current`).
 */

/** how long a released control gets to exit before it is killed: a control can outlive its server connection (herdrdev/herdr#5175) */
export const SESSION_RELEASE_MS = 3000;
/** what of the CLI's stderr is kept for the log */
const STDERR_TAIL = 2048;

export interface TerminalSessionOptions {
  /** the herdr binary */
  command: string;
  /** herdr's terminal id (pane.terminal_id), not the pane id */
  terminal: string;
  cols: number;
  rows: number;
  /** `full`: the frame paints the whole screen */
  onData: (data: string, full: boolean) => void;
  /** `reason`: herdr's terminal.closed, null when the CLI ended without one */
  onExit: (code: number | null, reason: string | null) => void;
  /** Extra environment for the CLI, on top of this process's own. */
  env?: Record<string, string>;
  /** the most `current` holds before a late joiner needs a full frame painted instead */
  replayBytes?: number;
  releaseMs?: number;
}

type Sink = { write(data: string): unknown; flush(): unknown; end(): unknown };

export class TerminalSession {
  readonly exited: Promise<void>;
  /** true once herdr answered (a frame or terminal.closed); false when the CLI ended without a word of its protocol */
  readonly started: Promise<boolean>;
  private settleStarted!: (spoke: boolean) => void;
  private readonly proc: ReturnType<typeof Bun.spawn>;
  /** the owner closed it: no onExit */
  private closed = false;
  private paused = false;
  private spoke = false;
  private reason: string | null = null;
  private stderrTail = "";
  private cols: number;
  private rows: number;
  /** the frames since the last full one, while they fit in replayBytes and none was dropped */
  private frames: string[] | null = null;
  private frameBytes = 0;
  private watchdog: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: TerminalSessionOptions) {
    this.cols = options.cols;
    this.rows = options.rows;
    this.started = new Promise((resolve) => { this.settleStarted = resolve; });
    // Bun.spawn throws synchronously (no herdr on PATH): the caller falls back, as for a PtySession
    this.proc = Bun.spawn(
      [options.command, "terminal", "session", "control", options.terminal, "--cols", String(options.cols), "--rows", String(options.rows)],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...options.env }, windowsHide: true },
    );
    // every frame is delivered before onExit lets the server remove the attachment
    this.exited = Promise.all([this.proc.exited, this.pump(), this.drainStderr()]).then(([code]) => {
      clearTimeout(this.watchdog);
      this.settleStarted(this.spoke);
      if (this.closed) return;
      this.closed = true;
      options.onExit(code ?? null, this.reason);
    });
  }

  /** whether herdr has answered on this stream yet */
  get answered(): boolean {
    return this.spoke;
  }

  /** the CLI's last stderr, for the log when it ended without a reason */
  get stderr(): string {
    return this.stderrTail;
  }

  /** The screen for a client joining now: the frames since the last full one, or null when they are not all here (repaint() paints one). */
  get current(): string | null {
    return this.frames === null ? null : this.frames.join("");
  }

  private async pump(): Promise<void> {
    const stream = this.proc.stdout;
    if (!(stream instanceof ReadableStream)) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let line = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        line += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = line.indexOf("\n")) >= 0) {
          this.receive(line.slice(0, end));
          line = line.slice(end + 1);
        }
      }
      this.receive(line + decoder.decode());
    } catch {
      /* the CLI went away underneath us; its exit reports it */
    } finally {
      reader.releaseLock();
    }
    // the stream is over: a control that outlives it would keep the terminal's one controller slot
    this.end();
  }

  private async drainStderr(): Promise<void> {
    const stream = this.proc.stderr;
    if (!(stream instanceof ReadableStream)) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) this.stderrTail = (this.stderrTail + decoder.decode(value, { stream: true })).slice(-STDERR_TAIL);
      }
    } catch {
      /* gone with the CLI */
    } finally {
      reader.releaseLock();
    }
  }

  private receive(text: string): void {
    if (!text.trim()) return;
    let message: { type?: unknown; full?: unknown; bytes?: unknown; reason?: unknown };
    try {
      message = JSON.parse(text);
    } catch {
      return; // not the protocol: nothing to show
    }
    if (typeof message !== "object" || message === null) return;
    if (message.type === "terminal.frame" && typeof message.bytes === "string") {
      this.answer();
      const full = message.full === true;
      const frame = Buffer.from(message.bytes, "base64").toString("utf8");
      if (this.paused) {
        // only the latest screen matters: resume() asks for a full one
        this.frames = null;
        return;
      }
      this.keep(frame, full);
      this.options.onData(frame, full);
    } else if (message.type === "terminal.closed") {
      this.answer();
      this.reason = typeof message.reason === "string" ? message.reason : "";
      this.end();
    }
    // other messages (newer herdrs may add some) carry nothing shown here
  }

  private answer(): void {
    if (this.spoke) return;
    this.spoke = true;
    this.settleStarted(true);
  }

  private keep(frame: string, full: boolean): void {
    if (full) {
      this.frames = [];
      this.frameBytes = 0;
    }
    if (this.frames === null) return;
    this.frameBytes += Buffer.byteLength(frame);
    if (this.frameBytes > (this.options.replayBytes ?? Number.POSITIVE_INFINITY)) this.frames = null;
    else this.frames.push(frame);
  }

  private get sink(): Sink | null {
    const sink = this.proc.stdin;
    return sink && typeof sink !== "number" && "write" in sink ? sink as Sink : null;
  }

  private send(message: Record<string, unknown>): boolean {
    if (this.closed) return false;
    const sink = this.sink;
    if (!sink) return false;
    try {
      sink.write(`${JSON.stringify(message)}\n`);
      sink.flush();
      return true;
    } catch {
      return false; // the CLI already gone
    }
  }

  write(data: string): boolean {
    return this.send({ type: "terminal.input", bytes: Buffer.from(data, "utf8").toString("base64") });
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.send({ type: "terminal.resize", cols, rows });
  }

  /** A full frame of the screen as it is, to every client: herdr paints one on a resize to the same size. */
  repaint(): void {
    this.send({ type: "terminal.resize", cols: this.cols, rows: this.rows });
  }

  /** A wheel of `lines` lines at a 1-based cell. */
  scroll(direction: "up" | "down", lines: number, column: number, row: number): boolean {
    return this.send({ type: "terminal.scroll", direction, lines, column, row });
  }

  /** Frames are dropped while a client cannot take them: a frame paints over the one before. */
  pause(): void {
    if (this.closed) return;
    this.paused = true;
  }

  /** A paused client missed frames it cannot do without: the screen goes out whole. */
  resume(): void {
    if (!this.paused || this.closed) return;
    this.paused = false;
    this.repaint();
  }

  /** stdin closed and the CLI killed: after terminal.closed, after its stdout ended, or once a release ran out. */
  private end(): void {
    try { this.sink?.end(); } catch { /* already closed */ }
    try { this.proc.kill(); } catch { /* already gone */ }
  }

  /** for a teardown the release did not end */
  forceKill(): void {
    try { this.proc.kill("SIGKILL"); } catch { /* already gone */ }
  }

  /** Lets go of the terminal (herdr frees its controller slot and resize lock), and kills a CLI that does not exit in time. */
  kill(): void {
    if (this.closed) return;
    const sink = this.sink;
    try {
      sink?.write(`${JSON.stringify({ type: "terminal.release" })}\n`);
      sink?.flush();
    } catch {
      /* the CLI already gone */
    }
    this.closed = true;
    try { sink?.end(); } catch { /* already closed */ }
    this.watchdog = setTimeout(() => this.end(), this.options.releaseMs ?? SESSION_RELEASE_MS);
  }
}
