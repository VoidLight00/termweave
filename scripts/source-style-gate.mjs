import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Runs under Bun (the verifier's source-style lane) and Node alike: node:fs/path/url only.
const root = fileURLToPath(new URL('../src/', import.meta.url));
const errors = [];
let scanned = 0;
function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) visit(path);
    else if (entry.name.endsWith('.css')) {
      scanned++;
      const text = readFileSync(path, 'utf8');
      if (/border-left\s*:\s*[^;]*(?:solid|dashed)/i.test(text) && /(?:status-stripe|vertical-stripe)/i.test(text)) errors.push(path);
    }
  }
}
visit(root);
// a scan that reached no stylesheet proves nothing
if (!scanned) { console.error(`FAIL[source-style] no CSS found under ${root}`); process.exitCode = 1; }
else if (errors.length) { console.error(`FAIL[source-style] decorative status stripe found: ${errors.join(', ')}`); process.exitCode = 1; }
else console.log(`PASS[source-style] repository-owned decorative status stripe check (${scanned} CSS files)`);
