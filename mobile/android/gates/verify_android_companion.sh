#!/usr/bin/env bash
set -euo pipefail
companion_root="$(cd "$(dirname "$0")/.." && pwd)"
repo_root="$(cd "$companion_root/../.." && pwd)"
python3 "$companion_root/build.py" :app:assembleDebug :app:lintDebug
(cd "$repo_root" && bun test tools/mobile-relay server/mobile-relay server/mobile-relay-auth.contract.test.ts)
test -s "$companion_root/app/build/outputs/apk/debug/app-debug.apk"
printf '%s\n' 'PASS: APK build, Android lint, relay security tests. LTE device execution remains unverified.'
