import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalSession, type TerminalSessionOptions } from "./terminal-session.ts";
import { sessionControlStandIn, type StandInEntry } from "./session-control-fixture.ts";

const root = mkdtempSync(join(tmpdir(), "termweave-terminal-session-"));
let herdr: string;
let runs = 0;

// building the stand-in, and its first start, take a few seconds
beforeAll(() => { herdr = sessionControlStandIn(join(root, "bin")); }, 60_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function until(what: string, predicate: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** A session on the stand-in, with what it handed on and what the stand-in read. */
function open(mode: string, options: Partial<TerminalSessionOptions> = {}) {
  const log = join(root, `run-${++runs}.log`);
  const data: { data: string; full: boolean }[] = [];
  const exits: { code: number | null; reason: string | null }[] = [];
  const session = new TerminalSession({
    command: herdr, terminal: `term_${runs}`, cols: 80, rows: 24,
    env: { STANDIN_MODE: mode, STANDIN_LOG: log, HERDR_SOCKET_PATH: "the-socket" },
    onData: (text, full) => data.push({ data: text, full }),
    onExit: (code, reason) => exits.push({ code, reason }),
    ...options,
  });
  const entries = (): StandInEntry[] => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const read = () => entries().flatMap((entry) => entry.line ? [JSON.parse(entry.line)] : []);
  return { session, data, exits, entries, read };
}

describe("TerminalSession", () => {
  it("starts herdr's session control for the terminal at the grid, on the socket it is given", async () => {
    const { session, entries } = open("frames", { cols: 132, rows: 43 });
    expect(await session.started).toBe(true);
    await until("the stand-in's argv", () => entries().length > 0);
    expect(entries()[0]).toEqual({ terminal: `term_${runs}`, argv: ["terminal", "session", "control", `term_${runs}`, "--cols", "132", "--rows", "43"], socket: "the-socket" });
    session.kill();
    await session.exited;
  });

  it("hands on each frame's bytes, decoded, whatever the line was cut into, and skips what is not a frame", async () => {
    const { session, data } = open("frames");
    await until("two frames", () => data.length === 2);
    expect(data[0]!.full).toBe(true);
    expect(data[0]!.data).toStartWith("\x1b[?2026h\x1b[?25l\x1b[2J\x1b[1;1Hscreen of ");
    // UTF-8 inside the base64, and the live cursor the frame ends with
    expect(data[0]!.data).toEndWith(" 한글\x1b[1;5H\x1b[?25h\x1b[?2026l");
    expect(data[1]).toEqual({ data: "\x1b[2;1Hpartial\x1b[2;8H\x1b[?25l", full: false });
    // a late joiner gets the frames since the full one
    expect(session.current).toBe(data[0]!.data + data[1]!.data);
    session.kill();
    await session.exited;
  });

  it("sends input as base64 bytes, resizes, repaints and scrolls as herdr's messages", async () => {
    const { session, data, read } = open("frames");
    await until("the first frames", () => data.length === 2);
    expect(session.write("a\x03\x1b한")).toBe(true);
    session.resize(100, 30);
    session.scroll("up", 3, 5, 7);
    session.repaint();
    await until("four messages", () => read().length === 4);
    expect(read()).toEqual([
      { type: "terminal.input", bytes: Buffer.from("a\x03\x1b한").toString("base64") },
      { type: "terminal.resize", cols: 100, rows: 30 },
      { type: "terminal.scroll", direction: "up", lines: 3, column: 5, row: 7 },
      // a repaint is a resize to the size the session is at
      { type: "terminal.resize", cols: 100, rows: 30 },
    ]);
    // the full frame of the new size starts what a late joiner gets over
    await until("the resized frame", () => data.some((frame) => frame.data.includes("size 100x30")));
    expect(session.current).toStartWith("\x1b[2J\x1b[1;1Hsize 100x30");
    session.kill();
    await session.exited;
  });

  it("drops frames while paused and asks for a full one on resume", async () => {
    const { session, data, read } = open("frames");
    await until("the first frames", () => data.length === 2);
    session.pause();
    session.write("x");
    await until("the echo the pause dropped", () => read().length === 1);
    await Bun.sleep(100);
    expect(data).toHaveLength(2);
    expect(session.current).toBeNull();
    session.resume();
    await until("the repainted screen", () => data.length === 3);
    expect(read()[1]).toEqual({ type: "terminal.resize", cols: 80, rows: 24 });
    expect(data[2]!.full).toBe(true);
    expect(session.current).toBe(data[2]!.data);
    session.kill();
    await session.exited;
  });

  it("keeps no replay that outgrew its bound: the joiner needs a repaint", async () => {
    const { session, data } = open("frames", { replayBytes: 60 });
    await until("the first frames", () => data.length === 2);
    expect(session.current).toBeNull();
    session.kill();
    await session.exited;
  });

  it("lets go with a release, and reports no exit of its own", async () => {
    const { session, data, read, exits } = open("frames");
    await until("the first frames", () => data.length === 2);
    session.kill();
    await session.exited;
    expect(read()).toEqual([{ type: "terminal.release" }]);
    expect(exits).toEqual([]);
    expect(session.write("late")).toBe(false);
  });

  it("kills a CLI that outlives its release", async () => {
    const { session, data, read, exits } = open("hang", { releaseMs: 300 });
    await until("the first frames", () => data.length === 2);
    const at = Date.now();
    session.kill();
    await session.exited;
    expect(Date.now() - at).toBeGreaterThanOrEqual(250);
    expect(read()).toEqual([{ type: "terminal.release" }]);
    expect(exits).toEqual([]);
  });

  it("ends on terminal.closed with herdr's reason, killing a CLI that stays", async () => {
    const { session, exits } = open("closed");
    expect(await session.started).toBe(true);
    await session.exited;
    expect(exits).toHaveLength(1);
    expect(exits[0]!.reason).toBe(`terminal attach failed: terminal term_${runs} already has an attached client; retry with --takeover`);
    expect(session.answered).toBe(true);
  });

  it("says it never started when the CLI ends without a word of the protocol", async () => {
    const { session, exits } = open("silent");
    expect(await session.started).toBe(false);
    await session.exited;
    expect(exits).toEqual([{ code: 2, reason: null }]);
    expect(session.answered).toBe(false);
    expect(session.stderr).toContain("unrecognized subcommand 'session'");
  });

  it("throws at once when the CLI is not there", () => {
    expect(() => new TerminalSession({ command: join(root, "no-such-herdr"), terminal: "t", cols: 80, rows: 24, onData: () => {}, onExit: () => {} })).toThrow();
  });
});
