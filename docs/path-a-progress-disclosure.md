# Path A — Progressive Disclosure on the Local Function Surface

Last updated: 2026-09-07\
Branch: `chris-custom` (tracking `fork/chris-custom`)\
Published: `fork/chris-custom` @ `7601e60` (core commit `dd395d2`, doc commit `7601e60`)\
Upstream package: `26.901.41600` (deb sha256 `15cf422a77e8f28a7553d3180b8c72784a994438a141784c82d72cde93efca77`)\
QA candidate: `/home/chris/.cache/codex-merge-app` (staging build; CDP port 9243)

## Goal

Run Codex Desktop as the UI that drives the **native Hermes runtime**, with
parity to how Hermes presents tools to its own model, and without any
`hermes-chatgpt` bridge dependency (Path A). Concretely:

1. **Progressive disclosure.** Advertise a curated bare core plus the three
   meta-tools (`tool_search` / `tool_describe` / `tool_call`) instead of a
   flat tool list, matching Hermes's native tool architecture
   (`tools/tool_search_catalog.py`, `handle_function_call` in
   `model_tools.py`).
2. **Unified lifecycle.** Tool activity in plain Chat must flow into the same
   session transcript the lifecycle uses, so persistence, recall, and memory
   all see it. Conversation-keyed session identity bridges tool-call-only
   turns that have no gizmo `SessionRuntime`.
3. **Disabled by default.** Both features opt in explicitly; nothing changes
   for a stock install.

Constraints: no bridge dependency; string-only parameter protocol (the local
function protocol carries no schemas); structural ASAR anchors only (the
repack minifier re-hashes names); push path is `fork/chris-custom` via
`scripts/chris-custom-sync.sh` only.

## What was accomplished (2026-09-07, published)

### p2 — meta-tools advertised on the local function surface

- `local-function-probe/patch.js` signature table extended to six tools:
  `hermes_read_file`, `hermes_search_files`, `hermes_web_search`, plus
  `hermes_tool_search`, `hermes_tool_describe`, `hermes_tool_call`
  (string-only params; the bridge's `_string_list_arg` / JSON-argument
  coercion makes this protocol-compatible with no change on either side).
- The advertised names map to the bridge's registry names by stripping the
  `hermes_` prefix; unknown names pass through to the real registry, which
  returns the truthful "Unknown tool" error to the model.
- Verified in the shipped artifact: all six names present in the built
  `app-initial`/`app-primary` webview assets of the QA candidate.

### p3 — tool_call recorded into the shared session transcript

- `lifecycle_helper.py` `tool_call` phase:
  - **Bridge pass-through** checked before registry dispatch (bridge names
    are never registry entries).
  - **Conversation-keyed session**: `tool\0<conversation_id>` — get-or-create
    per conversation, so tool-call-only turns share the conversation's
    transcript with regular turns.
  - Each **executed** call appends a `tool_call` row and a `tool` result row
    to the runtime history; **failed** calls report the error to the model
    but stay out of the transcript.
  - Identity fields (`session_id`, `call_id`) are passed into
    `handle_function_call`.
  - `close_session` flushes the accumulated transcript to
    `engine.on_session_end(session_id, history)` (LCM) and the memory
    provider, the same seam regular turns use.
- **Main-bundle `patch.js`**: the `tool_call` IPC branch normalizes the
  conversation fields and re-maps any missing or non-canonical session id
  (the probe sends the raw conversation id) to the conversation-keyed
  session, so the host never stores a raw conversation id as a session id.
- **Proven end-to-end against the live store**: a real `read_file` call plus
  close moved `messages` in `~/.hermes/lcm.db` by +2 rows
  (`tool_call`, `tool`) under the probe conversation id; rows were removed
  after the check.

### p4 — productionized

- Both features `defaultEnabled: false` (`feature.json`).
- READMEs (lifecycle + probe) and the probe `feature.json` description
  document the new surface.
- `scripts/chris-custom-sync.sh` branch validation now runs
  `node --test linux-features/hermes-chat-lifecycle/test.js` (13 tests)
  in addition to the chat-bridge, framework-contract, and sync self-tests.

### Enabling fix found along the way — LCM store recovery

`/home/chris/.hermes/lcm.db` (1.1 GB) was **malformed**
(`PRAGMA integrity_check`: "database disk image is malformed", even on a
copy), which is why `get_plugin_context_engine()` returned `None` and live
LCM transcript persistence had been silently dead while Hindsight kept
working. Recovery:

- `sqlite3 .recover` on a copy → clean SQL dump (1.31 GB) → rebuilt DB:
  integrity ok, 299,880 messages across 746 conversations.
- FTS5 virtual tables do not survive `.recover`; the LCM plugin's own
  self-repair (`_fts_needs_rebuild_structural` in `db_bootstrap.py`)
  detected the missing virtual tables on service start and rebuilt
  `messages_fts` (full re-index: MATCH 'hermes' → 30,557) and `nodes_fts`.
- Deployed with `0600`; the corrupt original is preserved at
  `~/.hermes/lcm.db.corrupt-20260907200956` pending a period of observation.
- `hermes-chatgpt.service` (the other process sharing this store) was
  restarted and holds the recovered file read-only.

### Verification status at publish time

| Check | Result |
|---|---|
| `node --test linux-features/hermes-chat-lifecycle/test.js` | 13/13 pass |
| `node --test scripts/lib/linux-features.test.js` (framework contract) | 31/31 pass |
| `node --test linux-features/chat-bridge-tool-calls/test.js` | 0 failures |
| `tests/chris_custom_sync_test.sh` | coherent |
| `git diff --check origin/main...HEAD` | clean (hard breaks converted to backslashes) |
| Shipped artifact marker grep (webview + main bundle) | all present |
| Staged `lifecycle_helper.py` vs working tree | byte-identical |
| Live `lcm.db` post-deploy | integrity ok, FTS present, service active |
| `fork/chris-custom` SHA vs local HEAD | verified equal by sync script |

## What is next (in priority order)

1. **Live in-app QA of p2** (the one verification still owed). Unit tests
   and artifact greps are green; the unproven step is the model actually
   using the meta-tools in a running app (see "What is needed to test").
2. **Multi-turn plain-Chat persistence** — two consecutive tool turns in one
   conversation; confirm turn N+1's transcript includes turn N's tool rows
   after close (the persistent-host variant is unit-tested; the live-app
   variant needs one run).
3. **Observe `lcm.db` for a few days**, then delete the corrupt backup
   (`lcm.db.corrupt-20260907200956`, ~1.1 GB) if behavior is clean.
4. **Distribution decision** — whether `local-function-probe` ships in the
   cumulative distribution build (currently enabled only for the QA
   staging candidate via the gitignored `linux-features/features.json`).
5. **Re-verify anchors after each upstream rebase** — minified anchors can
   drift without git conflicts; the sync script's rebase + validation is the
   guard, and the marker grep in the built artifact is the proof.
6. **Optional:** add a `test.js` to `local-function-probe` (it is currently
   covered by the framework-contract test and artifact grep, but has no
   dedicated suite).

## What is needed to test

### Environment

- Black Monolith, repo `/home/chris/Projects/codex-desktop-linux` on branch
  `chris-custom` at `7601e60` (or later).
- The gitignored `linux-features/features.json` must list both features for
  the QA build: `["hermes-chat-lifecycle", "local-function-probe"]`.
- Staging candidate `/home/chris/.cache/codex-merge-app` (upstream
  `26.901.41600`). Rebuild if stale:

  ```bash
  cd /home/chris/Projects/codex-desktop-linux
  CODEX_FINAL_APP_DIR=/home/chris/.cache/codex-merge-app \
    scripts/rebuild-candidate.sh --install /tmp/chatgpt_26.901.41600_amd64.deb
  ```

- Launch (stop any other ChatGPT instance first; `pkill -x ChatGPT`):

  ```bash
  pkill -x ChatGPT 2>/dev/null
  systemd-run --user --unit=codex-merge-qa --collect \
    bash -lc 'cd /home/chris/.cache/codex-merge-app && exec ./start.sh \
      --no-sandbox --remote-debugging-port=9243 \
      --remote-allow-origins=http://127.0.0.1:9243'
  ```

- Sanity: `readlink /proc/$(pgrep -x ChatGPT | head -1)/exe` must point at
  the staging app; `curl -s http://127.0.0.1:9243/json/list` returns the
  pages. CDP websockets need the exact allow-listed `Origin` header
  (`http://127.0.0.1:9243`).

### Test cases

**T1 — progressive disclosure loop (p2).** In a plain Chat thread (no
gizmo), send: *"Use tool_search to find a web search tool, describe it,
then use it to look up the current date."* Expected:

- The model calls `hermes_tool_search` → `hermes_tool_describe` →
  `hermes_tool_call` (with `name=web_search`).
- The disclosure UI shows the tool-activity rows for those calls.
- Host log records three `tool_call` events for the conversation, each with
  the conversation-keyed session id `tool\0<conversation_id>` and an
  incrementing `history_messages`.

**T2 — truthful error path.** Ask the model to call a tool that does not
exist (e.g. "call a tool named hermes_nonexistent_tool"). Expected: the
error text from the real registry reaches the model (it can recover), and
**no** `tool` row is appended to the transcript for it.

**T3 — multi-turn persistence (p3).** Two consecutive tool turns in the same
plain Chat conversation. After the second turn, in
`~/.hermes/lcm.db`:

```sql
select role, tool_name from messages
where conversation_id = '<conversation_id>' order by rowid;
```

Expected: `tool_call`/`tool` row pairs for **both** turns, in order,
surviving the close-session flush.

**T4 — recall round trip.** After T3, ask the model in a later turn about
what it had looked up earlier (or query LCM recall for the conversation).
Expected: the transcript content is retrievable, proving the recorded rows
are readable by the LCM engine, not merely stored.

**T5 — regression.** One ordinary two-turn plain Chat conversation with no
tools. Expected: normal lifecycle (session open/close, memory), no errors in
the host log, no FTS or integrity errors in `lcm.db`
(`PRAGMA integrity_check; PRAGMA foreign_key_check;` both clean).

### Pass criteria

T1 and T3 are the acceptance tests for p2/p3 respectively. T2, T4, T5 are
guard tests. After passing, commit any follow-up findings to
`chris-custom` and re-run `scripts/chris-custom-sync.sh --push` (it re-bases
onto `origin/main`, re-runs the validation set, and force-with-lease pushes
to the fork with SHA verification).
