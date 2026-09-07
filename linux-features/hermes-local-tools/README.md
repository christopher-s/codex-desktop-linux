# hermes-local-tools (Phase 1 — disposable QA proof)

Advertises ONE deterministic Hermes tool through the client-local function
protocol in ordinary Chat mode and executes it locally in-process via an
owner-only loopback HTTP endpoint. No custom GPT, no bridge, no tunnel.

## Status: round trip VERIFIED end-to-end

Live CDP verification (built candidate, plain Chat):

- `tWr` advertises `hermes_read_file(path)`; signature built per request.
- Detector matches `local.hermes_read_file` / `functions.hermes_read_file`.
- Normalization converts the call to a handoff-shaped item so the native
  executor `Bu` mounts, paired by call id.
- Executor parses the model's `path` arg and `fetch`es the loopback endpoint
  (`127.0.0.1:9473`), which calls `model_tools.handle_function_call("read_file", …)`
  in-process.
- Real result returns via the native hidden tool-role continuation (`Ygi`).
- Model consumes and restates the exact file contents:
  `endpointResp.result.content = "1|PHASE1-SECOND-FIXTURE-99-ZEBRA\n2|"`,
  assistant reply "Exact contents: Plain text 1|PHASE1-SECOND-FIXTURE-99-ZEBRA 2|".

## What the patch changes

- `app-initial`: advertise `hermes_read_file(path)` via `tWr`; open both
  `local_function_signatures` request gates; normalize the call; classify and
  pair the hidden result.
- `app-primary`: detector accepts `functions./local.hermes_read_file`; args
  schema `N0t` accepts `{path}`; executor `D0t` parses `path` and fetches the
  loopback endpoint with the real tool name `read_file`.
- `viewer`: route the incomplete call through the native executor.
- `chip-group`: render arguments and the exact tool result.
- `webview/index.html` (`extracted-app:post-webview`): add `http://127.0.0.1:*`
  to CSP `connect-src` so the `app://` origin can reach the loopback endpoint.

## The endpoint

`tool_endpoint.py` binds `127.0.0.1:9473` (configurable via `PHASE1_TOOL_PORT`),
maps POST `{name, arguments}` to `model_tools.handle_function_call` in-process.
Owner-only loopback, self-contained, no bridge dependency.

Run it:

```bash
PHASE1_TOOL_PORT=9473 python3 linux-features/hermes-local-tools/tool_endpoint.py
```

## Hard-won lessons (do not rediscover)

1. **Nested template literals in ASAR patches corrupt the minified bundle.**
   Building injected code as a JS template literal that itself contains
   `` \`...\${...}\` `` produced `SyntaxError: Unexpected template string` at a
   lazily-loaded route chunk — even though `node --check` passed on every main
   bundle. Isolated via PHASE1_ONLY builds (initial-only clean, primary-only
   broken). Fix: use string concatenation and double-quoted strings in injected
   executor code; never nest template literals.
2. **CSP connect-src blocks loopback fetch.** The `app://` webview CSP allows
   only `'self'` + named https hosts. The executor's `fetch` to `127.0.0.1`
   failed until `connect-src` was patched.
3. **Model-facing name vs registry name.** The advertised signature name
   (`hermes_read_file`) is what the model calls; the executor must map it to the
   real Hermes registry tool (`read_file`) when calling the endpoint.
4. **`execute_code` hits the interactive approval gate** — unusable for an
   automated round trip. `read_file` is approval-free, deterministic, no-network.
5. **Hermes `read_file` dedups** in a long-lived process: re-reading the same
   path returns "unchanged since last read" instead of content. Use a fresh path
   per run to verify content delivery.

## Open gate (unchanged, paused)

The completed tool call does not persist as an expandable disclosure card (the
`tool=handoff` executor item is consumed by the handoff lifecycle and excluded
from the persistent reasoning-group card path by `pWr`). Round trip is fully
functional; persistent-card rendering is a separate follow-up (re-emit a
standalone completed item, or drive the executor outside the handoff lifecycle).
