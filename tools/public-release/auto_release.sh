#!/bin/zsh
# Auto release: run by the post-commit hook in the background after every commit on main.
#   feat/fix/perf/refactor -> patch bump (feat! or BREAKING CHANGE -> minor), changelog entry,
#                             version commit, then publish with a GitHub Release
#   any other type          -> publish the code only (no version change)
# Every publish passes build_public.sh (leakscan) and the harness flow (gates/verify_github.sh).
# Kill switch: touch ~/.config/termweave/auto-release.off     Log: ~/.local/state/termweave/auto-release.log
set -uo pipefail
# git exports GIT_DIR, GIT_INDEX_FILE and friends (relative paths) to hooks; they break worktrees and nested git calls
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES 2>/dev/null
repo=${0:A:h:h:h}
log=$HOME/.local/state/termweave/auto-release.log
lock=$HOME/.local/state/termweave/auto-release.lock
harness=$HOME/projects/github-harness/bin/github
mkdir -p "${log:h}"
exec >>"$log" 2>&1
print "== $(date '+%F %T') commit $(git -C "$repo" rev-parse --short HEAD)"

[[ -e $HOME/.config/termweave/auto-release.off ]] && { print "skip: kill switch is on"; exit 0; }
[[ $(git -C "$repo" branch --show-current) == main ]] || { print "skip: not on main"; exit 0; }
mkdir "$lock" 2>/dev/null || { print "skip: another release is running"; exit 0; }
trap 'rmdir "$lock" 2>/dev/null' EXIT

subject=$(git -C "$repo" log -1 --format=%s)
body=$(git -C "$repo" log -1 --format=%b)
bump=""
case $subject in
  chore\(release\)*) bump="" ;;
  feat!*|*"!:"*) bump=minor ;;
  feat*|fix*|perf*|refactor*) bump=patch ;;
esac
[[ $body == *"BREAKING CHANGE"* && -n $bump ]] && bump=minor

if [[ -n $bump ]]; then
  current=$(python3 -c "import json;print(json.load(open('$repo/package.json'))['version'])")
  next=$(python3 - "$current" "$bump" <<'EOF'
import sys
major, minor, patch = map(int, sys.argv[1].split("."))
print(f"{major}.{minor + 1}.0" if sys.argv[2] == "minor" else f"{major}.{minor}.{patch + 1}")
EOF
)
  print "bump $bump: $current -> $next"
  # every feat/fix/perf/refactor since the previous release commit goes into this version's entry
  since=$(git -C "$repo" log -1 --format=%H -E --grep='^(chore\(release\)|release): v')
  notes=$(git -C "$repo" log --format=%s ${since:+$since..}HEAD | grep -E '^(feat|fix|perf|refactor)(\(|!|:)' || print -r -- "$subject")
  python3 - "$repo" "$current" "$next" "$notes" <<'EOF'
import re, sys, datetime
repo, cur, nxt, notes = sys.argv[1:]
def sub(path, pattern, repl):
    p = f"{repo}/{path}"; s = open(p).read(); t, n = re.subn(pattern, repl, s, count=1, flags=re.M)
    if n != 1: raise SystemExit(f"version not found in {path}")  # same value is fine; a missing line is not
    open(p, "w").write(t)
sub("package.json", r'"version": "[^"]+"', f'"version": "{nxt}"')
sub("shared/product.ts", r'PRODUCT_VERSION = "[^"]+"', f'PRODUCT_VERSION = "{nxt}"')
sub("herdr-plugin.toml", r'^version = "[^"]+"', f'version = "{nxt}"')
sub("CITATION.cff", r'^version: "[^"]+"', f'version: "{nxt}"')
today = datetime.date.today().isoformat()
sub("CITATION.cff", r'^date-released: "[^"]+"', f'date-released: "{today}"')
p = f"{repo}/CHANGELOG.termweave.md"; s = open(p).read()
entry = f"## [{nxt}] - {today}\n\n" + "".join(f"- {line}\n" for line in notes.splitlines() if line.strip()) + "\n"
i = s.index("## [")
open(p, "w").write(s[:i] + entry + s[i:])
EOF
  [[ $? -eq 0 ]] || { print "FAIL: version files (restored)"; git -C "$repo" checkout -q -- package.json shared/product.ts herdr-plugin.toml CITATION.cff CHANGELOG.termweave.md; exit 1; }
  git -C "$repo" add package.json shared/product.ts herdr-plugin.toml CITATION.cff CHANGELOG.termweave.md
  # hooks off: this version commit must not start a second release run
  git -C "$repo" -c core.hooksPath=/dev/null commit -q -m "chore(release): v$next" -m "Automatic $bump release for: $subject"
  version=v$next
else
  version=v$(python3 -c "import json;print(json.load(open('$repo/package.json'))['version'])")
fi

"$repo/tools/public-release/build_public.sh" --version "$version" || { print "FAIL: export or leakscan"; exit 1; }
"$harness" flow "$repo/.local/public" --profile public-full --languages en,ko,ja,zh \
  --approve-images --approve-publish --public --release --approve-release || { print "FAIL: harness flow"; exit 1; }
print "PASS: published $version"
# a version bump also moves the live app (launchd com.voidlight.termweave) to this release, health-checked
if [[ -n $bump ]] && launchctl print gui/$(id -u)/com.voidlight.termweave >/dev/null 2>&1; then
  "$repo/tools/operations/deploy-release.sh" || { print "FAIL: live deploy (previous release kept)"; exit 1; }
fi
