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
const RUNTIME_MARKER_REG = "codexLinuxChatBridgeToolCallsIconRegRuntime";

const ASSET_PATTERN = /^subagent-activity-chip-group-[0-9a-f]+\.js$/;
const REGISTRY_ASSET_PATTERN = /^agent-activity-item-[0-9a-f]+\.js$/;

// Anchor A — icon switch fallback:
//   ??(n.namespace===`codex_app`?(0,s_.jsx)(th,{"aria-hidden":!0,className:c_}):null);
const ICON_ANCHOR =
  /\?\?\((?<n>\w+)\.namespace===`codex_app`\?\(0,(?<jsx>\w+)\.jsx\)\((?<th>\w+),\{"aria-hidden":!0,className:(?<cls>\w+)\}\):null\);/;

// Anchor C — an existing asset-icon usage in the same chunk (gives us the
// asset-icon component, e.g. $a, which renders {className,asset} pairs):
//   (0,s_.jsx)($a,{className:`shrink-0 text-text/60`,asset:Fg});
const ASSET_ICON_ANCHOR =
  /\(0,(?<jsx2>\w+)\.jsx\)\((?<assetComp>[\w$]+),\{className:`shrink-0 text-text\/60`,asset:(?<sampleAsset>\w+)\}\)/;

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

    // ---- Site 0: extend chip-group's app-primary import with the gear ----
    // app-primary exports the gear asset as `dh` (gear-light-16). chip-group
    // already imports from app-primary; append an alias to that import.
    if (!out.includes(`/*${RUNTIME_MARKER}GEARIMP*/`)) {
      const imp =
        /import\{(?<body>[^}]*)\}from"(?<chunk>\.\/app-primary-[0-9a-f]+\.js)"/.exec(out);
      if (!imp) {
        warn("app-primary import not found; gear icon unavailable (site 0 skipped)");
      } else if (/\bdh\b/.test(imp.groups.body)) {
        warn("app-primary import already binds `dh`; site 0 skipped");
      } else {
        const original = imp[0];
        const bodyClose = original.lastIndexOf("}");
        const extended =
          original.slice(0, bodyClose) +
          `,dh as __cbtcGear/*${RUNTIME_MARKER}GEARIMP*/` +
          original.slice(bodyClose);
        out = out.replace(original, extended);
      }
    }

    // ---- Site A: icon-switch fallback (th -> gear) -----------------------
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
          // swap the icon component th -> gear (only when the import landed)
          const th = m.groups.th;
          if (out.includes("__cbtcGear")) {
            // th is the themed agent-activity COMPONENT; __cbtcGear is a raw
            // icon asset. Render it through the chunk's asset-icon component
            // ($a-equivalent) captured from an existing asset usage.
            const ai = ASSET_ICON_ANCHOR.exec(out);
            const use = `(0,${m.groups.jsx}.jsx)(${th},{"aria-hidden":!0,className:${m.groups.cls}})`;
            const useIdx = out.indexOf(use, at);
            if (useIdx >= 0 && ai) {
              const gearUse = `(0,${m.groups.jsx}.jsx)(${ai.groups.assetComp},{"aria-hidden":!0,className:${m.groups.cls},asset:__cbtcGear})`;
              out = out.slice(0, useIdx) + gearUse + out.slice(useIdx + use.length);
            } else {
              warn("icon-switch usage/asset-component not found; keeping th");
            }
          }
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

function applyChatBridgeToolCallsRegistryIconPatch(source, context = {}) {
  // Retired: the registry-route experiment destabilized rendering (tool line
  // vanished). The icon-switch route in chip.js covers all consumers via the
  // shared Ub component; this descriptor now intentionally no-ops.
  void source;
  void context;
  return source;
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
  {
    id: "chat-bridge-tool-calls-icon-registry",
    order: 20_991,
    phase: "webview-asset",
    ciPolicy: "optional",
    pattern: REGISTRY_ASSET_PATTERN,
    missingDescription: "agent-activity-item chunk",
    skipDescription: "chat-bridge-tool-calls registry gear-icon patch",
    apply: applyChatBridgeToolCallsRegistryIconPatch,
  },
];

module.exports = {
  ASSET_PATTERN,
  REGISTRY_ASSET_PATTERN,
  RUNTIME_MARKER,
  RUNTIME_MARKER_REG,
  ICON_ANCHOR,
  NB_ANCHOR,
  applyChatBridgeToolCallsIconPatch,
  applyChatBridgeToolCallsRegistryIconPatch,
  descriptors,
};
