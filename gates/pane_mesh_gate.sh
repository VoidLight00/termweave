#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [ "${HERDR_TEST_LIVE:-0}" = 1 ]; then
  printf 'FAIL[isolation] live tests forbidden\n' >&2
  exit 1
fi
run_gate() {
  local name="$1"; shift
  if "$@"; then
    printf 'PASS[%s] exit=0\n' "$name"
  else
    local rc=$?
    printf 'FAIL[%s] exit=%s\n' "$name" "$rc" >&2
    exit "$rc"
  fi
}
# Component verification does not imply deployment readiness. Never run native tests
# against a caller's HOME/socket; the canonical verifier provisions its own HOME/XDG.
case "${1:---local}" in
  --local)
    exec bun scripts/verify-isolated.ts ledger ledger-tests type build unit integration pane-mesh workspace-status render
    ;;
  --deployment)
    printf 'BLOCKED[pane-mesh-production-workflow] real agent semantics and production integration remain unverified\n' >&2
    exit 1
    ;;
  --components)
    if [ -z "${TERMWEAVE_TEST_ROOT:-}" ]; then
      printf 'FAIL[isolation] component tests require an isolated root\n' >&2
      exit 1
    fi
    # Validate caller isolation before any native/component action (unit preload alone does not).
    run_gate isolation bun -e 'import { isolateTestEnvironment } from "./scripts/test-isolation.ts"; isolateTestEnvironment();'
    ;;
  *) printf 'Usage: pane_mesh_gate.sh [--local|--components|--deployment]\n' >&2; exit 2 ;;
esac
run_gate type bun run typecheck
run_gate status bun test ./src/lib/status.test.ts ./src/lib/snapshot.test.ts ./src/lib/needsInput.test.ts ./src/lib/i18n.test.ts ./scripts/ui-literals.test.ts
run_gate tmux bun test ./server/tmux/client.test.ts ./scripts/tmux-mesh-isolation.test.ts
run_gate ownership bun test ./server/pane-mesh-ownership.test.ts ./scripts/pane-mesh-task.test.ts
run_gate directory bun test ./server/pane-directory.test.ts ./scripts/terminal-mesh.test.ts ./scripts/terminal-mesh.native.test.ts
run_gate native-agent-transport bun test ./scripts/terminal-mesh-agent.native.test.ts
run_gate workspace-status-browser bun scripts/workspace-status-regression.ts
run_gate whitespace git diff --check
printf 'PASS[pane-mesh-component-tests] exit=0\n'
printf 'NOT_RUN[pane-mesh-production-workflow] use --deployment for the separate readiness gate\n'
exit 0
