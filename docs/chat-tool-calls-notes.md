# Chat Tool-Call Surfacing: Approach and Gotchas

Notes from building `chat-tool-calls` and `chat-bridge-tool-calls`
(`feature/chat-tool-calls` through `b2f8d13`, upstream 26.901.x /
codex-desktop `2026.09.05.184604`). Two audiences: anyone re-deriving this
after an upstream rewrite, and anyone extending the technique to other
dropped event types.

## The problem

Custom-GPT **Actions** (JIT plugins) emit tool-call messages on the wire with
`recipient = "<sanitized-domain>__jit_plugin.<action>"`, `author.role =
"assistant"`, `channel = "commentary"`, and the action arguments as a JSON
`code` content body. The desktop client's turn-item classifier only produces
tool items for a fixed recipient set (`api_tool.call_tool`, `functions.*`,
`local.*`, and `role === "tool"` nodes), so Actions calls classify to `null`
and are silently dropped from `turn.items` — the transcript never shows them,
even though both the live SSE stream and conversation history deliver them.

Verified at the TLS layer (mitmproxy interception): the events arrive on the
client. The drop is client-side classification, not server omission.

Separately, tool calls that *do* render in ordinary Chat threads are collapsed
behind the "Ran N commands / Worked for Nm" disclosure row by default.

## The approach: patch every gate an event must pass

An event reaches the screen only if it survives a chain of filters. Each one
that dropped our items got its own fail-soft patch, applied by
`make build-app` via the linux-features engine:

1. **Classifier fallback** (`patch.js`, marker
   `codexLinuxChatBridgeToolCallsRuntime`) — anchor
   `let u=kWr(e),d=ng().safeParse(s);return e.author.role===`assistant`&&u!=null&&d.success?`
   in `app-initial-*.js`. When the built-in `kWr` helper returns `null` and
   the recipient contains `__jit_plugin.`, synthesize
   `{ completed, pairKey: null, tool: <action> }` so the message classifies
   as a `dynamic-tool-call` item with the same presentation as `functions.*`
   calls.
2. **Visibility gate** (`visibility.js`) — the transcript pipeline drops
   `chatgpt-reasoning-group`s the server flags as "visually hidden"; ours
   landed inside such groups. The patch exempts groups containing synthesized
   dynamic-tool-call items.
3. **Viewer recap gate** (`recap.js`) — the transcript *viewer* independently
   drops reasoning groups whose server-set recap says `hide_all`. Same
   exemption.
4. **Chip arguments** (`chip.js`, marker
   `codexLinuxChatBridgeToolCallsChipRuntime`) — generic dynamic-tool chips
   render only the tool name; the patch adds the web-extension-style inline
   summary: `tool · key: value · key: value`.
5. **Gear icon** (`icon.js`) — generic dynamic-tool chips fell back to a
   themed activity glyph. Now renders the app's own `gear-light-16` (see
   gotchas below).
6. **Disclosure expansion** (`chat-tool-calls`) — rewrites
   `tool-activity-disclosure-*.js` `defaultExpanded` capture to `true` so the
   rows render expanded; manual collapse still works.

Toggles: `showBridgeToolCalls: false` / `expandToolActivity.enabled: false`
in `features.json` settings.

**Known hard limit:** tool *results* are never delivered client-side
(verified at TLS); only the calls. Results remain observable through the
Actions bridge's own journal at `127.0.0.1:8444`.

## Gotchas

### Icon assets are not components

Icon modules (`gear-light-16`, built by the `hS`/`lo` asset builder) export
plain objects, not components. Rendering one directly as a jsx type crashes
the thread with "element type is invalid", and the error boundary eats the
whole message. Render through the chunk's asset-icon component: find an
existing `(0,NS.jsx)(Comp,{className:`shrink-0 text-text/60`,asset:X})`
usage and reuse its component. Note the prop order varies across call sites
(`"aria-hidden":!1` sometimes sits between `className` and `asset`) — anchor
on the minimal form or make the extra prop optional in the regex.

### Extending a minified import

Import statements end with `.js"`, so a regex anchored `\}$` never fires.
Locate the last binding with `lastIndexOf('}')` and slice, then append
`, name as alias` (e.g. `dh as __cbtcGear` on the chip-group chunk's existing
`app-primary` import).

### `$`-prefixed minified names

`\w` misses names like `$a`. Every identifier class in patch regexes must be
`[\w$]`. This silently half-worked for three iterations before biting.

### Prefer consumer-side switches over registry synthesis

Injecting a synthetic entry into a lookup array (the agent-activity-item icon
registry) silently destabilized rendering — the tool line vanished with no
console error. Patching the consumer's icon switch (namespace `null ||
codex_app` branch) was stable and localized.

### Verification pipeline (do all four before committing)

1. `node --check` on the patched chunk — catches syntax damage.
2. `node --test linux-features/chat-bridge-tool-calls/test.js` (36/36) and
   `node --test scripts/lib/linux-features.test.js` (31/31).
3. Marker grep on the **built deb** — `dpkg-deb -x` + `asar extract` of
   `opt/codex-desktop/resources/app.asar` (the payload lives under `opt/`,
   not a `webview/` dir at the deb root).
4. Live CDP check (`--remote-debugging-port=9231`) of the rendered DOM:
   chip icon `viewBox="0 0 16 16"`, class `icon-xs shrink-0 text-text/60`,
   plus a screenshot. The crash in the first gotcha passed `node --check`
   and all unit tests — only live rendering caught it.

### Icon inventory technique

Enumerate embedded icons with `name:`[a-z0-9-]+-\d+`` greps over
`app-initial-*.js` and `app-primary-*.js` (~250 icons in 26.901.x).
Tool-appropriate options: `gear-light-16/20` (16 ships; 20 is `Sni` in
app-initial, not exported), `wrench-light-16/20`, `terminal-light-16/20`,
`bolt`, `code`, `braces`, `plugin`, `cloud-plugin`, `puzzle-piece`,
`sliders`, `robot`.

### General webview-patch discipline

- Anchors are structural and fail soft (warn + skip on miss); exact minified
  symbols are drift-prone and never trusted as anchors.
- Every patch is idempotent via its `/*codexLinux…Runtime*/` marker; the
  build reports `applied=6, already-applied=1` on re-runs.
- A clean build with no enabled ASAR feature must preserve `resources/app.asar`
  byte-for-byte (repo invariant; these features are opt-in for exactly that
  reason).
