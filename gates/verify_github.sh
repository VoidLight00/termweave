#!/bin/bash
# Publish gate run by the github harness before every public push (fail-closed: any failure blocks).
# Fast, herdr-free checks only; the full isolated suite stays in gates/verify_termweave.sh.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
rc=0
step() { local name=$1; shift; if "$@" >/dev/null 2>&1; then echo "PASS[$name]"; else echo "FAIL[$name]"; rc=1; fi; }
step install bun install --frozen-lockfile --ignore-scripts
step types bunx tsc --noEmit -p .
step unit bun test src/lib shared
step build bun run build
step product bun scripts/productization-gate.ts
[ "$rc" -eq 0 ] && echo "PASS[verify_github]" || echo "FAIL[verify_github]"
exit "$rc"
