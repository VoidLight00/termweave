import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../src/', import.meta.url));
const errors = [];
function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) visit(path);
    else if (entry.name.endsWith('.css')) {
      const text = readFileSync(path, 'utf8');
      if (/border-left\s*:\s*[^;]*(?:solid|dashed)/i.test(text) && /(?:status-stripe|vertical-stripe)/i.test(text)) errors.push(path);
    }
  }
}
visit(root);
if (errors.length) { console.error('FAIL[source-style] decorative status stripe found'); process.exitCode = 1; }
else console.log('PASS[source-style] repository-owned decorative status stripe check');
