# Hermes in Regular ChatGPT Chat — Execution and QA Plan

Status: **ACTIVE**
Owner objective: **full Hermes lifecycle and Hermes tooling in regular ChatGPT Chat mode (plain Chat, no Gizmo dependency).**
Repository: `/home/chris/Projects/codex-desktop-linux/`
Primary QA app: `/home/chris/.cache/codex-merge-app`
Primary CDP endpoint: `127.0.0.1:9243`
Last updated: **2026-09-08**

## 1. Objective

Deliver a production-quality Linux desktop modification in which an ordinary ChatGPT Chat conversation receives the Hermes runtime lifecycle and can execute Hermes tools locally through ChatGPT's client-local function protocol.

The completed system must provide, in regular Chat mode:

1. Hermes lifecycle activation for every eligible turn, including turns that invoke no tools.
2. Hindsight / memory lifecycle hooks and context-engine lifecycle hooks at the same semantic boundaries already proven by `hermes-chat-lifecycle`.
3. Hermes local tools advertised to ChatGPT through the native local-function signature mechanism.
4. Tool calls executed by the Hermes registry in the persistent lifecycle helper, with truthful results returned through the native local tool-result continuation protocol.
5. Correct multi-call and multi-turn tool behavior.
6. Stable logical conversation/workspace identity across app restart, conversation reopen, and server conversation-id assignment.
7. Rotating Hermes lifecycle-session identity independent from the stable operational workspace/task identity.
8. Native Chat disclosure UI that preserves completed local tool calls and their results.
9. Safe finalization on normal completion, close, restart, failures, and cancellation.
10. Repeatable end-to-end QA through both CDP and Linux Computer Use, with durable evidence and automated assertions.

## 2. Explicit non-goals / historical boundaries

- A Custom GPT / Gizmo is not the target product surface.
- Public ChatGPT Action callbacks are not the primary local Hermes tooling transport.
- Forcing public Action traffic into the same `hs_codex_*` lifecycle session is not a design requirement.
- Renderer CDP network inspection is not treated as authoritative transport evidence where Chromium does not expose the packaged app's request channel.
- The `local-function-probe` name and QA-only packaging state are temporary; protocol-probe code must graduate into a supported feature before completion.

Historical research remains valuable in:

- `docs/hermes-chat-lifecycle-plan.md`
- `docs/hermes-chat-lifecycle-status.md`
- `docs/local-function-protocol-research-handoff.md`
- `docs/path-a-progress-disclosure.md`
- `docs/path-a-live-qa-log.md`

This file is the canonical forward execution plan for **regular Chat**.

## 3. Architecture invariants

### 3.1 Identity

Maintain separate identities for separate lifetimes:

- **logical conversation identity**: stable across temporary client IDs, server conversation-ID assignment, app restart, and reopen;
- **operational workspace / Hermes `task_id`**: stable for the logical conversation so process/CWD/browser/tool state can survive lifecycle epochs where appropriate;
- **lifecycle `session_id`**: rotating `hs_codex_*` epoch for one helper-owned runtime lifetime;
- **turn/request/tool-call IDs**: exact per-operation correlation IDs, never overloaded as conversation/session identity.

A server conversation UUID and its earlier `local-chatgpt:<uuid>` alias must resolve to one canonical logical conversation.

### 3.2 Lifecycle

Regular Chat must enter Hermes before the model turn even when no local tool is called. The desired semantic order is:

1. identify/canonicalize regular Chat conversation;
2. ensure lifecycle runtime for the logical conversation;
3. begin turn;
4. memory/Hindsight pre-turn work;
5. context-engine / pre-LLM work;
6. request preparation / API hooks;
7. model streaming;
8. zero or more local Hermes tool call/result continuations;
9. complete turn / post-LLM work;
10. finalization at conversation/app lifecycle boundaries.

Tool execution reuses the already-open turn/runtime rather than creating the lifecycle opportunistically as a side effect of the first tool.

### 3.3 Tooling

- ChatGPT receives local Hermes function signatures through the native client-local function surface.
- Bare/core tools may be advertised directly.
- Deferrable tools remain discoverable through the Hermes meta-tool flow (`tool_search`, `tool_describe`, `tool_call`) where appropriate.
- The Hermes registry remains authoritative for dispatch, schema validation, hooks, and returned errors.
- The model receives the exact meaningful tool result/error through the native local-result continuation.
- Completed call/result disclosure remains visible in the regular Chat transcript.

### 3.4 Fail closed

- Structural bundle anchors must be semantic and tested against the current official ASAR.
- Unknown or drifted bundle structures must fail the feature build/patch rather than silently produce a partially working app.
- Lifecycle/tool errors must be observable in QA logs and must not fabricate successful tool results.

## 4. Evidence model

Every end-to-end acceptance run should gather multiple independent evidence layers:

1. **CDP shell evidence** — visible shell target, transcript, composer, tool disclosure DOM, React/native input behavior.
2. **Computer Use evidence** — composited screenshot plus coordinate/key interaction for visual truth and independent UI control.
3. **Hermes lifecycle JSONL** — begin/open/tool/complete/finalize event ordering, IDs, durations, errors.
4. **LCM database evidence** — tool rows, canonical conversation key, append-only behavior, integrity/FK/FTS checks.
5. **Process/service evidence** — QA app PID, app path, independent systemd ownership, CDP port ownership, clean exit/restart.
6. **Source/structural evidence** — adjacent unit tests and current-ASAR anchor tests.

No single UI/text signal should carry an acceptance test when an independent assertion is available.

## 5. QA-app isolation rules

The QA Electron process must remain outside the Hermes bridge service cgroup. Use the independent user unit `codex-merge-qa` (or an equivalent independent user scope), with the staging app and CDP endpoint:

```bash
systemd-run --user --unit=codex-merge-qa --collect \
  bash -lc 'cd /home/chris/.cache/codex-merge-app && exec ./start.sh \
    --no-sandbox --remote-debugging-port=9243 \
    --remote-allow-origins=http://127.0.0.1:9243'
```

Before a restart:

- stop the unit;
- use `pkill -x ChatGPT` only when cleanup is needed;
- wait until TCP port 9243 is actually free;
- start the unit;
- prove `/proc/<pid>/exe` belongs to the staging app;
- prove `/json/list` exposes the exact `app://-/index.html` shell target.

## 6. Reusable QA tooling to build

Create a committed harness under `scripts/qa/hermes-chat/` so the proven `~/.cache/codex-qa/*.py` experiments stop being the only executable record.

Planned modules:

- `cdp_client.py` — exact shell-target selection, request-ID-safe CDP RPC, Runtime evaluate, native mouse/key events.
- `app.py` — safe start/stop/restart, port-free wait, PID/exe verification, lifecycle-log baseline, candidate sanity checks.
- `chat.py` — regular-Chat selection, fresh-chat setup, visible composer selection, base64-safe text insertion, transcript-based send acceptance, completion detection, upsell handling.
- `recents.py` — interaction-driven Recents hydration, virtualized-window scrolling, stable server-ID React-fiber lookup where available, title fallback, rendered-transcript identity proof.
- `lifecycle.py` — parse and correlate lifecycle events; assert expected phases/order/IDs/errors.
- `lcm.py` — snapshots, row deltas, canonical key checks, append-only checks, integrity/FK/FTS checks.
- `evidence.py` — per-run timestamped JSON/text evidence bundle with test name, source SHA, candidate path/version, IDs, lifecycle delta, DB delta, CDP state, and Computer Use evidence references.
- `run.py` — CLI entry point for individual tests or a matrix.

The harness should expose small deterministic commands rather than one giant scenario script. It should preserve raw evidence on failure.

### Harness quality requirements

- No hard-coded historical conversation IDs in reusable tests.
- A test that creates a conversation must capture its client alias and eventual server ID dynamically.
- Prompt transport must be base64-safe.
- Composer selection must target a visible shell `[contenteditable=true]`; never the hidden webview `#prompt-textarea`.
- Send uses CDP `Input.dispatchKeyEvent`, with transcript/user-marker acceptance.
- Recents navigation accounts for virtualization and interaction-gated hydration.
- CDP and Computer Use must each be usable independently enough to cross-check the other.
- Tests return distinct PASS / FAIL / INCONCLUSIVE outcomes where model choice can make a scenario nondeterministic.
- Assertions must distinguish product defects from harness defects.

## 7. End-to-end acceptance matrix

### E0 — QA harness sanity

- candidate process/path correct;
- exact shell target selected;
- visible composer confirmed on-screen by Computer Use;
- CDP-injected unique draft appears in the Computer Use screenshot;
- draft is cleared without sending;
- lifecycle/DB baselines captured.

### E1 — no-tool regular Chat lifecycle

Create a fresh regular Chat. Send two simple text-only turns.

Required:

- both turns render normally;
- **Hermes lifecycle exists for each turn** (this deliberately supersedes historical T5's `lifecycle_delta=0` criterion);
- begin/pre-LLM/request/complete ordering is correct;
- no tool rows are created;
- canonical conversation identity remains the same across both turns;
- memory/context lifecycle has no errors;
- DB integrity remains clean;
- conversation can be reopened after restart and both turns still render.

### E2 — direct local Hermes tool

Use one directly advertised Hermes tool in regular Chat.

Required:

- signature is advertised;
- model calls it;
- Hermes registry executes it inside the conversation's existing lifecycle runtime;
- exact tool result reaches the model;
- call/result disclosure remains visible after completion;
- lifecycle/tool IDs correlate;
- LCM receives exactly one call/result pair under the canonical conversation key.

### E3 — progressive disclosure / deferrable tool

Use `tool_search -> tool_describe -> tool_call` against a genuinely deferrable tool (current proven target: `process_manage`).

Required:

- all three calls execute in order;
- successful envelopes do not carry false rejection state;
- truthful target-tool validation/runtime errors propagate unchanged when intentionally induced;
- transcript disclosure and lifecycle log agree on the sequence;
- LCM row order agrees with the sequence.

### E4 — multi-tool one-turn loop

Prompt one turn requiring multiple local tool continuations.

Required:

- repeated model -> local tool -> model continuation succeeds;
- no duplicate execution;
- call IDs remain unique;
- all calls remain in the same lifecycle turn/runtime;
- final answer follows the final result.

### E5 — multi-turn persistence

Two consecutive tool-using turns in one new regular Chat.

Required:

- same canonical conversation/workspace identity;
- expected new tool rows for both turns in strict order;
- no prefix duplication;
- stable operational `task_id` across both turns;
- lifecycle session semantics match the intended epoch policy.

### E6 — restart/reopen continuity (D10 closure)

Create a tool conversation, capture temporary client identity and assigned server conversation ID, cleanly stop the app, restart, reopen by the real UI, then execute another tool turn.

Required:

- reopened server-ID-only event reverse-resolves to the original canonical logical conversation;
- existing LCM rows remain byte-identical;
- only the new call/result rows append;
- rows append under the original canonical key;
- stable operational `task_id` is reused;
- new rotating lifecycle `session_id` is allowed/expected after restart;
- no lifecycle/DB integrity errors.

This is the primary D10 acceptance test.

### E7 — truthful error/recovery

Exercise:

- unknown/invalid deferrable tool target;
- invalid arguments;
- executor/registry error;
- cancellation where practical.

Required:

- truthful structured error reaches the model;
- UI does not present false success;
- lifecycle records the operation accurately;
- next valid turn can recover.

### E8 — visual disclosure persistence

For a completed local tool call:

- Computer Use screenshot proves the call card/row is actually painted;
- CDP DOM probe identifies the corresponding visible disclosure;
- expanding/collapsing it preserves result content;
- reopening the conversation retains an appropriate completed presentation where the upstream UI supports persistence.

### E9 — shutdown/finalization

Cover clean app stop and at least one interruption/failure path.

Required:

- context-engine session end;
- memory session end/shutdown;
- finalization event;
- bounded flush;
- no duplicate finalization;
- DB integrity/FTS clean.

### E10 — regression matrix

- regular no-tool Chat;
- Chat with one tool;
- Chat with multi-tool continuation;
- restart/reopen;
- existing Work mode and Gizmo behavior remain functional enough that the regular-Chat patch does not regress unrelated routing;
- optional feature off -> baseline app behavior unchanged.

## 8. Engineering phases

### Phase A — freeze current baseline and commit the QA harness

Status: **IN PROGRESS**

- [x] Read repository `AGENTS.md` and related Hermes/Path-A/tooling docs.
- [x] Re-run related source tests on the current dirty worktree: 104 tests, 92 pass, 12 expected asset-dependent skips, 0 failures.
- [x] Confirm D10 source fix is present in `_ensure_tool_session` and currently ahead of the live QA log.
- [x] Confirm current architectural gap: text-only regular Chat remains lifecycle-free.
- [x] Confirm current identity mismatch: Hermes `task_id` is derived from rotating `session_id` in several helper paths.
- [ ] Create committed reusable QA harness from the proven cache drivers, removing hard-coded historical IDs and known driver bugs. **IN PROGRESS:** shared `cdp_client.py`, `app.py`, `chat.py`, `recents.py`, `lifecycle.py`, `lcm.py`, `evidence.py`, and `computer_use.py` now exist under `scripts/qa/hermes-chat/`; scenario CLI/live proof remains.
- [x] Add focused harness unit tests for JS generation, target selection, lifecycle correlation, DB-delta assertions, and reusable primitives where testable without the live app. Initial suite: **6/6 pass** on 2026-09-08.
- [ ] Run E0 with both CDP and Computer Use.

### Phase B — close D10 and identity separation

Status: **NOT STARTED**

- [ ] Live-run E6 against the current `_ensure_tool_session` alias-resolution fix.
- [ ] Persist evidence in the QA log and this plan.
- [ ] Introduce stable logical workspace/task identity independent of `hs_codex_*` session ID.
- [ ] Replace all lifecycle-helper `task_id = f"chatgpt-codex:{session_id}"` derivations with the stable workspace/task identity.
- [ ] Unit-test restart/session-rotation behavior.
- [ ] Re-run E5/E6.

### Phase C — full Hermes lifecycle for regular Chat

Status: **NOT STARTED**

- [ ] Identify the regular-Chat request/turn hooks that are upstream of local tool dispatch.
- [ ] Generalize lifecycle activation from registered Gizmos to the intended regular-Chat eligibility policy.
- [ ] Ensure no-tool turns run begin/pre-request/complete lifecycle.
- [ ] Reuse the open runtime for local tool calls within the turn.
- [ ] Preserve existing Gizmo behavior during transition.
- [ ] Unit/structural tests.
- [ ] E1, E2, E4, E9 live runs.

### Phase D — productionize regular-Chat Hermes tooling

Status: **NOT STARTED**

- [ ] Rename/refactor the QA-only `local-function-probe` implementation into a supported feature or integrate it cleanly with `hermes-chat-lifecycle` according to the KISS/architecture review.
- [ ] Remove disposable `/tmp` QA endpoint paths from production feature code.
- [ ] Make enabled-feature composition explicit and fail closed.
- [ ] Preserve local-result continuation and completed disclosure attachment.
- [ ] E2, E3, E4, E7, E8.

### Phase E — hardening and release validation

Status: **NOT STARTED**

- [ ] failure/cancellation/finalization matrix;
- [ ] repeated restart/reopen loops;
- [ ] performance sampling;
- [ ] broad source tests;
- [ ] official-ASAR patch validation;
- [ ] feature-alone and intended-feature-composition candidate builds;
- [ ] `git diff --check`;
- [ ] documentation reconciliation;
- [ ] broad repo validation from `docs/agents/validation-playbook.md` as applicable;
- [ ] final `chris-custom-sync.sh` only after the worktree/evidence is reviewed and intentionally committed.

## 9. Review cadence

Reviews are mandatory checkpoints, not final cleanup.

### Code review

Perform after each meaningful patch group and before every live acceptance run.

Check:

- correctness and failure paths;
- source-anchor robustness;
- accidental coupling to minified names;
- ID/correlation handling;
- resource cleanup;
- tests that prove the changed behavior;
- preservation of unrelated dirty user work.

### KISS review

Perform at the end of every engineering phase and whenever a patch introduces another compatibility shim.

Questions:

- Can the same behavior be expressed by one owner rather than parallel feature paths?
- Can lifecycle and tool IPC share one canonical conversation identity helper?
- Is an experimental probe becoming production architecture accidentally?
- Can a durable semantic anchor replace several drift-prone transforms?
- Can the QA harness expose one reusable primitive instead of another scenario-local copy?

### Architecture review

Perform before Phase B identity changes, before Phase C lifecycle generalization, and before Phase D feature productization.

Verify:

- lifecycle ownership;
- logical-conversation/workspace/session/turn/tool identity separation;
- ordinary-Chat eligibility boundary;
- finalization ownership;
- local-function transport ownership;
- LCM/Hindsight ownership;
- feature composition and disabled-feature baseline.

### Performance review

Perform after Phase C and Phase D, then once during hardening.

Measure/inspect:

- regular no-tool turn overhead added by lifecycle activation;
- helper process reuse and startup count;
- per-turn Hindsight/context cost;
- tool dispatch latency;
- lifecycle JSONL volume;
- LCM flush time and row growth;
- Electron main/renderer CPU/RSS/FD stability during repeated turns;
- duplicate or unnecessary work across begin/tool/complete paths.

Record actual measurements in the progress log rather than relying on impressions.

## 10. Documentation cadence

After every source change or live QA run:

1. update this plan's phase checklist/status;
2. append dated evidence/findings to `docs/path-a-live-qa-log.md` or a successor dedicated regular-Chat QA log;
3. update feature README contracts when behavior changes;
4. update `AGENTS.md` only for durable repository/QA knowledge future agents must follow;
5. mark superseded historical assertions explicitly rather than deleting useful research context.

Every defect discovered during QA gets:

- an ID;
- reproduction conditions;
- evidence;
- root cause;
- patch reference;
- automated regression where practical;
- live re-verification status.

Every harness defect gets the same treatment and must be distinguished from a product defect.

## 11. Current known findings / blockers

### R1 — regular no-tool Chat has no Hermes lifecycle

Current Path-A host creation is lazy on first local `tool_call`. Historical T5 therefore expected `lifecycle_delta=0`. This conflicts with the current objective and will be changed in Phase C.

### R2 — stable workspace/task identity is not yet implemented

`lifecycle_helper.py` still derives Hermes `task_id` from the rotating lifecycle `session_id` in multiple paths. This can rotate process/CWD/browser/tool workspace state across app restart. Phase B must separate these lifetimes.

### R3 — D10 reopen key split requires live re-verification

The current dirty source includes reverse alias resolution in `_ensure_tool_session`, but the latest live QA log records the pre-fix key split. E6 is required before declaring D10 closed.

### R4 — local-function implementation is still QA-only

`local-function-probe` remains intentionally outside cumulative distribution. Phase D must make a supported production ownership decision.

### R5 — visual completed-result disclosure needs current-build live proof

The source now contains result reattachment (`__codexP2ResultAttached`) and structural coverage, but a fresh current-build CDP + Computer Use proof is still required.

### R6 — cached QA drivers are valuable but drifted

The cache contains proven mechanics plus accumulated historical assumptions and duplicated helpers. Examples include hard-coded T3 IDs and stale row-click/comment paths. Commit a cleaned reusable harness before relying on these scripts as the long-term acceptance framework.

## 12. Progress log

### 2026-09-08 — plan initialization

- Repository guidance and Hermes/Path-A feature/docs reviewed.
- Current worktree intentionally left untouched while reading.
- Related source suite run: **104 tests / 92 pass / 12 expected skips / 0 failures**.
- Forward objective frozen to regular Chat full lifecycle + local Hermes tooling.
- Historical Gizmo and Action-session unification goals demoted from forward architecture.
- D10 source/log drift identified.
- Stable `task_id` vs rotating `session_id` mismatch identified.
- Reusable committed QA harness made the first implementation task before additional large patches.
