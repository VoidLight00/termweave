#!/bin/bash
# One entry point for implemented component verification. Publishing has a separate scope gate.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [ "${1:-}" = --deployment ]; then
  printf 'FAIL[full-parity] cmux native/browser/transport parity remains incomplete; see tracking/cmux-tmux-parity.json\n' >&2
  exit 1
fi
exec bun scripts/verify-isolated.ts test-cleanup ledger ledger-tests type build unit integration pane-mesh workspace-status render tmux sidebar-lifecycle
