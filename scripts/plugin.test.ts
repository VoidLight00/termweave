import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The plugin's settings files, read by hand the way a headless PC runs `status` or `pair`:
 * no HERDR_PLUGIN_CONFIG_DIR, so the script asks herdr (a fake one here) for the config dir.
 */

const ROOT = join(import.meta.dir, "..");
let scratch: string;
let configDir: string;

async function status(): Promise<{ out: string; err: string; exitCode: number }> {
  return run("status");
}

async function run(command: string): Promise<{ out: string; err: string; exitCode: number }> {
  const bin = join(scratch, "bin");
  const env: Record<string, string | undefined> = { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, HOME: scratch, HERDR_PLUGIN_STATE_DIR: join(scratch, "state") };
  for (const key of ["HERDR_PLUGIN_CONFIG_DIR", "PORT", "HOST", "HERDR_WEB_TOKEN"]) delete env[key];
  const child = Bun.spawn(["bun", "scripts/plugin.ts", command], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
  const [out, err, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { out, err, exitCode };
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "herdr-plugin-env-"));
  configDir = join(scratch, "config");
  mkdirSync(configDir);
  mkdirSync(join(scratch, "bin"));
  const herdr = join(scratch, "bin", "herdr");
  writeFileSync(herdr, `#!/bin/sh\n[ "$1 $2" = "plugin config-dir" ] && echo "${configDir}"\n`);
  chmodSync(herdr, 0o755);
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe("plugin settings files", () => {
  it("finds the config dir through herdr and reads .env", async () => {
    writeFileSync(join(configDir, ".env"), "PORT=1\n");
    const run = await status();
    expect(run.exitCode, run.err).toBe(0);
    expect(run.out).toContain("down http://127.0.0.1:1");
    expect(run.out).toContain(`config: ${join(configDir, ".env")}`);
  });

  it("still reads env, from older installs", async () => {
    writeFileSync(join(configDir, "env"), "PORT=2\n");
    const run = await status();
    expect(run.out).toContain("down http://127.0.0.1:2");
    expect(run.out).toContain(`config: ${join(configDir, "env")}`);
  });

  it("lets .env win over env and names the keys they disagree on, not their values", async () => {
    writeFileSync(join(configDir, "env"), "PORT=2\nHERDR_WEB_TOKEN=old-secret\nHOST=127.0.0.1\n");
    writeFileSync(join(configDir, ".env"), "PORT=1\nHERDR_WEB_TOKEN=new-secret\nHOST=127.0.0.1\n");
    const run = await status();
    expect(run.out).toContain("down http://127.0.0.1:1");
    expect(run.out).toContain(`config: ${join(configDir, "env")}, ${join(configDir, ".env")}`);
    expect(run.out).toContain("set PORT, HERDR_WEB_TOKEN; .env wins");
    expect(run.out).not.toContain("secret");
  });

  it("says where settings go when there are none", async () => {
    const run = await status();
    expect(run.out).toContain(`config: none (settings go in ${join(scratch, ".config", "termweave", "env")})`);
  });
});

describe("stop", () => {
  it("returns only once the server's process group is gone", async () => {
    // a server that takes a second to exit, as the supervisor does while its bridge shuts down
    const server = spawn("sh", ["-c", "trap 'sleep 1; exit 0' TERM; while :; do sleep 0.1; done"], { detached: true, stdio: "ignore" });
    const pid = server.pid!;
    mkdirSync(join(scratch, "state"));
    writeFileSync(join(scratch, "state", "server.pid"), `${pid}\n`);
    const started = Date.now();
    const stopped = await run("stop");
    expect(stopped.exitCode, stopped.err).toBe(0);
    expect(stopped.out).toContain(`stopped TermWeave (pid ${pid})`);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(() => process.kill(-pid, 0)).toThrow();
    expect(existsSync(join(scratch, "state", "server.pid"))).toBe(false);
  });

  // a server that exited while its parent (a plugin host, say) has not reaped it yet
  it.skipIf(platform() !== "linux" || !Bun.which("setsid"))("counts an exited, unreaped server as gone", async () => {
    // the inner shell leads its own group; its parent turns into a sleep that never reaps it
    const parent = spawn("sh", ["-c", `setsid sh -c 'echo $$; exec sleep 0.2' & exec sleep 30`], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      const pid = Number(await new Promise<string>((resolve) => parent.stdout!.once("data", (chunk) => resolve(String(chunk).trim()))));
      const state = () => readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[0];
      const deadline = Date.now() + 5_000;
      while (state() !== "Z" && Date.now() < deadline) await Bun.sleep(20);
      expect(state()).toBe("Z");
      // what `stop` waited on: the zombie's group still answers signal 0
      expect(() => process.kill(-pid, 0)).not.toThrow();
      mkdirSync(join(scratch, "state"));
      writeFileSync(join(scratch, "state", "server.pid"), `${pid}\n`);
      const started = Date.now();
      const stopped = await run("stop");
      expect(stopped.exitCode, stopped.err).toBe(0);
      expect(stopped.out).toContain(`stopped TermWeave (pid ${pid})`);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(existsSync(join(scratch, "state", "server.pid"))).toBe(false);
    } finally { parent.kill("SIGKILL"); }
  }, 30_000);
});
