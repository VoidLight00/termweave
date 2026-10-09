import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

/** Identity of the actual emitted frontend, including dirty/uncommitted sources. */
export function frontendBuildIdentity(): Plugin {
  return {
    name: "frontend-build-identity", enforce: "post",
    generateBundle(_options, bundle) {
      const hash = createHash("sha256");
      for (const name of Object.keys(bundle).sort()) {
        const output = bundle[name]!;
        hash.update(name).update("\0");
        hash.update(output.type === "chunk" ? output.code : output.source);
      }
      hash.update(readFileSync("public/sw.js"));
      const id = hash.digest("hex");
      const index = bundle["index.html"];
      if (!index || index.type !== "asset" || typeof index.source !== "string") throw new Error("Built HTML missing");
      index.source = index.source.replace("</head>", `<meta name="frontend-build-id" content="${id}" /></head>`);
    },
  };
}
