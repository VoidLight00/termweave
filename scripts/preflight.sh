#!/bin/sh
# herdr runs this first when it installs the plugin (herdr-plugin.toml, [[build]]), with its own
# environment rather than your shell's. It says in one line what is missing, instead of a failed
# `bun install` some steps later. The startup hook runs with the same PATH, so a bun that is
# missing here would also keep the app from starting with herdr.
set -u
fail=0
if command -v bun >/dev/null 2>&1; then
  version=$(bun --version 2>/dev/null || echo unknown)
  case "$version" in
    0.*|1.[0-3].*) echo "herdr web ui needs Bun 1.4 or newer; this is Bun $version. Update it with: bun upgrade"; fail=1 ;;
  esac
else
  echo "herdr web ui needs Bun, and 'bun' is not on the PATH of the shell that started herdr."
  echo "Install it (https://bun.sh), start herdr from a shell where 'bun --version' works, then install again."
  fail=1
fi
if command -v node >/dev/null 2>&1; then
  major=$(node --version 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/')
  if [ "${major:-0}" -lt 18 ]; then
    echo "herdr web ui needs Node 18 or newer for its terminal sidecar; this is Node $(node --version)."
    fail=1
  fi
else
  echo "herdr web ui needs Node 18 or newer for its terminal sidecar, and 'node' is not on the PATH of the shell that started herdr."
  echo "Install it (nodejs.org, nvm, Homebrew or your distro), start herdr from a shell where 'node --version' works, then install again."
  fail=1
fi
exit $fail
