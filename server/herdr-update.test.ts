import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleHerdrUpdateRequest, HerdrUpdater, parseHerdrStatus, plainOutput } from "./herdr-update.ts";

/**
 * The updater runs a stand-in herdr here, a shell script: the real `herdr update` replaces the
 * herdr on PATH and hands its server off, which no test may do.
 */
const root = mkdtempSync(join(tmpdir(), "herdr-update-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

interface StandIn {
  path: string;
  /** every call's arguments, one line each */
  calls: () => string[];
  /** what `update --handoff` saw of its environment and stdin */
  seen: () => string;
  status: (status: { server: string; binary: string; stale: boolean; handoff?: boolean }) => void;
}

/** A herdr whose `update` prints `says` and exits with `code`; a live handoff brings the server to the binary's version. */
function standIn(says: string, code = 0, options: { handoffCode?: number; sleep?: number; ignoreTerm?: boolean; statusGoesAfterUpdate?: boolean } = {}): StandIn {
  const dir = mkdtempSync(join(root, "herdr-"));
  const path = join(dir, "herdr");
  const calls = join(dir, "calls");
  const seen = join(dir, "seen");
  const statusFile = join(dir, "status.json");
  const fresh = join(dir, "status-after-handoff.json");
  const write = (file: string, server: string, binary: string, stale: boolean, handoff: boolean): void => writeFileSync(file, JSON.stringify({
    client: { version: binary, binary: path },
    server: { running: true, version: server, capabilities: { live_handoff: handoff } },
    update: { restart_needed: false, server_binary_stale: stale },
  }));
  writeFileSync(path, [
    "#!/bin/sh",
    `echo "$*" >> '${calls}'`,
    'case "$1 $2" in',
    // a warning on stderr is not part of the answer
    `  "status --json") echo "warning: herdr integrations need updating" >&2; cat '${statusFile}' 2>/dev/null || exit 1 ;;`,
    '  "update --handoff")',
    `    { echo "env=\${HERDR_ENV-unset} pane=\${HERDR_PANE_ID-unset} socket=\${HERDR_SOCKET_PATH-unset} web=\${HERDR_WEB_STATE_DIR-unset}"; if [ -t 0 ]; then echo stdin=tty; else echo stdin=closed; fi; } > '${seen}'`,
    // a herdr whose status stops answering once its update has begun
    options.statusGoesAfterUpdate ? `    rm -f '${statusFile}'` : "    :",
    options.ignoreTerm ? "    trap '' TERM" : "    :",
    options.sleep ? `    sleep ${options.sleep}` : "    :",
    // herdr reports progress on stderr, with colors on a terminal
    `    printf '%s\\n' '${says}' >&2`,
    `    exit ${code} ;;`,
    '  "server live-handoff")',
    `    cp '${fresh}' '${statusFile}'`,
    `    echo "live handoff complete; server log: /tmp/herdr-server.log" >&2`,
    `    exit ${options.handoffCode ?? 0} ;;`,
    "  *) exit 2 ;;",
    "esac",
    "",
  ].join("\n"));
  chmodSync(path, 0o755);
  write(statusFile, "0.9.3", "0.9.3", false, true);
  return {
    path,
    calls: () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [],
    seen: () => existsSync(seen) ? readFileSync(seen, "utf8") : "",
    status: ({ server, binary, stale, handoff = true }) => {
      write(statusFile, server, binary, stale, handoff);
      write(fresh, binary, binary, false, handoff);
    },
  };
}

async function finished(updater: HerdrUpdater): Promise<Awaited<ReturnType<HerdrUpdater["status"]>>> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const status = await updater.status();
    if (status.phase !== "updating") return status;
    if (Date.now() >= deadline) throw new Error("Timed out: the update finished");
    await Bun.sleep(20);
  }
}

describe("updating herdr from the app", () => {
  // what a server started by the herdr plugin carries: a pane's variables
  const pane = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/pane/herdr.sock" };
  const previous: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const [name, value] of Object.entries(pane)) { previous[name] = process.env[name]; process.env[name] = value; }
  });
  afterEach(() => {
    for (const name of Object.keys(pane)) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });

  it("runs `herdr update --handoff` outside the pane it was started from, for its own herdr, with no terminal", async () => {
    const herdr = standIn("checking stable channel for updates...\nalready up to date (0.9.3)");
    const updater = new HerdrUpdater({ bin: herdr.path, socketPath: "/srv/herdr.sock" });
    expect(updater.start()).toBe("started");
    const status = await finished(updater);
    expect(herdr.calls()).toContain("update --handoff");
    // HERDR_ENV=1 is what makes herdr refuse; the socket is this server's, not the pane's
    expect(herdr.seen()).toContain("env=unset pane=unset socket=/srv/herdr.sock");
    expect(herdr.seen()).toContain("stdin=closed");
    expect(status.phase).toBe("idle");
    expect(status.output).toBe("checking stable channel for updates...\nalready up to date (0.9.3)");
    expect(status.finished_at).not.toBeNull();
    // nothing to move: the server already runs the installed binary
    expect(herdr.calls().filter((call) => call.startsWith("server live-handoff"))).toEqual([]);
  });

  it("moves the panes onto a binary that is newer than the running server", async () => {
    const herdr = standIn("already up to date (0.9.3)");
    herdr.status({ server: "0.9.0", binary: "0.9.3", stale: true });
    const updater = new HerdrUpdater({ bin: herdr.path, socketPath: "/srv/herdr.sock" });
    expect(await updater.status()).toMatchObject({ supported: true, server_version: "0.9.0", binary_version: "0.9.3", stale: true });
    updater.start();
    const status = await finished(updater);
    expect(herdr.calls()).toContain(`server live-handoff --import-exe ${herdr.path} --expected-version 0.9.3`);
    expect(status).toMatchObject({ phase: "idle", server_version: "0.9.3", binary_version: "0.9.3", stale: false });
    expect(status.output).toBe("already up to date (0.9.3)\nlive handoff complete; server log: /tmp/herdr-server.log");
  });

  it("leaves a server that cannot hand off alone", async () => {
    const herdr = standIn("already up to date (0.9.3)");
    herdr.status({ server: "0.8.0", binary: "0.9.3", stale: true, handoff: false });
    const updater = new HerdrUpdater({ bin: herdr.path });
    updater.start();
    const status = await finished(updater);
    expect(herdr.calls().filter((call) => call.startsWith("server live-handoff"))).toEqual([]);
    expect(status).toMatchObject({ phase: "idle", stale: true });
  });

  it("reports what herdr said when the update fails, and hands nothing off", async () => {
    const herdr = standIn("update failed: self-update is disabled for Homebrew installs; run `brew update && brew upgrade herdr`", 1);
    herdr.status({ server: "0.9.0", binary: "0.9.3", stale: true });
    const updater = new HerdrUpdater({ bin: herdr.path });
    updater.start();
    const status = await finished(updater);
    expect(status.phase).toBe("error");
    expect(status.output).toContain("self-update is disabled for Homebrew installs");
    expect(herdr.calls().filter((call) => call.startsWith("server live-handoff"))).toEqual([]);
  });

  it("reports a handoff that failed", async () => {
    const herdr = standIn("already up to date (0.9.3)", 0, { handoffCode: 1 });
    herdr.status({ server: "0.9.0", binary: "0.9.3", stale: true });
    const updater = new HerdrUpdater({ bin: herdr.path });
    updater.start();
    expect((await finished(updater)).phase).toBe("error");
  });

  it("runs one update at a time", async () => {
    const herdr = standIn("already up to date (0.9.3)", 0, { sleep: 1 });
    const updater = new HerdrUpdater({ bin: herdr.path });
    expect(updater.start()).toBe("started");
    expect(updater.start()).toBe("busy");
    expect((await updater.status()).phase).toBe("updating");
    await finished(updater);
    expect(herdr.calls().filter((call) => call === "update --handoff")).toHaveLength(1);
    expect(updater.start()).toBe("started");
    await finished(updater);
  });

  it("stops a herdr that does not finish", async () => {
    const herdr = standIn("never printed", 0, { sleep: 30 });
    const updater = new HerdrUpdater({ bin: herdr.path, timeoutMs: 200 });
    updater.start();
    const status = await finished(updater);
    expect(status.phase).toBe("error");
    expect(status.output).toContain("did not finish");
  });

  it("does not call an update done when herdr's status cannot be read after it", async () => {
    const herdr = standIn("installed 0.9.4", 0, { statusGoesAfterUpdate: true });
    const updater = new HerdrUpdater({ bin: herdr.path, statusRetryMs: 10 });
    updater.start();
    const status = await finished(updater);
    // the server may still run the old binary: no handoff was possible, and none is claimed
    expect(status.phase).toBe("error");
    expect(status.output).toContain("installed 0.9.4");
    expect(status.output).toContain("status could not be read");
    expect(herdr.calls().filter((call) => call === "status --json").length).toBeGreaterThanOrEqual(5);
    // the controls stay, with what herdr said and the button to try again
    expect(status).toMatchObject({ supported: true, server_version: null });
  });

  it("keeps the controls while an update runs although the status does not answer", async () => {
    const herdr = standIn("update failed: no network", 1, { statusGoesAfterUpdate: true, sleep: 1 });
    const updater = new HerdrUpdater({ bin: herdr.path, statusRetryMs: 10 });
    updater.start();
    await Bun.sleep(300); // the stand-in's status is gone by now, and its update still runs
    expect(await updater.status()).toMatchObject({ supported: true, phase: "updating" });
    expect(await finished(updater)).toMatchObject({ supported: true, phase: "error", output: "update failed: no network" });
  });

  it("kills a herdr that ignores being stopped, and is free for the next update", async () => {
    const herdr = standIn("never printed", 0, { sleep: 30, ignoreTerm: true });
    const updater = new HerdrUpdater({ bin: herdr.path, timeoutMs: 200, killGraceMs: 200 });
    const startedAt = Date.now();
    updater.start();
    const status = await finished(updater);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(status.phase).toBe("error");
    expect(updater.start()).toBe("started");
    await finished(updater);
  });

  it("offers nothing on Windows, where herdr has no live handoff", async () => {
    const herdr = standIn("already up to date (0.9.3)");
    const updater = new HerdrUpdater({ bin: herdr.path, platform: "win32" });
    expect(await updater.status()).toMatchObject({ supported: false, server_version: null });
    expect(updater.start()).toBe("unsupported");
    expect(herdr.calls()).toEqual([]);
  });

  it("offers nothing where herdr does not run", async () => {
    const updater = new HerdrUpdater({ bin: join(root, "no-such-herdr") });
    expect((await updater.status()).supported).toBe(false);
  });
});

describe("the herdr update endpoint", () => {
  const post = (headers: Record<string, string> = {}, url = "http://127.0.0.1:7317/api/herdr/update") => new Request(url, { method: "POST", headers });
  const own = { "x-herdr-update": "1", origin: "http://127.0.0.1:7317", "sec-fetch-site": "same-origin" };

  it("answers the status without caching, and offers nothing without an updater", async () => {
    const response = await handleHerdrUpdateRequest(new Request("http://127.0.0.1:7317/api/herdr/update"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ supported: false, phase: "idle" });
    expect((await handleHerdrUpdateRequest(post(own))).status).toBe(409);
  });

  it("starts an update only for this app's own controls", async () => {
    const herdr = standIn("already up to date (0.9.3)", 0, { sleep: 1 });
    const updater = new HerdrUpdater({ bin: herdr.path });
    // an HTML form cannot send the header; another site's page is cross-site
    for (const headers of [{}, { ...own, "x-herdr-update": "0" }, { ...own, origin: "https://evil.example" }, { ...own, "sec-fetch-site": "cross-site" }]) {
      const refused = await handleHerdrUpdateRequest(post(headers), updater);
      expect(refused.status).toBe(403);
      expect((await refused.json() as { error: { code: string } }).error.code).toBe("invalid_update_request");
    }
    expect((await handleHerdrUpdateRequest(post(own, "http://127.0.0.1:7317/api/herdr/update?x=1"), updater)).status).toBe(403);
    expect(herdr.calls().filter((call) => call === "update --handoff")).toEqual([]);

    const accepted = await handleHerdrUpdateRequest(post(own), updater);
    expect(accepted.status).toBe(202);
    const busy = await handleHerdrUpdateRequest(post(own), updater);
    expect(busy.status).toBe(409);
    expect((await busy.json() as { error: { code: string } }).error.code).toBe("herdr_update_busy");
    await finished(updater);
    expect((await handleHerdrUpdateRequest(new Request("http://127.0.0.1:7317/api/herdr/update", { method: "DELETE" }), updater)).status).toBe(405);
  });
});

describe("herdr's own words", () => {
  it("reads the versions from `herdr status --json`", () => {
    const real = '{"client":{"version":"0.9.3","channel":"stable","binary":"/home/u/.local/bin/herdr"},"server":{"status":"running","running":true,"version":"0.9.0","capabilities":{"live_handoff":true}},"update":{"restart_needed":false,"server_binary_stale":true}}'; // leakscan:allow: test fixture
    expect(parseHerdrStatus(real)).toEqual({ server: "0.9.0", binary: "0.9.3", binaryPath: "/home/u/.local/bin/herdr", stale: true, handoff: true }); // leakscan:allow: test fixture
    expect(parseHerdrStatus('{"client":{"version":"0.9.3"},"server":{"running":false,"version":null}}')).toMatchObject({ server: null, stale: false, handoff: false });
    expect(parseHerdrStatus("herdr: unknown command")).toBeNull();
    expect(parseHerdrStatus("null")).toBeNull();
  });

  it("drops what herdr prints for a terminal", () => {
    expect(plainOutput("\u001b[1mchecking\u001b[0m stable channel...\r\n\r\n\r\n\r\ndownloading 0.9.4...   \r\n")).toBe("checking stable channel...\n\ndownloading 0.9.4...");
  });
});
