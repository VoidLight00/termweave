import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc, paneSendText, paneSendKeys } from "./herdr/client.ts";
import { OUTPUT_HARD_BYTES, OUTPUT_HIGH_BYTES, OUTPUT_STALL_MS } from "./output-window.ts";
import { OUTPUT_STALLED_CLOSE_CODE } from "../shared/terminal-flow.ts";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-output-contract-"));
const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: root });
const workspaces: string[] = [];
const sockets: WebSocket[] = [];
afterAll(async () => {
  for (const socket of sockets) socket.close();
  server.stop();
  for (const workspace of workspaces) await herdrRpc("workspace.close", { workspace_id: workspace });
  rmSync(root, { recursive: true, force: true });
});

async function until(check: () => boolean, label: string, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(10);
  }
}

async function pane(): Promise<string> {
  const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
    "workspace.create", { label: "herdr-web-ui-test-output", cwd: root, focus: false },
  );
  workspaces.push(created.workspace.workspace_id);
  return created.root_pane.pane_id;
}

async function connect(paneId: string, ack = true, observer = false, port = server.port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  sockets.push(ws);
  const state = {
    bytes: 0, frames: 0, ack, code: 0, exits: 0,
    latest: undefined as Extract<ServerMessage, { type: "pty-data" }> | undefined,
    errors: [] as string[], tail: "",
  };
  const send = (message: ClientMessage) => ws.send(JSON.stringify(message));
  const acknowledge = (frame = state.latest) => {
    if (frame?.flow && ws.readyState === WebSocket.OPEN) send({ type: "pty-ack", pane_id: paneId, ...frame.flow });
  };
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as ServerMessage;
    if (frame.type === "error") state.errors.push(frame.code);
    if (frame.type === "pty-exit" && frame.pane_id === paneId) state.exits++;
    if (frame.type !== "pty-data" || frame.pane_id !== paneId) return;
    state.bytes += Buffer.byteLength(frame.data);
    state.frames++;
    state.latest = frame;
    state.tail = (state.tail + frame.data).slice(-8192);
    if (state.ack) acknowledge(frame);
  });
  ws.addEventListener("close", (event) => { state.code = event.code; });
  await until(() => ws.readyState === WebSocket.OPEN, "socket open");
  if (observer) send({ type: "role", mode: "observe" });
  send({ type: "attach", pane_id: paneId, cols: 100, rows: 30, flow_control: "ack" });
  await until(() => state.frames > 0, "initial terminal paint");
  return { ws, state, send, acknowledge };
}

/** Bun.spawn throws synchronously for the pty sidecar while `node` is not on PATH. */
function breakPath(): () => void {
  const previous = process.env["PATH"];
  process.env["PATH"] = "/nonexistent";
  return () => { process.env["PATH"] = previous; };
}

async function flood(paneId: string): Promise<void> {
  // Redraws reach the attach stream; raw shell byte rate alone is not its workload.
  await Bun.sleep(150); // herdr's attach consumes very early keystrokes
  await paneSendText(paneId, `python3 -u -c 'import sys,time; [(sys.stdout.write("\\033[H"+(str(i%10)*79+"\\n")*23),sys.stdout.flush(),time.sleep(.01)) for i in range(1500)]'`);
  await paneSendKeys(paneId, ["Enter"]);
}

describe("real terminal output flow control", () => {
  it("waits for the old attach to retire when a pane is reopened immediately", async () => {
    const paneId = await pane();
    const client = await connect(paneId);
    try {
      const old = client.state.latest!.flow!;
      client.send({ type: "detach", pane_id: paneId });
      client.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30, flow_control: "ack" });
      await until(() => !!client.state.latest?.flow && client.state.latest.flow.stream_id !== old.stream_id, "fresh attach after retirement");
      client.send({ type: "pty-ack", pane_id: paneId, stream_id: old.stream_id, offset: Number.MAX_SAFE_INTEGER });
      await Bun.sleep(100);
      expect(client.state.errors).toEqual([]);
      expect(client.state.exits).toBe(0);
      expect(client.state.code).toBe(0);
    } finally { client.ws.close(); }
  }, 20_000);

  it("bounds a stalled observer, releases the operator, and leaves the pane alive", async () => {
    const paneId = await pane();
    const operator = await connect(paneId);
    const observer = await connect(paneId, false, true);
    try {
      await flood(paneId);
      await until(() => observer.state.bytes >= OUTPUT_HIGH_BYTES, "observer high watermark", 15_000);
      const started = Date.now();
      await until(() => observer.state.code !== 0, "stalled observer closed", OUTPUT_STALL_MS + 3000);
      expect(observer.state.code).toBe(OUTPUT_STALLED_CLOSE_CODE);
      expect(observer.state.bytes).toBeLessThanOrEqual(OUTPUT_HARD_BYTES);
      expect(Date.now() - started).toBeLessThan(OUTPUT_STALL_MS + 2000);
      const received = operator.state.bytes;
      await until(() => operator.state.bytes > received + 4096, "operator output resumes");
      // Ctrl+C takes the actual WS input path while output is running.
      operator.send({ type: "input", pane_id: paneId, text: "\x03" });
      await Bun.sleep(200);
      operator.send({ type: "input", pane_id: paneId, text: "printf 'FLOW_%s\\n' ALIVE\r" });
      await until(() => operator.state.tail.includes("FLOW_ALIVE"), "pane survives observer eviction");
      expect(operator.state.code).toBe(0);
      expect(operator.state.errors).toEqual([]);
    } finally { operator.ws.close(); observer.ws.close(); }
  }, 35_000);

  it("resumes on valid ACKs and rejects future credit without accepting stale subscriptions", async () => {
    const paneId = await pane();
    const client = await connect(paneId, false);
    try {
      const initial = client.state.latest!;
      client.send({ type: "pty-ack", pane_id: paneId, stream_id: initial.flow!.stream_id, offset: Number.MAX_SAFE_INTEGER });
      await until(() => client.state.errors.includes("invalid_ack"), "future ACK refused");
      await flood(paneId);
      await until(() => client.state.bytes >= OUTPUT_HIGH_BYTES, "pause at high watermark", 15_000);
      await Bun.sleep(200);
      const paused = client.state.bytes;
      client.send({ type: "pty-ack", pane_id: paneId, stream_id: "previous-subscription", offset: paused });
      await Bun.sleep(200);
      expect(client.state.bytes).toBe(paused);
      client.state.ack = true;
      client.acknowledge();
      await until(() => client.state.bytes > paused + 4096, "valid credit resumes output");
      expect(client.state.code).toBe(0);
      client.send({ type: "input", pane_id: paneId, text: "\x03" });
    } finally { client.ws.close(); }
  }, 30_000);
});

describe("a terminal attach that cannot spawn (#154)", () => {
  it("reports the failure and leaves the pane attachable, never a record without a pty", async () => {
    const paneId = await pane();
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    sockets.push(ws);
    const errors: string[] = [];
    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as ServerMessage;
      if (frame.type === "error") errors.push(frame.code);
    });
    await until(() => ws.readyState === WebSocket.OPEN, "socket open");
    const restore = breakPath();
    try {
      ws.send(JSON.stringify({ type: "attach", pane_id: paneId, cols: 100, rows: 30, flow_control: "ack" } satisfies ClientMessage));
      await until(() => errors.includes("command_failed"), "the failed spawn is reported");
    } finally { restore(); }
    // the next attach spawns its own pty instead of joining a dead record
    const second = await connect(paneId);
    second.ws.close();
    await until(() => second.state.code !== 0, "second client closed");
    // closing it tore the attachment down cleanly: the server still attaches the pane
    const third = await connect(paneId);
    try {
      expect(third.state.errors).toEqual([]);
      expect(third.state.exits).toBe(0);
    } finally { third.ws.close(); ws.close(); }
  }, 30_000);
});

describe("an attach herdr refuses over a read in progress", () => {
  /**
   * A herdr that refuses the first `refusals` attaches as herdr 0.9 refuses one racing a
   * pane read of the same terminal, then attaches for real.
   */
  function refusingHerdr(refusals: number): { path: string; attempts: () => number } {
    const real = process.env["HERDR_WEB_HERDR_BIN"] || Bun.which("herdr") || "herdr";
    const dir = mkdtempSync(join(root, "refusing-herdr-"));
    const count = join(dir, "count");
    const path = join(dir, "herdr");
    writeFileSync(path, [
      "#!/bin/sh",
      `n=$(cat '${count}' 2>/dev/null || echo 0)`,
      `echo $((n + 1)) > '${count}'`,
      `if [ "$n" -lt ${refusals} ]; then printf 'herdr: server shut down: terminal attach failed: terminal term_0 has a read in progress; retry\\r\\n'; exit 1; fi`,
      `exec '${real}' "$@"`,
      "",
    ].join("\n"));
    chmodSync(path, 0o755);
    return { path, attempts: () => existsSync(count) ? Number(readFileSync(count, "utf8").trim() || 0) : 0 };
  }

  async function withHerdr<T>(path: string, run: () => Promise<T>): Promise<T> {
    const previous = process.env["HERDR_WEB_HERDR_BIN"];
    process.env["HERDR_WEB_HERDR_BIN"] = path;
    try { return await run(); } finally {
      if (previous === undefined) delete process.env["HERDR_WEB_HERDR_BIN"];
      else process.env["HERDR_WEB_HERDR_BIN"] = previous;
    }
  }

  it("attaches again for the same client instead of ending its terminal", async () => {
    const paneId = await pane();
    const herdr = refusingHerdr(2);
    await withHerdr(herdr.path, async () => {
      const client = await connect(paneId);
      try {
        // the refusals are retried; the third attach is real and paints the pane
        await until(() => herdr.attempts() === 3 && client.state.tail.includes("\x1b[?1049h"), "the third attach paints");
        await Bun.sleep(300); // herdr's attach consumes very early keystrokes
        client.send({ type: "input", pane_id: paneId, text: "echo attach-$((6*7))\r" });
        await until(() => client.state.tail.includes("attach-42"), "the retried attach streams the pane");
        expect(herdr.attempts()).toBe(3);
        expect(client.state.exits).toBe(0);
        expect(client.state.errors).toEqual([]);
        // a refused attach's setup, teardown and message never reached the terminal
        expect(client.state.tail).not.toContain("read in progress");
      } finally { client.ws.close(); }
    });
  }, 30_000);

  it("ends the terminal, not the server, when a retried attach cannot spawn", async () => {
    const paneId = await pane();
    const herdr = refusingHerdr(1);
    await withHerdr(herdr.path, async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      sockets.push(ws);
      const errors: string[] = [];
      let exits = 0;
      ws.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as ServerMessage;
        if (frame.type === "error") errors.push(frame.code);
        if (frame.type === "pty-exit" && frame.pane_id === paneId) exits++;
      });
      await until(() => ws.readyState === WebSocket.OPEN, "socket open");
      ws.send(JSON.stringify({ type: "attach", pane_id: paneId, cols: 100, rows: 30 } satisfies ClientMessage));
      // the refusal is running: the retry that follows its exit spawns without node
      await until(() => herdr.attempts() === 1, "the refused attach started");
      const restore = breakPath();
      try {
        await until(() => exits === 1, "pty-exit for the retry that failed to spawn");
      } finally { restore(); }
      expect(errors).toEqual(["command_failed"]);
      expect(herdr.attempts()).toBe(1);
      ws.close();
      // the server survived and the pane attaches again for real
      const client = await connect(paneId);
      try {
        expect(client.state.errors).toEqual([]);
        expect(herdr.attempts()).toBe(2);
      } finally { client.ws.close(); }
    });
  }, 30_000);

  it("still ends the terminal when herdr keeps refusing past the longest such read", async () => {
    const paneId = await pane();
    const herdr = refusingHerdr(1000);
    const impatient = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: mkdtempSync(join(root, "impatient-")), attachRetryForMs: 800 });
    try {
      await withHerdr(herdr.path, async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${impatient.port}/ws`);
        sockets.push(ws);
        let exits = 0; let tail = "";
        ws.addEventListener("message", (event) => {
          const frame = JSON.parse(String(event.data)) as ServerMessage;
          if (frame.type === "pty-exit" && frame.pane_id === paneId) exits++;
          if (frame.type === "pty-data" && frame.pane_id === paneId) tail += frame.data;
        });
        await until(() => ws.readyState === WebSocket.OPEN, "socket open");
        ws.send(JSON.stringify({ type: "attach", pane_id: paneId, cols: 100, rows: 30 } satisfies ClientMessage));
        await until(() => exits === 1, "pty-exit once the retries run out");
        expect(herdr.attempts()).toBeGreaterThan(2);
        // the last refusal is shown: it says why the terminal ended
        expect(tail).toContain("read in progress");
        ws.close();
      });
    } finally { impatient.stop(); }
  }, 30_000);
});
