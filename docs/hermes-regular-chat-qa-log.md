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

### Review checkpoint

Code/KISS review after E0:

- retained one CDP client and one Computer Use MCP client;
- removed the experiment-only AT-SPI `set_value` wrapper after proving Electron does not expose the required interface;
- kept Computer Use pointer results as observed diagnostics rather than trusting backend `ok:true` as end-to-end proof;
- moved durable GNOME/session behavior into this QA log and harness README;
- no Hermes product code changed during E0 bring-up.
