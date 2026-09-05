"use strict";

/**
 * chat-bridge-tool-calls/icon patch: give generic dynamic-tool-call chips the
 * same agent-activity icon Codex app-tools get — for ANY tool without a
 * specialized registry icon (every custom-GPT Action / jit_plugin call and
 * any other unregistered dynamic tool).
 *
 * Verified shape (subagent-activity-chip-group-*.js, 2026-09-05):
 *   Icon switch:
 *     case`dynamic-tool-call`:return rh(n)?.renderAgentActivityIcon?.(n)
 *       ??(n.namespace===`codex_app`?(0,s_.jsx)(th,{"aria-hidden":!0,className:c_}):null);
 *   Nb summary-text component:
 *     c=r.namespace===`codex_app`&&s!==`summary-text`
 *
 * `rh(n)` is the specialized registry (agent-activity-item sn=[...Ct,...$t,...kt],
 * matched on namespace+tool) — custom-GPT Action tools never match, so the
 * fallback branch runs. That branch only renders the themed agent-activity
 * icon `th` when namespace===`codex_app`; our synthesized items carry
 * namespace:null, so today they render icon-less. (Upstream's own dynamic
 * fallback emits namespace:null too, so this covers all generic tools.)
 *
 * Patch strategy: pure CONDITION rewrites at both sites:
 *   n.namespace===`codex_app`            ->  (n.namespace===`codex_app`||n.namespace==null)
 *   r.namespace===`codex_app`            ->  (r.namespace===`codex_app`||r.namespace==null)
 * Renderers/branches untouched. `th` is the themed component Codex app-tools
 * already use (alias chain: th -> m -> z, which selects its glyph by theme).
 *
 * Fail-soft: anchor miss returns the source unchanged with a warning.
 * Idempotent via the /*MARKER* / comment. Disable via settings
 * { showBridgeToolCalls: false } (shared with the classifier patch).
 */

const RUNTIME_MARKER = "codexLinuxChatBridgeToolCallsIconRuntime";

const ASSET_PATTERN = /^subagent-activity-chip-group-[0-9a-f]+\.js$/;

// Anchor A — icon switch fallback:
//   ??(n.namespace===`codex_app`?(0,s_.jsx)(th,{"aria-hidden":!0,className:c_}):null);
const ICON_ANCHOR =
  /\?\?\((?<n>\w+)\.namespace===`codex_app`\?\(0,(?<jsx>\w+)\.jsx\)\((?<th>\w+),\{"aria-hidden":!0,className:(?<cls>\w+)\}\):null\);/;

// Anchor B — Nb summary-text gate:
//   c=r.namespace===`codex_app`&&s!==`summary-text`
const NB_ANCHOR =
  /(?<c>\w+)=(?<r>\w+)\.namespace===`codex_app`&&(?<s>\w+)!==`summary-text`/;

function warn(message) {
  console.warn(`WARN: chat-bridge-tool-calls-icon: ${message}`);
}

function showBridgeToolCallsEnabled(context = {}) {
  const settings =
    context.settings && typeof context.settings === "object"
      ? context.settings
      : {};
  return settings.showBridgeToolCalls !== false;
}

function applyChatBridgeToolCallsIconPatch(source, context = {}) {
  try {
    if (!showBridgeToolCallsEnabled(context)) {
      return source;
    }
    let out = source;

    // ---- Site A: icon-switch fallback ----------------------------------
    if (!out.includes(`/*${RUNTIME_MARKER}A*/`)) {
      const m = ICON_ANCHOR.exec(out);
      if (!m) {
        warn("icon-switch anchor not found; skipping site A");
      } else {
        const n = m.groups.n;
        const original = `${n}.namespace===\`codex_app\`?(0,`;
        const replacement =
          `(${n}.namespace===\`codex_app\`||${n}.namespace==null)/*${RUNTIME_MARKER}A*/?(0,`;
        const at = m.index + m[0].indexOf(original);
        if (at < m.index) {
          warn("site A condition not located inside anchor; skipping");
        } else {
          out = out.slice(0, at) + replacement + out.slice(at + original.length);
        }
      }
    }

    // ---- Site B: Nb summary-text gate ----------------------------------
    if (!out.includes(`/*${RUNTIME_MARKER}B*/`)) {
      const m = NB_ANCHOR.exec(out);
      if (!m) {
        warn("Nb summary-text anchor not found; skipping site B");
      } else {
        const r = m.groups.r;
        const original = `${r}.namespace===\`codex_app\`&&`;
        const replacement =
          `(${r}.namespace===\`codex_app\`||${r}.namespace==null)/*${RUNTIME_MARKER}B*/&&`;
        const at = m.index + m[0].indexOf(original);
        if (at < m.index) {
          warn("site B condition not located inside anchor; skipping");
        } else {
          out = out.slice(0, at) + replacement + out.slice(at + original.length);
        }
      }
    }

    if (out === source) {
      if (!source.includes(`/*${RUNTIME_MARKER}A*/`)) {
        warn("no changes produced; source unchanged");
      }
      return source;
    }
    return out;
  } catch (error) {
    warn(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    return source;
  }
}

const descriptors = [
  {
    id: "chat-bridge-tool-calls-icon",
    order: 20_990, // after chip (20_980)
    phase: "webview-asset",
    ciPolicy: "optional",
    pattern: ASSET_PATTERN,
    missingDescription: "subagent-activity-chip-group chunk",
    skipDescription: "chat-bridge-tool-calls icon patch",
    apply: applyChatBridgeToolCallsIconPatch,
  },
];

module.exports = {
  ASSET_PATTERN,
  RUNTIME_MARKER,
  ICON_ANCHOR,
  NB_ANCHOR,
  applyChatBridgeToolCallsIconPatch,
  descriptors,
};
