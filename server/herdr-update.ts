/**
 * Updating herdr from the app.
 *
 * herdr refuses `herdr update` in any process that carries a pane's HERDR_ENV=1 ("run `herdr
 * update` outside herdr after detaching from the session"). Every terminal this app shows is a
 * pane, and the plugin that starts this server inherits a pane's variables too, so someone who
 * only has the app (a phone) cannot update herdr at all. This server runs the update itself:
 *
 * - `herdr update --handoff`, with none of herdr's variables, stdin closed and
 *   HERDR_SOCKET_PATH naming the herdr this server talks to. herdr asks before it stops a
 *   server only on a terminal; without one it never stops any (a server too old for a handoff
 *   fails the update before the download, and a failed handoff keeps the old server:
 *   herdr 0.9.3, src/update.rs). The socket variable makes that one herdr the update's only
 *   target: without it herdr plans every session it finds, and one stale session whose status
 *   does not answer fails the whole update.
 * - then `herdr server live-handoff`, when herdr's own status says the installed binary is
 *   newer than the running server. An update installed from a shell leaves it so, and
 *   `herdr update` stops at "already up to date" without touching the server.
 *
 * A live handoff keeps every pane and its processes; open terminals attach again (index.ts).
 * Windows has no live handoff: its herdr updates through an installer, and the app offers nothing.
 */
import type { HerdrUpdateStatus } from "../shared/update.ts";
import { herdrSocketPath } from "./herdr/client.ts";
import { jsonResponse } from "./http.ts";
import { updateRequestAllowed } from "./update-api.ts";

/** a download of herdr's binary (about 30 MB) on a slow link, then the handoff */
const UPDATE_TIMEOUT_MS = 10 * 60_000;
const STATUS_TIMEOUT_MS = 5_000;
/** how often, and how far apart, herdr's status is asked again after an update before it counts as unreadable */
const STATUS_TRIES = 5;
const STATUS_RETRY_MS = 500;
/** the versions shown are read from `herdr status`, a process each time: one read serves the polls of this long */
const STATUS_CACHE_MS = 2_000;
/** how long a herdr told to stop at its timeout is given before it is killed */
const KILL_GRACE_MS = 2_000;
/** how long the output of a herdr that has exited is still read */
const PIPE_GRACE_MS = 250;
/** herdr's last words, as much as the app shows */
const OUTPUT_TAIL = 4_000;

export interface HerdrUpdaterOptions {
  /** the herdr to run; unset, HERDR_WEB_HERDR_BIN or `herdr` from PATH, read at each run */
  bin?: string;
  /** the herdr this server talks to; unset, herdrSocketPath() */
  socketPath?: string;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  /** KILL_GRACE_MS; tests shorten it */
  killGraceMs?: number;
  /** STATUS_RETRY_MS; tests shorten it */
  statusRetryMs?: number;
}

interface HerdrVersions {
  server: string | null;
  binary: string | null;
  binaryPath: string | null;
  stale: boolean;
  handoff: boolean;
}

/** What `herdr status --json` says of the versions; null when it says nothing usable. */
export function parseHerdrStatus(text: string): HerdrVersions | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (value === null || typeof value !== "object") return null;
  const record = (input: unknown): Record<string, unknown> => input !== null && typeof input === "object" ? input as Record<string, unknown> : {};
  const text_ = (input: unknown): string | null => typeof input === "string" && input !== "" ? input : null;
  const root = record(value);
  const client = record(root["client"]);
  const server = record(root["server"]);
  return {
    server: server["running"] === false ? null : text_(server["version"]),
    binary: text_(client["version"]),
    binaryPath: text_(client["binary"]),
    stale: record(root["update"])["server_binary_stale"] === true,
    handoff: record(server["capabilities"])["live_handoff"] === true,
  };
}

/** herdr prints progress for a terminal: its colors and cursor moves are not for the app. */
export function plainOutput(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n?/g, "\n")
    .split("\n").map((line) => line.trimEnd()).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export class HerdrUpdater {
  private phase: HerdrUpdateStatus["phase"] = "idle";
  private output: string | null = null;
  private finishedAt: string | null = null;
  private running = false;
  private versions: { at: number; value: Promise<HerdrVersions | null> } | null = null;

  constructor(private readonly options: HerdrUpdaterOptions = {}) {}

  private get supported(): boolean {
    return (this.options.platform ?? process.platform) !== "win32";
  }

  /** The update's own environment: nothing of the pane that started this server, and this server's herdr. */
  private env(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined && !name.startsWith("HERDR_")) env[name] = value;
    }
    env["HERDR_SOCKET_PATH"] = this.options.socketPath ?? herdrSocketPath();
    return env;
  }

  /** `output` is everything herdr printed, for the app to show; `stdout` alone is what a command answers with. */
  private async exec(args: string[], timeoutMs: number): Promise<{ code: number | null; output: string; stdout: string }> {
    const bin = this.options.bin ?? (process.env["HERDR_WEB_HERDR_BIN"] || "herdr");
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([bin, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: this.env() });
    } catch (error) {
      return { code: null, output: `herdr could not be started: ${error instanceof Error ? error.message : String(error)}`, stdout: "" };
    }
    // read as it comes: a process herdr left behind that still holds the pipes must not hold the answer
    const read = (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let text = "";
      const done = (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      })().catch(() => {});
      return { done, text: () => text, cancel: () => { void reader.cancel().catch(() => {}); } };
    };
    const stdout = read(proc.stdout as ReadableStream<Uint8Array>);
    const stderr = read(proc.stderr as ReadableStream<Uint8Array>);
    let timedOut = false;
    let killer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
      // one that ignores the request would keep the updater busy for good
      killer = setTimeout(() => proc.kill("SIGKILL"), this.options.killGraceMs ?? KILL_GRACE_MS);
    }, timeoutMs);
    try {
      const code = await proc.exited;
      await Promise.race([Promise.all([stdout.done, stderr.done]), Bun.sleep(PIPE_GRACE_MS)]);
      const output = plainOutput([stdout.text(), stderr.text()].filter(Boolean).join("\n"));
      if (timedOut) return { code: null, output: [output, `herdr did not finish within ${Math.round(timeoutMs / 1000)} seconds and was stopped.`].filter(Boolean).join("\n"), stdout: stdout.text() };
      return { code, output, stdout: stdout.text() };
    } finally {
      clearTimeout(timer);
      clearTimeout(killer);
      stdout.cancel();
      stderr.cancel();
    }
  }

  private readVersions(fresh = false): Promise<HerdrVersions | null> {
    const now = Date.now();
    if (!fresh && this.versions && now - this.versions.at < STATUS_CACHE_MS) return this.versions.value;
    // its answer is on stdout; a warning herdr adds on stderr is not part of it
    const value = this.exec(["status", "--json"], STATUS_TIMEOUT_MS).then((result) => parseHerdrStatus(result.stdout), () => null);
    this.versions = { at: now, value };
    return value;
  }

  async status(): Promise<HerdrUpdateStatus> {
    const none = { server_version: null, binary_version: null, stale: false };
    if (!this.supported) return { supported: false, phase: "idle", ...none, output: null, finished_at: null };
    const versions = await this.readVersions();
    return {
      // a status that cannot be read hides the controls only before any update: during one
      // and after it, its progress, what herdr said and the button to try again stay
      supported: versions !== null || this.running || this.finishedAt !== null,
      phase: this.phase,
      ...(versions ? { server_version: versions.server, binary_version: versions.binary, stale: versions.stale } : none),
      output: this.output,
      finished_at: this.finishedAt,
    };
  }

  /** Starts an update, unless this PC offers none or one is already running. */
  start(): "started" | "busy" | "unsupported" {
    if (!this.supported) return "unsupported";
    if (this.running) return "busy";
    this.running = true;
    this.phase = "updating";
    this.output = null;
    void this.run().then((result) => {
      this.output = result.output.slice(-OUTPUT_TAIL) || null;
      this.phase = result.ok ? "idle" : "error";
    }, (error: unknown) => {
      this.output = error instanceof Error ? error.message : String(error);
      this.phase = "error";
    }).finally(() => {
      this.finishedAt = new Date().toISOString();
      this.versions = null;
      this.running = false;
    });
    return "started";
  }

  private async run(): Promise<{ ok: boolean; output: string }> {
    const update = await this.exec(["update", "--handoff"], this.options.timeoutMs ?? UPDATE_TIMEOUT_MS);
    if (update.code !== 0) return { ok: false, output: update.output };
    // installed, by this run or an earlier one from a shell, and the server still the old one.
    // The status may not answer for a moment right after a handoff; one that never does is no
    // proof that the server runs the new binary.
    let versions = await this.readVersions(true);
    for (let tries = 1; versions === null && tries < STATUS_TRIES; tries++) {
      await Bun.sleep(this.options.statusRetryMs ?? STATUS_RETRY_MS);
      versions = await this.readVersions(true);
    }
    if (versions === null) {
      return { ok: false, output: [update.output, "herdr's status could not be read after the update: the running server may still be the old one. Update again to check."].filter(Boolean).join("\n") };
    }
    if (!versions.stale || !versions.handoff || !versions.binaryPath || !versions.binary) return { ok: true, output: update.output };
    const handoff = await this.exec(
      ["server", "live-handoff", "--import-exe", versions.binaryPath, "--expected-version", versions.binary],
      this.options.timeoutMs ?? UPDATE_TIMEOUT_MS,
    );
    return { ok: handoff.code === 0, output: [update.output, handoff.output].filter(Boolean).join("\n") };
  }
}

export async function handleHerdrUpdateRequest(request: Request, updater?: HerdrUpdater): Promise<Response> {
  const reply = (body: unknown, code = 200) => jsonResponse(body, code, { "cache-control": "no-store" });
  const fail = (code: string, message: string, http: number) => reply({ error: { code, message } }, http);
  if (request.method === "GET") {
    // a server started without the updater (tests, an embedding) offers nothing
    return reply(updater ? await updater.status() : { supported: false, phase: "idle", server_version: null, binary_version: null, stale: false, output: null, finished_at: null } satisfies HerdrUpdateStatus);
  }
  if (request.method !== "POST") return fail("method_not_allowed", "Use GET or POST /api/herdr/update", 405);
  if (!updateRequestAllowed(request)) return fail("invalid_update_request", "Use the update controls from this app.", 403);
  const started = updater?.start() ?? "unsupported";
  if (started === "unsupported") return fail("herdr_update_unsupported", "herdr cannot be updated from the app on this PC.", 409);
  if (started === "busy") return fail("herdr_update_busy", "herdr is already being updated.", 409);
  return reply({ accepted: true }, 202);
}
