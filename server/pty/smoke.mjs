// Runs in bundled Node, including on the destination before runtime activation.
// Loading the addon alone misses macOS spawn-helper permission/architecture errors.
import pty from "@lydell/node-pty";

const timer = setTimeout(() => { console.error("Bundled PTY smoke test timed out"); process.exit(1); }, 10_000);
try {
  const child = pty.spawn("/bin/sh", ["-c", "printf herdr-bundle-pty-ok"], { cols: 80, rows: 24 });
  let output = "";
  child.onData((text) => { output += text; });
  child.onExit(({ exitCode }) => {
    clearTimeout(timer);
    if (exitCode !== 0 || !output.includes("herdr-bundle-pty-ok")) {
      console.error("Bundled PTY smoke test failed"); process.exit(1);
    }
    process.exit(0);
  });
} catch (error) {
  clearTimeout(timer);
  console.error("Bundled PTY could not start:", error.message);
  process.exit(1);
}
