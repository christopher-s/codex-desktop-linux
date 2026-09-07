# Local Function Protocol / Hermes Architecture Research Handoff

Date: 2026-09-07
Branch: `chris-custom`
Repo: `/home/chris/Projects/codex-desktop-linux`
Bridge repo: `/home/chris/Projects/hermes-chatgpt` (READ ONLY; still clean on `main`)

## Purpose

This file captures the current state of the first-principles architecture research into replacing or minimizing the GPT Action bridge by using ChatGPT Desktop's client-local function protocol in Chat mode. It is intended to be sufficient for another agent to continue the work without reconstructing the investigation from conversation history.

The decisive open question is whether Codex Desktop can complete this loop for arbitrary locally advertised functions:

```text
ChatGPT model
  -> client-local function call
  -> Codex Desktop local executor
  -> local Hermes tool/runtime
  -> hidden tool-role result
  -> ChatGPT continuation
```

Ordinary Chat has now proven the **model -> arbitrary local function call** half. The remaining unproven half is a fully live **client local result -> model continuation** for a renamed/custom function.

---

## Non-negotiable constraints / project rules

1. Work on branch `chris-custom` in `/home/chris/Projects/codex-desktop-linux`.
2. Do not edit generated `codex-app` trees as source of truth; feature work belongs under `linux-features/<feature>` once productionized.
3. `/home/chris/Projects/hermes-chatgpt` must remain read-only until an exact bridge change is presented to the user first. No bridge edit has been made during this research.
4. Backward compatibility is **not required** for the eventual bridge/control-plane redesign.
5. ASAR patches must use explicit anchors/count checks, idempotence, and syntax checks.
6. Electron/CDP QA must run outside `hermes-chatgpt.service` (see QA harness section below).
7. Current local-function experiments are intentionally disposable and live under `/tmp`; they are not production feature code.

---

## Current git state

Latest observed status:

```text
## chris-custom...fork/chris-custom
 M docs/chat-tool-calls-notes.md
 M linux-features/chat-bridge-tool-calls/test.js
 M tests/scripts_smoke.sh
?? docs/chris-custom-maintenance.md
?? docs/hermes-chat-lifecycle-plan.md
?? docs/hermes-chat-lifecycle-status.md
?? linux-features/hermes-chat-lifecycle/
?? scripts/chris-custom-sync.sh
?? tests/chris_custom_sync_test.sh
```

Bridge repo:

```text
/home/chris/Projects/hermes-chatgpt
## main...origin/main
```

Bridge is clean and untouched.

Note: several Codex repo changes predate the local-function research. Do not conflate them with this experiment.

---

## Broader architecture context already established

The Codex-local Hermes lifecycle integration is substantially complete and QA'd. Current lifecycle architecture:

```text
User submit
 -> Hermes lifecycle begin_turn
    -> session start
    -> Hindsight/MemoryManager on_turn_start + prefetch
    -> pre_llm_call
    -> Superpowers/LCM/plugins
 -> split ephemeral context:
    -> hidden one-turn system message:
       MemoryManager.build_system_prompt() ONLY
    -> hidden one-turn contextual user message:
       recalled memory + pre_llm_call plugin context
 -> normal ChatGPT request
 -> ChatGPT model + tools
 -> terminal response
 -> Codex complete_turn
    -> post_api_request
    -> post_llm_call
    -> LCM ingest
    -> Hindsight sync
    -> background skill review
    -> on_session_end / finalize when appropriate
```

Important authority split already implemented and tested:

- `system_context`: only `MemoryManager.build_system_prompt()`
- `user_context`: recalled memory fenced using native `build_memory_context_block()` + plugin `pre_llm_call` context
- renderer sends visible canonical user prompt unchanged plus hidden one-turn system/user context messages

The lifecycle feature is under:

```text
linux-features/hermes-chat-lifecycle/
```

and was previously validated with 12/12 lifecycle tests plus broader CI/core QA.

---

## Hermes identity research: key architectural result

Do **not** force one universal session ID across Codex lifecycle and bridge operational state.

Native Hermes already distinguishes:

```text
session_key = operational/routing identity
session_id  = lifecycle/observability identity
```

Native `gateway.session_context.set_session_vars()` accepts these separately.

Recommended identity model if GPT Actions remain:

```text
stable ChatGPT conversation/workspace
  -> session_key / task_id
     CWD
     terminal/browser environments
     files
     processes
     invocation recovery
     bridge request fencing

rotating Codex Hermes lifecycle epoch
  -> session_id = hs_codex_*
     lifecycle/plugin observability
     Hindsight lineage
     LCM current-session binding

per turn/request
  -> turn_id
  -> api_request_id
  -> tool_call_id
```

Critical correction discovered during research:

- `task_id` is operational in native Hermes and isolates terminal/browser/code environments, CWD/tool state, read/patch tracking, background processes, etc.
- therefore `task_id` should remain stable with the workspace/session key, not rotate with each `hs_codex_*` lifecycle epoch.

The bridge already contains dormant fields that anticipate this split:

```text
SessionContext.session_id
SessionContext.hermes_task_id
SessionContext.hermes_session_id
```

`MinimalAgentShim.session_id` already prefers `hermes_session_id` when present.

Current bridge fallback still fabricates `turn_id` / `api_request_id` from the bridge session; that would need correction only if the Action path remains.

---

## KISS bridge-session research

No new conversation/session database is required for a retained bridge workspace.

`SessionManager` already persists:

```text
bootstrap_request_id -> random opaque bridge session_id
```

A deterministic bootstrap request key derived from `(gizmo_id, client_conversation_id)` was tested against the real `SessionManager` / `RecordStore` in `/tmp`:

```text
same process, same conversation key
  -> same random bridge session

bridge manager restart/recovery
  -> same random bridge session

explicit prune
  -> mapping removed
  -> new bridge session
```

Existing bridge session retention is approximately 24h idle / 256 retained sessions. Rotation after prune is semantically acceptable because workspace resources are already released.

A tiny owner-only Unix control plane was also validated experimentally using AF_UNIX + `SO_PEERCRED`; a Node client connected to Python and the server observed peer UID 1000 matching owner UID 1000. This remains the conservative KISS option if GPT Actions remain.

---

# Local Function Protocol Research

## What the official bundle proves statically

Official package/build under investigation:

```text
26.901.41600
```

Official read-only ASAR extraction used for static research:

```text
/tmp/codex-hermes-asar
```

Relevant bundles:

```text
/tmp/codex-hermes-asar/webview/assets/app-initial-36a3a1b7313c.js
/tmp/codex-hermes-asar/webview/assets/app-primary-804f738d362c.js
/tmp/codex-hermes-asar/webview/assets/viewer-b286e659c89a.js
/tmp/codex-hermes-asar/webview/assets/local-conversation-thread-c7ae74a9bc27.js
```

### Request-side local function signatures

ChatGPT Chat request construction includes:

```text
local_function_signatures
```

Built-in generator `tWr(...)` advertises the built-in local function:

```text
handoff(prompt: string, reason: string)
```

This is present in ordinary Chat request construction and related request preparation paths.

### Generic local tool-result continuation

The renderer contains a generic result submitter (minified symbol `Ygi(...)`) with semantic inputs:

```text
callId
conversationId
result
toolName
model / thinking effort / thread metadata
```

It ultimately constructs/submits a hidden tool-role message equivalent to:

```js
{
  author: {
    role: "tool",
    name: toolName
  },
  channel: "commentary",
  content: {
    content_type: "code",
    text: JSON.stringify({
      call_id: callId,
      result,
      tool: toolName
    })
  },
  metadata: {
    is_visually_hidden_from_conversation: true
  }
}
```

This message is fed into the same ChatGPT conversation so the model can continue after client-local execution.

This part is generic. The built-in `handoff` UI uses this exact result continuation path for accepted/rejected results.

### Handoff-specific execution today

Current client dispatch/detection is handoff-specific:

- recipient detector accepts `functions.handoff` / `local.handoff`
- argument parser expects `prompt` + `reason`
- viewer/rendering has special handling for `dynamic-tool-call.tool === "handoff"`
- generic other dynamic tool calls render as display cards and are not executed by this client-local handoff executor

So the current implementation is roughly:

```text
generic:
  signature transport
  server function-call representation
  hidden tool-role result continuation

handoff-specific:
  discovery/detection
  argument parsing
  local executor UI
  special render routing
```

---

## LIVE PROOF: arbitrary local function names work in ordinary Chat

A disposable supported-build probe renamed the advertised function to:

```text
qa_local_echo(prompt: string, reason: string)
```

The ChatGPT server/model emitted real calls to this unknown function in **ordinary Chat mode**.

Observed real calls included exact arguments:

```text
Qa local echo
prompt: PING-PLAIN-73
reason: validate-client-local-function
```

and a second independent run:

```text
Qa local echo
prompt: ROUNDTRIP-73
reason: prove-client-result-continuation
```

The call rendered as a native dynamic-tool card in the Chat transcript.

This proves:

1. `local_function_signatures` is a functioning model-facing local-tool interface.
2. The ChatGPT server is not restricted to the literal built-in name `handoff` in ordinary Chat mode.
3. Arbitrary client-advertised function names can be selected by the model.
4. Arbitrary custom arguments survive the complete server round trip.
5. The resulting call is normalized/rendered as a native `dynamic-tool-call`.

This is a live protocol proof, not a static inference.

---

## Winston / Gizmo mode result

The same custom signature was constructed in Winston / `gizmo_interaction` mode; instrumentation observed repeated signature generation (`__codexLocalFnQaSignatureBuilds = 9` in one run).

However Winston replied that `qa_local_echo` was unavailable and emitted no custom local-function call.

Current evidence:

```text
ordinary Chat
  arbitrary local function invocation = PROVEN

Winston / gizmo_interaction
  custom local signature built = PROVEN
  arbitrary local function invocation = NOT OBSERVED / currently blocked
```

This likely reflects a server-side Gizmo/tool-capability boundary or conversation-mode behavior. Do not assume Gizmo local functions work yet.

A temporary probe currently also contains experimental code that strips `conversation_mode` while retaining the gizmo ID. This was exploratory and has not been promoted or fully validated. Treat it as disposable.

---

# Disposable QA Probe State

## Temporary feature root

```text
/tmp/codex-localfn-features
```

Enabled feature config:

```text
/tmp/codex-localfn-features/features.json
```

It enables:

```text
chat-tool-calls
chat-bridge-tool-calls
hermes-chat-lifecycle
local-function-probe
```

The first three are symlinked to the real repo features. `local-function-probe` exists only under `/tmp`.

Probe patch:

```text
/tmp/codex-localfn-features/local-function-probe/patch.js
```

Probe manifest/readme:

```text
/tmp/codex-localfn-features/local-function-probe/feature.json
/tmp/codex-localfn-features/local-function-probe/README.md
```

### Probe instrumentation globals

Depending on build revision, the probe defines/increments:

```text
__codexLocalFnQaSignatureBuilds
__codexLocalFnQaNormalized
__codexLocalFnQaViewerRouted
__codexLocalFnQaDetected
__codexLocalFnQaLastRecipient
__codexLocalFnQaResultsSubmitted
__codexLocalFnQaLastResult
__codexLocalFnQaGizmoModeStripped
```

Unique intended rejection/result marker:

```text
LOCAL-QA-RESULT-73
```

### Current temp patch intent

The current `/tmp/.../patch.js` is **newer than the currently running app3 build**.

Current temp source has been changed to normalize server-emitted `qa_local_echo` calls to the native renderer-facing tool tag `handoff` at the message normalization seam:

```text
server/source recipient remains functions.qa_local_echo or local.qa_local_echo
normalized dynamic-tool-call item.tool becomes "handoff"
```

The purpose is to make every native handoff-specialized render/executor branch eligible while preserving the original source message/call ID and using the renamed exported function constant for result submission.

This latest normalization change has NOT YET been rebuilt into the currently running app3 candidate.

That distinction is critical.

---

## Supported builds completed

Two supported-pipeline disposable builds completed successfully:

```text
/tmp/codex-localfn-supported-build.exit = 0
/tmp/codex-localfn-roundtrip-build.exit = 0
```

The supported feature/build pipeline was necessary because naïve ASAR extract/repack caused runtime failure (`ChatGPT hit a snag`) due packaging/link semantics. That naïve run was discarded as protocol evidence.

Do not repeat naïve ASAR repacking for this experiment.

Use the repo's supported rebuild pipeline.

Previous round-trip build log/report:

```text
/tmp/codex-localfn-roundtrip-build.log
/tmp/codex-localfn-build-report3/patch-report.json
```

The report showed QA descriptors applied, including viewer instrumentation.

---

## Current running disposable candidate

Unit:

```text
codex-localfn-qa.service
```

Latest observed:

```text
ActiveState=active
SubState=running
MainPID=504242
InvocationID=1d479748bb0a430a87a9522ca37d0f70
```

CDP:

```text
http://127.0.0.1:9243
Chrome/152.0.7977.64
Protocol-Version 1.3
```

Current app directory:

```text
/tmp/codex-localfn-qa-app3
```

Runtime log:

```text
/tmp/codex-localfn-roundtrip-runtime.log
```

IMPORTANT: app3 was built BEFORE the very latest `qa_local_echo -> handoff` normalization edit now present in the temp patch. Therefore current runtime counters from app3 cannot validate that latest change.

---

# Exact point where execution stopped

The last completed reasoning step found the missing architectural seam:

1. Ordinary Chat definitely emits `qa_local_echo` calls.
2. The live running bundle had:
   - custom signature generation
   - custom result submitter instrumentation
   - viewer instrumentation
3. Viewer route counter remained zero.
4. Static bundle search showed only these literal handoff special cases:
   - `viewer-b286e659c89a.js`: `dynamic-tool-call.tool === "handoff"`
   - `local-conversation-thread-c7ae74a9bc27.js`: thread/tool display logic with handoff checks
   - `app-initial-36a3a1b7313c.js`: normalization/grouping logic and handoff classification
5. The live `viewer` script did contain the QA instrumentation, proving build composition was correct.
6. The real issue is normalization/routing: arbitrary local calls remain `tool:"qa_local_echo"`, while native local execution branches expect renderer-facing `tool:"handoff"`.
7. The latest temp patch therefore changed the app-initial normalization seam so **only `qa_local_echo`** becomes renderer-facing `tool:"handoff"`, while source recipient/call ID remain unchanged.
8. Execution timed out immediately after making that temp patch change.

The next agent should NOT start by searching for another viewer bundle. First rebuild the current temp patch and test the normalized route.

---

# Immediate next steps (recommended exact order)

## 1. Validate the latest temp transform before rebuilding

Run the current temporary patch against the official extracted assets and verify:

- exact anchors all match once
- transformed JS passes `node --check`
- idempotence holds
- normalization counter/source is present
- original recipient detector remains `functions.qa_local_echo` / `local.qa_local_echo`
- generic result submitter instrumentation remains present

The temp patch currently uses strict `replaceExactlyOnce()` anchors, so failures should be explicit.

## 2. Stop the current disposable app3 unit

```bash
systemctl --user stop codex-localfn-qa.service
```

Do not use `pkill -f` with a command containing the same app path; a prior QA attempt self-killed its shell that way.

## 3. Rebuild through the supported pipeline into a NEW directory

Suggested next app dir:

```text
/tmp/codex-localfn-qa-app4
```

Suggested report dir:

```text
/tmp/codex-localfn-build-report4
```

Use:

```bash
CODEX_LINUX_FEATURES_ROOT=/tmp/codex-localfn-features \
CODEX_LINUX_FEATURES_CONFIG=/tmp/codex-localfn-features/features.json \
CODEX_NEXT_APP_DIR=/tmp/codex-localfn-qa-app4 \
REBUILD_REPORT_DIR=/tmp/codex-localfn-build-report4 \
./scripts/rebuild-candidate.sh /tmp/chatgpt_26.901.41600_amd64.deb
```

If `/tmp` is short on space, remove only obsolete disposable QA trees. An earlier rebuild failed because `/tmp` was full; after cleanup there was ~13 GB free and builds succeeded.

## 4. Launch app4 in its own user-systemd unit

Use independent user-systemd ownership so bridge hard recovery cannot kill the Electron app.

Example:

```bash
systemd-run --user \
  --unit=codex-localfn-qa \
  --property=CollectMode=inactive-or-failed \
  /bin/bash -lc 'cd /tmp/codex-localfn-qa-app4 && exec ./start.sh --no-sandbox --remote-debugging-port=9243 --remote-allow-origins=http://127.0.0.1:9243 > /tmp/codex-localfn-app4-runtime.log 2>&1'
```

Port `9233` belongs to qBittorrent on this machine; use `9243` or another verified-free port.

## 5. Run a fresh ordinary Chat local-function round trip

Submit something equivalent to:

```text
Protocol QA round trip: call the local function qa_local_echo exactly once with prompt='ROUNDTRIP-74' and reason='prove-client-result-continuation'. Do not call any other tool. When the local result arrives, reply with exactly its message string and nothing else.
```

Expected success sequence:

```text
__codexLocalFnQaSignatureBuilds > 0
__codexLocalFnQaNormalized > 0
native handoff/local executor mounts
__codexLocalFnQaViewerRouted > 0 (if viewer path is used)
__codexLocalFnQaDetected > 0
last recipient = functions.qa_local_echo or local.qa_local_echo
Reject/negative path sends LOCAL-QA-RESULT-73
__codexLocalFnQaResultsSubmitted > 0
__codexLocalFnQaLastResult.toolName == qa_local_echo
__codexLocalFnQaLastResult.result.message == LOCAL-QA-RESULT-73
ChatGPT final response == LOCAL-QA-RESULT-73
```

If the native handoff UI appears with Accept/Reject, click **Reject**. The temp primary patch changes the rejected response payload to the unique marker.

The key proof is the combination of:

1. server emitted custom function call;
2. client result instrumentation records exact `callId/toolName/result`;
3. ChatGPT continuation consumes the marker.

## 6. If normalization still does not mount the native executor

Inspect the normalized item at runtime before adding more bundle patches.

Use CDP / live script source and compare:

```text
dynamic-tool-call item.tool
source message recipient
call ID
conversation item placement
```

Do not assume another lazy bundle without evidence.

## 7. Only after ordinary Chat full round trip succeeds, revisit Winston/Gizmo

The Gizmo result is currently negative/incomplete.

Research options:

- determine whether `conversation_mode: {kind:"gizmo_interaction"}` suppresses local function availability server-side;
- test whether removing/altering conversation mode while preserving injected Winston persona/orientation is viable;
- consider whether the ideal architecture should stop depending on Custom GPT/Gizmo mode and instead inject Winston's identity/orientation locally in ordinary Chat mode.

Do not productionize the experimental Gizmo mode stripping currently in the temp patch without separate validation.

---

# Why this research matters for the final architecture

If the full local result round trip succeeds, the leading ideal architecture becomes:

```text
ChatGPT ordinary Chat
  -> local_function_signatures
  -> Codex local tool dispatcher
  -> local Hermes runtime/tools
  -> hidden role:"tool" result
  -> ChatGPT continuation
```

Potential benefits:

- removes public GPT Action server from the interactive Hermes tool path;
- eliminates Action-session adoption/unification complexity;
- lower latency;
- exact local lifecycle correlation (`session_key`, `session_id`, `task_id`, `turn_id`, `api_request_id`, `tool_call_id`);
- easier cancellation/error propagation;
- no model-carried bridge session bootstrap requirement;
- no Action-side process/service recovery interfering with foreground tool execution.

The public bridge could remain for other surfaces/use cases, but would no longer be necessary for Codex Chat interactive tool execution.

If Gizmo mode fundamentally cannot use arbitrary local functions, the likely product-level choice becomes:

```text
A. keep Winston as Custom GPT / Gizmo and retain GPT Actions
or
B. recreate Winston identity/orientation in ordinary Chat through Codex-local trusted context, enabling local Hermes tools
```

This decision should be made only after the ordinary-Chat local result continuation is proven.

---

# QA harness lesson: avoid bridge-owned Electron processes

Earlier visual QA appeared to crash Codex with Chromium:

```text
zygote communication failure
-> Storage/Network/GPU launch failures code 1002
-> GPU unusable
```

Root cause was proven with `strace` + systemd journal:

```text
Hermes execute_code timeout
-> bridge hard recovery
-> hermes-chatgpt.service exits 75/TEMPFAIL
-> systemd --user SIGTERMs the entire bridge service cgroup
-> QA-launched Codex inherited that cgroup and was killed
```

Therefore all long-lived Electron QA must launch in an independent user-systemd unit/scope. This is already documented in `docs/hermes-chat-lifecycle-status.md` and `docs/hermes-chat-lifecycle-plan.md`.

---

# Existing relevant documentation

Read these before changing architecture:

```text
/home/chris/Projects/codex-desktop-linux/docs/hermes-chat-lifecycle-plan.md
/home/chris/Projects/codex-desktop-linux/docs/hermes-chat-lifecycle-status.md
/home/chris/Projects/codex-desktop-linux/docs/chat-tool-calls-notes.md
/home/chris/Projects/codex-desktop-linux/linux-features/hermes-chat-lifecycle/README.md
/home/chris/Projects/codex-desktop-linux/linux-features/chat-tool-calls/README.md
/home/chris/Projects/codex-desktop-linux/linux-features/chat-bridge-tool-calls/README.md
```

`docs/hermes-chat-lifecycle-status.md` already contains the live ordinary-Chat local-function proof and the Winston/Gizmo difference.

---

# Bridge repo read-only findings retained for fallback architecture

If local functions fail as the final architecture, the conservative bridge design should use:

```text
stable workspace identity:
  session_key
  task_id

rotating Hermes lifecycle identity:
  session_id = hs_codex_*

per turn:
  turn_id
  api_request_id
  tool_call_id = Action request_id surrogate
```

Likely local control plane:

```text
$XDG_RUNTIME_DIR/hermes-chatgpt/session-control.sock
```

using filesystem permissions + `SO_PEERCRED`, not an additional secret copied into Codex.

Public/model-driven `hermes_bootstrap` is a candidate for removal if bridge integration is redesigned, since it is currently the only public normal session-creation operation and the only Action request without `session_id`.

Again: do not edit `/home/chris/Projects/hermes-chatgpt` until the user is shown the exact proposed bridge change first.

---

# Known pitfalls

1. **Naïve ASAR extract/repack is invalid evidence.** It produced runtime route failures. Use supported feature/build pipeline.
2. **`9233` is occupied by qBittorrent.** Use `9243` or another checked-free port.
3. **Bridge tool timeouts can restart `hermes-chatgpt.service`.** Never launch QA Electron as its descendant.
4. **Background process handles may become stale across Hermes bridge recovery.** Prefer explicit result/log/exit files for long supported builds.
5. **The current temp patch is ahead of the running app3 build.** Rebuild before interpreting the new normalization behavior.
6. **Do not treat Gizmo failure as proof local functions are globally unsupported.** Ordinary Chat has already proven they work.
7. **Do not treat ordinary Chat call proof as full local execution proof yet.** Client result continuation for the custom function remains the final missing live step.
8. **Do not overfit to minified symbol names.** Anchor semantic byte sequences and verify exact count/idempotence.
9. **The current temp patch contains experimental Gizmo-mode stripping.** Keep it disposable until separately validated.

---

# Success criteria for this research phase

The local-function architecture becomes fully validated when all of the following are observed in a single clean ordinary-Chat turn:

```text
1. custom signature advertised
2. ChatGPT emits qa_local_echo call
3. client recognizes/routs it to a local executor
4. local executor produces result
5. generic Ygi/tool-role continuation submits result
6. instrumentation records exact callId/toolName/result
7. ChatGPT resumes from that result
8. final assistant output proves result consumption
```

Recommended unique marker remains:

```text
LOCAL-QA-RESULT-73
```

After that, test:

- two sequential local calls in one turn;
- model -> tool -> model -> tool -> model loops;
- cancellation while local tool runs;
- local executor error propagation;
- unknown/unhandled local function behavior;
- conversation history persistence;
- parallel tool-call behavior;
- coexistence with existing GPT Actions;
- ordinary Chat + locally injected Winston persona/orientation;
- Gizmo behavior only if keeping Custom GPT mode is still desired.

---

## Final handoff status

**Proven:**

```text
ordinary ChatGPT Chat accepts and emits arbitrary client-local function names via local_function_signatures
```

**Statically proven:**

```text
Codex has a generic hidden role:"tool" local-result continuation mechanism used by handoff
```

**Live-proven end to end on app4 (2026-09-07):**

```text
custom qa_local_echo client execution
  -> native handoff executor route
  -> hidden role:"tool" result containing LOCAL-QA-RESULT-73
  -> ChatGPT continuation
  -> final assistant text LOCAL-QA-RESULT-73
```

The clean app4 validation used:

```text
candidate: /tmp/codex-localfn-qa-app4
report:    /tmp/codex-localfn-build-report4
unit:      codex-localfn-qa.service
CDP:       http://127.0.0.1:9243
```

Observed runtime evidence from one ordinary-Chat turn:

```text
__codexLocalFnQaSignatureBuilds = 9
__codexLocalFnQaNormalized = 12
__codexLocalFnQaViewerRouted = 11
__codexLocalFnQaDetected = 3
__codexLocalFnQaResultsSubmitted = 1
__codexLocalFnQaLastRecipient = local.qa_local_echo

callId = ab823175-806d-4c78-b9be-ee2572b4e3a9
conversationId = local-chatgpt:0881ed53-4b04-4265-810a-814893547ff7
toolName = qa_local_echo
result = {accepted:false,message:"LOCAL-QA-RESULT-73"}
final assistant text = LOCAL-QA-RESULT-73
```

This closes the protocol research success criteria for ordinary Chat. The next validation gate is presentation: local Hermes function calls and their results must remain visibly represented in the transcript using the established Chat/Hermes Action disclosure-card treatment. The temporary normalization to renderer-facing `tool:"handoff"` currently reaches the executor, but the completed turn does not retain a visible tool-call row. Do not productionize the executor until visible, expandable, untruncated call/result disclosure has been runtime-verified.

Bridge repo remains untouched.
