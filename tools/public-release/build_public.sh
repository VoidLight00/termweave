#!/bin/zsh
# Build the public TermWeave export from HEAD into .local/public and commit it there.
# The export keeps its own git history (one commit per export), so the private history of this
# repo never reaches GitHub. Files listed in public-exclude.txt are left out.
# usage: build_public.sh [--version X.Y.Z]   exit 0 = exported and leakscan clean
set -euo pipefail
repo=${0:A:h:h:h}
out=$repo/.local/public
denylist=$HOME/.config/termweave/publish-denylist.txt
harness=$HOME/projects/github-harness/bin/github
version=${2:-}

mkdir -p "$out"
[[ -d $out/.git ]] || git -C "$out" init -q -b main
# replace the tree, keep the export history
# the github harness keeps its publish state here; it lives only in the export
state=$(mktemp); [[ -f $out/.github/github-harness.json ]] && cp "$out/.github/github-harness.json" "$state"
find "$out" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
git -C "$repo" archive HEAD | tar -x -C "$out"
while IFS= read -r pattern; do
  [[ -z $pattern || $pattern == \#* ]] && continue
  (cd "$out" && rm -rf -- ${~pattern}(N))
done < "$repo/tools/public-release/public-exclude.txt"
find "$out" -name __pycache__ -type d -prune -exec rm -rf {} +

# the denylist names the owner's identifiers: it stays outside the repo and out of the export
mkdir -p "$out/.github"
[[ -s $state ]] && cp "$state" "$out/.github/github-harness.json"; rm -f "$state"
cp "$denylist" "$out/.github/publish-denylist.txt"
grep -qx '.github/publish-denylist.txt' "$out/.gitignore" 2>/dev/null || printf '\n.github/publish-denylist.txt\n' >> "$out/.gitignore"

git -C "$out" add -A
src=$(git -C "$repo" rev-parse --short HEAD)
if git -C "$out" diff --cached --quiet; then
  print "no public changes since the last export"
else
  git -C "$out" -c user.name="TermWeave" -c user.email="noreply@users.noreply.github.com" \
    commit -q -m "chore(release): ${version:-export} from source ${src}"
fi
"$harness" leakscan "$out" --public
