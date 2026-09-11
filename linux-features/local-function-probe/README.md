# local-function-probe (Hermes tools via client-local function protocol)

Patches the Chat-mode client to advertise **bare Hermes tools** through the
client-local function protocol (`local_function_signatures`) and dispatch each
call to the **shared Hermes runtime**, so the model can invoke genuine Hermes
tools by name inside an ordinary Chat conversation.

## Advertised tools

A curated bare core (table form in the signature builder):

- `hermes_read_file`  → registry `read_file`
- `hermes_search_files` → registry `search_files`
- `hermes_web_search` → registry `web_search`

plus Hermes's progressive-disclosure trio, which mirrors the native
`tool_search` / `tool_describe` / `tool_call` bridge (the host maps
`hermes_tool_*` onto it; string-only arguments are acceptable and the bridge
parses them internally):

- `hermes_tool_search`   → discover the rest of the registry by description
- `hermes_tool_describe` → read a candidate's parameter schema
- `hermes_tool_call`     → execute any named registry tool

The `hermes_` prefix is model-facing only (avoids collision with built-in
local functions). Dispatch strips it for known bare tools and for the bridge
names; anything else is passed through so the registry's own "Unknown tool"
error surfaces truthfully.

## Dispatch path (Path A)

The executor (`D0t`) routes each call through the **Hermes lifecycle IPC**
first, so tool execution shares the same process/runtime/session as the
lifecycle host — no separate HTTP endpoint, no `hermes-chatgpt` bridge:

```
model emits local.<tool>
  → detector (I0t) + normalizer (uGr)  →  handoff item
  → native executor (D0t)
      → electronBridge.hermesChatLifecycle({phase:'tool_call', ...})
          → main-bundle tool_call bypass (conversation-keyed, no gizmo)
          → lifecycle_helper.py _handle_tool_call
          → model_tools.handle_function_call (shared runtime)
  → result {accepted:true, thread_id:"p2ok-<callId>", message:<tool output>}
  → hidden role:"tool" result pairs by call id and completes the dynamic-tool item
  → assistant consumes the result and continues
```

This requires the `hermes-chat-lifecycle` feature to be enabled so the
`electronBridge.hermesChatLifecycle` IPC is present. When that bridge is
absent (feature disabled), the executor falls back to the **loopback HTTP tool
endpoint** (`127.0.0.1:9473/call`, owned by the `hermes-local-tools` feature)
to stay functional on its own.

## Session unification and transcript recording

Plain-Chat tool calls are keyed by the conversation, so a tool-call-only
turn merges into the same lifecycle `SessionRuntime` as the conversation's
user/assistant turns (the host derives the session identity from the
conversation; the client's raw conversation id is never stored as a session
id, and a non-canonical session id in the payload is re-mapped). Every
executed call is appended to the runtime's transcript as a `tool_call` +
`tool` row pair, so the conversation's Hindsight sync and LCM ingestion see
the tool activity;
a call the registry rejects ("Unknown tool") is reported to the model with
the registry's error text *and* is also appended (the `tool` row carries
`result:"Unknown tool: <name>"` — verified in T2), so the transcript
records the attempt faithfully.

## Why no dispatcher

Earlier Phase 1 used a single dispatcher tool. This probe proves the server
honestly honors **multiple** advertised functions and lets the model call each
by bare name — so a dispatcher is not required, and the tool surface can match
Hermes's own progressive-disclosure shape (curated bare core + a search/describe/
call trio) without a catch-all shim.

## Status: VERIFIED (merge build)

- **Envelope semantics (T1b fix, 2026-09-08):** the executor now publishes
  `accepted:true` (with a `thread_id`) for every dispatch result. The
  original `accepted:false` — copied verbatim from the Codex-handoff
  reference implementation — made the model treat a *successful* Hermes
  tool execution as a rejection and it stopped at `tool_describe` without
  ever executing a tool (T1b failure, root cause traced to this single
  token; see `docs/path-a-progress-disclosure.md` §D1). A rejected call
  still returns `accepted:true` carrying the registry's "Unknown tool"
  error in `message` — the rejection is semantic (in the error text),
  not transport-level.
- **Presentation-state evolution (E5/E2, 2026-09-09 through 2026-09-10):** advertised local functions keep `tool:"handoff"` internally and carry `sourceTool:<real local function>`, so the native handoff component stays mounted while the pending call triggers the patched local executor through the existing `Stay in Chat` path. E5 originally suppressed the terminal accepted-task card after a `sourceTool` result was published. E2 requires persistent completed-tool disclosure, so `CompletedPresentationV2` removes that suppression and lets the published result continue through ChatGPT's native accepted presentation branch. `CompletedResultHandoffV2` also keeps the completed paired item's internal `tool` as `handoff` instead of rewriting it to `sourceTool`; the real function name remains in `sourceTool`, so the completed item still routes through the handoff viewer. After native tool-result continuation the transient handoff status store may no longer retain the accepted task, while the completed item still carries the persisted `{accepted:true,thread_id,...}` result. `CompletedSourceToolCardV1` detects that sourceTool-backed completed item after all native viewer hooks/selectors have run and renders the same native completed handoff card component from the persisted `thread_id`. Older installed viewers can still carry a historical `Ym` activity-loop clause that drops every `dynamic-tool-call`; the local-function patch migrates that clause back to the existing `codexLinuxChatBridgeToolCallsSkipRuntime` Gate 3c shape so completed handoff items reach `Lm`. Hidden role:`tool` result pairing and native assistant continuation remain unchanged; visual polish of the handoff presentation remains Phase D work.
- Multi-signature honored: `sigBuilds` > 1, each bare tool called and executed.
- IPC dispatch confirmed live from a plain-Chat webview:
  `hermes_read_file` → `read_file`, real file content returned, `enabled:true`.
- Full model round trip: prompt → tool call via IPC → lifecycle host executes
  in an auto-created plain-Chat session (`tool_call ok:true`) → assistant
  restates the file content (`PHASE1-DETERMINISTIC-FIXTURE-73`) verbatim.

Instrumentation is namespaced `__codexP2*` (`__codexP2ExecCalls`,
`__codexP2Dispatch`, `__codexP2EndpointResp`). Viewer QA also keeps a bounded
`__codexP2LmItems` sequence of the last 40 sourceTool/handoff snapshots with
`callId`, `completed`, and `result` so completed-item state transitions can be
verified without retaining unbounded renderer history. `LmSnapshotV2` gives
that observer an explicit migration marker so previously patched viewers
upgrade instead of treating the older single-value `__codexP2LmItem` probe as current.
The final Chat remount can transiently rehydrate the original pending dynamic item after
multiple completed snapshots for the same `callId`. `CompletedResultRehydrateV1` keeps a
bounded 100-entry accepted-result cache keyed by `callId`; a later stale pending copy of the
same `sourceTool` item is promoted back to `completed:true` with its accepted result before
snapshotting and native viewer routing, preserving one call identity and one completed card.
