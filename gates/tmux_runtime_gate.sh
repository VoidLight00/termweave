#!/bin/bash
# Every live operation in these tests uses a private temporary tmux socket.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [ "${HERDR_TEST_LIVE:-0}" = 1 ]; then
  printf 'FAIL[tmux-isolation] live tests forbidden\n' >&2
  exit 1
fi
bun test ./server/tmux/client.test.ts ./server/tmux/runtime.test.ts ./server/tmux/metadata.test.ts ./server/tmux/metadata-process.test.ts ./server/tmux/ports.test.ts ./scripts/tmux-mesh-isolation.test.ts
bun scripts/tmux-workspace-regression.ts
printf 'PASS[tmux-runtime] exit=0; full cmux parity is not asserted\n'
