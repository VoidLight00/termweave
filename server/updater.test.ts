import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Updater, runCommand, type Release } from "./updater.ts";
import { HERDR_SOCKET_PATH } from "../shared/protocol.ts";

let directory: string, upstream: string, root: string, stateDir: string;
let updater: Updater;
const git = (cwd: string, ...args: string[]) => runCommand(cwd, ["git", ...args]);
async function commit(contents: string, failBuild = false) {
  writeFileSync(join(upstream, "build-fixture.ts"), failBuild ? "throw new Error('fixture build failure');" :
    `await Bun.write('dist/index.html', ${JSON.stringify(contents)});`);
  await git(upstream, "add", ".");
  await git(upstream, "commit", "-qm", contents);
  return git(upstream, "rev-parse", "HEAD");
}
/** Commit and publish it as a release tag; only tags make an update available. */
async function release(contents: string, tag: string, options: { failBuild?: boolean; annotated?: boolean } = {}) {
  const revision = await commit(contents, options.failBuild);
  await git(upstream, "tag", ...(options.annotated ? ["-a", "-m", tag] : []), tag);
  return revision;
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "herdr-updater-"));
  upstream = join(directory, "upstream"); root = join(directory, "checkout"); stateDir = join(directory, "state");
  mkdirSync(upstream);
  await git(upstream, "init", "-q", "-b", "main");
  await git(upstream, "config", "user.email", "test@example.invalid");
  await git(upstream, "config", "user.name", "Updater test");
  writeFileSync(join(upstream, "package.json"), JSON.stringify({ name: "updater-fixture", scripts: {
    typecheck: "bun --eval 'process.exit(0)'", build: "bun build-fixture.ts",
  } }));
  writeFileSync(join(upstream, ".gitignore"), "node_modules/\ndist/\n");
  await runCommand(upstream, [process.execPath, "install"]);
  await commit("first");
  await git(directory, "clone", "-q", upstream, root);
  updater = new Updater({ root, stateDir, autoUpdate: false, publish() {}, activate: async (_next, persist) => persist() });
  await updater.initialize();
});

afterEach(() => {
  updater?.stop();
  rmSync(directory, { recursive: true, force: true });
});

/** A real launcher + supervisor + bridge on a free port, serving the fixture checkout. */
async function managedFixture(supervisor?: string) {
  updater.stop();
  mkdirSync(join(upstream, "server"), { recursive: true });
  const entry = `
    import { createServer } from ${JSON.stringify(join(import.meta.dir, "index.ts"))};
    import { connectUpdater } from ${JSON.stringify(join(import.meta.dir, "update-api.ts"))};
    const server = createServer({ updates: connectUpdater() });
    process.on('SIGTERM', () => { server.stop(); setTimeout(() => process.exit(0), 50); });
    process.on('disconnect', () => { server.stop(); process.exit(0); });
  `;
  writeFileSync(join(upstream, "server/index.ts"), entry);
  if (supervisor !== undefined) writeFileSync(join(upstream, "server/supervisor.ts"), supervisor);
  await commit("managed initial");
  await git(root, "pull", "--ff-only", "--quiet");
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = reservation.port!; reservation.stop(true);
  const origin = `http://127.0.0.1:${port}`;
  const headers = { authorization: "Bearer test-managed-token", "x-herdr-update": "1" };
  const launch = () => Bun.spawn([process.execPath, "--eval",
    `import {runManaged} from ${JSON.stringify(join(import.meta.dir, "managed.ts"))}; await runManaged(${JSON.stringify(root)});`], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", HERDR_WEB_STATE_DIR: stateDir,
      HERDR_WEB_TOKEN: "test-managed-token", HERDR_WEB_AUTO_UPDATE: "0", SUPERVISOR_MARKER: join(directory, "marker") },
    stdout: "ignore", stderr: "ignore",
  });
  const readStatus = async () => {
    try { return await (await fetch(`${origin}/api/updates`, { headers })).json() as typeof updater.status; }
    catch { return null; }
  };
  const until = async (check: () => Promise<boolean>) => {
    const deadline = Date.now() + 12_000;
    while (!await check()) {
      if (Date.now() > deadline) throw new Error(`Managed update timeout: ${JSON.stringify(await readStatus())}`);
      await Bun.sleep(50);
    }
  };
  const request = async (command: string) => {
    const response = await fetch(`${origin}/api/updates/${command}`, { method: "POST", headers });
    expect(response.status).toBe(202);
  };
  const health = async () => (await (await fetch(`${origin}/api/health`)).json()) as { web_ui: { revision: string; boot_id: string } };
  return { launch, readStatus, until, request, health, origin };
}
/** A release's own supervisor: records that it ran, then runs the real one (or fails on purpose). */
const releaseSupervisor = (broken = false) => broken ? "process.exit(3);\n" : `
  import { appendFileSync } from "node:fs";
  appendFileSync(process.env.SUPERVISOR_MARKER, "release\\n");
  const { runSupervisor } = await import(${JSON.stringify(join(import.meta.dir, "supervisor.ts"))});
  await runSupervisor(process.env.HERDR_WEB_SOURCE_ROOT);
`;
const liveHerdr = existsSync(process.env["HERDR_SOCKET"] || HERDR_SOCKET_PATH);

describe("managed source updates with real Git repositories and builds", () => {
  it("checks without installing, then builds an exact revision without changing the source", async () => {
    const original = await git(root, "rev-parse", "HEAD");
    const target = await release("second", "v0.2.0");
    await updater.request("check");
    expect(updater.status.available).toBe(true);
    expect(updater.status.current_revision).toBe(original);
    expect(readdirSync(stateDir).filter(name => name.startsWith("release-"))).toHaveLength(0);
    await updater.request("install");
    expect(updater.status.error).toBeNull();
    expect(updater.status.current_revision).toBe(target);
    expect(readFileSync(join(updater.release!.directory, "dist/index.html"), "utf8")).toBe("second");
    expect(await git(root, "rev-parse", "HEAD")).toBe(original);
    expect(await git(root, "status", "--porcelain")).toBe("");
    const resumed = new Updater(updater.options);
    expect((await resumed.initialize())?.revision).toBe(target);
    resumed.stop();
  });

  it("refuses local changes, detached branches, and an ahead/diverged history", async () => {
    await commit("second");
    writeFileSync(join(root, "user-draft.txt"), "preserve");
    await updater.request("install");
    expect(updater.status.blocked_reason).toContain("local changes");
    expect(readFileSync(join(root, "user-draft.txt"), "utf8")).toBe("preserve");
    rmSync(join(root, "user-draft.txt"));
    await git(root, "checkout", "--detach", "--quiet");
    await updater.request("install");
    expect(updater.status.blocked_reason).toContain("main");
    await git(root, "checkout", "main", "--quiet");
    await git(upstream, "checkout", "--orphan", "replacement", "--quiet");
    await release("unrelated", "v9.0.0");
    await git(upstream, "branch", "-M", "main");
    await updater.request("install");
    expect(updater.status.available).toBe(false);
    expect(updater.status.blocked_reason).toContain("release history");
  });

  it("updates a herdr-managed plugin checkout: shallow, detached, owned by herdr", async () => {
    // What `herdr plugin install` leaves behind: a depth-1 fetch checked out as FETCH_HEAD.
    const plugin = join(directory, "plugin");
    mkdirSync(plugin);
    await git(plugin, "init", "-q");
    await git(plugin, "remote", "add", "origin", `file://${upstream}`);
    await git(plugin, "fetch", "-q", "--depth", "1", "origin", "main");
    await git(plugin, "checkout", "-q", "FETCH_HEAD");
    const original = await git(plugin, "rev-parse", "HEAD");
    const pluginState = join(directory, "plugin-state");
    const make = (pluginCheckout: boolean) => new Updater({ root: plugin, stateDir: pluginState, autoUpdate: false, pluginCheckout,
      publish() {}, activate: async (_next, persist) => persist() });

    const outside = make(false);
    await outside.initialize();
    expect(outside.status.blocked_reason).toContain("main");
    outside.stop();

    const managed = make(true);
    await managed.initialize();
    expect(managed.status.blocked_reason).toBeNull();
    const target = await release("second", "v0.2.0");
    await managed.request("install");
    expect(managed.status.error).toBeNull();
    expect(managed.status.current_revision).toBe(target);
    expect(readFileSync(join(managed.release!.directory, "dist/index.html"), "utf8")).toBe("second");
    expect(await git(plugin, "rev-parse", "HEAD")).toBe(original);
    expect(await git(plugin, "status", "--porcelain")).toBe("");
    managed.stop();
  });

  it("follows only plain vX.Y.Z tags: untagged commits, bundle tags and pre-releases stay put", async () => {
    await commit("untagged work on main");
    await git(upstream, "tag", "remote-v9");
    await git(upstream, "tag", "v1.0.0-rc1");
    await updater.request("check");
    expect(updater.status.error).toBeNull();
    expect(updater.status.available).toBe(false);
    expect(updater.status.latest_version).toBeNull();

    const target = await release("released", "v0.10.0", { annotated: true });
    await release("older", "v0.9.0");
    await git(upstream, "reset", "-q", "--hard", target);
    await updater.request("check");
    expect(updater.status.latest_version).toBe("0.10.0");
    // the annotated tag peels to the commit that builds and health checks report
    expect(updater.status.latest_revision).toBe(target);
    expect(updater.status.available).toBe(true);
    await updater.request("install");
    expect(updater.status.error).toBeNull();
    expect(updater.status.current_revision).toBe(target);
  });

  it("treats a shallow plugin checkout ahead of the latest release as up to date", async () => {
    await git(upstream, "tag", "v0.1.0", "HEAD");
    await commit("unreleased");
    const plugin = join(directory, "plugin");
    mkdirSync(plugin);
    await git(plugin, "init", "-q");
    await git(plugin, "remote", "add", "origin", `file://${upstream}`);
    await git(plugin, "fetch", "-q", "--depth", "1", "origin", "main");
    await git(plugin, "checkout", "-q", "FETCH_HEAD");
    const managed = new Updater({ root: plugin, stateDir: join(directory, "plugin-state"), autoUpdate: false, pluginCheckout: true,
      publish() {}, activate: async (_next, persist) => persist() });
    await managed.initialize();
    await managed.request("check");
    expect(managed.status.error).toBeNull();
    expect(managed.status.blocked_reason).toBeNull();
    expect(managed.status.latest_version).toBe("0.1.0");
    expect(managed.status.available).toBe(false);
    await release("third", "v0.2.0");
    await managed.request("check");
    expect(managed.status.available).toBe(true);
    managed.stop();
  });

  it("leaves the current release intact on build failure and cleans the failed stage", async () => {
    const original = updater.release;
    await release("broken build", "v0.2.0", { failBuild: true });
    await updater.request("install");
    expect(updater.status.phase).toBe("error");
    expect(updater.status.error).toContain("fixture build failure");
    expect(updater.release).toBe(original);
    expect(readdirSync(stateDir).filter(name => name.startsWith("release-"))).toHaveLength(0);
  });

  it("does not persist a candidate that failed startup", async () => {
    updater.options.activate = async () => { throw new Error("health check failed; previous restored"); };
    const original = updater.release;
    await release("bad startup", "v0.2.0");
    await updater.request("install");
    expect(updater.release).toBe(original);
    expect(updater.status.error).toContain("health check failed");
    expect(readdirSync(stateDir)).not.toContain("current.json");
  });

  it("automatically installs when enabled and coalesces overlapping requests", async () => {
    let activations = 0;
    updater.options.autoUpdate = true;
    updater.options.activate = async (_release: Release, persist) => { activations++; persist(); };
    const target = await release("automatic", "v0.2.0");
    await Promise.all([updater.request("check"), updater.request("install"), updater.request("check")]);
    expect(activations).toBe(1);
    expect(updater.status.current_revision).toBe(target);
  });

  it("cancels an update command with a deadline", async () => {
    const start = Date.now();
    await expect(runCommand(root, [process.execPath, "--eval", "setInterval(() => {}, 1000)"], undefined, 100)).rejects.toThrow("timed out");
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("does not repeatedly restart into the same failed automatic update, including after restart", async () => {
    updater.options.autoUpdate = true;
    let attempts = 0;
    updater.options.activate = async () => { attempts++; throw new Error("startup failed"); };
    await release("bad automatic startup", "v0.2.0");
    await updater.request("check");
    await updater.request("check");
    expect(attempts).toBe(1);
    expect(updater.status.error).toContain("previously failed");
    const resumed = new Updater(updater.options);
    await resumed.initialize();
    await resumed.request("check");
    expect(attempts).toBe(1);
    await resumed.request("install");
    expect(attempts).toBe(2);
    resumed.stop();
  });

  // the supervisor's health check pings herdr, so this one needs a live herdr (CI has none)
  it.skipIf(!liveHerdr)("restarts the real bridge over IPC, rolls back a failed boot, and resumes the saved release", async () => {
    const { launch, readStatus, until, request, health } = await managedFixture();
    let processHandle = launch();
    try {
      await until(async () => (await readStatus())?.managed === true);
      const target = await release("managed second", "v0.2.0");
      await request("check");
      await until(async () => (await readStatus())?.available === true);
      await request("install");
      await until(async () => { const s = await readStatus(); return s?.current_revision === target && s.phase === "idle"; });
      expect((await readStatus())?.error).toBeNull();
      expect((await health()).web_ui.revision).toBe(target);

      writeFileSync(join(upstream, "server/index.ts"), "throw new Error('fixture startup failure');");
      await release("broken startup", "v0.3.0");
      await request("check");
      await until(async () => (await readStatus())?.available === true);
      await request("install");
      await until(async () => (await readStatus())?.phase === "error");
      expect((await readStatus())?.current_revision).toBe(target);
      expect((await readStatus())?.error).toContain("Previous version restored");

      processHandle.kill("SIGTERM"); await processHandle.exited;
      processHandle = launch();
      await until(async () => (await readStatus())?.current_revision === target);
      expect((await readStatus())?.phase).toBe("idle");
    } finally {
      processHandle.kill("SIGTERM");
      await processHandle.exited;
    }
  }, 30_000);

  it.skipIf(!liveHerdr)("hands over to the installed release's own supervisor", async () => {
    const { launch, readStatus, until, request, health } = await managedFixture(releaseSupervisor());
    const marker = join(directory, "marker");
    const handle = launch();
    try {
      await until(async () => (await readStatus())?.managed === true);
      // the source checkout's supervisor starts first: nothing is installed yet
      expect(existsSync(marker)).toBe(false);
      const target = await release("handover", "v0.2.0");
      await request("check");
      await until(async () => (await readStatus())?.available === true);
      await request("install");
      await until(async () => { const s = await readStatus(); return existsSync(marker) && s?.current_revision === target && s.phase === "idle"; });
      expect(readFileSync(marker, "utf8")).toBe("release\n");
      expect((await health()).web_ui.revision).toBe(target);
      expect((await readStatus())?.error).toBeNull();
    } finally {
      handle.kill("SIGTERM");
      expect(await handle.exited).toBe(0);
    }
  }, 30_000);

  it.skipIf(!liveHerdr)("falls back to the previous supervisor when the new one cannot start", async () => {
    const { launch, readStatus, until, request, health } = await managedFixture();
    const handle = launch();
    try {
      await until(async () => (await readStatus())?.managed === true);
      writeFileSync(join(upstream, "server/supervisor.ts"), releaseSupervisor(true));
      const target = await release("broken supervisor", "v0.2.0");
      await request("check");
      await until(async () => (await readStatus())?.available === true);
      await request("install");
      await until(async () => (await readStatus())?.error?.includes("previous one") === true);
      // the bridge that passed its health check keeps serving under the old supervisor
      expect((await readStatus())?.current_revision).toBe(target);
      expect((await health()).web_ui.revision).toBe(target);
      expect(handle.exitCode).toBeNull();
    } finally {
      handle.kill("SIGTERM");
      await handle.exited;
    }
  }, 30_000);
});
