#!/bin/sh
# Install the post-commit hook that runs tools/public-release/auto_release.sh in the background.
set -eu
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
hook="$root/.git/hooks/post-commit"
cat > "$hook" <<'HOOK'
#!/bin/sh
# TermWeave auto release (installed by tools/public-release/install-hooks.sh). Off: touch ~/.config/termweave/auto-release.off
PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"; export PATH
nohup "$(git rev-parse --show-toplevel)/tools/public-release/auto_release.sh" >/dev/null 2>&1 &
HOOK
chmod +x "$hook"
echo "installed $hook"
