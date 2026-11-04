import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A stand-in for `herdr terminal session control`, built into an executable as herdr's own is: a
 * script behind a .cmd would leave its Bun running past a kill on Windows. Each run appends to
 * STANDIN_LOG its argv and every line it reads, as `{terminal, argv|line}` JSON lines. Its mode is
 * the terminal's in STANDIN_MODES (a JSON object), else STANDIN_MODE:
 * - `frames` (default): a full frame split across two writes, a line that is not JSON and a message
 *   of a type nobody knows, then a partial frame; a resize answers a full frame of the new size,
 *   input is echoed as a partial frame, and a release (or stdin's end) exits 0
 * - `hang`: as `frames`, but neither a release nor stdin's end makes it exit
 * - `closed`: herdr's refusal of a terminal another client holds, and it stays running (herdrdev/herdr#5175)
 * - `silent`: a herdr without session control: a usage error on stderr, exit 2, not a word on stdout
 */
const SOURCE = String.raw`
import { appendFileSync } from "node:fs";
const log = process.env.STANDIN_LOG;
const terminal = process.argv[5];
const mode = JSON.parse(process.env.STANDIN_MODES || "{}")[terminal] || process.env.STANDIN_MODE || "frames";
const record = (entry) => { if (log) appendFileSync(log, JSON.stringify({ terminal, ...entry }) + "\n"); };
record({ argv: process.argv.slice(2), socket: process.env.HERDR_SOCKET_PATH ?? null });
let seq = 0;
const frame = (full, text) => JSON.stringify({ type: "terminal.frame", seq: ++seq, width: 80, height: 24, full, encoding: "base64", bytes: Buffer.from(text).toString("base64") }) + "\n";
const out = (text) => process.stdout.write(text);
if (mode === "silent") {
  process.stderr.write("error: unrecognized subcommand 'session'\n");
  process.exit(2);
}
if (mode === "closed") {
  out(JSON.stringify({ type: "terminal.closed", reason: "terminal attach failed: terminal " + terminal + " already has an attached client; retry with --takeover" }) + "\n");
  setInterval(() => {}, 1000);
} else {
  const first = frame(true, "\x1b[?2026h\x1b[?25l\x1b[2J\x1b[1;1Hscreen of " + terminal + " 한글\x1b[1;5H\x1b[?25h\x1b[?2026l");
  out(first.slice(0, 25));
  await Bun.sleep(40);
  out(first.slice(25) + "not json\n" + JSON.stringify({ type: "terminal.future", seq: 0 }) + "\n");
  await Bun.sleep(40);
  out(frame(false, "\x1b[2;1Hpartial\x1b[2;8H\x1b[?25l"));
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of Bun.stdin.stream()) {
    pending += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      record({ line });
      const message = JSON.parse(line);
      if (message.type === "terminal.resize") out(frame(true, "\x1b[2J\x1b[1;1Hsize " + message.cols + "x" + message.rows));
      if (message.type === "terminal.input") out(frame(false, "echo " + Buffer.from(message.bytes, "base64").toString("utf8")));
      if (message.type === "terminal.release" && mode !== "hang") process.exit(0);
    }
  }
  if (mode === "hang") setInterval(() => {}, 1000);
}
`;

/** Builds the stand-in in `dir` and returns its path. */
export function sessionControlStandIn(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "standin.ts");
  writeFileSync(script, SOURCE);
  const out = join(dir, process.platform === "win32" ? "herdr.exe" : "herdr");
  const built = Bun.spawnSync([process.execPath, "build", "--compile", script, "--outfile", out], { stdout: "pipe", stderr: "pipe" });
  if (!built.success) throw new Error(`could not build the session control stand-in: ${built.stderr.toString()}`);
  // its first start is the slow one (a virus scan of the fresh executable took seconds on Windows): taken here, not in a test
  Bun.spawnSync([out, "terminal", "session", "control", "warm-up"], { env: { ...process.env, STANDIN_MODE: "silent", STANDIN_LOG: "" }, stdout: "ignore", stderr: "ignore" });
  return out;
}

export interface StandInEntry { terminal: string; argv?: string[]; socket?: string | null; line?: string }
