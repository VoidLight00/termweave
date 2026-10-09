import { describe, expect, it } from "bun:test";
import { PtySession } from "./session.ts";

/**
 * The attach command is `herdr terminal attach`, and herdr's CLI picks its socket from
 * HERDR_SOCKET_PATH, so the session must be able to hand the command an environment
 * of its own on top of the server's - otherwise a non-default session's terminals
 * are looked up on the default socket and the attach dies.
 */
describe("PtySession", () => {
  it("forwards extra env to the command running on the pty", async () => {
    const sentinel = "/tmp/herdr-web-ui-session-test.sock";
    let output = "";
    const printed = new Promise<string>((resolve) => {
      new PtySession({
        command: "sh",
        args: ["-c", 'printf "[%s]" "$HERDR_SOCKET_PATH"'],
        cols: 40,
        rows: 5,
        env: { HERDR_SOCKET_PATH: sentinel },
        onData: (data) => {
          output += data;
        },
        onExit: () => resolve(output),
      });
    });
    expect(await printed).toContain("[" + sentinel + "]");
  }, 10000);

  it("delivers split UTF-8 and the entire final burst before reporting the exit code", async () => {
    const expected = "한글🙂\u001b[31m끝\u001b[0m".repeat(100_000);
    let output = "";
    let session: PtySession | undefined;
    const done = new Promise<number | null>((resolve) => {
      session = new PtySession({
        command: "node", args: ["-e", `
          const data = Buffer.from("한글🙂\\x1b[31m끝\\x1b[0m".repeat(100000));
          process.stdout.write(data.subarray(0, 1));
          setTimeout(() => process.stdout.write(data.subarray(1), () => process.exit(7)), 10);
        `],
        cols: 80, rows: 24,
        onData: (data) => { output += data; }, onExit: resolve,
      });
    });
    try {
      expect(await done).toBe(7);
      expect(output).toBe(expected);
    } finally { session?.kill(); }
  }, 15000);

  it("stops output reads while keeping Ctrl+C input live, then resumes without loss", async () => {
    let bytes = 0;
    let outputTail = "";
    let session!: PtySession;
    let stopped = false;
    const done = new Promise<number | null>((resolve) => {
      session = new PtySession({
        command: "node", args: ["-e", `
          process.stdin.setRawMode(true);
          let running = true;
          process.stdin.on("data", data => {
            if (data.includes(3)) {
              running = false;
              process.stdout.write("STOPPED", () => process.exit(0));
            }
          });
          const chunk = "x".repeat(16384);
          function pump() {
            if (!running) return;
            if (process.stdout.write(chunk)) setImmediate(pump);
            else process.stdout.once("drain", pump);
          }
          pump();
        `],
        cols: 80, rows: 24,
        onData: (data) => {
          bytes += Buffer.byteLength(data);
          outputTail = (outputTail + data).slice(-32);
          if (!stopped && bytes >= 65536) { stopped = true; session.pause(); }
        }, onExit: resolve,
      });
    });
    try {
      const deadline = Date.now() + 5000;
      while (!stopped && Date.now() < deadline) await Bun.sleep(10);
      expect(stopped).toBe(true);
      await Bun.sleep(150); // allow the already-read pipe tail to arrive
      const pausedBytes = bytes;
      await Bun.sleep(200);
      expect(bytes).toBe(pausedBytes);
      session.write("\x03");
      await Bun.sleep(50);
      session.resume();
      expect(await done).toBe(0);
      expect(outputTail).toEndWith("STOPPED");
    } finally { session.kill(); }
  }, 15000);

  it("reaps both processes when the last client leaves with output paused", async () => {
    const tag = `herdr-pty-kill-${crypto.randomUUID()}`;
    let painted = false;
    const session = new PtySession({
      command: "node", args: ["-e", `/* ${tag} */ setInterval(() => process.stdout.write("x".repeat(4096)), 5);`],
      cols: 80, rows: 24,
      onData: () => { painted = true; session.pause(); }, onExit: () => {},
    });
    try {
      const started = Date.now();
      while (!painted && Date.now() - started < 5000) await Bun.sleep(10);
      expect(painted).toBe(true);
      await Bun.sleep(100);
      session.kill();
      const deadline = Date.now() + 5000;
      while (Bun.spawnSync(["pgrep", "-f", tag]).stdout.length > 0 && Date.now() < deadline) await Bun.sleep(25);
      expect(Bun.spawnSync(["pgrep", "-f", tag]).stdout.length).toBe(0);
    } finally { session.kill(); }
  }, 12000);
});
