# Hermes Regular-Chat QA Harness

Reusable end-to-end QA helpers for the regular ChatGPT Chat Hermes lifecycle and local tooling work.

The harness is intentionally separate from feature code. It drives the real staged Electron app through Chromium DevTools Protocol (CDP), inspects Hermes lifecycle/LCM evidence, and can be paired with the repository's Linux Computer Use backend for independent visual/input proof.

Canonical execution plan: [`../../../docs/hermes-regular-chat-execution-plan.md`](../../../docs/hermes-regular-chat-execution-plan.md).

## Preconditions

- Staged app: `/home/chris/.cache/codex-merge-app` by default.
- Independent user unit: `codex-merge-qa` by default.
- CDP: `127.0.0.1:9243`.
- The app must be launched with:

  ```text
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
- `CODEX_HERMES_QA_LIFECYCLE_LOG`
- `CODEX_HERMES_QA_LCM_DB`

## Design rules

- Select only the exact visible shell CDP target `app://-/index.html`.
- Never drive the hidden `chatgpt.com` webview target.
- Select the visible shell `[contenteditable=true]`; never `#prompt-textarea`.
- Move prompt text through base64/UTF-8 decoding inside JS so quotes/newlines/unicode cannot corrupt the expression.
- Dispatch Enter through CDP `Input.dispatchKeyEvent`.
- Accept a send only after the user turn appears in the rendered shell transcript.
- Treat Recents as virtualized and interaction-gated.
- Capture conversation IDs dynamically in reusable scenarios.
- Preserve raw evidence on failure.
- Report model-choice ambiguity as `INCONCLUSIVE` where appropriate instead of calling it a product failure.

## Initial commands

```bash
python3 scripts/qa/hermes-chat/run.py sanity
python3 scripts/qa/hermes-chat/run.py state
```

Additional E2-E10 scenarios are added as their supporting primitives are committed and unit-tested.
