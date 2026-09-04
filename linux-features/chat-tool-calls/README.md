# Chat Tool Call Visibility

`chat-tool-calls` is an optional Linux feature that surfaces rich tool-call
detail in ChatGPT conversation threads. It is disabled by default.

## Why

The upstream webview ships one shared disclosure component for agent tool
activity (the "Ran N commands, called N tools" collapsible row). Tool-call
events **do arrive** in chat threads - the client collapses them behind the
disclosure. The same bundled renderer that Codex/Work threads use
(`agent-activity-item`, `mcp-tool-item-content`, `subagent-activity-chip-group`)
is reached through this disclosure widget, so expanding it exposes command
output, diffs, MCP invocations, and web-search queries inline.

## What it does

Patches `tool-activity-disclosure-*.js` so the widget renders expanded by
default (`defaultExpanded` capture rewritten to `true`). Manual collapse still
works; running-state auto-expand behavior is unchanged.

## Settings

```json
{
  "enabled": ["chat-tool-calls"],
  "settings": {
    "tweaks": {
      "expandToolActivity": { "enabled": true }
    }
  }
}
```

`enabled: false` (or omitting the tweak) disables the rewrite; the feature
then applies no changes to the asset.

## Limitations

- This expands disclosures that the client already renders. If OpenAI's
  backend omits tool events for a surface entirely, there is nothing to
  expand; this feature cannot conjure events that never arrive.
- Asset-hash filenames change per build; the patch anchors structurally and
  fails soft (warns and skips) when upstream rewrites the component.

## Cleanup

Disable the feature in `features.json` and rebuild; the staged asset is
replaced from the official package on the next build.

## Supported sessions

Verified against official Linux `.deb` payload `codex-desktop
2026.09.04.211555` (upstream commit `23c55eb`, ASAR built 2026-09-03).

## Tests

```bash
node --test linux-features/chat-tool-calls/test.js
```
