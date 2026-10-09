#!/bin/zsh
# Build the companion APK and publish it to the relay: copy to a fixed private path, write apk.json
# (path, bytes, sha256, versionCode, versionName) and restart a running relay so it serves the new version.
# Phones that already run an updater build see it on the next check and offer the install.
# usage: publish_apk.sh [--no-build]        State: ~/.local/state/termweave-mobile-relay
set -eu
repo=${0:A:h:h:h}
state=${TERMWEAVE_RELAY_STATE:-$HOME/.local/state/termweave-mobile-relay}
android=$repo/mobile/android
if [[ ${1:-} != --no-build ]]; then
  # build from a clean checkout of HEAD so uncommitted work never reaches phones
  snapshot=$(mktemp -d)/src
  git -C "$repo" worktree add -q --detach "$snapshot" HEAD
  trap 'git -C "$repo" worktree remove --force "$snapshot" 2>/dev/null' EXIT
  android=$snapshot/mobile/android
  python3 "$android/build.py" :app:assembleDebug
fi
out=$android/app/build/outputs/apk/debug
export JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}
signer=$HOME/Library/Android/sdk/build-tools/34.0.0/apksigner
"$signer" verify "$out/app-debug.apk" || { print -u2 "FAIL[apk]: signature"; exit 1; }
target=$state/termweave-companion.apk
install -m 600 "$out/app-debug.apk" "$target.tmp" && mv -f "$target.tmp" "$target"
python3 - "$state" "$target" "$out/output-metadata.json" <<'PY'
import hashlib, json, os, sys
state, apk, meta = sys.argv[1:]
element = json.load(open(meta))["elements"][0]
data = open(apk, "rb").read()
record = {"path": apk, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
          "versionCode": element["versionCode"], "versionName": element["versionName"], "signing": "verified-debug-pilot"}
tmp = os.path.join(state, "apk.json.tmp")
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f: json.dump(record, f)
os.replace(tmp, os.path.join(state, "apk.json"))
print(f"apk.json: {record['versionName']} ({record['versionCode']}) {record['bytes']} bytes")
PY
manage=$repo/tools/mobile-relay/manage.py
if python3 "$manage" status | grep -q '"running": true'; then
  python3 "$manage" stop >/dev/null && python3 "$manage" start >/dev/null && print "relay restarted"
else
  print "relay not running: the new APK is served on the next start"
fi
