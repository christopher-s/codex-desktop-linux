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
