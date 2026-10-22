#!/usr/bin/env zsh
# Bring a pull request from the public repo (an export) into this source repo.
# The public main is rebuilt from here, so a PR merged only there would be overwritten.
# Usage: tools/public-release/apply_pr.sh <pr-number> [--check]
#   --check   show the PR, its CI state and whether the patch applies; change nothing
# Without --check: applies the commits with `git am -3` on a branch pr/<n>, keeping each author.
# Push, release and the PR comment stay manual: they publish.
set -euo pipefail
repo=VoidLight00/termweave
n=${1:?usage: apply_pr.sh <pr-number> [--check]}
[[ $n == <-> ]] || { print -u2 "FAIL: PR number must be digits"; exit 2; }
root=$(git rev-parse --show-toplevel); cd "$root"
[[ -z $(git status --porcelain --untracked-files=no) ]] || { print -u2 "FAIL: commit or stash local changes first"; exit 1; }
gh pr view "$n" -R "$repo" --json title,author,state,headRefOid -q '"\(.title) by @\(.author.login) [\(.state)] \(.headRefOid[0:7])"'
gh pr checks "$n" -R "$repo" || print "WARN: PR checks are not all green"
patch=$(mktemp); trap 'rm -f "$patch"' EXIT
gh pr diff "$n" -R "$repo" --patch > "$patch"
# the export drops internal paths: a PR touching them was not written against this tree
excluded() {
  local file=$1 pat
  for pat in ${(f)"$(grep -v '^#' tools/public-release/public-exclude.txt | sed '/^$/d')"}; do
    [[ $file == ${~pat} || $file == ${~pat}/* ]] && return 0
  done
  return 1
}
for file in ${(f)"$(sed -n 's|^+++ b/||p' "$patch")"}; do
  excluded "$file" && { print -u2 "FAIL: the PR touches $file, which the public export leaves out"; exit 1; }
done
if [[ ${2:-} == --check ]]; then git apply --check -3 "$patch" && print "PASS: patch applies cleanly"; exit; fi
git switch -c "pr/$n"
git am -3 --keep-cr "$patch" || { print -u2 "FAIL: conflict. Resolve and run 'git am --continue', or 'git am --abort'"; exit 1; }
print "PASS: PR #$n applied on branch pr/$n"
print "Next: bun scripts/verify-isolated.ts type build unit render source-style, then merge into main."
