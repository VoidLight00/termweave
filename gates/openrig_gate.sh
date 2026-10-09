#!/bin/bash
# Checks only the OpenRig bridge. Full product parity is a separate gate.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "${HERDR_TEST_LIVE:-}" = 1 ] || [ -n "${HERDR_SOCKET:-}" ]; then
  printf 'FAIL[openrig-isolation] inherited native socket is not allowed\n' >&2
  exit 1
fi
HERDR_TEST_MODE=unit bun test server/openrig/ server/openrig-service.test.ts
python3 -m unittest discover -s scripts -p openrig_daemon_test.py
bun test server/openrig-auth.contract.test.ts
printf 'PASS[openrig-bridge] unit and isolated authentication checks\n'
