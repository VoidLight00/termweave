import { sep } from "node:path";

/** Every test belongs to one suite; newly added unit tests are picked up automatically. `--list` prints the suite's files instead of running them. */
const suite = process.argv[2];
const list = process.argv[3] === "--list";
if ((suite !== "unit" && suite !== "integration") || process.argv.length > (list ? 4 : 3)) throw new Error("Usage: bun scripts/ci-tests.ts unit|integration [--list]");
// Bun.Glob yields native separators (scripts\x.test.ts on Windows); suites are classified on the POSIX spelling
const files = [...new Bun.Glob("{src,shared,server,scripts}/**/*.test.ts").scanSync({ cwd: process.cwd() })].map((file) => file.split(sep).join("/")).sort();
// The legacy updater suite mixes Git-only cases with real bridge restart/rollback cases.
// *.native.test.ts drive a real herdr and tmux and refuse to skip, so they never belong in the unit lane
const needsHerdr = (file: string) => file.endsWith(".contract.test.ts") || file.endsWith(".native.test.ts") || file === "server/updater.test.ts" || file.startsWith("server/herdr/") || file.startsWith("server/pty/");
const selected = files.filter((file) => needsHerdr(file) === (suite === "integration"));
if (!selected.length) throw new Error(`No ${suite} tests found`);
if (list) {
  console.log(selected.join("\n"));
  process.exit(0);
}
if (suite === "integration" && !Bun.which(process.env["HERDR_WEB_HERDR_BIN"] || "herdr")) {
  throw new Error("Integration tests require herdr on PATH (or HERDR_WEB_HERDR_BIN)");
}
if (suite === "integration" && process.env["HERDR_TEST_LIVE"] === "1") {
  throw new Error("CI integration tests must use an isolated herdr session");
}
console.log(`${suite}: ${selected.length} test files`);
// Live process/pane probes can poll for 10s; Bun's 5s default would cut them off early.
const child = Bun.spawn([process.execPath, "test", ...(suite === "integration" ? ["--timeout", "15000"] : []), ...selected.map((file) => `./${file}`)], {
  env: { ...process.env, HERDR_TEST_MODE: suite },
  windowsHide: true, stdin: "inherit", stdout: "inherit", stderr: "inherit",
});
process.exit(await child.exited);
