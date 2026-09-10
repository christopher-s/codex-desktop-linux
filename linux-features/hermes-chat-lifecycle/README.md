# Hermes Chat Lifecycle

Opt-in Codex Desktop integration that surrounds eligible ChatGPT turns with native Hermes lifecycle behavior while ChatGPT remains the foreground conversational model.

The feature is disabled by default. When enabled, project-less ordinary Chat turns are eligible directly; non-empty Custom GPT/Gizmo IDs remain eligible only when explicitly registered.

Architecture and roadmap: [`../../docs/hermes-chat-lifecycle-plan.md`](../../docs/hermes-chat-lifecycle-plan.md)\
Verified implementation and QA record: [`../../docs/hermes-chat-lifecycle-status.md`](../../docs/hermes-chat-lifecycle-status.md)

## Activation

Eligible Custom GPTs are registered through a local versioned manifest owned by the Codex main process. The default path is:

```text
$CODEX_LINUX_APP_STATE_DIR/hermes-chat-lifecycle-gizmos.json
```

or, when `CODEX_LINUX_APP_STATE_DIR` is unset:

```text
~/.local/state/codex-desktop/hermes-chat-lifecycle-gizmos.json
```

Version 1 schema:

```json
{
  "version": 1,
  "gizmos": {
    "g-abc12345": { "enabled": true }
  }
}
```

Only valid `g-...` IDs whose entry is an object and whose `enabled` field is either omitted or exactly boolean `true` are registered. Disabled entries, malformed manifests, unsupported versions, non-regular files, and files larger than 256 KiB fail closed. The file is re-read on every probe, so registration changes take effect without rebuilding the ASAR.

A custom manifest path can be supplied with:

```bash
CODEX_HERMES_GIZMO_MANIFEST=/path/to/gizmos.json
```

For development only, the comma-separated environment override still has explicit precedence:

```bash
CODEX_HERMES_GIZMO_IDS=g-abc12345,g-def67890
```

When that override is non-empty, invalid IDs are filtered and the manifest is not used as a fallback. Registration controls only non-empty Custom GPT/Gizmo identities; project-less ordinary Chat does not require a manifest entry.

The renderer performs a fast `probe` through trusted main-process IPC before creating any Hermes preflight state. Project-less ordinary Chat probes are eligible when the feature is enabled. Non-empty Custom GPT/Gizmo IDs still fail closed unless registered, and unrelated webviews keep their normal behavior.

## What the feature currently does

The feature patches three Codex layers:

- **Electron preload** — exposes `electronBridge.hermesChatLifecycle(request)`;
- **Electron main process** — validates trusted IPC senders, allows project-less ordinary Chat directly, enforces manifest/env registration for non-empty Gizmo IDs, binds canonical conversations to lifecycle sessions, and hosts a persistent Hermes helper process;
- **ChatGPT webview turn orchestrator** — runs Hermes lifecycle before the observable ChatGPT request, injects the provider system block at system authority and recalled/plugin context at hidden user authority, and reports success/error/interruption terminal states.

The persistent Python helper imports the locally installed Hermes Agent runtime directly. It does not contact or modify the `hermes-chatgpt` bridge.

## Current lifecycle

Successful turn:

```text
Chat/Gizmo probe
  -> session open/reuse
  -> Hindsight MemoryManager.on_turn_start
  -> Hindsight provider system prompt + prefetch
  -> native pre_llm_call hooks
     -> Superpowers
     -> LCM/plugin hooks
  -> hidden one-turn system message (provider prompt only)
  -> hidden one-turn contextual user message (fenced recall + plugin context)
  -> native pre_api_request
  -> ChatGPT startCompletionStream
  -> native post_api_request
  -> native post_llm_call
  -> LCM on_turn_complete
  -> Hindsight sync_all + queued prefetch
  -> native on_session_end(completed=true)
```

Interrupted turn:

```text
begin_turn / optional pre_api_request
  -> user presses Stop
  -> on_session_end(interrupted=true)
  -> abort_turn
  -> no successful Hindsight sync
```

Observable ChatGPT failure:

```text
pre_api_request
  -> ChatGPT error
  -> api_request_error
  -> on_session_end(failed=true)
```

## Native Hermes components used

The implementation deliberately calls Hermes proper rather than reimplementing plugin semantics:

- `hermes_cli.lifecycle.invoke_hook`;
- `hermes_cli.lifecycle.finalize_session`;
- native plugin discovery;
- `MemoryManager`;
- configured external memory provider loading;
- plugin-registered context engine (`lcm` in the current environment);
- native Hindsight provider lifecycle;
- installed Superpowers plugin;
- native `post_llm_call` / LCM ingestion.

## Persistent lifecycle host

Electron launches:

```text
lifecycle_helper.py --persistent
```

The host retains one session runtime per Codex lifecycle session so memory-provider caches/counters, LCM bindings, conversation history, plugin process state, and logical API request correlation survive across turns.

Electron automatically prefers the Hermes venv interpreter:

```text
$HERMES_AGENT_ROOT/venv/bin/python3
```

or:

```text
~/.hermes/hermes-agent/venv/bin/python3
```

This ensures provider dependencies such as `hindsight-client` are available. `CODEX_HERMES_PYTHON` is an explicit override.

The helper also includes a narrowly scoped fallback compatibility shim for the current Hermes daemon thread pool on CPython 3.14. The installed Hermes checkout is not modified.

## Conversation, task, and lifecycle identity

The integration keeps three identity scopes separate:

```text
logical conversation: canonical client conversation id (for example local-chatgpt:<uuid>)
operational task:     chatgpt-codex:<canonical conversation id>
lifecycle epoch:      hs_codex_<uuid>
```

The ChatGPT client conversation ID is the canonical Hermes/LCM continuity key. When OpenAI later assigns a server conversation UUID, the helper persists the local↔server alias so a server-ID-only reopen after app restart reverse-resolves to the original local canonical key.

The Hermes operational `task_id` is derived from that canonical conversation identity. This keeps process/CWD/browser/tool workspace identity stable across lifecycle rotation. A session-derived task id is used only as a defensive fallback when a payload has no conversation identity.

Lifecycle session reuse remains intentionally process-local. Within one Codex main-process lifetime, repeated turns for the same logical conversation reuse one `hs_codex_*` session. After a Codex restart, the in-memory lifecycle binding is gone and the next eligible turn creates a fresh `hs_codex_*` session with `is_first_turn=true`. Session-local caches/reviewer/plugin first-turn state therefore rotate at the process boundary while canonical conversation and operational task identity remain stable.

API request IDs remain lifecycle-session-scoped because they correlate one request inside one lifecycle epoch; they are intentionally distinct from the stable operational task identity.

Executable helper tests cover stable `task_id` derivation across two lifecycle session IDs, server-ID-only alias reopen, and conversation-based tool dispatch.

## IPC payload normalization

Renderer lifecycle calls send only structured-clone-safe primitives/plain data. User and assistant renderer message objects are normalized to plain text before crossing Electron IPC.

This is required for steady-state reliability: runtime QA found that a mutable renderer message object could serialize successfully at `begin_turn` and later fail at `pre_api_request` with `IPC arguments could not be serialized`. The text-only contract removed that second-turn failure; a rebuilt two-turn Winston regression paired `pre_api_request` / `post_api_request` with API call counts `1` and `2` and produced no serialization warning.

Successful completion ordering is deliberate: the native ChatGPT completion finalizer runs before the renderer sends Hermes `complete_turn`, and already-patched candidates with the older notify-before-finalize ordering are migrated structurally and idempotently. Live E1 also proved that ordering alone does not populate assistant history. `assistant_message` must be read from the conversation's `currentNode` plus `mapping` state under the canonical conversation key. The patch discovers both state atoms and the upstream local→canonical conversation resolver structurally, resolves the renderer's local conversation ID first, then reads the current assistant message. Older injected notifiers using `projectId`/`title` state or direct unaliased `currentNode`/`mapping` reads are migrated to the V2 resolver-aware form.

Hermes turn context is appended through ChatGPT's native `extraDeveloperInstructionMessages` contract. The renderer patch structurally discovers the upstream hidden system/developer-message constructor and its message-ID factory from the paired `extraDeveloperInstructions` / `oneTurnDeveloperInstructions` mapping sites. Both Hermes `system_context` and `user_context` are represented as one-turn hidden developer messages so they expire after the next user message and do not become visible conversation turns. The patch does not trust minified constructor names; already-patched payloads that used unrelated current-build identifiers are migrated to the discovered constructor pair, and missing or ambiguous upstream semantics fail closed.

## `tool_call` phase (plain-Chat tool dispatch)

The host also serves a `tool_call` phase that executes a single Hermes tool in
the shared runtime, letting ordinary Chat conversations call genuine Hermes
tools with **no Custom-GPT gizmo**:

```text
renderer → electronBridge.hermesChatLifecycle({
  phase: "tool_call", name, arguments, callId, conversationId,
  client_conversation_id, session_id?
})
```

Main process:

- `tool_call` bypasses the gizmo-registration gate (it is keyed by the
  conversation, not a gizmo) and reuses the same process-local plain-Chat
  lifecycle binding keyed by `chat\0<conversation_id>`. If no lifecycle turn
  has opened yet, the binding is created lazily as `hs_codex_<uuid>`. A
  payload `session_id` that is missing or not a canonical `hs_codex_*` id
  (for example a raw conversation id) is re-mapped onto that shared
  conversation-keyed session, so identity observation, model lifecycle, and
  tool dispatch converge on one `SessionRuntime`.

Host:

- Lazily boots `model_tools` (the same registry instance the lifecycle
  session uses) and maps the advertised name: `hermes_tool_search`,
  `hermes_tool_describe`, and `hermes_tool_call` map onto Hermes's native
  Tool Search bridge (progressive disclosure over the full registry; the
  bridge is never a registry entry, so it is checked before the registry
  set); `hermes_<bare>` strips the prefix when `<bare>` is a registered
  tool; anything else is passed through so the registry's own "Unknown
  tool" error surfaces truthfully.
- Calls `model_tools.handle_function_call` with the session, task, and
  tool-call ids, records the executed call as a `tool_call` + `tool` row
  pair in the runtime transcript (failed calls are reported to the model
  but excluded from the transcript), and returns the parsed result plus a
  `tool_call` diagnostic event (`tool_call_error` for failures).

When the local Hermes runtime is not installed, `tool_call` answers
`{ok:false, enabled:false}` instead of raising, so plain-Chat turns proceed
without a Hermes layer and the host stays alive for subsequent requests.

This is the dispatch target for the `local-function-probe` executor (Path A):
tool execution runs in the same process/session as Hindsight/LCM state, with
no separate HTTP endpoint and no `hermes-chatgpt` bridge.

## Hidden context injection

Hermes uses two different authority channels, and Codex now mirrors that split.

The external memory provider's `MemoryManager.build_system_prompt()` output is injected as a visually hidden one-turn **system** message. Recalled memory and installed plugin `pre_llm_call` output are injected as a separate visually hidden, one-turn **user** message marked as contextual-retry content. The memory portion uses Hermes's native `build_memory_context_block()` fence before plugin context is appended.

This matches Hermes proper's API semantics: provider instructions remain system-level, while recalled memory and plugin context are appended to the user API content rather than promoted to system authority.

The canonical visible user message is never rewritten. The contextual user message is visually hidden, excluded after the next user message, and does not become the local visible prompt.

## Cancellation safety

Hermes recall/plugin work can take several seconds before ChatGPT receives the foreground request. Runtime QA exposed a race where a user could press Stop during this pre-stream interval and the request would later start anyway.

The feature now keeps a registration-scoped preflight cancellation registry and integrates with Codex's existing Stop handler. Cancellation is checked:

1. after `begin_turn`;
2. after `pre_api_request`;
3. immediately before `startCompletionStream`;
4. immediately after normal stream registration.

Real QA verifies interrupted turns do not produce a final assistant answer or successful Hindsight sync.

## Session shutdown

The lifecycle host implements explicit close/finalization through:

```text
LCM/context-engine on_session_end
  -> MemoryManager.on_session_end
  -> MemoryManager.shutdown_all
  -> hermes_cli.lifecycle.finalize_session
  -> plugin on_session_finalize / Relay cleanup
```

This path is verified through the live Electron candidate. Closing a lifecycle session ends native LCM/Hindsight state, runs `finalize_session()`, removes the Electron `(gizmo_id, client_conversation_id)` binding, and reopening the same conversation creates a fresh `hs_codex_*` session with `turn_number=1`.

## Background skill review

Successful turns can schedule Hermes's native background skill reviewer. The Codex helper lazily creates a quiet real `AIAgent` parent only when the configured cadence is due, then calls Hermes's own `_spawn_background_review()` path. The current profile routes that review to `bifrost / gemini/aux-quality` with `skills.creation_nudge_interval: 15`.

Because ChatGPT's server-internal model/tool iterations are not fully visible client-side, the lifecycle uses `model_iterations_estimate` (default `1` per successful client-visible turn) as a documented approximation for the native skill cadence. A new foreground turn preempts any active review using Hermes's own `cancel_background_review_for_live_turn()` API.

QA controls:

```bash
# Force one native skill review for each lifecycle session.
CODEX_HERMES_QA_FORCE_SKILL_REVIEW=1

# Disable all background review hosting.
CODEX_HERMES_BACKGROUND_REVIEW=0
```

Reviewer events include `background_review_host_ready`, `background_review_spawned`, `background_review_action`, `background_review_complete`, `background_review_cancelled`, and `background_review_host_close`.

Real installed-runtime QA has verified native reviewer-parent initialization, configured auxiliary routing, non-blocking foreground scheduling, clean cancellation on lifecycle-host shutdown, and natural auxiliary completion. A forced trivial review completed through `bifrost / gemini/aux-quality` in about 49 seconds with `cancelled=false` and no skill action required.

## Deterministic failure QA

The environment-only control accepts these QA-only values:

```bash
CODEX_HERMES_QA_FAULT=model_call_error
CODEX_HERMES_QA_FAULT=disable_context
CODEX_HERMES_QA_FAULT=suppress_complete
CODEX_HERMES_QA_FAULT=begin_only
CODEX_HERMES_QA_FAULT=identity_only
```

`model_call_error` runs `begin_turn` and `pre_api_request`, then routes through Codex's real stream-error callback before a real ChatGPT request is started. `disable_context` keeps the lifecycle active while withholding Hermes system/user context from `extraDeveloperInstructionMessages`. `suppress_complete` keeps `begin_turn`/`pre_api_request` active and lets the native model request finish while suppressing only the renderer's terminal `complete_turn` notification. `begin_only` keeps a real lifecycle `probe → begin_turn`, withholds Hermes context, skips `pre_api_request`, and suppresses terminal completion notification so UI coupling can be localized to the earliest lifecycle activation. With `begin_only`, the auxiliary `CODEX_HERMES_QA_FAST_BEGIN=1` control allocates the normal main-process session and returns an enabled empty-context begin response immediately, without launching the Hermes helper; this isolates renderer lifecycle activation from helper latency/side effects. `identity_only` makes the lifecycle probe report disabled while leaving the independent server-ID `conversation_identity` observer active, which isolates identity/session provisioning from renderer begin activation. With `identity_only`, `CODEX_HERMES_QA_FAST_IDENTITY=1` allocates the normal main-process conversation session and immediately returns a successful identity response without launching the helper; this separates successful IPC/session mapping from helper/session-open side effects. Helper-side session provisioning can be split further with `CODEX_HERMES_QA_SESSION_INIT=no_memory`, `no_context`, `no_hooks`, or `minimal`; `minimal` still imports Hermes and creates/logs the lifecycle runtime while skipping Hindsight initialization, context-engine session start, and session-start hooks. These modes exist only for deterministic lifecycle QA; unsupported values are ignored.

## Runtime diagnostics

Structured lifecycle diagnostics are appended to:

```text
$CODEX_LINUX_APP_STATE_DIR/hermes-chat-lifecycle.jsonl
```

Set:

```bash
CODEX_HERMES_LIFECYCLE_DEBUG=1
```

to surface helper stderr in the Electron main-process log.

Useful diagnostic events include:

```text
host_start
session_open
begin_turn
pre_api_request
post_api_request
api_request_error
on_session_end
complete_turn
abort_turn
model_call_error
session_close
helper_error
```

## Testing

Feature tests:

```bash
node --test linux-features/hermes-chat-lifecycle/test.js
```

Current status at 2026-09-06:

```text
12 / 12 passing
```

The test suite covers:

- opt-in descriptors;
- trusted IPC registration;
- preload bridge exposure;
- exact Gizmo probe path;
- renderer `begin_turn` / `pre_api_request` injection;
- split hidden context construction: provider system message plus contextual user message;
- terminal success/error/cancel hooks;
- pre-stream cancellation registry;
- patch idempotency;
- unrelated-asset no-op behavior;
- fake native-Hermes hook passthrough;
- persistent session and memory-manager state;
- API request correlation/pairing.

### Composed candidate validation

After a runtime QA pass caught a minified-variable collision that isolated patch checks did not detect, the final candidate ASAR is also extracted after all enabled feature patches have composed.

The actual candidate bundles are syntax checked:

```bash
node --check .vite/build/main-*.js
node --check webview/assets/app-initial-*.js
```

This composed-artifact validation is part of the required QA procedure for future changes to this feature.

## Verified runtime behavior

The modified `codex-app-next` has been launched locally without sudo and inspected through Electron remote debugging.

Verified in the live Winston Custom GPT:

- native Superpowers reaches the ChatGPT model on first lifecycle turn;
- Hindsight initializes from the configured `memory.provider: hindsight`;
- real Hindsight memories are recalled before ChatGPT runs;
- successful turns queue native Hindsight sync;
- interrupted turns skip successful Hindsight sync;
- native LCM is active and durably stores the Codex transcript in `~/.hermes/lcm.db`;
- logical `pre_api_request` / `post_api_request` hooks fire around the observable ChatGPT conversation stream;
- user cancellation produces `interrupted=true` and no final answer.

See the status document for exact QA evidence and current remaining work.

## Known boundary: Action-session unification

The Codex lifecycle session is currently distinct from the Hermes session created/used by Custom GPT Actions through `hermes-chatgpt`:

```text
Codex lifecycle session != Custom GPT Action session
```

Tool calls can still use Hermes's canonical Action/tool lifecycle in the existing service, but they do not yet share the same lifecycle session identity/state.

Unifying those sessions is intentionally deferred until Codex-local lifecycle work is complete and coordinated bridge changes are safe to perform.
