import { describe, expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import { PtySession, writeLine } from "./session.ts";

/** Prints only whether the bridge token is present, plus the socket and TERM the attach would use. */
const REPORT_ENV = ["-e", `process.stdout.write("TOKEN_PRESENT=" + Object.prototype.hasOwnProperty.call(process.env, "HERDR_WEB_TOKEN")
  + " SOCKET=[" + process.env.HERDR_SOCKET_PATH + "] TERM=[" + process.env.TERM + "]")`];
const fixtureToken = () => `herdr-web-token-fixture-${crypto.randomUUID()}`;

/** Runs REPORT_ENV through a PtySession with a fixture bridge token in this process's env, capturing the sidecar's spawn options. */
async function reportThroughSession(env: Record<string, string>) {
  const parentToken = fixtureToken();
  const previous = process.env["HERDR_WEB_TOKEN"];
  process.env["HERDR_WEB_TOKEN"] = parentToken;
  const spawn = spyOn(Bun, "spawn");
  let output = "";
  let session: PtySession | undefined;
  try {
    const code = await new Promise<number | null>((resolve) => {
      session = new PtySession({
        command: "node", args: REPORT_ENV, cols: 80, rows: 5, env,
        onData: (data) => { output += data; }, onExit: resolve,
      });
    });
    const options = spawn.mock.calls[0]?.[1] as { env?: Record<string, string | undefined> } | undefined;
    return { code, output, sidecarEnv: options?.env ?? {}, parentToken, parentKept: process.env["HERDR_WEB_TOKEN"] === parentToken };
  } finally {
    session?.kill();
    spawn.mockRestore();
    if (previous === undefined) delete process.env["HERDR_WEB_TOKEN"];
    else process.env["HERDR_WEB_TOKEN"] = previous;
  }
}

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

  // The bridge's bearer token is for browsers: neither the Node sidecar nor the attach command needs it.
  it("omits bridge token from the sidecar after merging overrides", async () => {
    const overrideToken = fixtureToken();
    const run = await reportThroughSession({ HERDR_WEB_TOKEN: overrideToken });
    expect(run.code).toBe(0);
    expect(Object.prototype.hasOwnProperty.call(run.sidecarEnv, "HERDR_WEB_TOKEN")).toBe(false);
    expect(run.output).toContain("TOKEN_PRESENT=false");
    expect(run.parentKept).toBe(true);
    // compared as booleans so a failure never prints a token
    expect(run.output.includes(run.parentToken) || run.output.includes(overrideToken)).toBe(false);
  }, 10000);

  it("host omits bridge token from attach environment", async () => {
    // Launched outside PtySession: the host defends the attach child on its own.
    const token = fixtureToken();
    const socket = "/tmp/herdr-web-ui-host-test.sock";
    const host = Bun.spawn(
      ["node", join(import.meta.dir, "pty-host.mjs"), "80", "5", "node", ...REPORT_ENV],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, HERDR_WEB_TOKEN: token, HERDR_SOCKET_PATH: socket } },
    );
    try {
      const [code, output, errors] = await Promise.all([host.exited, new Response(host.stdout).text(), new Response(host.stderr).text()]);
      expect(code).toBe(0);
      expect(output).toContain("TOKEN_PRESENT=false");
      expect(output).toContain(`SOCKET=[${socket}]`);
      expect(output.includes(token) || errors.includes(token)).toBe(false);
    } finally { host.kill(); }
  }, 10000);

  it("preserves socket and terminal configuration", async () => {
    const socket = "/tmp/herdr-web-ui-session-config.sock";
    const run = await reportThroughSession({ HERDR_SOCKET_PATH: socket });
    expect(run.code).toBe(0);
    expect(run.sidecarEnv["HERDR_SOCKET_PATH"]).toBe(socket);
    expect(run.sidecarEnv["PATH"]).toBe(process.env["PATH"]);
    expect(run.sidecarEnv["HOME"]).toBe(process.env["HOME"]);
    expect(run.output).toContain(`SOCKET=[${socket}]`);
    expect(run.output).toContain("TERM=[xterm-256color]");
    expect(run.output).toContain("TOKEN_PRESENT=false");
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

describe("writeLine", () => {
  // Only a child that really closes its stdin handle reaches EPIPE on Windows: Python's os.close(0) does;
  // Bun's and Node's closeSync(0) / stdin.destroy() and an exited child do not, so skip where Python is absent.
  // Windows' Microsoft Store alias (WindowsApps\python.exe) is on PATH with no Python behind it: it exits non-zero.
  const python = Bun.which(process.platform === "win32" ? "python" : "python3");
  const runs = python !== null && Bun.spawnSync([python, "-c", ""], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  it.skipIf(!runs)("survives a child that already closed its stdin", async () => {
    // on Windows the write settles later and an EPIPE rejects the returned promise instead of throwing
    const rejections: unknown[] = []; const track = (error: unknown) => rejections.push(error);
    process.on("unhandledRejection", track);
    let proc: ReturnType<typeof Bun.spawn> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const child = Bun.spawn([
        python!, "-c",
        "import os,threading; os.close(0); os.write(1,b'closed\\n'); os.close(1); threading.Event().wait()",
      ], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
      proc = child;
      const ready = await Promise.race([
        new Response(child.stdout).text(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Child did not close stdin within 2 seconds")), 2000);
        }),
      ]);
      clearTimeout(timer);
      expect(ready).toBe("closed\n");
      expect(child.exitCode).toBeNull();
      writeLine(child.stdin, "{}\n");
      await Bun.sleep(300); // fixed wait: observe delayed unhandled rejections after the pipe write
      expect(rejections).toEqual([]);
    } finally {
      clearTimeout(timer);
      proc?.kill();
      await proc?.exited;
      process.off("unhandledRejection", track);
    }
  });
});
