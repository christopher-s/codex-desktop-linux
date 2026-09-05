"use strict";

/**
 * chat-bridge-tool-calls/visibility patch: stop the transcript pipeline from
 * dropping `chatgpt-reasoning-group`s that the server flags as "visually
 * hidden" WHEN such a group contains our synthesized dynamic-tool-call items.
 *
 * Background (verified on app-initial-c89bb5bd3099.js, 2026-09-04):
 *   - Turn items for custom-GPT Action calls land inside a reasoning group
 *     whose source message metadata carries
 *     `is_visually_hidden_reasoning_group: true` (set server-side for
 *     bridge/gizmo turns). The group (with its recap "Worked for Xm Ys")
 *     exists in React state but the grouping pass computes
 *     `isVisuallyHiddenReasoningGroup` from that metadata and a later
 *     flatMap DROPS such entries entirely:
 *       let i=n.flatMap((e,t)=>{if(e.isVisuallyHiddenReasoningGroup===!0)return[];...
 *     Result: no recap row, no tool chips — nothing renders, even though
 *     state holds valid items. This drop matches upstream behavior on
 *     unpatched builds (server hides these groups by design); we only keep
 *     them when our classifier patch contributed items inside.
 *
 * Patch strategy: pure INSERTION immediately BEFORE the drop-guard:
 *   if(<entry is hidden group carrying dynamic-tool-call items>)
 *     entry = {...entry, isVisuallyHiddenReasoningGroup: false};   // keep
 *   else
 *     <original guard runs unchanged>  if(hidden)return[]; ...
 * Hidden groups WITHOUT dynamic-tool-call items take the else branch and are
 * dropped exactly as upstream intended. The copy (not mutation) also clears
 * the flag for any downstream re-checks.
 *
 * Item shapes referenced (verified upstream):
 *   xz(e): e?.item.type === `chatgpt-reasoning-group`
 *   group items: e.item.items (array)
 *
 * Fail-soft: anchor miss returns the source unchanged with a warning.
 * Idempotent via the /*MARKER* / comment. Disable via settings
 * { showBridgeToolCalls: false } (shared with the classifier patch).
 */

const RUNTIME_MARKER = "codexLinuxChatBridgeToolCallsVisRuntime";

const ASSET_PATTERN = /^app-initial-[0-9a-f]+\.js$/;

// Anchor: the flatMap drop-guard. Structural, prop-name based:
//   let i=n.flatMap((e,t)=>{if(e.isVisuallyHiddenReasoningGroup===!0)return[];if(!xz(e))return[e];
// Identifiers (i, e, t, xz) differ per build; capture them.
const DROP_GUARD_ANCHOR =
  /let (?<result>\w+)=\w+\.flatMap\(\((?<entry>\w+),(?<idx>\w+)\)=>\{if\(\k<entry>\.isVisuallyHiddenReasoningGroup===!0\)return\[\];if\(!(?<xz>\w+)\(\k<entry>\)\)return\[\k<entry>\];/;

function warn(message) {
  console.warn(`WARN: chat-bridge-tool-calls-vis: ${message}`);
}

function showBridgeToolCallsEnabled(context = {}) {
  const settings =
    context.settings && typeof context.settings === "object"
      ? context.settings
      : {};
  return settings.showBridgeToolCalls !== false;
}

function applyChatBridgeToolCallsVisibilityPatch(source, context = {}) {
  try {
    if (!showBridgeToolCallsEnabled(context)) {
      return source;
    }
    if (source.includes(`/*${RUNTIME_MARKER}*/`)) {
      return source; // already patched (idempotent)
    }

    const m = DROP_GUARD_ANCHOR.exec(source);
    if (!m) {
      warn(
        "flatMap drop-guard anchor not found (upstream bundle changed); source unchanged",
      );
      return source;
    }

    const entry = m.groups.entry;
    const xz = m.groups.xz;

    // Inserted BEFORE the original drop-guard; ties into it via `else`:
    //   keep-and-unhide  → original guard sees the visible copy, falls through
    //   everything else  → original guard runs byte-identically
    const insertion =
      `if(${entry}.isVisuallyHiddenReasoningGroup===!0&&${xz}(${entry})&&` +
      `Array.isArray(${entry}.item.items)&&${entry}.item.items.some(function(it){return it&&it.type===` +
      "`dynamic-tool-call`" + `}))` +
      `${entry}={...${entry},isVisuallyHiddenReasoningGroup:!1};/*${RUNTIME_MARKER}*/else `;

    const guardStart = m.index + m[0].indexOf(`if(${entry}.isVisuallyHiddenReasoningGroup===!0)return[];`);
    const patched =
      source.slice(0, guardStart) + insertion + source.slice(guardStart);

    if (patched === source) {
      warn("insertion produced no change; source unchanged");
      return source;
    }
    return patched;
  } catch (error) {
    warn(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    return source;
  }
}

const descriptors = [
  {
    id: "chat-bridge-tool-calls-visibility",
    order: 20_960, // after the classifier patch (20_950)
    phase: "webview-asset",
    ciPolicy: "optional",
    pattern: ASSET_PATTERN,
    missingDescription: "app-initial chunk",
    skipDescription: "chat-bridge-tool-calls visibility patch",
    apply: applyChatBridgeToolCallsVisibilityPatch,
  },
];

module.exports = {
  ASSET_PATTERN,
  RUNTIME_MARKER,
  DROP_GUARD_ANCHOR,
  applyChatBridgeToolCallsVisibilityPatch,
  descriptors,
};
