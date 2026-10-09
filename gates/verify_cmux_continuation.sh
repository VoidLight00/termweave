#!/usr/bin/env bash
# Scope: workspace shortcut isolation, safe terminal links, translated dock controls.
set -eu
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$ROOT"
bun test src/lib/workspaceNavigation.test.ts src/lib/terminalAddress.test.ts src/lib/i18n.test.ts src/lib/shortcuts.test.ts src/lib/dockLayout.test.ts src/lib/sessionLayout.test.ts
bun run typecheck
bun scripts/cmux-continuation-regression.ts
bun scripts/frontend-controls-regression.ts
bun scripts/cmux-focus-regression.ts

bash gates/chat_gui_gate.sh

bun test ./src/lib/paneNumber.test.ts
bun scripts/pane-number-regression.ts
