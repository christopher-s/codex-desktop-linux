# AGENTS.md

Downstream `chris-custom` branch: see `docs/chris-custom-maintenance.md` for the
upstream rebase workflow and `scripts/chris-custom-sync.sh` for the guided sync
(origin fetch-only, fork push-only; run `tests/chris_custom_sync_test.sh`).

## Purpose

This repository repackages OpenAI's signed official Linux `chatgpt` package as
the independently named `codex-desktop` distribution. It preserves the
official ELF/Electron payload and bundled tools, adds disabled-by-default Linux
features, builds deb/RPM/pacman/AppImage/Nix outputs, and ships a Rust update
manager that rebuilds from the signed stable APT repository.

## Non-negotiable rules

- Support only the latest signed stable OpenAI Linux package on `amd64` and
  `arm64`. Remove obsolete drift paths in the same change.
- Trust `InRelease` through the pinned repository key, then verify `Packages`
  and package SHA-256 values. `latest` URLs are never a trust root.
- Never execute upstream maintainer scripts. Extract the data payload only.
- A clean build with no enabled ASAR feature must preserve `resources/app.asar`
  byte-for-byte.
- Keep the output identity `codex-desktop` under `/opt/codex-desktop`; do not
  install the upstream APT source, key, package identity, or maintainer scripts.
- Keep the user-facing desktop name **ChatGPT Community** and its distinct
  community icon; `ChatGPT` without the qualifier identifies the upstream app.
- The default core patch registry is empty. A core patch requires a reproduced
  launch/work blocker and a required regression test.
- Experimental or workflow-specific behavior belongs in `linux-features/` and
  remains disabled in committed configuration.
- Known retired feature IDs are ignored; arbitrary unknown IDs remain errors.
- Do not edit generated output (`codex-app/`, `dist/`, candidates, `target/`).

## Source routing

- Upstream verification/extraction: `scripts/lib/upstream-linux-package.js` and
  `scripts/lib/upstream-linux-package.sh`.
- Build orchestration: `install.sh`, `scripts/lib/*.sh`.
- Launcher: `launcher/start.sh.template`.
- Feature descriptors/resources/hooks: `linux-features/<id>/`.
- ASAR engine/reporting: `scripts/patches/`,
  `scripts/patch-linux-window-ui.js`, `scripts/lib/patch-report.js`.
- Packaging: `scripts/build-*.sh`, `scripts/lib/package-common.sh`,
  `packaging/`.
- Updater: `updater/src/`; minimal rebuild payload:
  `packaging/update-builder/`.
- Signed-release automation:
  `scripts/automation/upstream-linux-package-watchdog/`.
- Nix: `flake.nix`, `nix/upstream-linux-packages.json`, `nix/*.nix`.

Every repository feature and local feature must contain both `feature.json` and
`README.md`. Prefer declarative resources and runtime/package hooks over a
feature `stage.sh`.

## Editing guidance

- Search for all consumers before removing a descriptor, helper crate,
  package resource, workflow, or document.
- Treat exact minified filenames and symbols as drift-prone. Prefer semantic,
  unique anchors with fail-closed tests against the current official ASAR.
- Keep feature changes inside their feature directory unless a genuinely
  generic framework extension is required.
- Keep update-builder contents minimal and consumer-driven. Enabled feature
  resources and prebuilt helpers must be present; the full repository and
  Cargo workspaces must not be.
- Preserve user changes in dirty worktrees and never repair generated output by
  editing it in place.
- Update English and Chinese top-level usage when installation, removal,
  feature IDs, commands, or public identity changes.

## Runtime invariants

- The official `ChatGPT`, Electron libraries, native modules, `codex`, `rg`,
  code-mode host, locales, and Owl metadata come directly from upstream.
- The compact wrapper sets desktop identity, loads declarative feature hooks,
  and forwards arguments/URIs. Upstream owns single-instance, deep links, tray,
  windows, and lifecycle.
- The custom and official packages may coexist, but both use the upstream
  `Codex` user profile and must not be run concurrently.
- Legacy bundled Browser/Chrome cache migration must be narrow and
  fingerprinted: never wipe arbitrary plugin caches or user-authored plugins.
- AppImage never adds `--no-sandbox` automatically. Native packages adapt the
  upstream AppArmor policy to `/opt/codex-desktop/ChatGPT`.
- Candidate promotion is transactional. Build while running is allowed;
  promotion waits for exit. Rollback keeps the immediately previous artifact.

## Driving the app from CDP (QA navigation)

The packaged app is a local SPA: every view renders at one fixed URL,
`app://-/index.html`. Navigation is state-routed, not path-routed:

- Deep links do not exist. `Page.navigate` to any other path (e.g.
  `app://-/c/<uuid>`) returns a 404 page, and `?initialRoute=` query
  variants are ignored. There is no addressable URL for a conversation.
- `history.back()` / `history.forward()` are no-ops for view changes.
  Never use the URL or history as a navigation primitive or a state
  probe; read `document.body.innerText` instead.

Views (all reachable only from the live UI):

| View | How to reach it |
|---|---|
| Home landing (no composer) | App startup |
| New / blank chat | Sidebar "New chat" button |
| Open conversation | Sidebar row click (below) |
| Work | Top bar "Work" tab |
| Chat | Top bar "Chat" tab |

The sidebar lists sections Scheduled, Plugins, Explore, Pinned,
Projects, and Recents; each header is a collapsible button. Recents
conversation rows are `li[role=listitem]` containing a
`div[role=button][tabindex="0"]` row body, a leaf `span` title, and
hover-only buttons "Pin chat" and "Chat actions".

Row click semantics (verified 2026-09-08; the #1 pitfall):

- The only DOM click target that opens a conversation is the row's
  `div[role=button][tabindex="0"]`. `el.click()` on it mounts the
  transcript ("You said:" markers appear in `body.innerText`).
- `el.click()` on the title wrapper `div` (text `"<title>Chat"`,
  <=3 children) is silently swallowed. Substring-matching a row title
  and clicking the first candidate lands on that wrapper and does
  nothing. From a title match, select the inner `role=button`
  descendant of the `role=listitem` instead.
- A real CDP `Input.dispatchMouseEvent` (move -> press -> release,
  left button) at the row's bounding-rect center also opens it.
- Keyboard activation (`btn.focus()` + CDP `Input.dispatchKeyEvent`
  Enter) is the expected equivalent; unverified on this build.

Composer (stays mounted and editable across turns; it never unmounts
after a reply):

- Insert text with `document.execCommand('insertText', false, text)`
  on the `[contenteditable=true]` node (ProseMirror; property setters
  do not work). Embed prompts base64 (`atob` + `TextDecoder` IIFE,
  invoked) — raw apostrophes in a prompt break JS string literals.
- Send with CDP `Input.dispatchKeyEvent` `rawKeyDown`/`char`/`keyUp`
  Enter. The send button stays disabled until React registers the
  input; do not click it directly.
- Drafts persist across app restarts in the active conversation.
  Clear with `selectAll()` + `delete` before typing, or stale draft
  text concatenates with the new prompt.
- Detect completion by polling `body.innerText` for transcript
  stability (plus the Stop button disappearing). Fast replies are
  missed by button polling alone.

CDP target selection: `/json/list` may return several `app://-/` page
targets, including an `avatar-overlay` decoy. Select exactly the
target whose `url` is `app://-/index.html` (exact match, no query
string).

Recents hydration is lazy: after a fresh app start the Recents list
fills from the server over the following minutes. Poll for several
minutes before concluding a row is missing. Codex may re-title a
conversation on re-open (case changes observed); match row titles
case-insensitively, and prefer unique user-bubble markers in the
transcript over row titles for identity.

Process notes: the QA instance is the systemd user service
`codex-merge-qa` (app dir `~/.cache/codex-merge-app`, CDP
`127.0.0.1:9243` with `--remote-allow-origins=http://127.0.0.1:9243`).
Before restarting it, wait until port 9243 is actually free (bind
race). Kill with `pkill -x ChatGPT`, never `pkill -f` (the pattern
matches the invoking shell). Ports 9222 and 9223 are used by other
apps on this host.

## Generated state

Generated/local paths include `codex-app/`, `codex-app-next/`,
`codex-app.backup-*`,
`.codex-app.candidate-*`, `dist/`, `dist-next/`, `target/`,
`linux-features/features.json`, `linux-features/local/`, updater state under
XDG config/state/cache, and launcher state under XDG state/cache.

## Commands and validation

```bash
./install.sh
./install.sh /path/to/chatgpt_<version>_<arch>.deb
make setup-native
make install-native
make deb
make rpm
make pacman
make appimage
```

`make setup-native` only configures optional features. `make install-native`
builds, packages, and installs for the current distribution.
`make bootstrap-native` installs build dependencies first and then performs the
same native installation. A local `UPSTREAM_DEB` is structural input, not a
replacement trust root for the signed repository.

Run the relevant subset, and use `./scripts/ci-local.sh all` for broad changes:

```bash
bash -n install.sh scripts/lib/*.sh launcher/start.sh.template
bash tests/scripts_smoke.sh
node --test scripts/lib/upstream-linux-package.test.js
node --test scripts/patch-linux-window-ui.test.js scripts/lib/linux-features.test.js linux-features/*/test.js
cargo test -p codex-update-manager
cargo clippy -p codex-update-manager --all-targets -- -D warnings
nix flake check
```

Package/update/launcher/framework changes are cross-format unless explicitly
scoped. When changing payloads, inspect all supported output formats. Refresh
Nix pins through `scripts/ci/update-official-linux-pins.sh`, never by inventing
hashes.

## Change expectations

- Source-security changes cover valid and invalid signatures, wrong keys,
  index/package hash failures, metadata mismatch, unsupported architecture, and
  incomplete payload.
- Feature changes run the adjacent test and an official-bundle build with that
  feature alone.
- Package payload changes inspect deb, RPM, pacman, AppImage, and Nix on the
  applicable architectures.
- Updater changes cover interrupted work, app-running guards, atomic promotion,
  rollback, cache cleanup, and persisted-state migration.
- Documentation changes verify relative links, documented Make/CLI commands,
  feature IDs, and `git diff --check`.
