# Hermes Lifecycle for ChatGPT Chat Mode in Codex Desktop

Status: active architecture + roadmap; phases 0–5 implemented and runtime-verified\
Branch: `chris-custom` (tracking `fork/chris-custom`)\
Scope: Codex Desktop ChatGPT Chat mode, only for explicitly registered Custom GPT/Gizmo IDs that use Hermes tooling\
Out of scope for this phase: modifying `/home/chris/Projects/hermes-chatgpt`\
Verified implementation/QA record: [`hermes-chat-lifecycle-status.md`](./hermes-chat-lifecycle-status.md)

## Objective

Make ChatGPT Chat mode behave as closely as practical to a native Hermes agent while ChatGPT remains the foreground conversational model and owns reasoning, response generation, and GPT Action selection.

Hermes supplies the surrounding lifecycle: sessions, plugins, hooks, Hindsight recall/retain, context-engine integration, Superpowers, tool middleware for Hermes-backed Actions, post-turn learning, and background memory/skill review.

Existing `hermes-chatgpt`, Chrome extension, Stream Enhancer, and prior lifecycle experiments are reference material only. They do not constrain this architecture.

## Current implementation status

As of 2026-09-06, the Codex-side implementation has moved beyond the original design-only stage. The following are implemented and verified in the modified Electron app using the Winston Custom GPT:

- exact registered-Gizmo activation with the feature disabled by default and a trusted versioned local manifest as the primary registration source;
- dedicated trusted Electron IPC with text-only message payload normalization and a persistent Hermes lifecycle helper;
- native Hermes plugin discovery and `pre_llm_call` / `post_llm_call` dispatch;
- native Superpowers first-turn bootstrap injection;
- native Hindsight provider initialization, recall, one-turn hidden context injection, successful-turn sync, and interrupted-turn skip behavior;
- native LCM context-engine session binding and durable transcript ingestion into `~/.hermes/lcm.db`;
- logical ChatGPT `pre_api_request` / `post_api_request` mapping around the observable `startCompletionStream()` boundary;
- per-turn `on_session_end` with success/failure/interrupted semantics;
- pre-stream cancellation protection so a Stop during Hermes recall cannot resurrect a ChatGPT request afterward;
- final composed-ASAR syntax validation after all enabled feature patches are applied.

Session finalization, background skill review, success/error/interruption semantics, and steady-state two-turn API correlation are runtime-verified. Action-session unification remains intentionally deferred because it is the first likely step requiring coordinated `hermes-chatgpt` changes.

See [`hermes-chat-lifecycle-status.md`](./hermes-chat-lifecycle-status.md) for runtime evidence, QA results, known boundaries, and the current roadmap.

## First-principles findings

The current Codex webview contains a semantic ChatGPT turn builder. It already supports invisible per-turn instruction channels before the ChatGPT request is created:

- `oneTurnDeveloperInstructions`
- `extraDeveloperInstructions`
- `systemHints`

`oneTurnDeveloperInstructions` are converted to visually hidden `system` messages with `exclude_after_next_user_message: true`. That channel is appropriate only for Hermes context that is system-authority in Hermes proper, such as the external memory provider's `build_system_prompt()` block.

Hermes proper deliberately appends recalled memory and `pre_llm_call` plugin context to the current **user** API content. Codex therefore injects those lower-authority components as a separate visually hidden contextual-retry `user` message with one-turn expiry. The canonical visible user prompt remains unchanged. This preserves both UI invisibility and Hermes's authority boundary.

The outgoing ChatGPT request also contains exact Custom GPT identity through:

```js
conversation_mode: {
  kind: "gizmo_interaction",
  gizmo_id: "..."
}
```

This allows deterministic activation for registered Hermes-backed Custom GPTs. DOM heuristics, assistant-text markers, and Action-result interception are unnecessary for scoping.

The ChatGPT turn orchestration also owns completion, error, cancellation, and resume callbacks, providing semantic post-turn boundaries without DOM scraping.

## Target architecture

```text
User submits message
        |
        v
Codex ChatGPT turn adapter
        |
        +--> Hermes External Conversation Runtime: begin_turn
        |      - on_session_start when needed
        |      - pre_llm_call
        |      - Hindsight / MemoryManager on_turn_start
        |      - external-memory prefetch
        |      - Superpowers / LCM / user plugins
        |      - lifecycle bookkeeping
        |
        +<-- split ephemeral context
        |
        +--> hidden one-turn system: provider system prompt
        |
        +--> hidden contextual user: fenced recall + plugin context
        |
        v
normal ChatGPT request / Custom GPT model loop
        |
        +--> Hermes-backed GPT Actions
        |      - canonical Hermes tool middleware
        |      - pre_tool_call
        |      - execution
        |      - post_tool_call
        |      - transform_tool_result
        |
        v
final ChatGPT assistant response
        |
        v
Codex terminal-turn adapter
        |
        +--> Hermes External Conversation Runtime: complete_turn
               - post_llm_call
               - Hindsight / MemoryManager sync
               - LCM ingest
               - post-turn lifecycle hooks
               - memory/skill review cadence
               - background reviewer
```

## Ownership boundaries

### ChatGPT owns

- foreground model reasoning
- Custom GPT instructions
- foreground response generation
- GPT Action selection
- continuation after tool results
- ChatGPT-native server tools

### Hermes owns

- lifecycle session
- plugin discovery and hooks
- Hindsight recall and retain
- external-memory prefetch and sync
- context-engine / LCM lifecycle
- Superpowers lifecycle
- Hermes Action tool middleware and hooks
- memory/skill review cadence
- background self-improvement

### Codex owns

- determining whether a turn is an eligible Hermes-backed Custom GPT turn
- calling lifecycle before the first ChatGPT model request
- injecting returned lifecycle context invisibly
- observing success/error/cancel terminal states
- delivering final conversation state to Hermes
- maintaining desktop-side conversation/session binding

## Activation and safety

The lifecycle must be disabled unless all activation conditions hold:

1. The surface is ChatGPT Chat mode.
2. `conversation_mode.kind === "gizmo_interaction"`.
3. `gizmo_id` is explicitly registered as Hermes-backed.
4. The lifecycle feature is enabled locally.

Ordinary ChatGPT, other Custom GPTs, Codex task/agent mode, Work mode, and unrelated webviews must remain byte-for-byte behaviorally unchanged.

Production registration now comes from the trusted version-1 local Gizmo manifest owned by the Codex main process. `CODEX_HERMES_GIZMO_IDS` remains a development override only. Session reuse is process-local by design: a Codex restart rotates the Hermes lifecycle session while preserving the ChatGPT client conversation ID as the continuity key.

## Codex integration seams

### Renderer/webview pre-turn seam

Patch the semantic ChatGPT completion builder before the real submitted turn constructs its conversation request. Do not run lifecycle work from `/f/conversation/prepare`, because Codex may issue speculative prepare requests while the user is still typing.

Input to `begin_turn` should include the strongest identifiers available at the call site:

```json
{
  "phase": "begin_turn",
  "gizmo_id": "g-...",
  "conversation_id": "...",
  "client_conversation_id": "...",
  "turn_id": "...",
  "user_message": "...",
  "history": [],
  "model": "..."
}
```

Returned `context` is appended to `oneTurnDeveloperInstructions` without changing visible user content.

### Renderer/webview terminal seam

Use existing stream terminal callbacks. Emit exactly one lifecycle event per logical turn:

- `complete_turn`
- `abort_turn`
- `model_call_error`

The complete event should include the original user message, final assistant response, conversation history/mapping when available, tool/action observations, and stable turn identity for deduplication.

### Electron IPC seam

Add a dedicated trusted IPC channel exposed through `electronBridge`, rather than overloading the generic `codex_desktop:message-from-view` schema.

The renderer calls:

```js
window.electronBridge.hermesChatLifecycle(request)
```

The main process validates the IPC sender through Codex's existing trusted-event predicate and invokes the lifecycle host.

No network-listening lifecycle port is required.

## Hermes External Conversation Runtime

The long-term abstraction should be independent of ChatGPT and independent of the current `hermes-chatgpt` service:

```text
open_session
begin_turn
begin_api_request
end_api_request
api_request_error
complete_turn
abort_turn
close_session
```

For the Codex-only implementation phase, the Electron main process may invoke a packaged Python helper that imports the locally installed Hermes runtime. This proves the lifecycle contract without modifying the active ChatGPT bridge.

The helper should ultimately use Hermes proper rather than duplicating plugin behavior:

- `hermes_cli.lifecycle.invoke_hook`
- canonical plugin discovery
- `MemoryManager`
- configured external memory providers
- context-engine integration
- background review APIs

## Hermes hook mapping

| Hermes lifecycle | Codex / ChatGPT boundary | Expected fidelity |
| --- | --- | --- |
| session start | first eligible turn | high |
| `pre_llm_call` | semantic ChatGPT turn before request construction | high |
| Hindsight prefetch | `begin_turn` | high |
| Superpowers bootstrap | hidden one-turn contextual user message (native user-content authority) | high |
| LCM pre-turn recall | `begin_turn` | high |
| `pre_api_request` | immediately before ChatGPT stream request | medium/high |
| `post_api_request` | request/stream terminal callback | medium/high |
| `api_request_error` | ChatGPT error callback | high |
| Hermes Action `pre_tool_call` | Action transport / canonical tool executor | high |
| Hermes Action `post_tool_call` | Action transport / canonical tool executor | high |
| `transform_tool_result` | Action transport / canonical tool executor | high |
| `post_llm_call` | successful terminal ChatGPT turn | high |
| Hindsight retain/sync | `complete_turn` | high |
| LCM ingest | `complete_turn` | high |
| background skill/memory review | after `complete_turn` | high when real reviewer is hosted |
| `transform_llm_output` | after ChatGPT answer exists | partial |
| pre-hooking ChatGPT-native server tools | unavailable | low/impossible |
| ChatGPT internal compaction events | server-owned | unavailable directly |

## Compaction strategy

ChatGPT can compact server-side context without exposing Hermes-equivalent compaction hooks. Essential lifecycle steering must therefore be refreshed on each turn.

Hindsight and plugin pre-turn context naturally refresh every turn. Superpowers should retain its native first-turn bootstrap semantics and may need a compact recurring guard after the first turn so invisible ChatGPT compaction does not permanently remove steering.

## Session model

Codex should bind:

```text
(gizmo_id, ChatGPT conversation identity) -> Hermes lifecycle session
```

Lifecycle operations are idempotent by `(session_id, turn_id, phase)`.

During the Codex-only phase, this lifecycle session may be local and distinct from the currently running remote `hermes-chatgpt` Action session. Session unification across desktop lifecycle and GPT Actions is a later bridge-boundary task and must not be attempted by modifying the active bridge without explicit coordination.

## Development phases

### Phase 0 - documentation and conformance scaffolding — **implemented**

- [x] Add this plan and the live implementation-status record.
- [x] Add disabled-by-default `hermes-chat-lifecycle` feature.
- [x] Add contract tests for current ChatGPT bundle anchors.
- [x] Add patch idempotency and unrelated-bundle tests.
- [x] Add final composed-candidate ASAR syntax validation after all enabled feature patches are applied.
- [x] Run long-lived Electron/CDP QA from an independent user-systemd unit/scope, never as a descendant of `hermes-chatgpt.service`; bridge hard recovery terminates that service cgroup and would otherwise kill the app under test.

### Phase 1 - Codex IPC and semantic lifecycle probe — **implemented and runtime-verified**

- [x] Add dedicated preload IPC method.
- [x] Add trusted main-process lifecycle handler.
- [x] Add renderer pre-turn call for eligible Gizmos.
- [x] Inject provider instructions as hidden one-turn system context and recalled/plugin context as hidden one-turn contextual user content, preserving native Hermes authority.
- [x] Add terminal success/error/cancel event delivery.
- [x] Log structured lifecycle diagnostics locally.
- [x] Add exact registered-Gizmo `probe` activation, trusted local manifest loading, and pre-stream cancellation protection.

Success criterion met: real Winston turns behave normally while diagnostics prove lifecycle work occurs before the ChatGPT request and successful/interrupted terminal events are emitted once.

### Phase 2 - real Hermes pre-turn hooks in Codex helper — **implemented and runtime-verified**

- [x] Import locally installed Hermes runtime from the persistent helper.
- [x] Discover native plugins.
- [x] Invoke real `pre_llm_call` with Hermes-compatible payload.
- [x] Return plugin context unchanged to Codex.
- [x] Verify native Superpowers context reaches ChatGPT on first turn and does not duplicate on later turns.
- [x] Bind the plugin-registered LCM context engine and pass it as `context_compressor`.

Success criterion met: the installed Hermes plugins' own hook outputs are what ChatGPT receives; Superpowers is not reimplemented in Codex.

### Phase 3 - Hindsight prefetch/retain — **implemented and runtime-verified**

- [x] Instantiate the configured Hermes memory provider through native `MemoryManager` loading.
- [x] Call `on_turn_start`, provider system prompt, and `prefetch_all` before ChatGPT.
- [x] Inject returned Hindsight context invisibly with plugin context.
- [x] On successful completion call canonical `sync_all` with final user/assistant/history.
- [x] Queue future prefetch using Hermes's native async-recall behavior.
- [x] Skip successful memory sync for interrupted/partial turns.
- [x] Keep one persistent provider/session runtime across turns.

Success criterion met: real Winston turns recall Hindsight memory automatically before ChatGPT and successful turns queue native Hindsight sync without explicit foreground memory-tool calls.

### Phase 4 - LCM and post-turn lifecycle — **substantially implemented; finalization/error QA still open**

- [x] Run native `post_llm_call` on successful ChatGPT turns.
- [x] Bind the native plugin-registered LCM context engine to each lifecycle session.
- [x] Supply accumulated conversation history to LCM and verify durable rows in `~/.hermes/lcm.db`.
- [x] Map the observable ChatGPT stream to logical `pre_api_request` / `post_api_request` hooks.
- [x] Implement `api_request_error` mapping for observable ChatGPT failures.
- [x] Implement success/failure/interrupted `on_session_end` semantics.
- [x] Implement context-engine end, memory-provider end/shutdown, and `finalize_session()` on explicit close.
- [x] Complete explicit real-app close-session/finalization QA, including Electron binding removal and fresh-session recreation.
- [x] Exercise the real renderer error callback through deterministic QA fault injection and verify `api_request_error`, failed `on_session_end`, and absence of successful post-turn work.

### Phase 5 - background self-improvement — **implemented and runtime-verified**

- [x] Host a real Hermes auxiliary reviewer agent after foreground completion.
- [x] Preserve the configured Hermes skill-review cadence using a documented client-visible iteration estimate (`1` per successful ChatGPT turn by default).
- [x] Keep foreground ChatGPT latency independent of the reviewer.
- [x] Preempt active reviews on new foreground turns using Hermes's native cancellation API.
- [x] Route review to the configured auxiliary runtime (`bifrost / gemini/aux-quality`).
- [x] Verify natural auxiliary completion with `cancelled=false` using the installed Hermes runtime.
- [x] Keep external Hindsight as the automatic memory owner; background review is skill-focused because the built-in MEMORY.md store is disabled in this profile.

### Phase 6 - choose and implement the ideal Hermes tool path

Read-only architecture research superseded the original "one shared session ID" goal. Native Hermes already separates operational `session_key` / `task_id` state from lifecycle `session_id`, and those lifetimes should remain distinct.

Research priority:

1. Prove or disprove generalized ChatGPT Chat `local_function_signatures` execution for arbitrary Hermes tools. The renderer already advertises a built-in local `handoff` function and can submit hidden local tool-result messages back through the normal ChatGPT continuation path.
2. If arbitrary local tools are supported robustly, execute Hermes tools in the Codex-local Hermes host and remove the public GPT Action bridge from the interactive Codex Chat tool loop.
3. Otherwise retain GPT Actions with a small owner-only local control plane; keep stable bridge workspace identity (`session_key` / `task_id`) separate from rotating Codex lifecycle identity (`session_id`), propagate real turn/request/tool correlation, and remove model-driven bootstrap.

Do not modify `hermes-chatgpt` until this architecture choice is proven and the exact bridge change, if any, has been presented explicitly.

## QA strategy

### Static/patch QA

- current official ASAR contract matches exactly once
- idempotent patching
- drift fails soft and reports a useful warning
- feature disabled means upstream ASAR remains unchanged
- unrelated app-initial assets remain unchanged

### Runtime QA

Launch the locally modified ChatGPT Community build and inspect with Electron remote debugging when useful.

Validate:

```text
eligible Custom GPT turn
  -> begin_turn once
  -> hidden Hermes context exists before stream request
  -> visible user message remains unchanged
  -> normal GPT Actions continue to work
  -> complete_turn once

ordinary ChatGPT turn
  -> zero Hermes lifecycle calls

other Custom GPT
  -> zero Hermes lifecycle calls

cancelled turn
  -> abort_turn
  -> no durable memory sync
```

### Lifecycle conformance targets

```text
[x] session start once per lifecycle session
[x] pre_llm_call once per submitted user turn
[x] first-turn Superpowers context reaches model
[x] Hindsight prefetch completes before ChatGPT request
[x] logical pre_api_request precedes startCompletionStream
[x] logical post_api_request occurs on successful stream completion
[x] post_llm_call once per successful turn
[x] Hindsight sync once per successful turn
[x] interrupted output is not retained as successful memory
[x] LCM receives and durably stores the final conversation snapshot
[x] Hermes Action tools keep canonical tool hooks in their existing Action path
[ ] explicit real-app close_session/finalization QA
[ ] real observable api_request_error QA
[ ] background skill/memory review follows configured cadence
[ ] lifecycle session and Action session are unified
```

## Known hard boundaries

- ChatGPT-native server tools execute outside Hermes, so Hermes cannot reliably veto them with `pre_tool_call`.
- `transform_llm_output` happens after OpenAI has already committed the ChatGPT response; local rewriting would diverge from server history.
- ChatGPT server-side compaction is not directly observable as Hermes `pre_compact/post_compact`.
- Exact lifecycle/Action session unification requires a protocol understood by the Action service and is intentionally deferred until bridge work can be coordinated.

## Current implementation rule

Work in `/home/chris/Projects/codex-desktop-linux` on `chris-custom`. Preserve unrelated local changes. Keep `hermes-chatgpt` read-only until coordinated separately.
