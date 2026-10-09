import { frontendBuildIdentity } from './scripts/frontend-build-identity.ts';
import { developmentTarget } from './scripts/dev-target.ts';
import { buildXtermSource } from "./scripts/build-xterm.ts";
import { defineConfig, normalizePath, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const xtermSource = normalizePath(buildXtermSource(fileURLToPath(new URL(".", import.meta.url))));

let revision: string | null = process.env.HERDR_BUILD_REVISION ?? null;
if (!revision) { try { revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* non-Git build */ } }

// agentSvgMarks.ts carries LobeHub Icons paths (MIT): their notice ships with every built client
const thirdPartyNotices: Plugin = {
  name: "third-party-notices",
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "THIRD_PARTY_NOTICES.md", source: readFileSync("THIRD_PARTY_NOTICES.md", "utf8") });
  },
};

export default defineConfig({
  plugins: [react(), thirdPartyNotices, frontendBuildIdentity()],
  define: {
    __APP_REVISION__: JSON.stringify(revision),
    __APP_VERSION__: JSON.stringify((JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version),
  },
  server: {
    port: 5173,
    proxy: {
      "/api": developmentTarget(),
      "/ws": { target: developmentTarget().replace(/^http:/, 'ws:'), ws: true },
    },
  },
  build: { outDir: "dist" },
  // The Bun patch targets xterm's readable source, not its minified distribution. Build that
  // source so dev, production and the website use the same reviewed IME backport.
  resolve: { alias: [
    { find: /^@xterm\/xterm$/, replacement: `${xtermSource}/browser/public/Terminal.js` },
    { find: /^browser\//, replacement: `${xtermSource}/browser/` },
    { find: /^common\//, replacement: `${xtermSource}/common/` },
    { find: "@shared", replacement: new URL("./shared", import.meta.url).pathname },
  ] },
});
