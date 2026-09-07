#!/bin/bash
set -Eeuo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$REPO_DIR/scripts/chris-custom-sync.sh"

fail() { echo "[chris-custom-sync-test][ERROR] $*" >&2; exit 1; }
assert_contains() { grep -Fq -- "$2" "$1" || fail "$1 does not contain: $2"; }

[ -f "$SCRIPT" ] || fail "missing script: $SCRIPT"
[ -x "$SCRIPT" ] || fail "script is not executable: $SCRIPT"
bash -n "$SCRIPT"

help_output="$($SCRIPT --help)"
grep -Fq -- "chris-custom" <<<"$help_output" || fail "help omits branch name"
grep -Fq -- "--push" <<<"$help_output" || fail "help omits guarded push option"

assert_contains "$SCRIPT" 'UPSTREAM_REMOTE="origin"'
assert_contains "$SCRIPT" 'FORK_REMOTE="fork"'
assert_contains "$SCRIPT" 'CUSTOM_BRANCH="chris-custom"'
assert_contains "$SCRIPT" 'git rebase "$UPSTREAM_REMOTE/main"'
assert_contains "$SCRIPT" 'git push --force-with-lease "$FORK_REMOTE" "$CUSTOM_BRANCH:$CUSTOM_BRANCH"'
assert_contains "$REPO_DIR/AGENTS.md" 'docs/chris-custom-maintenance.md'
assert_contains "$REPO_DIR/AGENTS.md" 'scripts/chris-custom-sync.sh'

if grep -Eq 'git push[^\n]*origin|git push[^\n]*\$UPSTREAM_REMOTE' "$SCRIPT"; then
    fail "script contains an upstream push path"
fi

printf '[chris-custom-sync-test] guarded upstream rebase workflow is coherent\n'
