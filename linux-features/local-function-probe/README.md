# local-function-probe (Hermes tools via client-local function protocol)

Patches the Chat-mode client to advertise **bare Hermes tools** through the
client-local function protocol (`local_function_signatures`) and dispatch each
call to the **shared Hermes runtime**, so the model can invoke genuine Hermes
tools by name inside an ordinary Chat conversation.

## Advertised tools

Three bare tools are advertised (table form in the signature builder):

- `hermes_read_file`  → registry `read_file`
- `hermes_search_files` → registry `search_files`
- `hermes_web_search` → registry `web_search`

The `hermes_` prefix is model-facing only (avoids collision with built-in
local functions). Dispatch strips it to reach the registry tool of the same
bare name; if the bare name is not registered, the advertised name is used so
the registry's own "Unknown tool" error surfaces truthfully.

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
  → result {accepted:false, message:<tool output>}
  → assistant consumes the result and continues
```

This requires the `hermes-chat-lifecycle` feature to be enabled so the
`electronBridge.hermesChatLifecycle` IPC is present. When that bridge is
absent (feature disabled), the executor falls back to the **loopback HTTP tool
endpoint** (`127.0.0.1:9473/call`, owned by the `hermes-local-tools` feature)
to stay functional on its own.

## Why no dispatcher

Earlier Phase 1 used a single dispatcher tool. This probe proves the server
honestly honors **multiple** advertised functions and lets the model call each
by bare name — so a dispatcher is not required, and the tool surface can match
Hermes's own progressive-disclosure shape (curated bare core + a search/describe/
call trio) without a catch-all shim.

## Status: VERIFIED (merge build)

- Multi-signature honored: `sigBuilds` > 1, each bare tool called and executed.
- IPC dispatch confirmed live from a plain-Chat webview:
  `hermes_read_file` → `read_file`, real file content returned, `enabled:true`.
- Full model round trip: prompt → tool call via IPC → lifecycle host executes
  in an auto-created plain-Chat session (`tool_call ok:true`) → assistant
  restates the file content (`PHASE1-DETERMINISTIC-FIXTURE-73`) verbatim.

Instrumentation is namespaced `__codexP2*` (`__codexP2ExecCalls`,
`__codexP2Dispatch`, `__codexP2EndpointResp`).
