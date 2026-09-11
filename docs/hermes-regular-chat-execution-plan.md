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

The QA Electron process must remain outside the Hermes bridge service cgroup. Use the harness-dedicated user unit `codex-hermes-qa` (or an equivalent independent user scope), with the staging app and CDP endpoint. Do not reuse historical `codex-merge-qa` units because a stale transient unit can retain an old candidate path or launch arguments:

```bash
systemd-run --user --unit=codex-hermes-qa --collect \
  bash -lc 'cd /home/chris/.cache/codex-merge-app && exec ./start.sh \
    --no-sandbox --force-renderer-accessibility \
    --remote-debugging-port=9243 \
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

Status: **COMPLETE**

- [x] Read repository `AGENTS.md` and related Hermes/Path-A/tooling docs.
- [x] Re-run related source tests on the current dirty worktree: 104 tests, 92 pass, 12 expected asset-dependent skips, 0 failures.
- [x] Confirm D10 source fix is present in `_ensure_tool_session` and currently ahead of the live QA log.
- [x] Confirm current architectural gap: text-only regular Chat remains lifecycle-free.
- [x] Confirm current identity mismatch: Hermes `task_id` is derived from rotating `session_id` in several helper paths.
- [x] Create committed reusable QA harness from the proven cache drivers, removing hard-coded historical IDs and known driver bugs. Shared `cdp_client.py`, `app.py`, `chat.py`, `recents.py`, `lifecycle.py`, `lcm.py`, `evidence.py`, `computer_use.py`, and scenario `run.py` live under `scripts/qa/hermes-chat/`.
- [x] Add focused harness unit tests for JS generation, target selection, lifecycle correlation, DB-delta assertions, and reusable primitives where testable without the live app. Initial suite: **6/6 pass** on 2026-09-08 and remains **6/6 pass** after E0 hardening.
- [x] Run E0 with both CDP and Computer Use. **PASS:** `20260909T045330Z-e0-sanity-463aeb85`; lifecycle delta 0, LCM delta 0, DB integrity clean. Computer Use screenshot + AT-SPI geometry independently matched the CDP composer. Current-session GNOME pointer/keyboard injection remains environment-limited and is recorded diagnostically rather than trusted from backend `ok:true` alone.

### Phase B — close D10 and identity separation

Status: **COMPLETE**

- [x] Live-run the E6/D10 alias-continuity path against the current `_ensure_tool_session` alias-resolution fix. **PASS:** `20260909T145606Z-e6-restart-reopen-dc243350`; 6→8 canonical rows, 3→4 tool pairs, zero server-key rows, immutable prefix preserved, new lifecycle session after restart. This closes the D10 key-split defect. Full E6 acceptance is re-run after stable `task_id` separation because that criterion is intentionally not satisfied by the current implementation.
- [x] Persist D10 evidence in the QA log and this plan.
- [x] Introduce stable logical workspace/task identity independent of `hs_codex_*` session ID in source: `chatgpt-codex:<canonical conversation id>`, with lifecycle-session fallback only when no conversation identity exists.
- [x] Replace lifecycle-helper Hermes `task_id` consumers with `SessionRuntime.task_id`; leave API request IDs lifecycle-session-scoped for per-request correlation.
- [x] Unit-test restart/session-rotation behavior. **18/18 lifecycle tests pass** after a deliberate two-failure red state (`_task_id` absent and tool dispatch still session-scoped).
- [x] Re-run E6 with explicit assertions that lifecycle `session_id` rotates while `task_id` remains identical across reopen. **PASS:** isolated-LCM run `20260909T191914Z-e6-restart-reopen-19a56ce0`; canonical key `local-chatgpt:4a9801b0-55c6-4264-bb5f-cb80fea43967`, stable task ID `chatgpt-codex:local-chatgpt:4a9801b0-55c6-4264-bb5f-cb80fea43967`, lifecycle session rotated `hs_codex_4e98340c308c44a092066e4e3c736f4d` → `hs_codex_20e56d156b184830bcf50374ce5bb2e7`, 6→12 canonical rows, 3→6 tool pairs, zero server-key rows, `integrity_check=ok`, messages=FTS=307879.
- [x] Re-run E5 after E6 identity acceptance. **PASS:** isolated-LCM run `20260909T221100Z-e5-same-process-reuse-f2cd5052`; two consecutive regular-Chat turns each completed `hermes_tool_search → hermes_tool_describe → hermes_tool_call` in one Electron process, one lifecycle session `hs_codex_5776f810a9da4ee4bfee184cc737abb8`, and one stable task `chatgpt-codex:local-chatgpt:213aa1a4-8a53-4d99-becb-b67ba24bf959`. The composer remained visible after both turns. Clean finalization produced 12 canonical rows / 6 tool pairs, zero server-key rows, messages=FTS=307879, `integrity_check=ok`, and zero FK violations.

### Phase C — full Hermes lifecycle for regular Chat

Status: **IN PROGRESS — E1 CLOSED/PASS; E2/E4/E9 pending**

- [x] Identify the regular-Chat request/turn hooks that are upstream of local tool dispatch.
- [x] Generalize lifecycle activation from registered Gizmos to the intended regular-Chat eligibility policy.
- [x] Ensure no-tool turns run begin/pre-request/complete lifecycle.
- [x] Reuse the open runtime for local tool calls within the turn.
- [ ] Preserve existing Gizmo behavior during transition with an explicit live regression run.
- [x] Unit/structural tests. Current lifecycle suite: **26/26 pass**; QA harness: **11/11 pass** after E1 send/reopen hardening.
- [x] E1 live run. **PASS:** `20260911T013528Z-e1-no-tool-lifecycle-c8bb1287`; two no-tool turns, one lifecycle session/task, exact server-ID remount recovery after a pristine-upstream-reproduced composer detach, four canonical LCM rows, zero tools/server-key rows, clean integrity, restart/reopen, and read-only postconditions.
- [ ] E2, E4, E9 live runs.

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

### R2 — stable workspace/task identity — CLOSED 2026-09-09

Hermes operational `task_id` now derives from the canonical logical conversation (`chatgpt-codex:<canonical conversation id>`), while `hs_codex_*` remains a rotating lifecycle epoch. Unit coverage proves stable derivation across lifecycle rotation and server-ID-only reopen. Live E6 proves the same task ID survives an Electron restart while lifecycle session identity rotates; live E5 proves two consecutive same-process tool turns reuse one lifecycle session/task.

### R3 — D10 reopen key split — CLOSED 2026-09-09

The `_ensure_tool_session` reverse-alias fix is now live-proven across an actual Electron restart. Reusable E6 run `20260909T145606Z-e6-restart-reopen-dc243350` finalized 6 rows / 3 tool pairs before restart, reopened the exact server conversation through the real virtualized Recents UI, executed another Hermes tool turn under a new lifecycle session, then finalized 8 rows / 4 tool pairs under the original local canonical key. The original prefix remained byte-identical, zero rows appeared under the bare server UUID, and SQLite integrity/FK/FTS checks remained clean. Stable operational `task_id` remains a separate Phase B requirement.

### R4 — local-function implementation is still QA-only

`local-function-probe` remains intentionally outside cumulative distribution. Phase D must make a supported production ownership decision.

### R5 — visual completed-result disclosure still needs Computer Use proof

Live E5 now proves functional completed-result continuation on the current candidate: both Hermes tool turns complete, hidden result pairing succeeds, and the composer remains available for the next turn. The visible transcript still shows the synthetic handoff envelope rather than final polished product disclosure, and a fresh current-build Computer Use visual proof is still required before this presentation path is considered production-ready.

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

### 2026-09-09 — Phase A E0 completion

- Dedicated QA ownership moved to `codex-hermes-qa` after proving the historical transient unit could retain a stale candidate path/arguments.
- QA launch now enables `--force-renderer-accessibility`; Computer Use sees a 334-node Electron AT-SPI tree including the real `Message ChatGPT` composer.
- Exact-shell startup races are handled by waiting for `app://-/index.html` and tolerating the brief pre-`document.body` state.
- Current GNOME session cannot provide reliable Computer Use keyboard/pointer effect despite backend send success; failed attempts are preserved and classified as environment/Computer Use limitations rather than Hermes defects.
- Deterministic E0 cross-check now uses Computer Use screenshot + AT-SPI geometry against CDP DOM geometry.
- E0 **PASS**: `20260909T045330Z-e0-sanity-463aeb85`; geometry deltas all < 2 px, no Chat turn sent, lifecycle delta 0, LCM delta 0, integrity/FK/FTS checks clean.
- Code/KISS review removed experiment-only `set_value` QA residue and retained one CDP client plus one Computer Use MCP client.
- Dedicated live evidence log created at `docs/hermes-regular-chat-qa-log.md`.

### 2026-09-09 — D10 alias-continuity closure

- Rebuilt `/home/chris/.cache/codex-merge-app` from the valid cached 26.901.51231 package with the current lifecycle/probe feature sources and verified the staged helper contains the `_ensure_tool_session()` reverse-alias payload fix.
- Hardened the reusable E6 driver around current upstream behavior: semantic `[data-turn-key]` transcript extraction, absolute CDP RPC deadlines, current Chat/New-chat ARIA state, Work upsell dismissal, lifecycle identity extraction from `session_open`, finalization-aware LCM snapshots, delayed shell/Recents hydration, and offscreen virtualized-row scrolling before native click.
- D10 supplemental proof **PASS:** `20260909T145304Z-d10-postrestart-proof-7b7c8036`; original 6 rows remained byte-identical, 2 new rows appended under the original local key, zero server-key rows, reopened server UUID resolved to the original local key under new lifecycle session `hs_codex_5e5774940d224f1da79e835528dc979b`.
- Reusable E6 command **PASS:** `20260909T145606Z-e6-restart-reopen-dc243350`; local key `local-chatgpt:8145ca8f-1403-495f-bfe6-716535e32e98`, server UUID `6aa17388-c118-83e8-859c-af99320dd4bd`, 6→8 rows, 3→4 tool pairs, zero server-key rows, new lifecycle session `hs_codex_5027bfde8f1a45dc9348904942cfb6fc`, DB integrity/FK/FTS clean.
- D10 key-split defect is closed. Full E6 remains scheduled after stable operational `task_id` is separated from lifecycle `session_id`, because the current helper still derives `task_id` from the rotating lifecycle session.

### 2026-09-09 — stable operational task identity implementation

- Architecture review froze three scopes: canonical conversation identity for logical continuity, `chatgpt-codex:<canonical conversation id>` for Hermes operational workspace/task identity, and rotating `hs_codex_*` for lifecycle epochs.
- API request IDs remain lifecycle-session-scoped because they correlate one request inside one epoch.
- TDD red state produced exactly two intended failures: `_task_id` absent and local tool dispatch still receiving `chatgpt-codex:<hs_codex_*>`.
- Added `_task_id()` plus `SessionRuntime.task_id`; routed Hermes hook/context/tool consumers through the stable task identity and exposed it on `session_open` / tool diagnostics for live verification.
- Lifecycle feature tests are now **18/18 pass**, including stable derivation across two lifecycle session IDs, server-ID-only reopen, conversation-based tool dispatch, and session fallback when conversation identity is unavailable.
- Live E6 task-identity acceptance is **functionally PASS** for identity continuity in evidence `20260909T172536Z-e6-restart-reopen-1accd5a1`: canonical conversation `local-chatgpt:007ab258-4635-4490-b3c9-1784cc6e0e5d` kept task ID `chatgpt-codex:local-chatgpt:007ab258-4635-4490-b3c9-1784cc6e0e5d` while lifecycle session rotated from `hs_codex_0e79105bcdf74f5999c69f78a98cb389` to `hs_codex_5821fbb5de6f44df83de2c7d07b79062`.
- The same E6 run remains globally **FAIL** because `LCMDatabase.integrity()` detected pre-existing SQLite secondary-index corruption before the restart. Read-only forensics later proved the apparent 8-row FTS/message mismatch was a harness counting artifact: SQLite had optimized plain `COUNT(*) FROM messages` through a corrupt covering index. The base table and FTS both contain **307867** rows with exact ID-set equality. The identity assertions completed successfully before the integrity gate.
- Forensic snapshot `20260909T180129Z-lcm-integrity-forensics-1989292e` localizes corruption to the four `messages` secondary indexes. Direct `REINDEX` is unsafe for the cross-linked tree: it damaged a disposable clone's base table. A safe copy-only reconstruction is proven by removing only the corrupt index catalog rows with `writable_schema`, `VACUUM INTO` a fresh DB, then recreating the four captured indexes. Final copy verification: `quick_check=ok`, `integrity_check=ok`, 0 FK violations, every recreated index has 307867 distinct rowids with 0 duplicate/missing/extra entries, and all measured base-table/FTS logical SHA256 digests match pre-repair exactly.
- The QA LCM reader now forces `messages NOT INDEXED` for logical message counts/rows so secondary-index corruption cannot masquerade as FTS divergence; the harness is **7/7 pass** after this correction. No live DB repair has been performed.
- The live candidate used the already-proven 26.901.51231 app bundle with only the lifecycle feature resource restaged through `linux-features.js --stage-install`; staged and source helper SHA256 matched exactly (`1d1c5dba1ce5a39ec68cabaf89611b0c268ffc1a291b8b53856f97d0f415364b`). The upstream `.deb` had been cleaned from local storage, so a full package rebuild was not possible without reacquiring it.
- Full E6 acceptance was recovered safely by using Hermes-LCM's supported `LCM_DATABASE_PATH` override plus `CODEX_HERMES_QA_LCM_DB`, both pointing at a fresh writable clone of the proven salvaged DB under a dedicated transient unit. First isolated attempt `20260909T190721Z-e6-restart-reopen-a05a1261` proved signatures were built but the model declined the meta-tools; E6 prompts were hardened to require exact `hermes_tool_search → hermes_tool_describe → hermes_tool_call` calls and committed in `a8dc78b`.
- Deterministic isolated E6 **PASS:** `20260909T191914Z-e6-restart-reopen-19a56ce0`. Pre-restart: 6 canonical rows / 3 tool pairs / integrity `ok`. Post-restart: 12 canonical rows / 6 tool pairs / zero server-key rows / integrity `ok`; task ID remained `chatgpt-codex:local-chatgpt:4a9801b0-55c6-4264-bb5f-cb80fea43967` while lifecycle session rotated `hs_codex_4e98340c308c44a092066e4e3c736f4d` → `hs_codex_20e56d156b184830bcf50374ce5bb2e7`. Final isolated DB: 307879 messages = 307879 FTS, 0 FK violations, SHA256 `73a8d816b1b1f556fa8eed49dcdeefb9b87b2aae9df12faf12987afa7244fc2c`.

### 2026-09-09 — E5 same-process reuse and Phase B closure

- Reusable E5 scenario added and hardened with bounded retries for zero-tool model refusals; an attempt satisfies the logical-turn gate only when its lifecycle delta is exactly `hermes_tool_search → hermes_tool_describe → hermes_tool_call`. Partial/unexpected sequences fail closed.
- Live E5 exposed the Path-A presentation defect that successful local results left the conversation in the native terminal handoff state with no composer. Two broader fixes were rejected by live evidence: replacing internal `tool:"handoff"` broke the executor path, and bypassing the native handoff viewer also prevented the component that mounts the executor.
- Final fix preserves native handoff execution state and mounts the normal handoff component while the call is pending, then suppresses only its terminal accepted-result card once a `sourceTool` result has been published. Structural suite covers fresh patching, migration from the earlier bypass form, idempotence, and fail-closed duplicate anchors.
- Source/product checkpoints are pushed through `57d9b58` (`fix: suppress completed local handoff presentation`). Full validation before live acceptance: QA **8/8**, structural **7/7**, related suite **109 total / 97 pass / 12 expected skips / 0 failures**.
- Candidate rebuild used preserved known-working ASAR `cf7b9fdf…` as the composition base. `app-initial` remained byte-identical, including two internal handoff execution anchors. The viewer differed only by one 80-byte completed-`sourceTool` suppression; removing it reproduces the base viewer byte-for-byte. Repacked candidate SHA256: `9af763bbfdacb526aa472e9d42eb1ed2f6910f4583b5921412627298cad345ca`. Full ASAR round trip: 8985 source files / 8985 extracted files / 0 missing / 0 extra / 0 hash mismatches.
- Isolated E5 **PASS:** `20260909T221100Z-e5-same-process-reuse-f2cd5052`. Canonical conversation `local-chatgpt:213aa1a4-8a53-4d99-becb-b67ba24bf959` used lifecycle session `hs_codex_5776f810a9da4ee4bfee184cc737abb8` and stable task `chatgpt-codex:local-chatgpt:213aa1a4-8a53-4d99-becb-b67ba24bf959` for all six successful Hermes calls across two regular-Chat turns. The composer remained visible after both turns.
- Clean finalization produced 12 canonical rows / 6 tool pairs, zero rows under server UUID `6aa1d97e-0758-83e8-a9fc-6d566e799999`, messages=FTS=307879, `integrity_check=ok`, and zero FK violations. Frozen isolated DB SHA256: `728f6ad0787218fd2f6df869384ffe7488a824f34bbafde908d3f09d8ede73a3`.
- **Phase B is complete.** Phase C begins with the still-open R1 defect: ordinary regular-Chat no-tool turns must enter the Hermes lifecycle before any local tool call occurs.
