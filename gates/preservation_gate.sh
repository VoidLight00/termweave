#!/bin/bash
# Historical P0/P1 preservation gate. Not the product master gate.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$#" -ne 1 ]; then
  printf 'FAIL[evidence] provide the restricted local evidence directory\n' >&2
  exit 2
fi
python3 "$ROOT/gates/preservation_gate.py" "$ROOT" "$1"
