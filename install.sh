#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
command -v bun >/dev/null || { printf '%s\n' 'Install Bun yourself.' >&2; exit 1; }
command -v herdr >/dev/null || { printf '%s\n' 'Install the separately licensed herdr runtime yourself.' >&2; exit 1; }
case "${1:-}" in
 --check) printf '%s\n' 'Prerequisites available; no changes.' ;;
 --install) [ -n "${TERMWEAVE_INSTALL_DIR:-}" ] || { printf '%s\n' 'Set TERMWEAVE_INSTALL_DIR to a new owned directory.' >&2; exit 2; }; bun "$ROOT/scripts/owned-install.ts" "$TERMWEAVE_INSTALL_DIR" ;;
 *) printf '%s\n' 'Usage: --check | --install (explicit TERMWEAVE_INSTALL_DIR)' >&2; exit 2 ;;
esac
