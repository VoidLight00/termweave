#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# Preset splits are retired; current dock lane verifies native split identities.
exec bun scripts/verify-isolated.ts type build unit integration dock render source-style
