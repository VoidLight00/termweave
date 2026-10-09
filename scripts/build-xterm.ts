/** xterm's source uses const enums in .d.ts files; TypeScript must inline them before Vite. */
import ts from "typescript";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function buildXtermSource(root: string): string {
  const source = join(root, "node_modules/@xterm/xterm/src");
  const output = join(root, "node_modules/.cache/herdr-xterm");
  const version = JSON.parse(readFileSync(join(source, "../package.json"), "utf8")).version;
  if (version !== "5.5.0") throw new Error("Revalidate the xterm composition backport before changing xterm versions");
  mkdirSync(output, { recursive: true });
  const program = ts.createProgram(ts.sys.readDirectory(source, [".ts"], undefined, ["**/*"]), {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    rootDir: source, outDir: output, baseUrl: source,
    paths: { "browser/*": ["browser/*"], "common/*": ["common/*"] },
    experimentalDecorators: true, useDefineForClassFields: false,
    skipLibCheck: true, types: [], noEmitOnError: true,
  });
  const emitted = program.emit();
  if (emitted.emitSkipped) {
    const diagnostics = ts.getPreEmitDiagnostics(program).concat(emitted.diagnostics);
    throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (name) => name, getCurrentDirectory: () => root, getNewLine: () => "\n",
    }));
  }
  return output;
}
