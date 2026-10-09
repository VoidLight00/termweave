#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
bun test server/android/runtime.test.ts src/lib/appearance.test.ts src/lib/paletteSearch.test.ts
