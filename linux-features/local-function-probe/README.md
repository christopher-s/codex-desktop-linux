# local-function-probe (QA disposable)

Patches the Chat-mode client to execute a local `qa_local_echo` function
call through the native handoff executor and return a fixed local result,
proving the client-local function tool-call round trip.

## Status: round trip VERIFIED (app24)

Counters at completion:
- normalization (uGr `local.qa_local_echo` branch): fires
- viewer routing to native `Bu` executor: fires
- app-primary detector: fires
- result submitted: 1 (`{accepted:false, message:"LOCAL-QA-RESULT-73"}`, toolName `qa_local_echo`)
- assistant continuation: `LOCAL-QA-RESULT-73` verbatim

## What the patch does (app-initial)

1. `tWr` — advertise `qa_local_echo` signature in real + prepare requests.
2. `$Wr` entry instrumentation (`__codexLocalFnQaWrCalled/WrRecipient`).
3. `uGr` — normalize BOTH `functions.qa_local_echo` AND `local.qa_local_echo`
   recipients to pending, handoff-shaped items with
   `pairKey: local-function:${callId}` and `tool: handoff`.
4. `_Gr.safeParse` branch — normalize dynamic-tool-call metadata path
   (kept for parity; not the live path).
5. Bridge `__jit_plugin` fallback — normalize embedded recipient (kept for parity).
6. `rGr`/`eGr` — classify the marked hidden tool result and attach
   `result` to the original dynamic-tool-call by call-id pair key.
7. `r_i` — mark hidden local-function results with
   `metadata.codex_local_function_result: true`.

## app-primary

- Detector `I0t` accepts `functions./local.` qa_local_echo and embedded
  `__jit_plugin.qa_local_echo` recipients; drops the `ly` gate and the
  `in_progress` exclusion.
- Auto-reject result replaced with `{accepted:false, message:"LOCAL-QA-RESULT-73"}`.

## viewer

- `dynamic-tool-call` branch routes `tool==="qa_local_echo"` (any completion
  state) to the native `Bu` handoff executor alongside `handoff`.

## chip-group

- Renders `arguments` AND own-property `result` in the recursive code tree
  (captures `__codexLocalFnQaChipItem`).

## Remaining gap

The completed-turn view does NOT persist a visible expandable disclosure
card for the call (no `.group/activity-header` in the finished thread).
The round trip and result pairing work; persistent card rendering in the
completed view is the open gate.

## app25 iteration (round trip still green; persistent card still open)

Changes:
- viewer routes qa_local_echo to Bu ONLY while completed===!1; completed items
  fall through to the generic el/chip disclosure renderer.
- uGr local./functions. branches + item construction now propagate sourceTool.
- eGr restores tool=sourceTool (qa_local_echo) when attaching result, and
  records __codexLocalFnQaResultAttached / __codexLocalFnQaAttachedItem.

Live (app25): norm=11, route=3, submitted=1 (toolName qa_local_echo,
message LOCAL-QA-RESULT-73), attached=6, attachedItem.tool=qa_local_echo,
continuation LOCAL-QA-RESULT-73. Round trip STILL works after routing change.

OPEN: completed item is built ($Wr fires) and result attaches (eGr fires),
but the finished turn renders only user/assistant messages — no persistent
disclosure card. The handoff lifecycle consumes the transient executor item;
the write-back u[D]=O stores the completed item, but it does not reach the
rendered DOM. Next: trace the CGr turn container / hide_all group the
completed item lands in.

## app26 iteration — ROOT CAUSE of the persistent-card gap identified

Added viewer instrumentation: __codexLocalFnQaLmSeen / __codexLocalFnQaLmItem.

FINDING: Lm (the per-item renderer) only EVER receives the PENDING item:
  {tool:"handoff", sourceTool:"qa_local_echo", completed:false, hasResult:false}
The COMPLETED item (completed:true, result attached, tool restored to
qa_local_echo) NEVER reaches Lm. Round trip still 100% green:
  submitted=1 (toolName qa_local_echo, LOCAL-QA-RESULT-73), attached=6,
  continuation LOCAL-QA-RESULT-73.

ARCHITECTURAL ROOT CAUSE:
- aWr() builds reasoning groups. pWr(e) EXCLUDES items with
  type=dynamic-tool-call AND tool=handoff from group membership.
- Our pending item has tool=handoff (required for the native Bu executor to
  mount and drive the local call). So it renders standalone/transiently.
- When the handoff auto-reject resolves, the native handoff lifecycle
  CONSUMES the resolved call (that is correct for real handoffs: work
  continues in a new Work thread, so the Chat thread shows only final text).
- The completed+result-attached item is therefore dropped upstream of Lm and
  never becomes a persistent disclosure card.

THE TENSION: Bu requires tool=handoff to execute; pWr excludes tool=handoff
from the persistent reasoning-group card path. One item cannot be both.
Resolution requires decoupling execution from handoff-lifecycle consumption
(e.g. drive the local executor without registering the call in the handoff
lifecycle, or re-emit a separate persistent disclosure item on completion).

STATUS: round trip (protocol) = VERIFIED. Persistent card = blocked on
handoff-lifecycle consumption; needs a dedicated follow-up.
