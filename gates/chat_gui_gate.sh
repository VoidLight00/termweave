#!/usr/bin/env bash
set -euo pipefail
cd "${1:-$(cd "$(dirname "$0")/.." && pwd)}"
bun run typecheck
bun test ./src/lib/paneView.test.ts ./src/lib/composerDraft.test.ts ./src/lib/sessionLayout.test.ts ./src/lib/workspaceNavigation.test.ts ./src/lib/terminalAddress.test.ts ./src/lib/spatialFocus.test.ts
# The upstream installed-plugin filename is absent from this independent checkout.
# Verify this checkout's actual numbered-pane focus fixture instead.
bun scripts/pane-number-regression.ts
bun scripts/chat-pane-regression.ts
bun scripts/chat-transcript-regression.ts
