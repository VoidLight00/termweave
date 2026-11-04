#!/bin/sh
# One-command TermWeave setup for a person or an AI coding agent.
#
#   sh scripts/install.sh            install (or repair) and start TermWeave
#   sh scripts/install.sh --check    verify only; changes nothing
#   sh scripts/install.sh --yes      also allow the official Bun and herdr installers
#
# Exit codes: 0 ok, 2 missing prerequisite, 1 any other failure.
# Safe to run twice: an existing install is reused and a running server is left alone.
# It never opens external access and never prints tokens.
set -u

MIN_HERDR=0.9.0
MIN_BUN=1.4.0
MIN_NODE=18
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
DIR=${TERMWEAVE_INSTALL_DIR:-"$HOME/.local/share/termweave-owned"}
PORT=${PORT:-7317}
CHECK=0
YES=0
START=1

usage() {
  cat <<EOF
Usage: sh scripts/install.sh [--check] [--yes] [--no-start] [--dir PATH] [--port N]
  --check     verify prerequisites, install and health; change nothing
  --yes       allow the official Bun and herdr installers when they are missing
  --no-start  install and build, but do not start the server
  --dir PATH  install directory (default: \$HOME/.local/share/termweave-owned)
  --port N    local port (default: 7317, or \$PORT)
Environment: TERMWEAVE_INSTALL_DIR, PORT, HERDR_SOCKET (named herdr session socket).
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1 ;;
    --yes) YES=1 ;;
    --no-start) START=0 ;;
    --dir) [ $# -ge 2 ] || { usage >&2; exit 1; }; DIR=$2; shift ;;
    --port) [ $# -ge 2 ] || { usage >&2; exit 1; }; PORT=$2; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 1 ;;
  esac
  shift
done
case "$PORT" in ''|*[!0-9]*) printf 'Invalid port: %s\n' "$PORT" >&2; exit 1 ;; esac
case "$DIR" in /*) ;; *) DIR="$(pwd)/$DIR" ;; esac

say() { printf '%s\n' "$*"; }
ok() { printf 'ok    %s\n' "$*"; }
miss() { printf 'MISS  %s\n' "$*" >&2; }
fail() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }

# version_ge A B: true when dotted version A >= B (numeric parts only)
version_ge() {
  a=$1 b=$2
  while [ -n "$a$b" ]; do
    x=${a%%.*} y=${b%%.*}
    x=${x%%[!0-9]*} y=${y%%[!0-9]*}
    x=${x:-0} y=${y:-0}
    [ "$x" -gt "$y" ] && return 0
    [ "$x" -lt "$y" ] && return 1
    case "$a" in *.*) a=${a#*.} ;; *) a= ;; esac
    case "$b" in *.*) b=${b#*.} ;; *) b= ;; esac
  done
  return 0
}

# Official installers only, and only with --yes.
try_install() {
  name=$1 cmd=$2
  if [ "$YES" -eq 1 ] && [ "$CHECK" -eq 0 ]; then
    say "Installing $name with its official installer: $cmd"
    sh -c "$cmd" || return 1
    PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"; export PATH
    return 0
  fi
  return 1
}

# ---- 1. prerequisites --------------------------------------------------------
missing=0
check_prereqs() {
  missing=0
  if command -v git >/dev/null 2>&1; then ok "git $(git --version | awk '{print $3}')"
  else miss "git not found. Fix: macOS 'xcode-select --install', Debian/Ubuntu 'sudo apt install git'"; missing=1; fi

  if command -v bun >/dev/null 2>&1 && version_ge "$(bun --version 2>/dev/null)" "$MIN_BUN"; then
    ok "bun $(bun --version)"
  elif command -v bun >/dev/null 2>&1; then
    miss "bun $(bun --version) is older than $MIN_BUN. Fix: bun upgrade"; missing=1
  else
    miss "bun not found. Fix: curl -fsSL https://bun.sh/install | bash   (or rerun with --yes)"; missing=1
  fi

  if command -v node >/dev/null 2>&1; then
    major=$(node --version | sed 's/^v\([0-9]*\).*/\1/')
    if [ "${major:-0}" -ge "$MIN_NODE" ]; then ok "node $(node --version)"
    else miss "node $(node --version) is older than $MIN_NODE. Fix: install Node $MIN_NODE+ from https://nodejs.org, nvm or Homebrew ('brew install node')"; missing=1; fi
  else
    miss "node not found (needed for the terminal sidecar). Fix: install Node $MIN_NODE+ from https://nodejs.org, nvm or Homebrew ('brew install node')"; missing=1
  fi

  if command -v herdr >/dev/null 2>&1; then
    hv=$(herdr --version 2>/dev/null | awk '{print $2}')
    if version_ge "${hv:-0}" "$MIN_HERDR"; then ok "herdr $hv"
    else miss "herdr ${hv:-unknown} is older than $MIN_HERDR. Fix: herdr update"; missing=1; fi
  else
    miss "herdr not found. Fix: curl -fsSL https://herdr.dev/install.sh | sh   (or rerun with --yes; docs: https://herdr.dev/docs/install/)"; missing=1
  fi
}

check_prereqs
if [ "$missing" -ne 0 ] && [ "$CHECK" -eq 0 ] && [ "$YES" -eq 1 ]; then
  command -v bun >/dev/null 2>&1 || try_install Bun 'curl -fsSL https://bun.sh/install | bash' || fail "Bun installer failed"
  command -v herdr >/dev/null 2>&1 || try_install herdr 'curl -fsSL https://herdr.dev/install.sh | sh' || fail "herdr installer failed"
  check_prereqs
fi
if [ "$missing" -ne 0 ]; then
  say "Missing prerequisites. Run the Fix commands above, then rerun: sh scripts/install.sh" >&2
  exit 2
fi

# ---- helpers -----------------------------------------------------------------
URL="http://127.0.0.1:$PORT"
health() { curl -fsS -m 3 "$URL/api/health" 2>/dev/null; }
installed() { [ -f "$DIR/.termweave-owned.json" ]; }
ours_running() { [ -f "$DIR/lifecycle.json" ] && health | grep -q '"ok":true'; }

print_next() {
  say ""
  say "TermWeave is running. Open: $URL"
  say "Phone (optional, off by default):"
  say "  Tailscale (easiest): install Tailscale on this computer and the phone, sign in to the same tailnet,"
  say "    set HERDR_WEB_TOKEN and TERMWEAVE_EXTERNAL_ACCESS=1, and serve port $PORT on the tailnet. See AGENTS.md."
  say "  Cloudflare tunnel (optional): same token rules; never expose the port without a token."
  say "Other optional features stay off:"
  say "  Android companion: build it yourself from mobile/android (docs/mobile-android-integration.md)."
  say "  OpenRig teams: turn it on later from the OpenRig panel in the app."
  say "Stop: (cd \"$DIR\" && bun scripts/install-lifecycle.ts stop --dir \"$DIR\")"
}

# ---- 2. check mode -----------------------------------------------------------
if [ "$CHECK" -eq 1 ]; then
  rc=0
  if installed; then ok "installed at $DIR"; else miss "not installed at $DIR (run: sh scripts/install.sh)"; rc=1; fi
  if ours_running; then ok "server answers $URL/api/health"
  elif health >/dev/null; then say "note  $URL answers, but not from this install (another server owns port $PORT)"
  else miss "no server answers $URL/api/health"; rc=1; fi
  exit $rc
fi

# ---- 3. install + build ------------------------------------------------------
if installed; then
  ok "already installed at $DIR (reused)"
elif [ -e "$DIR" ]; then
  fail "$DIR exists but is not a TermWeave install. Remove it or pass --dir NEW_PATH"
else
  mkdir -p "$(dirname -- "$DIR")" || fail "cannot create $(dirname -- "$DIR")"
  say "Installing dependencies and building into $DIR (takes about a minute)..."
  if ! (cd "$ROOT" && bun scripts/owned-install.ts "$DIR"); then
    fail "install failed. The source checkout must be a clean git clone (no local edits): git status; git stash"
  fi
  installed || fail "install did not finish"
  ok "installed and built at $DIR"
fi

[ "$START" -eq 1 ] || { say "Skipped start (--no-start). Start later: sh scripts/install.sh"; exit 0; }

# ---- 4. start ----------------------------------------------------------------
if ours_running; then
  ok "already running at $URL (left alone)"
  print_next
  exit 0
fi
if health >/dev/null || curl -s -m 2 -o /dev/null "$URL/" 2>/dev/null; then
  fail "port $PORT is used by another server. Rerun with --port 7318"
fi
if [ -f "$DIR/lifecycle.json" ]; then
  pid=$(sed -n 's/.*"launcher":\([0-9]*\).*/\1/p' "$DIR/lifecycle.json")
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    fail "a TermWeave launcher (pid $pid) is still starting or stuck. Wait, or stop it: (cd \"$DIR\" && bun scripts/install-lifecycle.ts stop --dir \"$DIR\")"
  fi
  # stale state from a previous run is reclaimed by owned-server under the lifecycle guard, never removed here
fi

LOG="$DIR/server.log"
# Minimal environment: the server must not inherit API keys from this shell.
# The token, if the user set one, passes through and is never printed.
set -- HOME="$HOME" PATH="$PATH" PORT="$PORT" HOST=127.0.0.1 LANG="${LANG:-en_US.UTF-8}"
[ -n "${USER:-}" ] && set -- "$@" USER="$USER"
[ -n "${SHELL:-}" ] && set -- "$@" SHELL="$SHELL"
[ -n "${XDG_CONFIG_HOME:-}" ] && set -- "$@" XDG_CONFIG_HOME="$XDG_CONFIG_HOME"
[ -n "${HERDR_SOCKET:-}" ] && set -- "$@" HERDR_SOCKET="$HERDR_SOCKET"
[ -n "${HERDR_WEB_TOKEN:-}" ] && set -- "$@" HERDR_WEB_TOKEN="$HERDR_WEB_TOKEN"
nohup env -i "$@" bun "$DIR/scripts/owned-server.ts" start >"$LOG" 2>&1 </dev/null &

say "Starting TermWeave on $URL ..."
i=0
while [ $i -lt 40 ]; do
  if health | grep -q '"ok":true'; then ok "health: $URL/api/health"; print_next; exit 0; fi
  i=$((i + 1)); sleep 1
done
if curl -s -m 2 "$URL/api/health" >/dev/null 2>&1; then
  fail "server is up but herdr does not answer. Start herdr in a terminal ('herdr'), then rerun. Log: $LOG"
fi
fail "server did not answer within 40 s. Log: $LOG"
