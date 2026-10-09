import { protectFrontendInput } from "./frontendReloadSafety.ts";
import type { ClientMessage, ClientRole, ServerFeature, ServerMessage } from "../../shared/protocol.ts";
import { OUTPUT_STALLED_CLOSE_CODE } from "../../shared/terminal-flow.ts";

type Handler = (message: ServerMessage) => void;

/** How a composer message ended: ok once the pane has it and its Enter, else why not. */
export type SubmitResult = { ok: true } | { ok: false; code: string; message: string };

/** Right after a reconnect the snapshot that says what the server supports may still be on its way. */
const SNAPSHOT_WAIT_MS = 2000;
/**
 * A submit the server never answers: the composer stops waiting and keeps the text. The
 * server types nothing once 45s have passed since the message reached it (queued behind
 * others included) and a send that started in time ends within two more 10s RPCs, so a
 * message the client gave up on is never submitted later.
 */
const SUBMIT_TIMEOUT_MS = 90_000;
const DISCONNECTED: SubmitResult = { ok: false, code: "disconnected", message: "the connection dropped before the pane confirmed this message" };

interface AttachState {
  cols: number;
  rows: number;
  /** the chat lens covers the grid: attaches (a reconnect's too) leave the shared pty's size alone */
  keepSize: boolean;
}

function defaultUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

/**
 * Reconnecting client for /ws. Attachments are remembered with their geometry so a
 * dropped connection restores the live terminal at the right size instead of
 * leaving a stale screen behind.
 *
 * Two policies live here:
 * - The connection's role survives reconnects: an observe connection re-sends its
 *   role before the attach replay, so a reconnecting phone still cannot resize or
 *   type into the operator's pty.
 * - Terminal input is NEVER queued while disconnected (a command typed into a dead
 *   socket must not fire later, unannounced); PaneTerminal keeps it as a draft the
 *   user reviews instead. Control frames (attach/resize/role) replay as before.
 */
export class HerdrSocket {
  private socket: WebSocket | null = null;
  private readonly url: string;
  private readonly handlers = new Set<Handler>();
  private readonly disconnectHandlers = new Set<() => void>();
  private snapshotKnown = false;
  private readonly outputSeen = new Set<string>();
  private readonly inputReady = new Set<string>();
  private readonly attached = new Map<string, AttachState>();
  private retries = 0;
  private reconnectTimer: number | null = null;
  private disposed = false;
  private draining = false;
  private readonly requestTimers = new Map<number, number>();
  private readonly snapshotTimers = new Map<number, () => void>();
  private mode: ClientRole = "interact";
  private outputStopped = false;
  /** what the connected server listed in its snapshot: empty until it arrives, and on older bridges */
  private features = new Set<ServerFeature>();
  /** settles when this connection's snapshot arrives (or the connection ends) */
  private snapshotSeen: Promise<void> = Promise.resolve();
  private markSnapshot: () => void = () => {};
  private nextSubmit = 1;
  /** submits waiting for their submit-result, by id */
  private readonly submits = new Map<number, (result: SubmitResult) => void>();

  constructor(url: string = defaultUrl()) {
    this.url = url;
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (this.disposed) return;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const socket = new WebSocket(this.url);
    this.socket = socket;
    this.features = new Set();
    this.inputReady.clear();
    this.outputSeen.clear();
    this.snapshotKnown = false;
    this.snapshotSeen = new Promise((resolve) => { this.markSnapshot = resolve; });

    socket.addEventListener("open", () => {
      this.retries = 0;
      // always send the role, never only when non-default: a user can flip the role
      // while disconnected (setMode stores it without sending), so without this frame
      // the reconnect would leave the server on the stale role and no ack would ever
      // arrive - the UI would stay stuck in the old role while the header pill lies
      this.rawSend({ type: "role", mode: this.mode });
      for (const [paneId, state] of this.attached) {
        this.rawSend({ type: "attach", pane_id: paneId, cols: state.cols, rows: state.rows, flow_control: "ack", ...(state.keepSize ? { keep_size: true } : {}) });
      }
    });

    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        /* ignore malformed frame */
        return;
      }
      if (message.type === "snapshot") {
        this.features = new Set(message.features ?? []);
        this.snapshotKnown = true;
        if (!this.features.has("input-ready")) for (const pane of this.outputSeen) if (this.attached.has(pane)) this.inputReady.add(pane);
        this.markSnapshot();
      }
      if (message.type === "pty-data") this.outputSeen.add(message.pane_id);
      if ((message.type === "input-ready" && message.ready !== false) || (message.type === "pty-data" && this.snapshotKnown && !this.features.has("input-ready"))) {
        if (this.attached.has(message.pane_id)) this.inputReady.add(message.pane_id);
      }
      if ((message.type === "input-ready" && message.ready === false) || message.type === "pty-exit" || (message.type === "error" && message.pane_id && ["attach_held", "input_not_ready"].includes(message.code))) this.inputReady.delete(message.pane_id!);
      if (message.type === "submit-result") {
        const settle = this.submits.get(message.id);
        this.submits.delete(message.id);
        this.clearRequestTimer(message.id);
        settle?.(message.ok ? { ok: true } : { ok: false, code: message.code ?? "submit_failed", message: message.message ?? "the pane did not take the message" });
        if (this.draining && this.submits.size === 0) this.close();
      }
      if (message.type === "secret-result") {
        const settle = this.submits.get(message.id);
        this.submits.delete(message.id);
        this.clearRequestTimer(message.id);
        settle?.(message.ok ? { ok: true } : { ok: false, code: message.code ?? "secret_failed", message: "Secret was not sent. Check the prompt and enter it again." });
        if (this.draining && this.submits.size === 0) this.close();
      }
      // A terminal/parser failure is not malformed JSON and must not disappear.
      this.emit(message);
    });

    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      for (const handler of this.disconnectHandlers) handler();
      this.markSnapshot();
      this.settleSubmits(DISCONNECTED);
      if (event.code === OUTPUT_STALLED_CLOSE_CODE) {
        this.outputStopped = true;
        this.emit({ type: "error", code: "output_stalled", message: "Terminal output stopped because this device could not keep up." });
        return;
      }
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      socket.close();
    });
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null) return;
    const delay = Math.min(5000, 250 * 2 ** this.retries);
    this.retries += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private rawSend(message: ClientMessage): void {
    this.socket?.send(JSON.stringify(message));
  }

  private send(message: ClientMessage): void {
    if (this.connected) this.rawSend(message);
    // Role/attach/geometry already live in state. Replaying both that state and
    // a queue used to attach twice and duplicate the initial terminal replay.
  }

  private emit(message: ServerMessage): void {
    for (const handler of this.handlers) handler(message);
  }

  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  onDisconnect(handler: () => void): () => void {
    this.disconnectHandlers.add(handler);
    return () => { this.disconnectHandlers.delete(handler); };
  }

  attach(paneId: string, cols: number, rows: number, keepSize = false): void {
    this.outputSeen.delete(paneId);
    this.inputReady.delete(paneId);
    this.attached.set(paneId, { cols, rows, keepSize });
    this.send({ type: "attach", pane_id: paneId, cols, rows, flow_control: "ack", ...(keepSize ? { keep_size: true } : {}) });
    if (this.outputStopped) {
      this.outputStopped = false;
      this.connect();
    }
  }

  /** Capture connection AND subscription before xterm's asynchronous write. Never queue ACKs. */
  outputAcknowledgement(message: Extract<ServerMessage, { type: "pty-data" }>): (() => void) | undefined {
    const flow = message.flow;
    if (!flow) return undefined;
    const connection = this.socket;
    const subscription = this.attached.get(message.pane_id);
    return () => {
      if (!connection || this.socket !== connection || !this.connected || !subscription
        || this.attached.get(message.pane_id) !== subscription) return;
      this.rawSend({ type: "pty-ack", pane_id: message.pane_id, stream_id: flow.stream_id, offset: flow.offset });
    };
  }

  detach(paneId: string): void {
    this.outputSeen.delete(paneId);
    this.inputReady.delete(paneId);
    this.attached.delete(paneId);
    this.send({ type: "detach", pane_id: paneId });
  }

  resize(paneId: string, cols: number, rows: number, force = false): void {
    const state = this.attached.get(paneId);
    if (state) {
      // skip only redundant resizes of OUR OWN geometry: a force resize re-asserts
      // it after another client resized the shared pty (see PaneTerminal refit)
      if (!force && state.cols === cols && state.rows === rows) return;
      state.cols = cols;
      state.rows = rows;
      state.keepSize = false;
    }
    this.send({ type: "resize", pane_id: paneId, cols, rows });
  }

  /** The chat lens covers the grid again: a reconnect attaches without resizing, until the next resize. */
  keepSize(paneId: string): void {
    const state = this.attached.get(paneId);
    if (state) state.keepSize = true;
  }

  /** Sets the connection's role. Not queued: the role replays before the attaches on reconnect. */
  setMode(mode: ClientRole): void {
    this.mode = mode;
    if (this.connected) this.rawSend({ type: "role", mode });
  }

  canInput(paneId: string): boolean {
    return !this.draining && !this.disposed && this.connected && this.mode === "interact" && this.inputReady.has(paneId);
  }

  sendInput(paneId: string, text: string): boolean {
    if (!this.canInput(paneId)) return false;
    try { this.rawSend({ type: "input", pane_id: paneId, text }); return true; } catch { return false; }
  }

  /**
   * Types a composer message and submits it, straight to the socket: a Ctrl armed on the
   * terminal key bar must not turn a one-letter message into a control key. A server
   * listing "submit" sends the Enter itself, after a gap, and says how it went; an older
   * bridge gets the payload and its Enter in one frame, as before. `text` is the message
   * as written, `payload` the same shaped for the pane's paste mode. null, sending
   * nothing, when offline.
   */
  /** `typed`: from the terminal's input line, typed into the pane like the keyboard (see ClientMessage) */
  submit(paneId: string, text: string, payload: string, typed = false): Promise<SubmitResult> | null {
    const socket = this.socket;
    if (this.draining || this.disposed || !this.connected || socket === null) return null;
    return protectFrontendInput(async (): Promise<SubmitResult> => {
      await this.waitForSnapshot();
      if (this.draining || this.disposed || !this.connected || this.socket !== socket) return DISCONNECTED;
      if (!this.features.has("submit")) {
        this.rawSend({ type: "input", pane_id: paneId, text: `${payload}\r` });
        return { ok: true };
      }
      const id = this.nextSubmit++;
      const result = new Promise<SubmitResult>((resolve) => {
        this.submits.set(id, resolve);
        this.requestTimers.set(id, window.setTimeout(() => {
          this.requestTimers.delete(id);
          if (!this.submits.delete(id)) return;
          resolve({ ok: false, code: "timeout", message: "the pane did not confirm this message in time" });
          if (this.draining && this.submits.size === 0) this.close();
        }, SUBMIT_TIMEOUT_MS));
      });
      this.rawSend({ type: "submit", id, pane_id: paneId, text, payload, ...(typed ? { typed: true } : {}) });
      return await result;
    });
  }

  /** Send once on this connection. Only a result callback is retained, never the value. */
  sendSecret(paneId: string, prompt: string, secret: string): Promise<SubmitResult> | null {
    const socket = this.socket;
    if (this.draining || this.disposed || !this.connected || socket === null || this.mode === "observe") return null;
    return protectFrontendInput(async (): Promise<SubmitResult> => {
      // right after a reconnect the terminal's output can arrive before the snapshot that says
      // whether the server takes masked input: wait for it, as a submit does
      await this.waitForSnapshot();
      if (this.draining || this.disposed || !this.connected || this.socket !== socket) { secret = ""; return DISCONNECTED; }
      if (!this.features.has("secret-input")) { secret = ""; return { ok: false, code: "unsupported", message: "Update this PC to use masked input." }; }
      const id = this.nextSubmit++;
      const result = new Promise<SubmitResult>((resolve) => {
        this.submits.set(id, resolve);
        this.requestTimers.set(id, window.setTimeout(() => {
          this.requestTimers.delete(id);
          if (this.submits.delete(id)) resolve({ ok: false, code: "timeout", message: "Check the terminal before trying again." });
          if (this.draining && this.submits.size === 0) this.close();
        }, 15_000));
      });
      try { this.rawSend({ type: "secret", id, pane_id: paneId, prompt, secret }); }
      catch {
        this.submits.get(id)?.(DISCONNECTED);
        this.submits.delete(id); this.clearRequestTimer(id);
      } finally { secret = ""; }
      return result;
    });
  }

  private clearRequestTimer(id: number): void {
    const timer = this.requestTimers.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    this.requestTimers.delete(id);
  }

  private async waitForSnapshot(): Promise<void> {
    let timer = 0;
    try {
      await Promise.race([this.snapshotSeen, new Promise<void>(resolve => {
        timer = window.setTimeout(resolve, SNAPSHOT_WAIT_MS);
        this.snapshotTimers.set(timer, resolve);
      })]);
    } finally { window.clearTimeout(timer); this.snapshotTimers.delete(timer); }
  }

  private cancelSnapshotWaits(): void {
    for (const [timer, resolve] of this.snapshotTimers) { window.clearTimeout(timer); resolve(); }
    this.snapshotTimers.clear();
  }

  private settleSubmits(result: SubmitResult): void {
    for (const settle of this.submits.values()) settle(result);
    this.submits.clear();
    for (const id of this.requestTimers.keys()) this.clearRequestTimer(id);
  }

  sendKeys(paneId: string, keys: string[]): void {
    if (this.draining || this.disposed || !this.connected) return;
    this.rawSend({ type: "keys", pane_id: paneId, keys });
  }

  /** A view unmount releases terminal subscriptions immediately, but a submitted
   * request keeps this connection only until its ACK/timeout. No replay or input.
   */
  closeAfterSubmits(): void {
    if (!this.submits.size || !this.connected) { this.close(); return; }
    this.draining = true;
    this.disposed = true;
    this.cancelSnapshotWaits();
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    for (const paneId of this.attached.keys()) this.detach(paneId);
    this.handlers.clear(); this.disconnectHandlers.clear();
  }

  close(): void {
    this.disposed = true;
    this.cancelSnapshotWaits();
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
    this.settleSubmits(DISCONNECTED);
    this.handlers.clear();
    this.disconnectHandlers.clear();
  }
}
