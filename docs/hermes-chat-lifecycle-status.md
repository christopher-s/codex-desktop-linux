# Hermes Chat Lifecycle — Implementation Status

Last updated: 2026-09-07\
Branch: `chris-custom` (tracking `fork/chris-custom`)\
Repository: `/home/chris/Projects/codex-desktop-linux`\
Upstream ChatGPT package used for QA: `26.901.41600`\
Current QA candidate: `/home/chris/Projects/codex-desktop-linux/codex-app-next`\
Bridge policy: `/home/chris/Projects/hermes-chatgpt` remains read-only until coordinated separately.

## Executive summary

Codex Desktop can now host a substantial portion of the native Hermes agent lifecycle around ChatGPT Chat mode while ChatGPT remains the foreground conversational model. The integration is scoped to explicitly registered Custom GPT/Gizmo IDs and is disabled by default.

The verified Codex-side lifecycle currently provides:

- exact Custom GPT/Gizmo scoping;
- trusted Electron IPC for lifecycle calls;
- a persistent Hermes lifecycle host using the installed Hermes Agent runtime;
- native Hermes plugin discovery and hook dispatch;
- native Superpowers `pre_llm_call` injection;
- native Hindsight provider initialization, recall, prefetch, and successful-turn sync;
- native LCM context-engine session binding and durable transcript ingestion;
- logical ChatGPT `pre_api_request`, `post_api_request`, and `api_request_error` hook mapping;
- per-turn `on_session_end` semantics;
- interrupted-turn handling that avoids successful memory retention;
- native session finalization plumbing through `hermes_cli.lifecycle.finalize_session()`;
- fail-soft behavior when Hermes is unavailable;
- exact-count ASAR patch guards, patch idempotency, and composed-candidate syntax validation.

The major remaining architectural boundary is session unification between the Codex-created Hermes lifecycle session and the Hermes session used by Custom GPT Actions through the existing `hermes-chatgpt` service.

## Current runtime architecture

```text
User submits a message in ChatGPT Chat mode
              |
              v
Codex semantic ChatGPT turn orchestrator
              |
              +--> fast registered-Gizmo probe
              |
              +--> Hermes lifecycle begin_turn
              |      - create/reuse stable lifecycle session
              |      - MemoryManager.on_turn_start
              |      - Hindsight system prompt + prefetch
              |      - native pre_llm_call hooks
              |      - Superpowers
              |      - LCM plugin/context-engine hooks
              |
              +<-- split one-turn lifecycle context
              |
              +--> hidden system message: provider system prompt only
              |
              +--> hidden contextual user message: fenced recall + plugin context
              |
              v
Hermes pre_api_request
              |
              v
ChatGPT startCompletionStream()
              |
              +--> ChatGPT model reasoning
              +--> Custom GPT Actions / server tools
              |
              v
terminal stream state
      | success                  | error                    | user stop
      v                          v                          v
post_api_request          api_request_error           interrupted turn
post_llm_call             on_session_end(failed)      on_session_end(interrupted)
LCM on_turn_complete                                  no successful memory sync
Hindsight sync
on_session_end(completed)
```

## Code added

The implementation is isolated under:

```text
linux-features/hermes-chat-lifecycle/
├── README.md
├── feature.json
├── lifecycle_helper.py
├── patch.js
└── test.js
```

Primary architecture/roadmap:

```text
docs/hermes-chat-lifecycle-plan.md
```

This status/QA record:

```text
docs/hermes-chat-lifecycle-status.md
```

## Feature activation

The feature manifest is `defaultEnabled: false`.

Eligible Gizmos are registered by a versioned local main-process manifest at:

```text
$CODEX_LINUX_APP_STATE_DIR/hermes-chat-lifecycle-gizmos.json
```

or, by default:

```text
~/.local/state/codex-desktop/hermes-chat-lifecycle-gizmos.json
```

Version 1 contains a `gizmos` object keyed by exact `g-...` IDs. An entry is active only when it is an object whose `enabled` field is omitted or exactly boolean `true`. The parser rejects malformed/wrong-version manifests, non-regular files, files over 256 KiB, invalid Gizmo IDs, and non-boolean enabled values by failing closed. The file is re-read on every probe.

`CODEX_HERMES_GIZMO_MANIFEST` can point to an alternate manifest. `CODEX_HERMES_GIZMO_IDS` remains an explicit development override and takes precedence when non-empty; invalid override IDs are filtered and there is no manifest fallback in that case.

The Winston QA Gizmo discovered from the live Codex React state is:

```text
g-6a3c531bc4948191aafbf19a1996bf10
```

Black Monolith now registers Winston through the default local manifest with owner-only (`0600`) permissions. Runtime QA launched Codex with no `CODEX_HERMES_GIZMO_IDS` or custom-manifest environment variable: Winston probed enabled, an unregistered Gizmo probed disabled, a live manifest disable/restore changed probe results immediately, and a full Winston turn completed as `MANIFEST-OK` through the normal Hermes lifecycle.

## Stable lifecycle/session identity

Codex binds:

```text
(gizmo_id, client_conversation_id) -> hs_codex_<uuid>
```

The stable ChatGPT client conversation ID is used as the Hermes/LCM conversation identity. OpenAI's server conversation ID is tracked separately as metadata because it may appear/change after the first turn.

This prevents LCM and other session-scoped providers from being rebound mid-conversation.

Session reuse is intentionally scoped to one Codex main-process lifetime. Repeated turns in the same process reuse the existing `hs_codex_*` binding. After a Codex restart, the in-memory map and persistent helper are recreated; the next eligible turn for the same ChatGPT conversation creates a fresh `hs_codex_*` session and is treated as `is_first_turn=true`. An executable main-runtime test covers reuse within one runtime and rotation across two independent runtime contexts using the same conversation identity.

## Hermes runtime hosting

Electron launches one persistent helper:

```text
lifecycle_helper.py --persistent
```

The main process correlates newline-delimited JSON requests/responses with `_request_id` values and keeps one long-lived helper process for the Codex instance.

The helper keeps one `SessionRuntime` per Codex-created Hermes session containing:

- stable lifecycle session ID;
- stable Codex conversation ID;
- latest server conversation ID;
- model identity;
- `MemoryManager`;
- configured memory provider;
- plugin-registered context engine;
- turn counter;
- logical ChatGPT API-call counter/state;
- accumulated conversation transcript.

The Electron host automatically prefers:

```text
~/.hermes/hermes-agent/venv/bin/python3
```

or:

```text
$HERMES_AGENT_ROOT/venv/bin/python3
```

because provider dependencies such as `hindsight-client` are installed in the Hermes venv. `CODEX_HERMES_PYTHON` is an explicit override.

### Python 3.14 compatibility

Black Monolith's system Python is 3.14.4. The current Hermes `DaemonThreadPoolExecutor` mirrors CPython 3.8–3.13 private `ThreadPoolExecutor` internals and fails on 3.14 because `_initializer` no longer exists.

The Codex helper contains a narrowly scoped Python 3.14 compatibility executor that preserves daemon-thread and `contextvars` behavior while using the 3.14 `_worker(executor_ref, worker_context, work_queue)` API. The installed Hermes checkout is not modified.

The normal path uses the Hermes venv's Python 3.11, so this shim acts as a safe fallback for other environments.

## Native Hermes lifecycle coverage

| Lifecycle area | Status | Notes |
| --- | --- | --- |
| plugin discovery | verified | Uses installed Hermes runtime/plugin manager. |
| `on_session_start` | implemented/directly probed | Runs when Codex creates a lifecycle session. |
| `pre_llm_call` | verified in real ChatGPT turn | Superpowers + LCM observed. |
| Hindsight system prompt | verified | Injected before ChatGPT request. |
| Hindsight recall/prefetch | verified in real ChatGPT turn | 50–70 memories observed during QA. |
| hidden model context injection | verified | Split authority: provider prompt is hidden system context; fenced recall + plugin output are hidden contextual user context. |
| `pre_api_request` | verified in real ChatGPT turn | Fires immediately before `startCompletionStream()`. |
| `post_api_request` | verified in real ChatGPT turn | Fires on successful terminal stream state. |
| `api_request_error` | verified through deterministic real-renderer fault QA | Uses Codex's real stream-error callback; UI cleanup and failed lifecycle semantics verified. |
| `post_llm_call` | verified | Runs on successful terminal turns. |
| LCM `on_turn_complete` | verified/directly probed | Real engine receives accumulated transcript. |
| durable LCM ingest | verified | Rows observed in `~/.hermes/lcm.db`. |
| Hindsight successful-turn sync | verified in real ChatGPT turn | `memory_sync_queued=true`, no sync error. |
| Hindsight interrupted-turn behavior | verified | No successful sync on Stop. |
| per-turn `on_session_end` | verified in success and interrupt paths | Correct completed/failed/interrupted flags. |
| context-engine `on_session_end` | verified in Electron close/reopen QA | Native LCM end hook completed without error. |
| MemoryManager `on_session_end` / shutdown | verified in Electron close/reopen QA | Native Hindsight end + shutdown completed without error. |
| `on_session_finalize` | verified through `finalize_session()` | Electron close/reopen produced a fresh `hs_codex_*` session with turn counter reset. |
| background skill reviewer | verified | Native auxiliary review routing, cancellation/preemption, cadence, and natural completion are runtime-proven; external Hindsight remains the memory owner. |
| Action tool hooks | existing Hermes Action path | Session is still separate from Codex lifecycle session. |
| `transform_llm_output` | partial only | ChatGPT answer already committed server-side. |
| ChatGPT-native server-tool pre-hooks | unavailable | Execution occurs on OpenAI servers. |
| ChatGPT internal compaction hooks | unavailable | No equivalent client lifecycle event. |

## Verified Hindsight behavior

Configured provider:

```yaml
memory:
  provider: hindsight
```

The live Codex helper has initialized the real provider and returned lifecycle responses such as:

```text
memory_provider: hindsight
memory_active: true
memory_context_chars: 18177
recall_status: Hindsight — recalled 63 memories
```

A real Winston turn asking for the tracked Codex branch received Hindsight recall before the foreground ChatGPT request and answered:

```text
chris-custom
```

The terminal lifecycle then reported:

```text
memory_sync_queued = true
memory_sync_error = ""
```

The foreground ChatGPT model does not need to explicitly call a memory tool for this automatic lifecycle.

### Hindsight async recall semantics

The current Hermes configuration uses asynchronous recall (`recall_sync=false`). Hermes therefore warms future recall after successful turns. The persistent host is required so Hindsight's cache, counters, and queued work survive between lifecycle operations.

## Verified Superpowers behavior

The helper executes the installed Superpowers plugin's native `pre_llm_call` hook. No ChatGPT-specific copy of the bootstrap exists.

On first lifecycle turn, QA observed approximately 5.6K characters of native Superpowers context beginning with the installed bootstrap text. On the second turn in the same session, Superpowers correctly returned no duplicate bootstrap because `is_first_turn=false`.

## Verified LCM behavior

The installed plugin context engine resolves to:

```text
hermes_plugins.hermes_lcm.engine.LCMEngine
name = lcm
```

A direct persistent lifecycle probe created durable LCM rows in:

```text
~/.hermes/lcm.db
```

under the Codex lifecycle session and stable client conversation identity.

The probe stored both user and assistant messages with the synthetic token `cobalt-739`, proving that the real LCM engine ingested the Codex transcript.

Real ChatGPT turns also report `context_engine=lcm` with no turn-complete error.

## ChatGPT API-hook mapping

Hermes proper may make multiple provider API calls inside its own model/tool loop. ChatGPT owns that loop server-side, so Codex cannot observe each internal OpenAI model call.

The integration maps the one client-visible ChatGPT conversation stream to a logical Hermes API request:

```text
pre_api_request
    -> immediately before Codex startCompletionStream()
post_api_request
    -> successful terminal stream state
api_request_error
    -> observable ChatGPT client/model error
```

Payloads include Hermes-style request correlation fields such as:

- `task_id`;
- `turn_id`;
- `api_request_id`;
- `session_id`;
- `api_call_count`;
- `started_at` / `ended_at`;
- platform/model/provider/base URL;
- request message/history metadata.

This is intentionally documented as a *logical ChatGPT client request*. It does not claim visibility into OpenAI server-internal model subcalls.

## Cancellation race discovered and fixed

Waiting for Hindsight/plugin context introduces pre-stream latency. Initial QA found that a user could press Stop while `begin_turn` was still running. Codex had not yet registered a ChatGPT stream ID, so its normal Stop mechanism had nothing to cancel; after recall completed, the request could start anyway.

The fix adds a registration-scoped preflight cancellation registry:

```text
probe eligible Gizmo
    -> register pending preflight
    -> await begin_turn
    -> check cancelled
    -> await pre_api_request
    -> check cancelled
    -> mark stream starting
    -> startCompletionStream
    -> reconcile cancellation immediately after stream registration
```

The existing Codex Stop handler marks the pending Hermes preflight canceled. If no ChatGPT stream exists yet, it returns early and the lifecycle path terminates the turn after recall returns.

Real QA now shows:

```text
on_session_end:
  completed = false
  failed = false
  interrupted = true
  turn_exit_reason = interrupted

abort_turn
```

with:

```text
no post_api_request
no complete_turn
no successful Hindsight sync
no assistant answer
```

## QA performed

### Feature tests

Current feature suite:

```bash
node --test linux-features/hermes-chat-lifecycle/test.js
```

Status at this document update:

```text
12 / 12 passing
```

Coverage includes:

- opt-in feature descriptors;
- trusted main-process IPC;
- preload bridge method;
- Gizmo probe;
- `begin_turn` renderer injection;
- `pre_api_request` renderer injection;
- text-only renderer→Electron lifecycle payload normalization (no mutable message objects cross IPC);
- split hidden context construction with provider system authority and contextual user authority;
- terminal success/error/cancel hooks;
- preflight cancellation registry;
- existing Stop-handler integration;
- patch idempotency;
- unrelated-asset no-op behavior;
- native hook passthrough with a fake Hermes root;
- persistent multi-turn session state;
- fake `MemoryManager` persistence;
- API request correlation and pairing.

### Real ASAR patch validation

Patches are applied against the official `26.901.41600` package with exact-count semantic anchors.

The individual transformed main and renderer bundles are syntax checked with Node.

After a cross-feature minified-name collision was discovered during runtime QA, the procedure was strengthened: the final **composed candidate ASAR** is extracted after every rebuild and its actual main/renderer JavaScript is syntax checked.

Current composed-candidate validation:

```text
node --check .vite/build/main-C5K7o1Hr.js   PASS
node --check webview/assets/app-initial-*.js PASS
```

### Real Electron/ChatGPT QA

The modified app has been launched repeatedly without sudo using:

```text
codex-app-next/start.sh
```

with Electron remote debugging on port `9232`.

Verified through the live Winston Custom GPT:

- preload bridge present;
- direct lifecycle IPC reaches native Hermes;
- real Superpowers context returned;
- real Hindsight recall returned;
- successful real ChatGPT turn;
- successful Hindsight sync;
- native LCM active during real turn;
- `pre_api_request` / `post_api_request` sequence;
- real user Stop path;
- interrupted turn avoids successful memory sync;
- pre-stream cancellation race fixed.

### Final normal two-turn regression

The steady-state two-turn candidate was rebuilt from official `26.901.41600`, launched with the Winston development registration override and lifecycle debug logging, and exercised without QA fault/force-review flags. A later manifest-only QA pass removed that development override entirely and is documented in the activation section above.

A two-turn Winston conversation proved the steady-state lifecycle:

```text
turn 1
  begin_turn
  pre_api_request  api_call_count=1
  post_api_request api_call_count=1
  complete_turn    memory_sync_queued=true
  reviewer cadence 1/15
  response: FIRST2-OK

turn 2
  begin_turn
  pre_api_request  api_call_count=2
  post_api_request api_call_count=2
  complete_turn    memory_sync_queued=true
  reviewer cadence 2/15
  response: SECOND2-OK
```

Both turns used the same Codex lifecycle session. LCM reported no turn-complete error and Hindsight sync reported no error.

This regression also exposed and fixed a second-turn Electron structured-clone issue: passing the mutable renderer message object directly to `pre_api_request` could fail with `IPC arguments could not be serialized`. Lifecycle IPC now normalizes user/assistant messages to plain text before every call. The rebuilt two-turn regression produced no serialization warning and paired `pre_api_request`/`post_api_request` on both turns.

Authority remained split on both turns. Real helper diagnostics recorded only the 211-character Hindsight provider block in `system_context`, while fenced recalled memory plus plugin context stayed in `user_context`. The visible UI showed only the canonical prompts and assistant responses; no memory/plugin context appeared in conversation text.

Electron CDP's renderer `Network` domain did not expose the ChatGPT conversation transport in this packaged build, so no claim is made that renderer CDP captured the raw HTTP wire body. Request-role fidelity is instead validated at the semantic request builder that immediately supplies `startCompletionStream(request=N)`, by the transformed composed-ASAR assertions, and by real helper/runtime diagnostics. This avoids treating an unavailable DevTools transport view as evidence.

### Visual QA harness isolation and Chromium `1002` follow-up

Extended tool-card QA initially appeared to crash Codex with a Chromium sequence beginning at zygote communication failure, then Storage/Network/GPU launch failures with code `1002`, ending in `GPU process isn't usable`. Host PID/RAM/disk/file-descriptor exhaustion was ruled out. `strace` and the user-systemd journal identified the actual cause outside Codex:

```text
forced Hermes execute_code timeout
  -> bridge hard_recovery_requested
  -> hermes-chatgpt.service exits 75/TEMPFAIL
  -> systemd --user (PID 2880) SIGTERMs hermes-chatgpt.service cgroup
  -> Chromium zygote/children of the QA-launched Codex instance receive SIGTERM
  -> Electron observes lost zygote and reports child launch failures / GPU 1002
```

Kernel trace evidence showed Chromium zygote PID `2543046` receiving `SIGTERM` with `si_pid=2880` and `si_uid=1000`. PID 2880 is `/usr/lib/systemd/systemd --user`. The journal at the same timestamp records `hard_recovery_requested`, `hermes-chatgpt.service: Main process exited ... status=75/TEMPFAIL`, followed by systemd restart of the bridge. All Hermes Action execution commands run inside `/user.slice/user-1000.slice/user@1000.service/app.slice/hermes-chatgpt.service`; a Codex candidate launched through those commands inherited that cgroup and was therefore swept up by bridge hard recovery.

This was a QA harness ownership bug, not a tool-card or Codex renderer crash. A traced hover/toggle workload kept the Electron main process stable at roughly 328-329 open FDs and five direct children with no zygote/GPU/service errors until bridge hard recovery terminated the cgroup. Future long-lived Electron QA must launch the candidate in an independent user-systemd unit/scope outside `hermes-chatgpt.service` before driving it through CDP.

The corrected QA launch was runtime-proven with a transient user service:

```bash
systemd-run --user \
  --unit=codex-hermes-qa-followup \
  --property=CollectMode=inactive-or-failed \
  --setenv=CODEX_HERMES_LIFECYCLE_DEBUG=1 \
  /bin/bash -lc 'cd /home/chris/Projects/codex-desktop-linux/codex-app-next && exec ./start.sh --no-sandbox --remote-debugging-port=9232 --remote-allow-origins=http://127.0.0.1:9232 > /tmp/codex-hermes-independent-qa.log 2>&1'
```

The resulting Electron main process was owned outside the bridge at:

```text
/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.chromium.Chromium-2584679.scope
```

A second deliberate non-cooperative `execute_code` timeout then forced `hermes-chatgpt.service` hard recovery. The bridge restart counter advanced to 6 and the bridge service generation changed, while Codex retained the same PID `2584679`, the same independent scope, responsive CDP on port `9232`, and zero zygote/GPU/Storage/Network crash markers. This proves independent user-systemd ownership prevents bridge recovery from terminating the app under test.

### Repository validation

Final validation state:

```text
node --test linux-features/hermes-chat-lifecycle/test.js  12/12 pass
make check                                                   pass
make test                                                    55/55 pass
make ci-pr                                                   pass
./scripts/ci-local.sh core  (manifest-enabled final tree)    861 pass, 0 fail, 13 expected skips
```

The final composed candidate ASAR was also extracted after all enabled patches and both actual main/renderer bundles passed `node --check`.

One manifest-enabled `core` run encountered a single unrelated AppShots startup-timing assertion (`bare modifier monitor fails before ready when XInput2 exits during startup`). The exact test then passed 20/20 isolated repetitions without any AppShots code change, and the full clean-container core rerun passed 861 tests with zero failures. The AppShots implementation was therefore left untouched and the first failure is recorded as a transient CI timing flake rather than masked by a source change.

Stress QA also exposed that the fake-Hermes Python tests inherited the host `PYTHONPATH` and live `HERMES_*`/RPC environment, accidentally depending on the real installed Hermes `tools.daemon_pool` module. The tests now scrub inherited Hermes/Python path variables and provide a minimal fake daemon-pool module for the Python 3.14 compatibility path. After that isolation fix, the complete 12-test lifecycle suite passed 20/20 consecutive runs under concurrent CI load.

## Known hard boundaries

### Tool-path identity and bridge architecture research

Today the Codex lifecycle host and the GPT Action bridge still use independent identity domains. Read-only analysis found that the correct Hermes model is **not** one universal session ID. Native Hermes already separates operational routing from lifecycle identity:

```text
stable ChatGPT conversation/workspace
  -> session_key / task_id
     CWD, terminal/browser environments, files, processes,
     invocation recovery, bridge request fencing

rotating Codex Hermes lifecycle epoch
  -> session_id = hs_codex_*
     lifecycle/plugin observability, Hindsight lineage,
     LCM current-session binding

per turn/request
  -> turn_id / api_request_id / tool_call_id
```

`gateway.session_context.set_session_vars()` accepts `session_key` and `session_id` independently. Native Hermes also uses `task_id` as an operational isolation key for terminal/browser sessions, CWD/tool environments, read/patch tracking, and related tool state, so `task_id` must remain stable with the workspace rather than rotate with each `hs_codex_*` lifecycle epoch.

The existing bridge already contains dormant `SessionContext.hermes_session_id` / `hermes_task_id` fields and `MinimalAgentShim.session_id` prefers `hermes_session_id`. Its current fallback still fabricates `turn_id` and `api_request_id` from the bridge session, which would need to be replaced by real Codex turn/request correlation if the Action path remains.

A KISS prototype also proved that no new conversation/session database is needed for a retained bridge workspace: the existing persisted `bootstrap_request_id -> random opaque session_id` mapping can use a deterministic conversation bootstrap key derived from `(gizmo_id, client_conversation_id)`. The same key reused the same random bridge session in-process and after `SessionManager` restart; explicit/TTL pruning intentionally rotated it.

The larger first-principles question is now whether GPT Actions should remain on the interactive path at all. The ChatGPT renderer already sends `local_function_signatures` and has a hidden local tool-result continuation format. Today only the built-in `handoff` local function is registered. If this protocol can safely support arbitrary Hermes functions, the ideal architecture may execute Hermes tools directly in Codex and remove public Action-session unification from the critical path. This local-function path is therefore the highest-priority architecture research item before any `hermes-chatgpt` edit.

Static bundle tracing now establishes the current local-function protocol more precisely:

- `tWr(...)` emits the `local_function_signatures` entry for the built-in function name `handoff` with two kwargs (`prompt`, `reason`).
- Chat completion request builders include that signature in ordinary Chat/Gizmo requests when local handoff is enabled.
- the renderer has a generic local result submitter `Ygi(...)` that accepts arbitrary `{callId, result, toolName}` and continues the same ChatGPT conversation by sending a hidden `author.role="tool"` message whose payload contains `{call_id, result, tool}`;
- the lazy `app-primary` handoff UI imports that generic submitter and uses it for both accepted and rejected local results;
- call *detection* is handoff-specific today: the current selector accepts assistant recipients only when they are exactly `functions.handoff` or `local.handoff`, and parses the hard-coded handoff argument schema;
- result-history parsing likewise validates the tool name against the exported handoff constant.

Therefore the continuation transport is already generic while discovery/dispatch is product-specific.

A disposable supported-build probe renamed the advertised function to `qa_local_echo(prompt, reason)` and forced its signature into both ordinary Chat and Gizmo request builders. Runtime instrumentation proved signature construction in both modes. The live results currently differ by conversation mode:

- **ordinary Chat:** the server/model emitted a real `qa_local_echo` local-function call. The native dynamic-tool card rendered `Qa local echo` with the exact requested arguments `prompt: PING-PLAIN-73` and `reason: validate-client-local-function`. This proves arbitrary client-local function names are accepted and callable in ordinary Chat; the server is not restricted to the literal built-in `handoff` name there.
- **Winston / `gizmo_interaction`:** the same patched request path built the local signature repeatedly (`__codexLocalFnQaSignatureBuilds = 9`), but the model replied that `qa_local_echo` was unavailable and no custom recipient was emitted. This indicates a Gizmo-mode capability/tool-selection boundary that still requires investigation.

The ordinary-Chat call initially remained pending because Codex's native executor UI special-cases `dynamic-tool-call.tool === "handoff"`; arbitrary local functions fall through to the generic display card and no executor consumes them. A follow-up disposable probe corrected the full routing chain: the custom call was excluded from reasoning/activity grouping like the native handoff, routed through the existing handoff executor component, recognized as `local.qa_local_echo`, and rejected with a unique local result marker.

The full ordinary-Chat round trip is now runtime-proven end to end:

```text
user requests qa_local_echo
  -> ChatGPT emits qa_local_echo(prompt="ROUNDTRIP-FINAL-73", reason="prove-local-result")
  -> Codex routes the dynamic-tool-call through the local executor
  -> local selector detects recipient local.qa_local_echo
  -> generic local-result submitter sends hidden role:"tool" continuation
     callId: 7b9ebf0b-994b-4c87-9700-15f3f6913318
     conversationId: local-chatgpt:c43ff1f6-6607-4a9b-9739-39e124181ece
     toolName: qa_local_echo
     result: {accepted:false,message:"LOCAL-QA-RESULT-73"}
  -> ChatGPT consumes the local result
  -> final assistant text: LOCAL-QA-RESULT-73
```

Runtime counters on that real turn were:

```text
__codexLocalFnQaSignatureBuilds = 8
__codexLocalFnQaViewerRouted = 10
__codexLocalFnQaDetected = 3
__codexLocalFnQaLastRecipient = local.qa_local_echo
__codexLocalFnQaResultsSubmitted = 1
```

This proves that ordinary Chat mode supports arbitrary client-advertised local function names, client-side execution/handling, hidden tool-role result submission, and model continuation using that result.

Additional protocol stress tests established:

- **sequential calls work:** one assistant turn requested `qa_local_echo` twice in sequence. `__codexLocalFnQaResultsSubmitted` advanced from 1 to 3, showing two additional client result continuations, and the model completed with `TWO-LOCAL-CALLS-DONE`. This proves model -> local tool -> model -> local tool -> model chaining works in one turn.
- **native handoff handling is interactive:** while a local call is pending, Codex shows the handoff UI (`Stay in Chat` / `Continue in Work`) and there is no normal stream Stop button because the server stream has already yielded a function call.
- **abandonment does not cancel the native handoff timer:** navigating to New chat while a custom call was awaiting the local timeout still caused `__codexLocalFnQaResultsSubmitted` to advance from 3 to 4 for the old `conversationId`, and reopening that old conversation showed the background continuation `CANCEL-UNEXPECTED`. A production Hermes local-tool executor therefore must not inherit handoff's loose timeout semantics; it needs explicit ownership and cancellation keyed by conversation/turn/call ID, and must drop late results after abandonment or generation change.

The remaining architecture question is product/mode integration: `gizmo_interaction` did not invoke the same custom local function even when the signature was forced into its request, so replacing GPT Actions for Winston likely requires either an ordinary-Chat Winston personality/orientation layer or further proof of a supported Gizmo-local-function path.

The ordinary-Chat personality/orientation option is now also runtime-proven. A disposable build appended a hidden one-turn system message through the same `Kgi/Jgi/Xgi` authority path used by the lifecycle feature. The visible user message was only `PERSONA-LOCAL-73`; the hidden instruction named the QA persona `Winston-Local-QA`, directed one `qa_local_echo` call with `reason="hidden-system-driven"`, and prescribed the final answer format. Runtime evidence showed `__codexLocalFnQaHiddenPersonaBuilds = 1`, the local selector detected `local.qa_local_echo`, one hidden tool result was submitted, and the final assistant answer was exactly `WINSTON-LOCAL-QA|LOCAL-QA-RESULT-73`. This proves ordinary Chat can simultaneously carry trusted hidden Winston/Hermes orientation and arbitrary client-local tools without `gizmo_interaction`.

A further hybrid Gizmo probe isolated the server boundary. The disposable request builder omitted only `conversation_mode:{kind:"gizmo_interaction",...}` while retaining `gizmo_id`. Under that hybrid shape Winston successfully invoked `qa_local_echo`, Codex submitted the local result, and the final answer was exactly `LOCAL-QA-RESULT-73`. However, a follow-up identity probe on a fresh Winston home answered `ChatGPT` rather than `Winston`. This demonstrates that removing `conversation_mode` unlocks local functions by dropping the effective Custom-GPT behavior; `gizmo_id` alone is not sufficient to preserve Winston's persona/instructions. That hybrid is therefore not a valid production architecture despite proving the protocol boundary.

The native Hermes execution side is also runtime-proven independently of the bridge. A lightweight local `AIAgent` constructed from the installed Hermes runtime exposed 34 native tools and invoked `read_file({path:"/etc/hostname"})` through `agent.agent_runtime_helpers.invoke_tool()` with no model call and no GPT Action hop. The result returned `black-monolith`. In-memory hook instrumentation verified exact lifecycle correlation:

```text
task_id        workspace-hook-probe
session_id     hs_codex_hook_probe
turn_id        turn-hook-7
api_request_id chatgpt-codex:hs_codex_hook_probe:7:1
tool_call_id   local-tool-call-777
```

A corresponding post-hook probe carried the same identity fields and the real tool result through `_emit_post_tool_call_hook`. This proves Codex can reuse Hermes's native registry, middleware, pre/post tool hooks, and task/session semantics locally instead of reimplementing bridge dispatch logic.

### ChatGPT-native tools

OpenAI server-side tools execute before Codex can observe them. Hermes cannot reliably run a true veto-capable `pre_tool_call` hook for those tools.

### Output transforms

`transform_llm_output` occurs after the ChatGPT answer has already been committed to OpenAI's conversation state. Rewriting only the local UI would intentionally diverge local and server history.

### Server-side compaction

ChatGPT does not expose Hermes-equivalent `pre_compact` / `post_compact` lifecycle events. Essential steering therefore needs to be refreshed through normal per-turn lifecycle context.

## Roadmap

### Milestone A — explicit session finalization QA

Status: **complete and runtime-verified**.

Verified through the live candidate:

- context engine `on_session_end`;
- Hindsight/MemoryManager `on_session_end`;
- `MemoryManager.shutdown_all`;
- `hermes_cli.lifecycle.finalize_session`;
- plugin/Relay finalization;
- Electron binding removal;
- close/reopen of the identical Gizmo/conversation identity creates a fresh `hs_codex_*` session with `turn_number=1`.

### Milestone B — observable failure-path QA

Status: **complete through deterministic renderer fault QA**.

The QA-only `CODEX_HERMES_QA_FAULT=model_call_error` path routes through Codex's real stream-error callback and proves:

```text
pre_api_request
api_request_error
on_session_end(failed=true)
model_call_error
```

with no `post_api_request`, `complete_turn`, successful LCM turn completion, or successful Hindsight sync. The renderer also exits its responding state correctly.

### Milestone C — native background self-improvement

Status: **implemented; real auxiliary completion still under QA**.

The persistent lifecycle host now lazily creates a genuine quiet Hermes `AIAgent` review parent only when skill-review cadence is due. It invokes Hermes's own `_spawn_background_review()` path, which preserves the native fork, prompts, auxiliary routing, tool whitelist, approval behavior, cancellation tokening, and summary callback.

Current profile routing is:

```text
parent runtime: bifrost / zai/glm-5.3
review runtime: bifrost / gemini/aux-quality
skills.creation_nudge_interval: 15
```

Because this profile uses external Hindsight, Hermes's built-in MEMORY.md store is disabled; automatic memory retention is already handled by the Hindsight lifecycle. The background reviewer is therefore used for native skill-improvement review.

Codex can only estimate Hermes model/tool iteration cadence from the client-visible ChatGPT turn graph. The current implementation increments the skill-review counter by `model_iterations_estimate` (default `1` per successful client turn), documents the approximation, and uses the native configured threshold. `CODEX_HERMES_QA_FORCE_SKILL_REVIEW=1` forces one review per lifecycle session for QA.

Foreground behavior is protected:

- foreground ChatGPT completion does not wait for reviewer completion;
- a new live ChatGPT turn calls Hermes's native `cancel_background_review_for_live_turn()`;
- helper shutdown cancels/closes the reviewer parent;
- reviewer failures are logged and do not change the foreground answer;
- review action callbacks are recorded in lifecycle diagnostics.

A real installed-runtime probe successfully initialized the native parent and spawned the configured `gemini/aux-quality` review. The foreground lifecycle returned immediately with `background_review.scheduled=true`. An initial 150-second harness window ended before that review completed; closing the helper canceled it cleanly, which also exposed and fixed a diagnostics bug that had labeled canceled requests as `background_review_complete`.

A second bounded probe then verified natural auxiliary completion: Hermes routed the review through `bifrost / gemini/aux-quality`, returned foreground completion immediately, and emitted `background_review_complete` after about 49 seconds with `cancelled=false`. The deliberately trivial transcript produced no skill action, which is the expected valid outcome for a session with no reusable technique to save.

### Milestone D — lifecycle conformance suite

Status: partially implemented.

Add high-level assertions for:

```text
session start once per lifecycle session
pre_llm_call once per submitted turn
Superpowers only on first turn
Hindsight recall before ChatGPT request
pre/post_api_request pairing on success
api_request_error pairing on failure
post_llm_call once on success
LCM durable ingest
Hindsight sync once on success
no successful sync on interrupt/failure
session finalization on close
background review cadence
```

### Milestone E — broader repository QA

Run:

```text
make checks
make test
make smoke
make smoke-asar
make validate-core
```

or the repo-equivalent subset appropriate to the current checkout, while preserving unrelated pre-existing local modifications.

### Milestone F — production registration/session persistence

Status: **complete for the Codex-local lifecycle host**.

A versioned local main-process registration manifest is now the primary activation mechanism. `CODEX_HERMES_GIZMO_IDS` remains an explicit development override only. The manifest parser is fail-closed, bounded, hot-reloaded on every probe, and runtime-verified on Black Monolith with Winston registered solely through the default local file.

Session behavior is deliberately process-scoped: one Codex main-process lifetime reuses a stable `hs_codex_*` binding for each `(gizmo_id, client_conversation_id)` pair; a Codex restart rotates that binding and starts a fresh Hermes lifecycle session for the same ChatGPT conversation identity. This is covered by executable main-runtime tests.

### Milestone G — choose the ideal Hermes tool path

Status: **architecture research in progress; bridge remains read-only**.

The earlier target of making one Codex `hs_codex_*` ID equal the Action bridge session is rejected. Native Hermes has two distinct lifetimes: an operational `session_key`/`task_id` workspace and a lifecycle `session_id`. Collapsing those would either rotate terminal/browser/file/process state with every lifecycle epoch or incorrectly reuse a finalized lifecycle identity.

Current architecture ranking:

1. **Preferred if runtime proof succeeds:** generalize ChatGPT Chat's existing `local_function_signatures` / local tool-result continuation protocol and execute Hermes tools directly in the Codex-local Hermes host. This could remove the public GPT Action bridge from the interactive tool loop and make lifecycle/tool correlation local and structural.
2. **Fallback if local functions are not general enough:** retain GPT Actions, add a tiny owner-only local control plane for conversation bootstrap/orientation and native lifecycle binding, keep stable bridge workspace identity separate from rotating Hermes lifecycle identity, and remove model-driven `hermes_bootstrap`.
3. **Rejected:** one universal session ID, rotating native `task_id` with lifecycle epochs, reliance on undocumented OpenAI conversation headers, or duplicating Hermes orientation policy in Codex.

Next read-only research steps:

1. Trace the built-in `handoff` local-function executor from streamed call detection through local execution and hidden tool-result continuation.
2. Determine whether arbitrary function names and JSON schemas can be registered in `local_function_signatures` for `gizmo_interaction` turns.
3. Determine whether repeated model -> local tool -> model loops, multiple sequential tool calls, cancellation, retries, conversation persistence, and tool-call IDs work generically rather than only for `handoff`.
4. If the local path works, design the smallest Codex-local Hermes tool registry/executor and identify which parts of `hermes-chatgpt` become unnecessary for Codex Chat.
5. If the local path fails a hard protocol constraint, finalize the Action fallback around native `session_key` / `session_id` separation and the existing persisted bootstrap-request mapping.

No `hermes-chatgpt` modification begins until this decision is made and the exact change set is presented.

## Branch/worktree policy

All work for this feature is performed on:

```text
chris-custom
```

Preserve unrelated existing worktree changes. Do not discard or overwrite unrelated maintenance/sync work.

`hermes-chatgpt` remains read-only for this phase.
