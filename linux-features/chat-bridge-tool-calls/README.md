# chat-bridge-tool-calls

Render custom-GPT **Actions** tool-call messages as native tool items in Chat
threads on the codex-desktop Linux build.

## Problem

Custom-GPT Actions (JIT plugins) emit tool-call messages on the wire with
`recipient = "<sanitized-domain>__jit_plugin.<action>"`, `author.role =
"assistant"`, `channel = "commentary"`, and the action arguments as a JSON
`code` content body. The desktop client's turn-item classifier only produces
tool items for a fixed recipient set (`api_tool.call_tool`, `functions.*`,
`local.*`, and `role === "tool"` nodes), so Actions calls classify to `null`
and are silently dropped from `turn.items` — the transcript never shows them,
even though both the live SSE stream and conversation history deliver them.

## Fix

Extend the classifier's dynamic-tool fallback (`kWr` consumer in the
`app-initial-*.js` chunk): when the built-in `kWr` helper returns `null` and
the message recipient contains `__jit_plugin.`, synthesize
`{ completed, pairKey: null, tool: <action> }` so the message renders as a
`dynamic-tool-call` item — same presentation as `functions.*` calls: action
name and full arguments, chronologically placed.

Tool *results* are never delivered client-side (verified at the TLS layer);
only the calls. Results remain visible through the bridge's own observability
journal (`127.0.0.1:8444`).

## Verification notes

- Anchor: `let u=kWr(e),d=ng().safeParse(s);return e.author.role===`assistant`&&u!=null&&d.success?`
  (structural; verified against app-initial-c8dbea294abe.js, upstream 26.901.x)
- Fail-soft: anchor miss → source unchanged with a warning.
- Idempotent: `/*codexLinuxChatBridgeToolCallsRuntime*/` marker.
- Settings: set `showBridgeToolCalls: false` to disable.
