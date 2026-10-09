/** Every test belongs to one suite; newly added unit tests are picked up automatically. */
const suite = process.argv[2];
if (suite !== "unit" && suite !== "integration") throw new Error("Usage: bun scripts/ci-tests.ts unit|integration");
const files = [...new Bun.Glob("{src,shared,server,scripts}/**/*.test.ts").scanSync({ cwd: process.cwd() })].sort();
// The legacy updater suite mixes Git-only cases with real bridge restart/rollback cases.
const needsHerdr = (file: string) => file.endsWith(".contract.test.ts") || file === "server/updater.test.ts" || file.startsWith("server/herdr/") || file.startsWith("server/pty/");
const selected = files.filter((file) => needsHerdr(file) === (suite === "integration"));
if (!selected.length) throw new Error(`No ${suite} tests found`);
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
