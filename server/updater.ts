/** Build in a private checkout. The source tree and the serving build stay intact. */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { unmanagedUpdateStatus, type UpdateCommand, type UpdateStatus } from "../shared/update.ts";

export interface Release { directory: string; revision: string; source_revision: string }
const SHA = /^[0-9a-f]{40,64}$/;
/** A release is a plain `vX.Y.Z` tag: `remote-v*` bundle tags and pre-releases never qualify. */
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

function packageVersion(directory: string): string | null {
  try {
    const version = (JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { version?: unknown }).version;
    return typeof version === "string" ? version : null;
  } catch { return null; }
}

/** Commands use argv, bounded output/time, and a separate group for cancellation. */
export function runCommand(cwd: string, argv: string[], signal?: AbortSignal, timeout = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd, detached: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    });
    let output = "", errors = "", failure: string | null = null;
    const cancel = (reason: string) => {
      failure = reason;
      if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
    };
    const abort = () => cancel("Update cancelled");
    const timer = setTimeout(() => cancel(`${argv[0]} timed out`), timeout);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", data => { output += data; if (output.length > 2_000_000) cancel("Command output too large"); });
    child.stderr.on("data", data => { errors = (errors + data).slice(-8000); });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    child.on("error", error => { cleanup(); reject(error); });
    child.on("close", code => {
      cleanup();
      if (code === 0 && !failure) resolve(output.trim());
      else reject(new Error(failure ?? `${argv.slice(0, 3).join(" ")} failed: ${errors.trim() || code}`));
    });
  });
}

export class Updater {
  readonly controller = new AbortController();
  status: UpdateStatus = { ...unmanagedUpdateStatus(), managed: true, blocked_reason: null };
  release: Release | null = null;
  private busy = false;
  private timer?: ReturnType<typeof setInterval>;
  private initialTimer?: ReturnType<typeof setTimeout>;
  private sourceRevision = "";
  private failedRevision: string | null = null;

  constructor(readonly options: {
    root: string; stateDir: string; autoUpdate: boolean;
    /** herdr's `plugin install` checks out a shallow, detached commit it owns; that HEAD is
     * accepted when it is an ancestor of origin/main (a user's own detached checkout is not). */
    pluginCheckout?: boolean;
    /** Runs once a release is installed and active; the supervisor hands itself over here. */
    afterInstall?: (release: Release) => void | Promise<void>;
    /** A standing problem to report in every status (a supervisor that fell back to its predecessor). */
    notice?: string;
    activate: (release: Release, commit: () => void) => Promise<void>;
    publish: (status: UpdateStatus) => void;
  }) { this.status.auto_update = options.autoUpdate; this.status.error = options.notice ?? null; }

  private git(...args: string[]) { return runCommand(this.options.root, ["git", ...args], this.controller.signal); }
  private patch(patch: Partial<UpdateStatus>) {
    this.status = { ...this.status, ...patch };
    this.options.publish(this.status);
  }

  async initialize(): Promise<Release | null> {
    mkdirSync(this.options.stateDir, { recursive: true, mode: 0o700 });
    try {
      const failed = JSON.parse(readFileSync(join(this.options.stateDir, "failed.json"), "utf8")) as { revision?: string };
      if (failed.revision && SHA.test(failed.revision)) this.failedRevision = failed.revision;
    } catch { /* no failed automatic candidate */ }
    try {
      this.sourceRevision = await this.git("rev-parse", "HEAD");
      if (!SHA.test(this.sourceRevision)) throw new Error("Invalid source revision");
      this.release = { directory: this.options.root, revision: this.sourceRevision, source_revision: this.sourceRevision };
      const reason = await this.sourceBlock();
      if (!reason) {
        try {
          const saved = JSON.parse(readFileSync(join(this.options.stateDir, "current.json"), "utf8")) as Release;
          // Only directories created by this updater may be resumed.
          if (saved.source_revision === this.sourceRevision && SHA.test(saved.revision) &&
              saved.directory.startsWith(join(this.options.stateDir, "release-")) &&
              await runCommand(saved.directory, ["git", "rev-parse", "HEAD"]) === saved.revision) this.release = saved;
        } catch { /* missing/stale release: use the source checkout */ }
      }
      this.patch({ current_revision: this.release.revision, current_version: packageVersion(this.release.directory), blocked_reason: reason });
    } catch {
      this.patch({ managed: false, blocked_reason: "Updates require a Git checkout on the main branch." });
    }
    return this.release;
  }

  private async sourceBlock(): Promise<string | null> {
    const branch = await this.git("branch", "--show-current");
    if (branch !== "main" && !(branch === "" && this.options.pluginCheckout)) return "Switch the source checkout to main to update.";
    if (await this.git("status", "--porcelain", "--untracked-files=all")) return "The source checkout has local changes. Commit or move them before updating.";
    if (await this.git("rev-parse", "HEAD") !== this.sourceRevision) return "The source checkout changed. Restart the app before updating.";
    return null;
  }

  start() {
    // TermWeave uses reviewed immutable releases; inherited source updater is disabled.
    if (!process.env.HERDR_TEST_MODE && !process.env.TERMWEAVE_TEST_ROOT) return;
    // One check per supervisor, independent of tabs. No network calls in createServer tests.
    this.initialTimer = setTimeout(() => void this.request("check"), 10_000);
    this.timer = setInterval(() => void this.request("check"), 5 * 60_000);
  }
  stop() {
    clearTimeout(this.initialTimer); clearInterval(this.timer); this.controller.abort();
  }

  private async discover() {
    this.patch({ phase: "checking", error: this.options.notice ?? null, available: false, blocked_reason: null });
    const reason = await this.sourceBlock();
    if (reason) { this.patch({ blocked_reason: reason, checked_at: new Date().toISOString() }); return; }
    // Only published releases update installs: commits pushed to main without a tag stay put.
    await this.git("fetch", "--no-tags", "origin", "+refs/tags/v*:refs/tags/v*");
    const tags = (await this.git("for-each-ref", "--sort=-v:refname", "--format=%(refname:short)", "refs/tags/v*"))
      .split("\n").filter((tag) => RELEASE_TAG.test(tag));
    const checked_at = new Date().toISOString();
    const latest = tags[0];
    if (!latest) {
      this.patch({ latest_revision: null, latest_version: null, checked_at, blocked_reason: null, available: false });
      return;
    }
    // ^{commit} peels an annotated tag to the commit the build and the health check report
    const target = await this.git("rev-parse", `${latest}^{commit}`);
    if (!SHA.test(target)) throw new Error("Invalid update revision");
    const current = this.release!.revision;
    let block: string | null = null;
    let available = false;
    if (target !== current) {
      if (await this.ancestor(current, target)) available = true;
      // running ahead of the latest release (a development checkout) is simply up to date
      else if (!await this.ancestor(target, current)) {
        block = "The running version is not part of the release history; automatic downgrade is disabled.";
      }
    }
    this.patch({ latest_revision: target, latest_version: latest.slice(1), checked_at, blocked_reason: block, available });
  }

  /** herdr's plugin checkout is shallow: fetch the missing history once before calling two commits unrelated. */
  private async ancestor(older: string, newer: string): Promise<boolean> {
    const test = () => this.git("merge-base", "--is-ancestor", older, newer).then(() => true, () => false);
    if (await test()) return true;
    if (await this.git("rev-parse", "--is-shallow-repository") !== "true") return false;
    await this.git("fetch", "--no-tags", "--unshallow", "origin");
    return test();
  }

  async request(command: UpdateCommand): Promise<void> {
    if (!process.env.HERDR_TEST_MODE && !process.env.TERMWEAVE_TEST_ROOT) { this.patch({ blocked_reason: 'TermWeave source updater is disabled. Use reviewed immutable release tooling.', available: false }); return; }
    if (this.busy || !this.status.managed || this.controller.signal.aborted) return;
    this.busy = true;
    let stage: string | null = null;
    let attempted: string | null = null;
    try {
      await this.discover();
      if ((command === "install" || this.options.autoUpdate) && this.status.available) {
        const revision = this.status.latest_revision!;
        if (command === "check" && revision === this.failedRevision) {
          this.patch({ phase: "error", error: "Automatic installation of this revision previously failed. Use Update and restart to retry, or wait for a newer revision." });
          return;
        }
        attempted = revision;
        this.patch({ phase: "building" });
        stage = mkdtempSync(join(this.options.stateDir, "release-"));
        const run = (args: string[], timeout?: number) => runCommand(stage!, args, this.controller.signal, timeout);
        await run(["git", "clone", "--quiet", "--no-checkout", "--no-hardlinks", this.options.root, "."]);
        await run(["git", "fetch", "--quiet", this.options.root, revision]);
        await run(["git", "checkout", "--quiet", "--detach", revision]);
        // The clone's origin must keep pointing at the user's chosen upstream.
        await run(["git", "remote", "set-url", "origin", await this.git("remote", "get-url", "origin")]);
        await run([process.execPath, "install", "--frozen-lockfile"], 180_000);
        await run([process.execPath, "run", "typecheck"], 120_000);
        await run([process.execPath, "run", "build"], 120_000);
        const reason = await this.sourceBlock();
        if (reason) throw new Error(reason);
        this.controller.signal.throwIfAborted();
        const next = { directory: stage, revision, source_revision: this.sourceRevision };
        this.patch({ phase: "restarting" });
        const previous = this.release;
        await this.options.activate(next, () => {
          const file = join(this.options.stateDir, "current.json");
          writeFileSync(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 });
          renameSync(`${file}.tmp`, file);
        });
        this.release = next;
        stage = null;
        this.patch({ current_revision: revision, current_version: packageVersion(next.directory), available: false });
        this.failedRevision = null;
        rmSync(join(this.options.stateDir, "failed.json"), { force: true });
        for (const entry of readdirSync(this.options.stateDir, { withFileTypes: true })) {
          const directory = join(this.options.stateDir, entry.name);
          if (entry.isDirectory() && entry.name.startsWith("release-") && directory !== next.directory && directory !== previous?.directory) {
            rmSync(directory, { recursive: true, force: true });
          }
        }
        // before "idle": a supervisor that hands over exits here, so "idle" with the new revision
        // only ever comes from the supervisor that will keep running it
        try { await this.options.afterInstall?.(next); }
        catch (error) { console.error("afterInstall failed", error); }
      }
      this.patch({ phase: "idle" });
    } catch (error) {
      if (attempted && !this.controller.signal.aborted) {
        this.failedRevision = attempted;
        try {
          writeFileSync(join(this.options.stateDir, "failed.json"), JSON.stringify({ revision: attempted }), { mode: 0o600 });
        } catch { /* the in-memory guard still prevents repeated automatic restarts */ }
      }
      this.patch({ phase: "error", error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (stage) rmSync(stage, { recursive: true, force: true });
      this.busy = false;
    }
  }
}
