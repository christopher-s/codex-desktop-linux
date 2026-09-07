#!/bin/bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
UPSTREAM_REMOTE="origin"
FORK_REMOTE="fork"
CUSTOM_BRANCH="chris-custom"
PUSH=0

usage() {
    cat <<'HELP'
Usage: ./scripts/chris-custom-sync.sh [--push]

Rebase chris-custom onto the latest origin/main, then run the branch checks.
The script fetches from origin and never pushes to origin.

Options:
  --push   Push chris-custom to fork with --force-with-lease after checks pass.
  -h       Show this help.
HELP
}

fail() {
    echo "[chris-custom-sync][ERROR] $*" >&2
    exit 1
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --push) PUSH=1 ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; fail "unknown option: $1" ;;
    esac
    shift
done

cd "$REPO_DIR"

[ "$(git branch --show-current)" = "$CUSTOM_BRANCH" ] ||
    fail "switch to $CUSTOM_BRANCH before running this script"
[ -z "$(git status --porcelain)" ] ||
    fail "working tree must be clean"

git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1 ||
    fail "missing upstream remote: $UPSTREAM_REMOTE"
git remote get-url "$FORK_REMOTE" >/dev/null 2>&1 ||
    fail "missing writable fork remote: $FORK_REMOTE"

upstream_url="$(git remote get-url "$UPSTREAM_REMOTE")"
fork_url="$(git remote get-url "$FORK_REMOTE")"
case "$upstream_url" in
    *github.com/ilysenko/codex-desktop-linux.git) ;;
    *) fail "$UPSTREAM_REMOTE does not point to ilysenko/codex-desktop-linux" ;;
esac
case "$fork_url" in
    *github.com/christopher-s/codex-desktop-linux.git) ;;
    *) fail "$FORK_REMOTE does not point to christopher-s/codex-desktop-linux" ;;
esac

printf '[chris-custom-sync] Fetching %s\n' "$UPSTREAM_REMOTE"
git fetch "$UPSTREAM_REMOTE"

printf '[chris-custom-sync] Rebasing %s onto %s/main\n' "$CUSTOM_BRANCH" "$UPSTREAM_REMOTE"
git rebase "$UPSTREAM_REMOTE/main"

printf '[chris-custom-sync] Running branch validation\n'
node --test linux-features/chat-bridge-tool-calls/test.js
node --test scripts/lib/linux-features.test.js
bash -n "$0" tests/chris_custom_sync_test.sh
tests/chris_custom_sync_test.sh
git diff --check "$UPSTREAM_REMOTE/main...HEAD"

if [ "$PUSH" -eq 1 ]; then
    printf '[chris-custom-sync] Pushing only to %s/%s\n' "$FORK_REMOTE" "$CUSTOM_BRANCH"
    git push --force-with-lease "$FORK_REMOTE" "$CUSTOM_BRANCH:$CUSTOM_BRANCH"

    local_sha="$(git rev-parse HEAD)"
    remote_sha="$(git ls-remote "$FORK_REMOTE" "refs/heads/$CUSTOM_BRANCH" | cut -f1)"
    [ "$local_sha" = "$remote_sha" ] || fail "fork branch SHA does not match local HEAD"
    printf '[chris-custom-sync] Verified fork/%s at %s\n' "$CUSTOM_BRANCH" "$remote_sha"
else
    printf '[chris-custom-sync] Checks passed. Re-run with --push to update fork/%s.\n' "$CUSTOM_BRANCH"
fi
