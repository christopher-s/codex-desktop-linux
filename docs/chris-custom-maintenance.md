# Chris Custom Branch Maintenance

`chris-custom` is the maintained downstream branch for Chris's cumulative changes. It contains the Chat enhancements and future custom work.

## Branch and remote model

| Ref | Purpose | Write policy |
|---|---|---|
| `origin/main` | Latest code from `ilysenko/codex-desktop-linux` | Fetch only |
| `fork/main` | Clean mirror of upstream `main` | Update only when intentionally mirroring upstream |
| `fork/chris-custom` | Chris's cumulative, working distribution | Push verified custom work here |
| `feature/<name>` | Temporary branch for a substantial isolated change | Merge into `chris-custom` after verification |

Never push to `origin`. The local `origin` push URL is disabled as an extra safeguard.

## Routine upstream update

Start from a clean `chris-custom` worktree:

```bash
git switch chris-custom
./scripts/chris-custom-sync.sh
```

The script performs this sequence:

1. Confirms the active branch is `chris-custom`.
2. Confirms the worktree is clean.
3. Confirms `origin` and `fork` point to the expected repositories.
4. Fetches the latest upstream refs from `origin`.
5. Rebases the custom commit stack onto `origin/main`.
6. Runs the Chat patch tests, feature framework tests, shell checks, and diff checks.
7. Stops without pushing.

Review the rebased branch and exercise the staged application. Push only after validation:

```bash
./scripts/chris-custom-sync.sh --push
```

The push target is fixed to `fork/chris-custom`. The script uses `--force-with-lease` and verifies the remote SHA.

## Conflict handling

A rebase can stop when upstream changed the same source or documentation:

```bash
git status
# Resolve each conflicted file.
git add <resolved-files>
git rebase --continue
```

Repeat until the rebase completes. Then run the sync script again to execute its full checks.

Abort the update when the correct resolution is uncertain:

```bash
git rebase --abort
```

Minified ASAR anchors can drift without producing Git conflicts. A clean rebase does not prove that a patch still applies. Run the feature tests, transactional candidate rebuild, and live UI checks required by `AGENTS.md` before pushing.

## Adding future custom work

Small related changes can be committed directly on `chris-custom`. Use focused commits so each downstream patch remains easy to diagnose or remove.

Use a temporary branch for substantial independent work:

```bash
git switch chris-custom
git switch -c feature/<short-name>
```

Build and verify the feature there. Merge it into `chris-custom` on the fork after approval. Delete the temporary branch when it no longer has independent value.

## Recovery

The pre-rebase state remains available in the reflog:

```bash
git reflog chris-custom
```

Create a recovery branch before resetting anything:

```bash
git branch recovery/chris-custom-<date> <known-good-sha>
```
