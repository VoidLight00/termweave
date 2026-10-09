#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# The shared verifier owns HOME/XDG/socket/staging and required cleanup.
exec bun scripts/verify-isolated.ts ledger type build unit integration dock title-drag move preview spatial workspace render source-style
