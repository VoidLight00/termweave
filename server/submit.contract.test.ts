import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, SUBMIT_DELAY_MS } from "./index.ts";
import { herdrRpc } from "./herdr/client.ts";

/**
 * Contract test for the composer's "submit" frame, against the real herdr server.
 * Each pane runs a raw-mode recorder that logs every chunk of input it reads with its
 * arrival time, so the test sees what the agent's TUI would: the text, then its Enter
 * as a separate keypress. One recorder is a plain program (the send_text path), the
 * other runs under the name `claude` and is reported as that agent (herdr's
 * agent.prompt path).
 */
const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-submit-"));
let server: { port: number; stop: () => void };
const workspaces: string[] = [];

const RECORDER = `
const { appendFileSync, writeFileSync } = require("node:fs");
const out = process.argv[2];
process.stdin.setRawMode(true);
process.stdin.resume();
// bracketed paste on, as agent TUIs have it: herdr passes the paste markers through;
// then what the TUI would show, when asked to (argv[3])
process.stdout.write("\\u001b[?2004h" + (process.argv[3] ?? ""), () => writeFileSync(out, ""));
process.stdin.on("data", (chunk) => appendFileSync(out, JSON.stringify({ at: Date.now(), data: chunk.toString("utf8") }) + "\\n"));
`;

interface Chunk { at: number; data: string }
interface Recorder { pane: string; log: string }
let shell: Recorder;
let agent: Recorder;
let codex: Recorder;
let codexApproval: Recorder;
let claudeQueue: Recorder;

const chunks = (recorder: Recorder): Chunk[] =>
  readFileSync(recorder.log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Chunk);
const typed = (recorder: Recorder, from: number) => chunks(recorder).slice(from).map((chunk) => chunk.data).join("");

/** the chunks read since `from`, once their bytes hold `count` Enters */
async function received(recorder: Recorder, from: number, count: number): Promise<Chunk[]> {
  for (let i = 0; i < 100; i++) {
    if (typed(recorder, from).split("\r").length > count) return chunks(recorder).slice(from);
    await Bun.sleep(50);
  }
  throw new Error(`no ${count} Enter(s) within 5s: ${JSON.stringify(chunks(recorder).slice(from))}`);
}

async function recorder(label: string, program: string, screen = ""): Promise<Recorder> {
  const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
    "workspace.create", { label: `herdr-web-ui-test-submit-${label}`, cwd: root, focus: false },
  );
  workspaces.push(created.workspace.workspace_id);
  const log = join(root, `${label}.jsonl`);
  const shown = screen ? ` '${screen.replace(/\n/g, "\r\n")}'` : "";
  await herdrRpc("pane.send_text", { pane_id: created.root_pane.pane_id, text: `exec '${program}' '${join(root, "record.js")}' '${log}'${shown}\n` });
  for (let i = 0; i < 200 && !existsSync(log); i++) await Bun.sleep(50);
  expect(existsSync(log)).toBe(true);
  return { pane: created.root_pane.pane_id, log };
}

class Socket {
  readonly seen: any[] = [];
  private readonly ws: WebSocket;
  private constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener("message", (event) => this.seen.push(JSON.parse(String((event as MessageEvent).data))));
  }
  static async connect(port = server.port): Promise<Socket> {
    const socket = new Socket(`ws://localhost:${port}/ws`);
    await new Promise<void>((resolve) => socket.ws.addEventListener("open", () => resolve()));
    await socket.waitFor((message) => message.type === "snapshot");
    return socket;
  }
  async waitFor(predicate: (message: any) => boolean, ms = 15_000): Promise<any> {
    for (let waited = 0; waited < ms; waited += 25) {
      const found = this.seen.find(predicate);
      if (found) return found;
      await Bun.sleep(25);
    }
    throw new Error(`frame not received within ${ms}ms`);
  }
  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }
  result(id: number): Promise<any> {
    return this.waitFor((message) => message.type === "submit-result" && message.id === id);
  }
  close(): void {
    this.ws.close();
  }
}

const paste = (text: string) => `\u001b[200~${text}\u001b[201~`;

beforeAll(async () => {
  server = createServer({ port: 0, stateDir: join(root, "push") });
  writeFileSync(join(root, "record.js"), RECORDER);
  // herdr's agent.prompt checks that the pane's foreground process is the agent
  copyFileSync(process.execPath, join(root, "claude"));
  chmodSync(join(root, "claude"), 0o755);
  copyFileSync(process.execPath, join(root, "codex"));
  chmodSync(join(root, "codex"), 0o755);
  shell = await recorder("shell", process.execPath);
  agent = await recorder("agent", join(root, "claude"));
  await herdrRpc("pane.report_agent", { pane_id: agent.pane, source: "manual", agent: "claude", state: "idle" });
  // Codex with a question waiting collapsed in its queue: herdr calls it blocked
  const queue = "\n• Queued follow-up inputs\n  ? 1 question\n    alt+↑ to answer\n";
  codex = await recorder("codex", join(root, "codex"), `${queue}› Ask Codex to do anything\n`);
  await herdrRpc("pane.report_agent", { pane_id: codex.pane, source: "manual", agent: "codex", state: "blocked" });
  // the queue above an approval: the approval holds the input, and y / Enter would answer it
  codexApproval = await recorder("codex-approval", join(root, "codex"), `${queue}\nWould you like to run the following command?\n\n$ rm -rf junk\n\n› 1. Yes, proceed (y)\n  2. No, and tell Codex what to do differently (esc)\n\nPress enter to confirm or esc to cancel\n`);
  await herdrRpc("pane.report_agent", { pane_id: codexApproval.pane, source: "manual", agent: "codex", state: "blocked" });
  // the same text in a pane whose agent is not Codex
  claudeQueue = await recorder("claude-queue", join(root, "claude"), `${queue}› Ask Codex to do anything\n`);
  await herdrRpc("pane.report_agent", { pane_id: claudeQueue.pane, source: "manual", agent: "claude", state: "blocked" });
}, 30_000);

afterAll(async () => {
  server?.stop();
  for (const id of workspaces) await herdrRpc("workspace.close", { workspace_id: id }).catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
});

describe("WebSocket submit", () => {
  it("lists the submit feature in the first snapshot", async () => {
    const socket = await Socket.connect();
    try {
      // a pane-status can arrive first: the snapshot is found by its type
      expect(socket.seen.find((message) => message.type === "snapshot")?.features).toContain("submit");
    } finally {
      socket.close();
    }
  });

  it("types the payload into a pane without an agent, then its own Enter SUBMIT_DELAY_MS later, and says so", async () => {
    const socket = await Socket.connect();
    try {
      const from = chunks(shell).length;
      socket.send({ type: "submit", id: 1, pane_id: shell.pane, text: "hello", payload: paste("hello") });
      expect(await socket.result(1)).toMatchObject({ ok: true, pane_id: shell.pane });
      const read = await received(shell, from, 1);
      const enter = read.findIndex((chunk) => chunk.data.includes("\r"));
      expect(read.slice(0, enter).map((chunk) => chunk.data).join("")).toBe(paste("hello"));
      expect(read[enter]!.data).toBe("\r");
      expect(read[enter]!.at - read[enter - 1]!.at).toBeGreaterThanOrEqual(SUBMIT_DELAY_MS - 20);
    } finally {
      socket.close();
    }
  }, 30_000);

  it("hands an agent the message through herdr's agent.prompt: the paste, then Enter apart", async () => {
    const socket = await Socket.connect();
    try {
      const from = chunks(agent).length;
      socket.send({ type: "submit", id: 2, pane_id: agent.pane, text: "line one\nline two", payload: "unused" });
      expect(await socket.result(2)).toMatchObject({ ok: true });
      const read = await received(agent, from, 1);
      const enter = read.findIndex((chunk) => chunk.data.includes("\r"));
      expect(read.slice(0, enter).map((chunk) => chunk.data).join("")).toBe(paste("line one\nline two"));
      expect(read[enter]!.data).toBe("\r");
      expect(read[enter]!.at - read[enter - 1]!.at).toBeGreaterThanOrEqual(SUBMIT_DELAY_MS);
    } finally {
      socket.close();
    }
  }, 30_000);

  it("refuses a message while the agent waits for an answer, typing nothing", async () => {
    const socket = await Socket.connect();
    await herdrRpc("pane.report_agent", { pane_id: agent.pane, source: "manual", agent: "claude", state: "blocked" });
    try {
      const from = chunks(agent).length;
      socket.send({ type: "submit", id: 3, pane_id: agent.pane, text: "yes", payload: "yes" });
      expect(await socket.result(3)).toMatchObject({ ok: false, code: "agent_blocked" });
      await Bun.sleep(SUBMIT_DELAY_MS * 3);
      expect(chunks(agent).slice(from)).toEqual([]);
    } finally {
      await herdrRpc("pane.report_agent", { pane_id: agent.pane, source: "manual", agent: "claude", state: "idle" });
      socket.close();
    }
  }, 30_000);

  it("types the terminal's input line into a waiting agent like the keyboard, then its Enter", async () => {
    const socket = await Socket.connect();
    await herdrRpc("pane.report_agent", { pane_id: agent.pane, source: "manual", agent: "claude", state: "blocked" });
    try {
      const from = chunks(agent).length;
      socket.send({ type: "submit", id: 12, pane_id: agent.pane, text: "2", payload: "2", typed: true });
      expect(await socket.result(12)).toMatchObject({ ok: true });
      const read = await received(agent, from, 1);
      expect(typed(agent, from)).toBe("2\r");
      // the Enter keeps its own gap after the text, as a composer message's does
      const enter = read.findIndex((chunk) => chunk.data.includes("\r"));
      if (enter > 0) expect(read[enter]!.at - read[enter - 1]!.at).toBeGreaterThanOrEqual(SUBMIT_DELAY_MS);
    } finally {
      await herdrRpc("pane.report_agent", { pane_id: agent.pane, source: "manual", agent: "claude", state: "idle" });
      socket.close();
    }
  }, 30_000);

  it("still hands a message to a Codex blocked only by questions waiting collapsed in its queue", async () => {
    const socket = await Socket.connect();
    try {
      const from = chunks(codex).length;
      socket.send({ type: "submit", id: 9, pane_id: codex.pane, text: "stop, do not touch prod", payload: paste("stop, do not touch prod") });
      expect(await socket.result(9)).toMatchObject({ ok: true });
      await received(codex, from, 1);
      expect(typed(codex, from)).toBe(`${paste("stop, do not touch prod")}\r`);
    } finally {
      socket.close();
    }
  }, 30_000);

  it("never types a message into an approval under the queue, nor for an agent other than Codex", async () => {
    const socket = await Socket.connect();
    try {
      for (const [id, recorder] of [[10, codexApproval], [11, claudeQueue]] as const) {
        const from = chunks(recorder).length;
        socket.send({ type: "submit", id, pane_id: recorder.pane, text: "y", payload: "y" });
        expect(await socket.result(id)).toMatchObject({ ok: false, code: "agent_blocked" });
        await Bun.sleep(SUBMIT_DELAY_MS * 3);
        expect(chunks(recorder).slice(from)).toEqual([]);
      }
    } finally {
      socket.close();
    }
  }, 30_000);

  it("keeps other input behind a message in flight: a Stop right after Send lands after its Enter", async () => {
    const socket = await Socket.connect();
    try {
      socket.send({ type: "attach", pane_id: shell.pane, cols: 100, rows: 30 });
      await socket.waitFor((message) => message.type === "pty-data" && message.pane_id === shell.pane);
      const from = chunks(shell).length;
      socket.send({ type: "submit", id: 4, pane_id: shell.pane, text: "one", payload: "one" });
      socket.send({ type: "input", pane_id: shell.pane, text: "\u001b" });
      socket.send({ type: "submit", id: 5, pane_id: shell.pane, text: "two", payload: "two" });
      await socket.result(5);
      await received(shell, from, 2);
      expect(typed(shell, from)).toBe("one\r\u001btwo\r");
    } finally {
      socket.close();
    }
  }, 30_000);

  it("sends a message typed right after a Stop only once the Stop reached the pane", async () => {
    const socket = await Socket.connect();
    try {
      socket.send({ type: "attach", pane_id: shell.pane, cols: 100, rows: 30 });
      await socket.waitFor((message) => message.type === "pty-data" && message.pane_id === shell.pane);
      await Bun.sleep(300);
      const from = chunks(shell).length;
      socket.send({ type: "input", pane_id: shell.pane, text: "\u001b" });
      socket.send({ type: "submit", id: 8, pane_id: shell.pane, text: "after", payload: "after" });
      await socket.result(8);
      await received(shell, from, 1);
      expect(typed(shell, from)).toBe("\u001bafter\r");
    } finally {
      socket.close();
    }
  }, 30_000);

  it("types nothing of a message that waited past its deadline behind another", async () => {
    // Advance only after the first message reaches the real recorder. Its RPC lookup
    // can take more than 50ms under load; that is not the queue deadline under test.
    let elapsed = 0;
    const hurried = createServer({ port: 0, stateDir: join(root, "push-hurried"), submitDeadlineMs: 50, submitNow: () => elapsed });
    const ws = new WebSocket(`ws://localhost:${hurried.port}/ws`);
    const seen: any[] = [];
    ws.addEventListener("message", (event) => seen.push(JSON.parse(String((event as MessageEvent).data))));
    try {
      await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
      for (let i = 0; i < 100 && !seen.some((message) => message.type === "snapshot"); i++) await Bun.sleep(50);
      const from = chunks(shell).length;
      ws.send(JSON.stringify({ type: "submit", id: 1, pane_id: shell.pane, text: "first", payload: "first" }));
      ws.send(JSON.stringify({ type: "submit", id: 2, pane_id: shell.pane, text: "late", payload: "late" }));
      for (let i = 0; i < 100 && !typed(shell, from).includes("first"); i++) await Bun.sleep(5);
      expect(typed(shell, from)).toContain("first");
      elapsed = 100;
      let late: any;
      for (let i = 0; i < 100 && !(late = seen.find((message) => message.type === "submit-result" && message.id === 2)); i++) await Bun.sleep(50);
      expect(seen.find((message) => message.type === "submit-result" && message.id === 1)).toMatchObject({ ok: true });
      expect(late).toMatchObject({ ok: false, code: "submit_timeout" });
      await Bun.sleep(SUBMIT_DELAY_MS * 3);
      expect(typed(shell, from)).toBe("first\r");
    } finally {
      ws.close();
      hurried.stop();
    }
  }, 30_000);

  it("still sends the Enter after the sender is gone", async () => {
    const socket = await Socket.connect();
    const from = chunks(shell).length;
    // closed right after the tap, as a phone that locks: the server finishes the send
    socket.send({ type: "submit", id: 6, pane_id: shell.pane, text: "gone", payload: "gone" });
    await Bun.sleep(20);
    socket.close();
    await received(shell, from, 1);
    expect(typed(shell, from)).toBe("gone\r");
  }, 30_000);

  it("sends nothing typed or keyed by a connection that closed while it waited behind a message", async () => {
    const gone = await Socket.connect();
    const socket = await Socket.connect();
    try {
      gone.send({ type: "attach", pane_id: shell.pane, cols: 100, rows: 30 });
      await gone.waitFor((message) => message.type === "pty-data" && message.pane_id === shell.pane);
      const from = chunks(shell).length;
      // the message is finished for a sender that left; the Stop and the Enter behind it are not
      gone.send({ type: "submit", id: 30, pane_id: shell.pane, text: "one", payload: "one" });
      gone.send({ type: "input", pane_id: shell.pane, text: "\u001b" });
      gone.send({ type: "keys", pane_id: shell.pane, keys: ["Enter"] });
      gone.close();
      await received(shell, from, 1);
      socket.send({ type: "submit", id: 31, pane_id: shell.pane, text: "two", payload: "two" });
      await socket.result(31);
      await received(shell, from, 2);
      expect(typed(shell, from)).toBe("one\rtwo\r");
    } finally {
      gone.close();
      socket.close();
    }
  }, 30_000);

  it("answers a submit from an observe connection with read_only, typing nothing", async () => {
    const socket = await Socket.connect();
    try {
      const from = chunks(shell).length;
      socket.send({ type: "role", mode: "observe" });
      await socket.waitFor((message) => message.type === "role-ack");
      socket.send({ type: "submit", id: 7, pane_id: shell.pane, text: "nope", payload: "nope" });
      expect(await socket.result(7)).toMatchObject({ ok: false, code: "read_only" });
      await Bun.sleep(SUBMIT_DELAY_MS * 3);
      expect(chunks(shell).slice(from)).toEqual([]);
    } finally {
      socket.close();
    }
  }, 30_000);
});

describe("a herdr without terminal attach (Windows)", () => {
  let bare: { port: number; stop: () => void };
  beforeAll(() => { bare = createServer({ port: 0, stateDir: join(root, "push-bare"), terminalAttach: false }); });
  afterAll(() => bare?.stop());

  it("mirrors the pane's screen: the pane's own grid first, then each changed screen, until the pane ends", async () => {
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create", { label: "herdr-web-ui-test-submit-mirror", cwd: root, focus: false },
    );
    workspaces.push(created.workspace.workspace_id);
    const pane = created.root_pane.pane_id;
    const socket = await Socket.connect(bare.port);
    try {
      socket.send({ type: "attach", pane_id: pane, cols: 33, rows: 7, flow_control: "ack" });
      const geometry = await socket.waitFor((message) => message.type === "pane-geometry" && message.pane_id === pane);
      // the grid is herdr's, not the 33x7 this client asked for
      expect(geometry.fixed).toBe(true);
      expect([geometry.cols, geometry.rows]).not.toEqual([33, 7]);
      const first = await socket.waitFor((message) => message.type === "pty-data" && message.pane_id === pane);
      expect(socket.seen.indexOf(geometry)).toBeLessThan(socket.seen.indexOf(first));
      expect(first.data.startsWith("\u001b[?25l\u001b[0m\u001b[H\u001b[2J")).toBe(true);
      // typing goes through herdr, and what the shell prints comes back as a new screen
      socket.send({ type: "resize", pane_id: pane, cols: 33, rows: 7 });
      socket.send({ type: "input", pane_id: pane, text: "echo mirror-$((40+2))\r" });
      await socket.waitFor((message) => message.type === "pty-data" && message.pane_id === pane && message.data.includes("mirror-42"));
      expect(socket.seen.filter((message) => message.type === "pane-geometry" && message.cols === 33)).toEqual([]);
      // a second viewer gets the grid, then the current screen at once
      const late = await Socket.connect(bare.port);
      try {
        late.send({ type: "attach", pane_id: pane, cols: 80, rows: 24 });
        const screen = await late.waitFor((message) => message.type === "pty-data" && message.pane_id === pane);
        expect(screen.data).toContain("mirror-42");
      } finally {
        late.close();
      }
      await herdrRpc("workspace.close", { workspace_id: created.workspace.workspace_id });
      await socket.waitFor((message) => message.type === "pty-exit" && message.pane_id === pane);
    } finally {
      socket.close();
    }
  }, 30_000);

  it("hands several lines for an agent on a mirrored pane over as one paste, typed or sent, and bare where no agent is", async () => {
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create", { label: "herdr-web-ui-test-submit-mirror-paste", cwd: root, focus: false },
    );
    workspaces.push(created.workspace.workspace_id);
    const pane = created.root_pane.pane_id;
    const socket = await Socket.connect(bare.port);
    const shows = (text: string) => socket.waitFor((message) => message.type === "pty-data" && message.pane_id === pane && message.data.includes(text));
    try {
      socket.send({ type: "attach", pane_id: pane, cols: 80, rows: 24 });
      await socket.waitFor((message) => message.type === "pty-data" && message.pane_id === pane);
      // a program that shows every byte it is sent, the escape of a paste marker as ^[
      socket.send({ type: "input", pane_id: pane, text: "cat -v\r" });
      await shows("cat -v");
      // no agent on the pane: the lines go as they came (#267: a program without paste support must get them bare)
      socket.send({ type: "input", pane_id: pane, text: "bare one\rbare two\r" });
      const bare = await shows("bare two");
      expect(bare.data).not.toContain("200~");
      // herdr names an agent on it: the same shape of block is one bracketed paste, on both paths
      await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state: "idle" });
      socket.send({ type: "input", pane_id: pane, text: "typed one\rtyped two" });
      await shows("^[[200~typed one");
      await shows("typed two^[[201~");
      socket.send({ type: "submit", id: 31, pane_id: pane, text: "sent one\nsent two", payload: "sent one\rsent two", typed: true });
      expect(await socket.result(31)).toMatchObject({ ok: true });
      await shows("^[[200~sent one");
      await shows("sent two^[[201~");
    } finally {
      socket.close();
    }
  }, 30_000);

  it("keeps unattached typing behind a message in flight: a Stop right after Send lands after its Enter", async () => {
    const socket = await Socket.connect(bare.port);
    try {
      const from = chunks(shell).length;
      socket.send({ type: "submit", id: 21, pane_id: shell.pane, text: "one", payload: "one" });
      socket.send({ type: "input", pane_id: shell.pane, text: "\u001b" });
      socket.send({ type: "submit", id: 22, pane_id: shell.pane, text: "two", payload: "two" });
      await socket.result(22);
      await received(shell, from, 2);
      expect(typed(shell, from)).toBe("one\r\u001btwo\r");
    } finally {
      socket.close();
    }
  }, 30_000);
});

describe("typing without terminal attach, at the edges", () => {
  it("takes its turn before herdr has said what it can do: a message sent meanwhile does not overtake it", async () => {
    let answer!: (attach: boolean) => void;
    const asked = new Promise<boolean>((resolve) => { answer = resolve; });
    const unsure = createServer({ port: 0, stateDir: join(root, "push-unsure"), terminalAttach: () => asked });
    const socket = await Socket.connect(unsure.port);
    try {
      const from = chunks(shell).length;
      socket.send({ type: "submit", id: 23, pane_id: shell.pane, text: "one", payload: "one" });
      socket.send({ type: "input", pane_id: shell.pane, text: "\u001b" });
      socket.send({ type: "submit", id: 24, pane_id: shell.pane, text: "two", payload: "two" });
      await socket.result(23);
      answer(false);
      await socket.result(24);
      await received(shell, from, 2);
      expect(typed(shell, from)).toBe("one\r\u001btwo\r");
    } finally {
      answer(false);
      socket.close();
      unsure.stop();
    }
  }, 30_000);

  it("sends nothing typed by a connection that closed while it waited its turn", async () => {
    const bare = createServer({ port: 0, stateDir: join(root, "push-gone"), terminalAttach: false });
    const gone = await Socket.connect(bare.port);
    const socket = await Socket.connect(bare.port);
    try {
      const from = chunks(shell).length;
      gone.send({ type: "submit", id: 25, pane_id: shell.pane, text: "one", payload: "one" });
      gone.send({ type: "input", pane_id: shell.pane, text: "\u001b" });
      gone.close();
      await received(shell, from, 1);
      socket.send({ type: "submit", id: 26, pane_id: shell.pane, text: "two", payload: "two" });
      await socket.result(26);
      await received(shell, from, 2);
      expect(typed(shell, from)).toBe("one\rtwo\r");
    } finally {
      socket.close();
      bare.stop();
    }
  }, 30_000);
});

describe("herdr unreachable when a terminal is asked for", () => {
  it("answers the attach with an in-band error and attaches once herdr is back", async () => {
    const asking = createServer({ port: 0, stateDir: join(root, "push-asking") });
    const socket = await Socket.connect(asking.port);
    const reachable = process.env["HERDR_SOCKET"];
    try {
      process.env["HERDR_SOCKET"] = join(root, "no-herdr-here.sock");
      socket.send({ type: "attach", pane_id: shell.pane, cols: 100, rows: 30 });
      const refused = await socket.waitFor((message) => message.type === "error");
      expect(refused.code).toBe("connect_failed");
      process.env["HERDR_SOCKET"] = reachable;
      socket.send({ type: "attach", pane_id: shell.pane, cols: 100, rows: 30 });
      await socket.waitFor((message) => message.type === "pty-data" && message.pane_id === shell.pane);
    } finally {
      process.env["HERDR_SOCKET"] = reachable;
      socket.close();
      asking.stop();
    }
  }, 30_000);
});
