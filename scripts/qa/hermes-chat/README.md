# Hermes Regular-Chat QA Harness

Reusable end-to-end QA helpers for the regular ChatGPT Chat Hermes lifecycle and local tooling work.

The harness is intentionally separate from feature code. It drives the real staged Electron app through Chromium DevTools Protocol (CDP), inspects Hermes lifecycle/LCM evidence, and can be paired with the repository's Linux Computer Use backend for independent visual/input proof.

Canonical execution plan: [`../../../docs/hermes-regular-chat-execution-plan.md`](../../../docs/hermes-regular-chat-execution-plan.md).

## Preconditions

- Staged app: `/home/chris/.cache/codex-merge-app` by default.
- Independent user unit: `codex-hermes-qa` by default.
- CDP: `127.0.0.1:9243`.
- The app must be launched with:

  ```text
  --force-renderer-accessibility
  --remote-debugging-port=9243
  --remote-allow-origins=http://127.0.0.1:9243
  ```

- Python 3 with the `websockets` package used by the existing local QA environment.
- A logged-in ChatGPT desktop profile.

Environment overrides:

- `CODEX_HERMES_QA_APP_DIR`
- `CODEX_HERMES_QA_UNIT`
- `CODEX_HERMES_QA_CDP_HOST`
- `CODEX_HERMES_QA_CDP_PORT`
- `CODEX_HERMES_QA_USER_DATA_DIR` — optional isolated Chromium/Electron profile root passed as `--user-data-dir`. Use a disposable copy of the logged-in Codex profile when the normal desktop app is running so QA does not collide with its Chromium singleton. The harness does not create or delete this directory automatically.
- `CODEX_HERMES_QA_LIFECYCLE_LOG`
- `CODEX_HERMES_QA_LCM_DB`
- `LCM_DATABASE_PATH` — forwarded explicitly into transient QA Electron units so the lifecycle helper can use an isolated LCM database across app restarts. The explicit QA-only controls `CODEX_HERMES_QA_FAULT`, `CODEX_HERMES_QA_FAST_BEGIN`, `CODEX_HERMES_QA_FAST_IDENTITY`, and `CODEX_HERMES_QA_SESSION_INIT` are also forwarded so diagnostic runs use the same port-release-safe launcher. `HERMES_HOME` and unrelated caller environment remain excluded. For isolated LCM runs, point both `LCM_DATABASE_PATH` and `CODEX_HERMES_QA_LCM_DB` at the same writable copy, and use a dedicated `CODEX_HERMES_QA_UNIT` so no existing transient unit can carry stale environment.

## Current GNOME-session caveat

On the present Wayland/GNOME login, compositor window enumeration is unavailable until the Codex WindowControl extension is loaded by a new GNOME session. `--force-renderer-accessibility` still exposes the Electron renderer through AT-SPI, and XDG Desktop Portal screenshots work. Keyboard injection through GNOME RemoteDesktop and a QA-local ydotool 1.0.4 probe did not reach Electron despite backend success reports; uinput pointer sends likewise did not produce an observed DOM focus change. Treat backend `ok:true` as a send result only. End-to-end acceptance must verify the effect independently through CDP/AT-SPI. See `docs/hermes-regular-chat-qa-log.md`.

## Design rules

- Select only the exact visible shell CDP target `app://-/index.html`.
- Never drive the hidden `chatgpt.com` webview target.
- Select the visible shell `[contenteditable=true]`; never `#prompt-textarea`.
- Move prompt text through base64/UTF-8 decoding inside JS so quotes/newlines/unicode cannot corrupt the expression.
- Dispatch Enter through CDP `Input.dispatchKeyEvent`. If Enter leaves a populated reopened-thread draft unsubmitted, retry the native visible Send control until it is actually clicked; never mark the fallback consumed on a control miss.
- Accept a send only after the user turn appears in the rendered shell transcript.
- Treat Recents as virtualized and interaction-gated.
- Capture conversation IDs dynamically in reusable scenarios.
- E1 treats a missing composer after an otherwise completed turn as an ambient shell condition only after the pristine upstream ASAR reproduces it. E1 records the detach, navigates to New chat, reopens the exact observed server conversation ID from Recents using the turn marker, and requires a visible composer before continuing. Session/task identity, lifecycle order/counts, zero-tool behavior, canonical four-row LCM persistence, integrity, restart/reopen, and read-only postconditions remain strict acceptance gates.
- Preserve raw evidence on failure.
- Report model-choice ambiguity as `INCONCLUSIVE` where appropriate instead of calling it a product failure.

## Initial commands

```bash
python3 scripts/qa/hermes-chat/run.py sanity
python3 scripts/qa/hermes-chat/run.py state
```

Additional E2-E10 scenarios are added as their supporting primitives are committed and unit-tested.
