# Hermes Regular-Chat QA Log

Canonical execution plan: `docs/hermes-regular-chat-execution-plan.md`

This log records live end-to-end evidence for the regular ChatGPT Chat Hermes lifecycle/tooling work. Raw run evidence is written under `.codex-linux/qa/hermes-chat/` and is intentionally not a substitute for the concise durable findings recorded here.

## 2026-09-08 / 2026-09-09 — E0 harness sanity

### Scope

Prove that the reusable harness can independently observe the real staged Electron shell through CDP and Linux Computer Use without sending a ChatGPT turn, while preserving Hermes LCM integrity.

QA process:

- app: `/home/chris/.cache/codex-merge-app/ChatGPT`
- unit: `codex-hermes-qa`
- CDP: `127.0.0.1:9243`
- exact target: `app://-/index.html`
- launch includes `--force-renderer-accessibility`

### Harness/environment defects found while bringing E0 up

#### QH-001 — stale historical transient QA unit

The historical `codex-merge-qa` transient unit remained loaded with an old `.codex-app.candidate-live` `ExecStart`. Reusing an active unit by name could therefore test the wrong app and wrong launch arguments.

Resolution:

- dedicated harness unit is now `codex-hermes-qa`;
- staging app remains `/home/chris/.cache/codex-merge-app`;
- launch arguments are owned by the new harness;
- exact shell target is verified after start.

#### QH-002 — CDP listener races shell creation

Port 9243 can accept connections before the exact `app://-/index.html` page exists, and that page can exist briefly before `document.body` is populated.

Resolution:

- `wait_for_shell_target()` waits for the exact page target;
- shell state probing tolerates a temporarily missing `document.body`.

#### QH-003 — GNOME WindowControl unavailable in the current login session

`list_windows` cannot use the Codex GNOME extension until GNOME Shell reloads the newly installed extension. GNOME Introspect also denies `GetWindows` in this session.

The repository's `setup-window-targeting` command installed/enabled the extension for the next GNOME session. Current-session QA therefore uses:

- XDG Desktop Portal for the Computer Use full-screen image;
- AT-SPI for semantic app/composer discovery;
- `--force-renderer-accessibility` so Electron exposes the renderer tree.

#### QH-004 — Computer Use keyboard injection unavailable in this GNOME session

The GNOME RemoteDesktop keyboard portal is denied. A QA-local Ubuntu `ydotool` 1.0.4 extraction plus private `ydotoold` socket was also tested. Both Computer Use-wrapped and direct ydotool commands reported successful sends while CDP independently proved that no key or text reached the focused Electron composer.

AT-SPI reports the composer as `editable`, but Electron does not expose the AT-SPI EditableText/Value interface for it, so `set_value` is unavailable as a replacement.

This is an environment/Computer Use backend limitation. E0 does not treat an input command exit code as proof that input landed.

#### QH-005 — uinput pointer reports send without observable focus change

Computer Use resolves the exact AT-SPI composer node to its cached bounds center and reports a successful uinput absolute-pointer click. CDP still observes `document.activeElement === document.body` afterwards in this GNOME session.

The click result is therefore retained as diagnostic evidence and marked `environment_limited` unless CDP observes the focus transition. It is not used as the E0 pass gate.

### Deterministic Computer Use cross-check

E0 uses Computer Use as an independent observation channel:

1. CDP inserts a unique unsent draft into the visible shell composer and records its DOM `getBoundingClientRect()`.
2. Computer Use captures a real 1920x1080 PNG through XDG Desktop Portal.
3. Computer Use obtains a fresh AT-SPI tree for app `Codex` and must find exactly one visible/showing `entry` named `Message ChatGPT`.
4. The containing AT-SPI `ChatGPT` frame supplies the native frame offset.
5. The globalized CDP DOM bounds must agree with the independent AT-SPI composer bounds within 3 px on x/y/width/height.
6. Computer Use still attempts the semantic pointer click and records whether CDP observes focus.
7. CDP verifies the unique draft is unchanged, clears it without sending, and verifies the composer is empty.
8. Lifecycle and LCM deltas/integrity are checked.

### Failed evidence runs retained

- `20260909T042111Z-e0-sanity-ee94f921` — AT-SPI semantic target/click path worked; GNOME RemoteDesktop key path denied.
- `20260909T042436Z-e0-sanity-47b0d11b` — Electron composer does not expose AT-SPI EditableText/Value.
- `20260909T043535Z-e0-sanity-3071aa58` — ydotool reported successful Ctrl+A/Backspace while CDP proved the draft remained unchanged.
- `20260909T044538Z-e0-sanity-b9b2a146` — uinput semantic click reported success while CDP proved composer focus did not change.

These are harness/environment findings rather than Hermes lifecycle/tooling product failures.

### Passing evidence

Run: `20260909T045330Z-e0-sanity-463aeb85`

Result: **PASS**

Observed:

- exact CDP shell target: `app://-/index.html`;
- staged process: `/home/chris/.cache/codex-merge-app/ChatGPT` under `codex-hermes-qa`;
- Computer Use screenshot: PNG, 1920x1080, 293,321 bytes, source `xdg-desktop-portal`;
- unique AT-SPI composer: index 324, role `entry`, name `Message ChatGPT`;
- containing frame: index 1, role `frame`, name `ChatGPT`, bounds `(0,26) 1280x820`;
- CDP DOM composer bounds: `(470.671875,358.765625) 548.421875x24`;
- expected global bounds after frame offset: `(470.671875,384.765625) 548.421875x24`;
- AT-SPI bounds: `(470,384) 550x25`;
- geometry deltas: x `0.671875`, y `0.765625`, width `1.578125`, height `1.0` px;
- pointer postcheck: `environment_limited`, draft unchanged;
- final composer length: 0;
- no Chat turn sent;
- lifecycle delta: 0;
- LCM row delta: 0;
- `PRAGMA integrity_check`: `ok`;
- foreign-key violations: none;
- messages count = FTS count: 307,463.

### 2026-09-09 — 26.901.51231 D10 staging refresh

Before Phase B continuity testing, `/home/chris/.cache/codex-merge-app` was refreshed from the known-good 26.901.51231 live candidate and overlaid with only the current repo lifecycle helper containing the D10 alias fix.

Provenance:

- staged ASAR SHA-256: `cf7b9fdf19b7e935eef21f0fd3694a549875f66d8e5693d577e1d74c22e07b78`;
- staged helper SHA-256: `a6acf463573a7fee10251f39cb8db2573c50aa23c0edf1b8b47f794376c6de7a`;
- source helper SHA-256: same `a6acf463...`;
- the preserved original 26.901.51231 upstream `.deb` remains corrupt, so this QA refresh deliberately did not invoke the official-package rebuild path against an untrusted archive.

The first E0 run on this refreshed candidate found two AT-SPI `ChatGPT` frames containing the composer center. The original harness assumed exactly one containing frame. The corrected harness scores containing frames by the CDP-vs-AT-SPI geometry residual and accepts only the best match when its maximum x/y/width/height delta is <= 3 px.

Re-run: `20260909T050938Z-e0-sanity-fff91c98` — **PASS**.

### Review checkpoint

Code/KISS review after E0:

- retained one CDP client and one Computer Use MCP client;
- removed the experiment-only AT-SPI `set_value` wrapper after proving Electron does not expose the required interface;
- kept Computer Use pointer results as observed diagnostics rather than trusting backend `ok:true` as end-to-end proof;
- moved durable GNOME/session behavior into this QA log and harness README;
- no Hermes product code changed during E0 bring-up.

## 2026-09-09 — E6 / D10 restart-reopen alias continuity

### Scope

Prove the dirty `_ensure_tool_session()` reverse-alias fix end to end through the real staged Electron app:

1. create one ordinary Chat tool conversation;
2. capture the temporary `local-chatgpt:*` identity and assigned server UUID dynamically;
3. cleanly stop/finalize the app;
4. restart the staged app under a new Electron/lifecycle epoch;
5. reopen the exact server conversation through the real desktop UI;
6. execute another Hermes local tool turn;
7. finalize again;
8. prove append-only LCM continuity under the original local canonical key and zero writes under the bare server UUID.

The D10 key-split criterion is intentionally separated from the still-open stable operational `task_id` criterion. Full E6 is re-run after `task_id` is decoupled from rotating lifecycle `session_id`.

### Candidate/source verification

Before live D10 execution:

- `/home/chris/.cache/codex-merge-app` was rebuilt from the valid cached 26.901.51231 package with the current `hermes-chat-lifecycle` and `local-function-probe` feature sources;
- staged `lifecycle_helper.py` was inspected directly;
- staged `_ensure_tool_session()` calls `_session({"conversation_id": conversation_id})`, allowing a server-only reopen event to reverse-resolve through the persisted alias map;
- related offline harness tests remained green throughout the E6 hardening work.

### Harness defects found while bringing E6 up

#### QH-006 — current New Chat control uses semantic/ARIA surface

The old driver matched only exact visible text `New chat` / `New conversation`. Current 26.901.51231 can expose the control through `aria-label`/title, and unnecessarily clicking Chat/New Chat while already on a blank Chat can remount the composer.

Resolution:

- generic visible-control matching now checks semantic text, `aria-label`, and title;
- regular Chat mode selection is idempotent via `aria-pressed` / `aria-selected`;
- an already-blank regular Chat is accepted without another navigation click;
- when the current conversation has no composer, `new_chat()` performs active recovery instead of waiting for a composer that cannot mount in that state.

#### QH-007 — CDP RPC timeout reset by unsolicited events

The CDP client previously applied the full timeout to every `recv()` call. A busy page emitting unsolicited DevTools events could therefore extend a nominal 30-second request indefinitely.

Resolution:

- every RPC now computes one absolute deadline;
- ignored event traffic consumes the remaining budget rather than resetting it.

#### QH-008 — `document.body.innerText` omits current virtualized turn text

A completed Hermes tool turn was visible in the UI and present in the DOM, but `document.body.innerText` did not include its user/assistant text because current upstream renders the transcript through a virtualized/content-visibility container.

Durable upstream semantic anchors observed:

- `[data-turn-key]` on each conversation turn;
- `[data-content-search-turn-key]` on the content-search wrapper;
- `data-user-message-bubble="true"` on the user bubble.

Resolution:

- transcript counts/tail use visible `[data-turn-key]` content;
- visible dialog text is included for floating Chat panels;
- shell chrome continues to use `document.body` independently.

This restored deterministic `you` / `said` completion counts and exact transcript-tail assertions.

#### QH-009 — Work upsell can block completion after send acceptance

After Chat accepts the user turn, upstream may display `Continue in ChatGPT Work / Stay in Chat`. The original harness dismissed this only while waiting for send acceptance. Once the user marker rendered, completion polling could remain blocked by the upsell.

Resolution:

- `Stay in Chat` dismissal is attempted during completion polling as well as send acceptance;
- the harness never treats the upsell itself as model/tool completion.

#### QH-010 — LCM tool history flushes at helper finalization

A successful pre-restart tool loop reported `history_messages=6` in lifecycle evidence while direct SQLite reads still showed zero rows for that conversation. A clean app stop immediately finalized the helper and atomically exposed all six rows.

Resolution:

- E6 performs clean stop/finalization before taking its pre-restart immutable-prefix snapshot;
- `_wait_for_tool_pairs()` polls finalized LCM state instead of racing the helper's in-memory context;
- the same finalization-aware check is used after the reopened tool turn.

This is a product lifecycle/storage behavior, not a data-loss defect.

#### QH-011 — server-ID Recents row can be hydrated offscreen

After restart, the exact server conversation existed in the virtualized Recents data and React props but its rendered row center was below the viewport (observed around `y≈956`). The old helper sent a native click to that offscreen coordinate, so navigation appeared to fail even though the correct row was already hydrated.

Resolution:

- the helper discovers rows by exact React/server conversation UUID;
- if the target row is outside the usable viewport, it scrolls the sidebar scroller to center that row;
- rows/coordinates are recomputed after scrolling;
- only then is the native CDP pointer click sent;
- rendered transcript identity is verified after the click.

A direct proof after the fix moved the target row to `y=345`, native-clicked it, rendered the original E6 user/assistant turn, and exposed the real `Message ChatGPT` composer.

#### QH-012 — Search/Recents indexing can lag immediately after restart

The native Search command menu can expose exact server UUID identity via `data-value="command-menu-async-result:chatgpt:<uuid>"`, but newly created conversations are not always searchable immediately after restart. Recents likewise needs interaction/hydration time before the newest row appears.

Resolution:

- Search support remains available as a secondary QA primitive;
- D10's critical path uses the real Recents row because exact server UUID identity is available there once hydrated;
- Search/Recents indexing latency is not classified as a Hermes lifecycle defect.

### Supplemental product proof

Run: `20260909T145304Z-d10-postrestart-proof-7b7c8036`

Result: **PASS**

Conversation:

- canonical local key: `local-chatgpt:dba01de6-a69e-4240-849c-c831e2ae5760`;
- server UUID: `6aa16ee6-ded4-83e8-9f2e-8a58944fcf7d`.

Observed:

- before restart/finalization: 6 canonical rows / 3 tool pairs;
- server-key rows before reopen: 0;
- original restarted conversation rendered through the real desktop UI;
- Computer Use full-screen screenshot captured the reopened state;
- post-restart `process_manage` tool turn completed with assistant result `{"processes":[]}`;
- reopened lifecycle session: `hs_codex_5e5774940d224f1da79e835528dc979b`;
- reopened `session_open` reported the original local canonical key together with the exact server UUID;
- after finalization: 8 canonical rows / 4 tool pairs;
- original six-row prefix remained byte-identical;
- server-key rows after reopen: 0;
- `PRAGMA integrity_check`: `ok`;
- foreign-key violations: none;
- messages count = FTS count.

This is the first decisive live closure of the historical D10 split-key failure.

### Reusable E6 proof

Run: `20260909T145606Z-e6-restart-reopen-dc243350`

Result: **PASS**

Dynamic identities:

- local canonical key: `local-chatgpt:8145ca8f-1403-495f-bfe6-716535e32e98`;
- server UUID: `6aa17388-c118-83e8-859c-af99320dd4bd`;
- reopened lifecycle session: `hs_codex_5027bfde8f1a45dc9348904942cfb6fc`.

Observed:

- first regular-Chat tool turn completed through `tool_search -> tool_describe -> tool_call`;
- clean stop/finalization produced 6 canonical rows / 3 tool pairs;
- bare server UUID had 0 rows;
- staged app restarted under a new Electron process;
- exact server-ID Recents row was found through React identity, scrolled into view, and native-clicked;
- original user/assistant turn rendered after reopen;
- Computer Use screenshot evidence was captured from the restarted app;
- second regular-Chat tool turn completed after restart with assistant result `{"processes":[]}`;
- finalization produced 8 canonical rows / 4 tool pairs;
- only 2 new rows appended;
- original six-row prefix remained byte-identical;
- bare server UUID still had 0 rows;
- reopened lifecycle session differs from the pre-restart epoch as expected;
- SQLite integrity/FK/FTS checks remained clean.

### D10 conclusion

**D10 alias/canonical-key continuity is CLOSED.**

The `_ensure_tool_session()` server-only reopen fix works in the real staged app across process restart. Server UUID assignment and reopen no longer split one logical conversation into separate LCM keys.

The remaining Phase B identity defect is separate: Hermes operational `task_id` is still derived from rotating lifecycle `session_id`, so process/CWD/browser/tool workspace identity can still rotate across lifecycle epochs even though LCM conversation identity is now stable.

### D10 code/KISS/architecture review checkpoint

- E6 was reduced to the minimum restart proof: one tool turn before restart and one tool turn after reopen. Consecutive multi-turn behavior remains E5's responsibility.
- Reopen identity is validated by the exact server conversation UUID before native navigation and by rendered transcript after navigation.
- Recents virtualization is handled in one reusable helper rather than scenario-local scrolling code.
- CDP transcript extraction uses upstream semantic `data-*` attributes rather than minified CSS identifiers.
- Finalization-aware LCM polling reflects the helper's real persistence boundary rather than adding forced DB flush hooks for tests.
- Supplemental one-off proof data remains under `.codex-linux/qa/hermes-chat/`; reusable behavior lives in `scripts/qa/hermes-chat/`.
- The exploratory Search reopen helper was removed from reusable code during KISS review because the passing E6 path uses the exact server-ID Recents row and Search indexing was demonstrably timing-sensitive; the Search findings remain documented here.
- Final checkpoint validation: harness **6/6 pass**; related Node suite **104 total / 92 pass / 12 expected skips / 0 failures**; `git diff --check` clean.
- No additional product lifecycle behavior was changed while closing D10; the only product-side dependency is the pre-existing dirty `_ensure_tool_session()` alias fix under test.

## 2026-09-09 — stable operational `task_id` live acceptance

### Source/unit checkpoint

Pushed commit: `9653c99` — `feat: stabilize Hermes task identity across chat restarts`.

Before live acceptance:

- canonical conversation identity remained the logical continuity key;
- Hermes operational task identity changed to `chatgpt-codex:<canonical conversation id>`;
- lifecycle `hs_codex_*` remains an epoch identity and is expected to rotate on app/helper restart;
- API request IDs remain lifecycle-session-scoped;
- lifecycle feature tests passed **18/18**;
- related regression suite passed **105 total / 93 pass / 12 expected skips / 0 failures**;
- QA harness passed **6/6**.

### Candidate provenance

The original upstream 26.901.51231 `chatgpt` `.deb` had already been cleaned from local storage. A full rebuild attempt using the remaining downstream `codex-desktop` package was rejected by `rebuild-candidate.sh` because that script correctly requires the upstream package identity.

For this acceptance run, the already-proven 26.901.51231 app bundle was left intact and only the lifecycle feature resources were restaged through the supported feature mechanism:

`node scripts/lib/linux-features.js --stage-install /home/chris/.cache/codex-merge-app`

The staged helper and source helper matched byte-for-byte:

`SHA256 1d1c5dba1ce5a39ec68cabaf89611b0c268ffc1a291b8b53856f97d0f415364b`

No generated app bundle was edited directly.

### Live E6 identity result

Run: `20260909T172536Z-e6-restart-reopen-1accd5a1`

Overall harness verdict: **FAIL** due a separate global LCM integrity gate described below.

The stable-task identity criterion itself is **PASS**.

Dynamic identity evidence:

- canonical conversation: `local-chatgpt:007ab258-4635-4490-b3c9-1784cc6e0e5d`;
- server UUID: `6aa19696-bf98-83e8-b958-79c670871a10`;
- pre-restart lifecycle session: `hs_codex_0e79105bcdf74f5999c69f78a98cb389`;
- post-restart lifecycle session: `hs_codex_5821fbb5de6f44df83de2c7d07b79062`;
- pre-restart task ID: `chatgpt-codex:local-chatgpt:007ab258-4635-4490-b3c9-1784cc6e0e5d`;
- post-restart task ID: `chatgpt-codex:local-chatgpt:007ab258-4635-4490-b3c9-1784cc6e0e5d`.

The reusable E6 driver independently asserted:

- canonical conversation unchanged across restart;
- operational task ID unchanged across restart;
- lifecycle session ID changed across restart;
- reopened server UUID reverse-resolved to the original canonical conversation;
- local Hermes tool execution completed in both lifecycle epochs.

This closes the stable operational task-identity behavior in source/unit/live execution terms.

### Separate LCM integrity blocker discovered during the same run

Before the restart, after the first clean finalization, `LCMDatabase.integrity()` already reported:

`Tree 290435 page 294110 cell 0: 2nd reference to page 300956`

At that pre-restart checkpoint:

- messages: `307873`;
- messages FTS: `307865`;
- FTS/message mismatch: 8 rows;
- foreign-key violations: 0.

After the reopened tool turn and finalization:

- messages: `307875`;
- messages FTS: `307867`;
- mismatch remained exactly 8 rows;
- foreign-key violations remained 0;
- the same SQLite tree double-reference remained.

Because the corruption/mismatch existed before the restart half of this E6 iteration, the harness correctly failed its global integrity gate even though the stable task/session assertions passed.

No in-place repair has been attempted. The next QA iteration is read-only forensics against a copied snapshot of the LCM database, with the live DB preserved untouched.

## 2026-09-09 — LCM secondary-index corruption forensics

### Snapshot/provenance

The live QA app was stopped before capture, but the Hermes gateway and GPT Action service still held the shared LCM database open. Instead of copying potentially changing DB/WAL files directly, the forensic capture used SQLite's online backup API from a `mode=ro` source connection.

Forensic directory:

`.codex-linux/qa/hermes-chat/20260909T180129Z-lcm-integrity-forensics-1989292e`

Snapshot:

`lcm-snapshot.db`

SHA256:

`634be7ed4155889d5c3fc273ee5455f7daed19e359038826fc798ccc2288ab10`

The live database remained untouched throughout this iteration.

### The apparent 8-row FTS mismatch was a counting artifact

The first E6 integrity report showed 307,875 `messages` versus 307,867 FTS rows after the run. Read-only forensic scans prove that the underlying base table and FTS are actually aligned:

- `messages NOT INDEXED`: **307,867** unique rows;
- `messages_fts`: **307,867** rows;
- `messages_fts_docsize`: **307,867** rows;
- base-table IDs missing from FTS docsize: **0**;
- FTS docsize IDs missing from the base table: **0**.

SQLite had optimized plain `SELECT COUNT(*) FROM messages` through a corrupt covering secondary index. That index contained eight extra logical entries, so the harness incorrectly described the discrepancy as an FTS mismatch.

The QA harness now forces `messages NOT INDEXED` for logical message counts, per-conversation rows, and conversation counts. `PRAGMA integrity_check` remains the independent secondary-index health signal.

### Corruption localized to `messages` secondary indexes

The snapshot's base `messages` table remains readable and logically intact. The four secondary indexes show corruption:

- `idx_msg_conversation_session`: physical cross-link; tree root 290435 reaches page 300956, which is also a live `messages` table leaf page;
- `idx_msg_session`: 8 duplicate rowid entries;
- `idx_msg_source_session`: the same 8 duplicate rowid entries;
- `idx_msg_session_ts`: 10 duplicate rowid entries plus 2 missing rowids, net +8 entries.

The common duplicated row IDs are `307718` through `307725`.

The previous clean E6 evidence at 2026-09-09 14:59:55 UTC had `PRAGMA integrity_check=ok`, so this corruption occurred after that checkpoint.

A correlated event exists inside the corruption window: at 16:17:53 UTC `hermes-chatgpt.service` performed hard service recovery after a non-cooperative `vision_analyze` invocation; the replacement process started at 16:17:56 UTC and recovered nine sessions. `hermes-gateway.service` did not restart in that window. This is correlation only; no causal claim is made.

### `REINDEX` is unsafe for this cross-linked corruption shape

A disposable clone was used to test `REINDEX idx_msg_conversation_session`.

Result: the rebuilt index still shared page 300956 with the table and the base table became unreadable (`database disk image is malformed`). The clone was discarded and restored from the immutable forensic snapshot.

Operational consequence: **do not run `REINDEX` or `DROP INDEX` directly on the live database while an index tree physically shares pages with the table.** Freeing/rebuilding the corrupt tree can damage pages still owned by the base table.

### Safe repair proof on a disposable copy

A successful reconstruction was proven entirely on copied data:

1. Clone the forensic snapshot.
2. Capture the four `messages` index SQL definitions.
3. With `PRAGMA writable_schema=ON`, remove only those four index catalog rows. This abandons the corrupt index pages without traversing or freeing them.
4. Bump the schema version and reopen the clone.
5. Confirm the base table and FTS still each contain 307,867 rows. `quick_check` reports only expected orphaned "never used" pages from the abandoned index trees.
6. `VACUUM INTO` a fresh database from that schema-stripped clone. The fresh DB reports `quick_check=ok` before any indexes are recreated.
7. Recreate the four captured index definitions normally from the intact base table.
8. Run full integrity and logical-preservation checks.

Final salvaged-copy verification:

- `PRAGMA quick_check`: `ok`;
- `PRAGMA integrity_check`: `ok`;
- foreign-key violations: 0;
- base `messages`: 307,867;
- FTS rows: 307,867;
- every recreated index: 307,867 rows / 307,867 distinct rowids / 0 duplicates / 0 missing / 0 extra;
- base-table logical SHA256 unchanged: `5528670ccea1f4fdd3f360dd29187a71bd97d3a8dfeed1b6c96848d0921f4f24`;
- `messages_fts_data` logical SHA256 unchanged: `c923a957e2d68f0d58870d7edd85e95de5991e5f28edb1b9ac5ce92e611d2994`;
- `messages_fts_idx` logical SHA256 unchanged: `6ddd13221dafc1898b440b55994edca84bb78eefbb61e482782be8cf895f0440`;
- `messages_fts_docsize` logical SHA256 unchanged: `d4e79aebfdb3c9f083eebfae334f4f0efcd9d5cd4b429b259d1168e8b13b4ec2`;
- FTS rowid logical SHA256 unchanged: `ea74f6129f69facae07aa1dc0ec54e4d51de1767fb437f784a1884e9f3bf1c3e`.

The repair proof therefore changes secondary-index structures only; all measured logical message and FTS data is preserved exactly.

### Harness correction

`scripts/qa/hermes-chat/lcm.py` now forces base-table reads with `NOT INDEXED` for:

- `total_messages()`;
- per-conversation `rows()`;
- `conversation_counts()`;
- the logical message count inside `integrity()`.

A trace-based regression test verifies the actual SQL reaching SQLite contains `NOT INDEXED` on those logical reads.

Validation against the two forensic DBs:

- corrupt snapshot: 307,867 messages, 307,867 FTS, `fts_matches_messages=true`, while `integrity_check` still reports the real secondary-index corruption;
- salvaged copy: 307,867 messages, 307,867 FTS, `fts_matches_messages=true`, `integrity_check=ok`.

Offline QA harness after the correction: **7/7 pass**.

Final checkpoint validation:

- QA harness: **7/7 pass**;
- related Node suite: **105 total / 93 pass / 12 expected skips / 0 failures**;
- `git diff --check`: clean.

### Live DB status

No live LCM repair has been performed. A live repair, if chosen, requires a backup-first maintenance window with all LCM writers stopped, followed by post-repair integrity/digest checks before normal service resumes.

## 2026-09-09 — isolated-LCM E6 acceptance

### Isolation mechanism

Hermes-LCM supports `LCM_DATABASE_PATH`. QA launcher commit `047c5aa` forwards that single variable into transient Electron units, and the harness uses `CODEX_HERMES_QA_LCM_DB` for its own reads. Both were pointed at the same writable clone of the proven salvaged DB, under dedicated unit `codex-hermes-qa-isolated`, so the restart inside E6 could not fall back to the corrupt shared live DB.

Fresh isolated DB before E6:

- source: forensic `lcm-salvaged.db`;
- source/clone SHA256: `1330f8dcc671108ec10342e3b13108ccd0f574b7e69095ebb82b22a1e38f394b`;
- messages: 307,867;
- FTS rows: 307,867;
- `PRAGMA integrity_check`: `ok`;
- foreign-key violations: 0.

The live `~/.hermes/lcm.db` was not modified or repaired.

### First isolated attempt — model-choice failure, infrastructure healthy

Run: `20260909T190721Z-e6-restart-reopen-a05a1261`

Result: **FAIL before restart tool-history assertion**.

The renderer instrumentation showed `__codexP2SignatureBuilds=2`, proving the six local function signatures were advertised. No local-function call was detected or executed. The assistant instead replied that `process_manage` was unavailable, and lifecycle finalization reported `history_messages=0`.

This was a model-choice failure, not an LCM isolation or lifecycle failure. The LCM context engine opened successfully (`context_engine=lcm`, `context_engine_active=true`, empty initialization error).

E6 prompts were then hardened to require the exact advertised chain:

`hermes_tool_search → hermes_tool_describe → hermes_tool_call`

with explicit `process_manage` arguments. That harness change is pushed as `a8dc78b` — `qa: make Hermes E6 tool invocation deterministic`.

### Deterministic isolated E6 — PASS

Run: `20260909T191914Z-e6-restart-reopen-19a56ce0`

Result: **PASS**.

Dynamic identities:

- canonical conversation: `local-chatgpt:4a9801b0-55c6-4264-bb5f-cb80fea43967`;
- server UUID: `6aa1b138-8180-83e8-8b16-10cac8337059`;
- pre-restart lifecycle session: `hs_codex_4e98340c308c44a092066e4e3c736f4d`;
- post-restart lifecycle session: `hs_codex_20e56d156b184830bcf50374ce5bb2e7`;
- pre/post operational task ID: `chatgpt-codex:local-chatgpt:4a9801b0-55c6-4264-bb5f-cb80fea43967`.

First epoch:

- `hermes_tool_search` succeeded;
- `hermes_tool_describe` succeeded;
- `hermes_tool_call(process_manage, {"action":"list"})` succeeded;
- clean finalization produced 6 canonical rows / 3 tool pairs;
- bare server UUID had 0 rows;
- messages = FTS = 307,873;
- `PRAGMA integrity_check=ok`;
- foreign-key violations: 0.

Restart/reopen:

- staged Electron app restarted under a new process;
- exact server-ID Recents row was reopened through the real UI;
- Computer Use screenshot evidence was captured;
- server UUID reverse-resolved to the original local canonical key;
- lifecycle session rotated;
- operational task ID remained exactly unchanged.

Second epoch:

- the same deterministic three-function Hermes chain succeeded again;
- finalization produced 12 canonical rows / 6 tool pairs;
- exactly 6 rows appended;
- original pre-restart prefix remained unchanged;
- bare server UUID still had 0 rows;
- messages = FTS = 307,879;
- `PRAGMA integrity_check=ok`;
- foreign-key violations: 0.

After stopping the dedicated QA unit, the isolated DB remained clean. Final SHA256:

`73a8d816b1b1f556fa8eed49dcdeefb9b87b2aae9df12faf12987afa7244fc2c`

### E6 conclusion

**Full E6 is now CLOSED/PASS** on a clean isolated LCM database without altering the corrupt live shared database.

The live acceptance simultaneously proves:

- canonical conversation continuity across process restart;
- server-ID reopen alias resolution;
- stable Hermes operational `task_id` across lifecycle rotation;
- rotated `hs_codex_*` lifecycle session identity;
- real regular-Chat local-function execution in both epochs;
- append-only LCM continuity under the canonical key;
- zero split rows under the bare server UUID;
- clean SQLite/FTS/FK integrity throughout the tested isolated database.
