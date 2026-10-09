import { describe, expect, it } from "bun:test";
import { codeIsFilePath, splitFilePaths } from "./filePaths.ts";

const paths = (text: string) => splitFilePaths(text).filter((part) => typeof part !== "string").map((part) => (part as { path: string }).path);

describe("file paths in chat text", () => {
  it("finds paths with a folder and an extension, absolute, ~ or relative", () => {
    expect(paths("Saved to docs/screenshots/demo-mobile.mp4 and ~/out/shot.png, see /tmp/run.log.")).toEqual([
      "docs/screenshots/demo-mobile.mp4", "~/out/shot.png", "/tmp/run.log",
    ]);
    expect(paths("./scripts/capture.ts 에서 확인")).toEqual(["./scripts/capture.ts"]);
    // the text around a path is kept, whole
    expect(splitFilePaths("open src/a.ts now")).toEqual(["open ", { path: "src/a.ts" }, " now"]);
  });

  it("leaves words, versions and bare names as text", () => {
    expect(paths("and/or, e.g. v1.2.3, 1.0/2.5, README.md, TCP/IP")).toEqual([]);
  });

  it("takes a code span that is one file name or path", () => {
    for (const code of ["README.md", "src/app.ts", "~/x/y.png", "/tmp/a.log", "docs/demo.mp4"]) expect(codeIsFilePath(code)).toBe(true);
    for (const code of ["bun test", "1.2.3", "git log --oneline", "a/b", "foo()", "x.y()", "tool.monitor", "Math.random", "process.env", "os.path", "process.env.HOME", "console.log", "JSON.parse"]) expect(codeIsFilePath(code)).toBe(false);
    // a file of any language still opens: what is refused above is known code, not an unknown extension
    for (const code of ["main.c", "util.h", "App.vue", "go.mod", "Cargo.lock", "nginx.conf", "config.env", "src/process.env", "os.py", "std.rs", "tool.ts", "fmt.go", "app.dev", "tool.vue", "std.lock", "os.conf", "Math.js", "process.yml", "README.org", "notes.io", "example.com"]) expect(codeIsFilePath(code)).toBe(true);
  });
});
