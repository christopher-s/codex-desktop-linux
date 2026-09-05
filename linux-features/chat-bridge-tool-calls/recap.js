"use strict";

/**
 * chat-bridge-tool-calls/recap patch: stop the transcript VIEWER from dropping
 * reasoning groups whose server-set recap says `hide_all`.
 *
 * Background (verified on viewer-b286e659c89a.js, 2026-09-04):
 *   The server sends bridge/custom-GPT-Action turns a reasoning recap of
 *   {content: "Worked for 1m 23s", type: "hide_all"}. The viewer's turn
 *   flatMap renders a reasoning group ONLY at its designated index (t===Ce)
 *   and ONLY when pe?.type !== "hide_all":
 *     Ve=S.items.flatMap((e,t)=>e.type===`chatgpt-reasoning-group`
 *        ? t!==Ce||pe?.type===`hide_all` ? [] : [{key:`reasoning`, node:...}]
 *        : ...)
 *   So even with items in state, a hide_all recap suppresses the group node.
 *
 * Patch strategy: pure INSERTION. When the flatMap is about to consult the
 * recap, first rewrite pe to null when the group at the render index carries
 * dynamic-tool-call items. pe==null passes the pe?.type!=='hide_all' test and
 * the group renders with its default (collapsed-summary) presentation.
 *
 * We anchor on the structural shape:
 *   e.type===`chatgpt-reasoning-group`?t!==Ce||pe?.type===`hide_all`?[]
 * where t is the index binding and Ce the designated render index — but
 * minifier names differ per build, so we capture them.
 *
 * Fail-soft: anchor miss returns the source unchanged with a warning.
 * Idempotent via the /*MARKER* / comment. Disable via settings
 * { showBridgeToolCalls: false } (shared with the classifier patch).
 */

const RUNTIME_MARKER = "codexLinuxChatBridgeToolCallsRecapRuntime";
const RUNTIME_MARKER_KM = "codexLinuxChatBridgeToolCallsKmRuntime";
const RUNTIME_MARKER_SKIP = "codexLinuxChatBridgeToolCallsSkipRuntime";

const ASSET_PATTERN = /^viewer-[0-9a-f]+\.js$/;

// Structural anchor on the viewer's reasoning-group render gate.
//   e.type===`chatgpt-reasoning-group`?t!==Ce||pe?.type===`hide_all`?[]:[{key:`reasoning`,...
const RECAP_GATE_ANCHOR =
  /(?<entry>\w+)\.type===`chatgpt-reasoning-group`\?(?<idx>\w+)!==(?<ce>\w+)\|\|(?<pe>\w+)\?\.type===`hide_all`\?\[\]:\[\{key:`reasoning`/;

function warn(message) {
  console.warn(`WARN: chat-bridge-tool-calls-recap: ${message}`);
}

function showBridgeToolCallsEnabled(context = {}) {
  const settings =
    context.settings && typeof context.settings === "object"
      ? context.settings
      : {};
  return settings.showBridgeToolCalls !== false;
}

function applyChatBridgeToolCallsRecapPatch(source, context = {}) {
  try {
    if (!showBridgeToolCallsEnabled(context)) {
      return source;
    }
    let out = source;

    // ---- Gate 3a: viewer flatMap render gate ------------------------------
    // e.type===`chatgpt-reasoning-group`?t!==Ce||pe?.type===`hide_all`?[]:[{key:`reasoning`,...
    // Rewritten so hide_all only drops groups WITHOUT dynamic-tool-call items.
    if (!out.includes(`/*${RUNTIME_MARKER}*/`)) {
      const m = RECAP_GATE_ANCHOR.exec(out);
      if (!m) {
        warn("viewer recap gate anchor not found (upstream bundle changed); skipping gate 3a");
      } else {
        const entry = m.groups.entry;
        const idx = m.groups.idx;
        const pe = m.groups.pe;
        const original = `${idx}!==${m.groups.ce}||${pe}?.type===\`hide_all\``;
        const replacement =
          `${idx}!==${m.groups.ce}||(${pe}?.type===\`hide_all\`&&` +
          `(!Array.isArray(${entry}.items)||` +
          `!${entry}.items.some(function(i){return i&&i.type===\`dynamic-tool-call\`})))` +
          `/*${RUNTIME_MARKER}*/`;
        const at = m.index + m[0].indexOf(original);
        if (at < m.index) {
          warn("gate 3a condition not located inside anchor; skipping");
        } else {
          out = out.slice(0, at) + replacement + out.slice(at + original.length);
        }
      }
    }

    // ---- Gate 3b: Km component body null-render ----------------------------
    // function Km(e){let t=(0,ih.c)(10);if(e.reasoningRecap?.type===`hide_all`)return null;
    // Rewritten so hide_all only nulls when items carry NO dynamic-tool-call.
    // Anchor on prop names only (e, ih, 10 vary per build).
    if (!out.includes(`/*${RUNTIME_MARKER_KM}*/`)) {
      const km = /function (?<fn>\w+)\((?<p>\w+)\)\{let \w+=\(0,\w+\.c\)\(\d+\);if\(\k<p>\.reasoningRecap\?\.type===`hide_all`\)return null;/.exec(out);
      if (!km) {
        warn("Km hide_all null-render anchor not found; skipping gate 3b");
      } else {
        const p = km.groups.p;
        const original = `if(${p}.reasoningRecap?.type===\`hide_all\`)return null;`;
        const replacement =
          `if(${p}.reasoningRecap?.type===\`hide_all\`&&` +
          `(!Array.isArray(${p}.items)||!${p}.items.some(function(i){return i&&i.type===\`dynamic-tool-call\`}))` +
          `)return null/*${RUNTIME_MARKER_KM}*/;`;
        const at = out.indexOf(original, km.index);
        if (at < 0) {
          warn("gate 3b condition not located; skipping");
        } else {
          out = out.slice(0, at) + replacement + out.slice(at + original.length);
        }
      }
    }

    // ---- Gate 3c: Ym/qc loops skip dynamic-tool-call items entirely ----------
    // Two sites in viewer:
    //   site1: if(A||...||a.type===`dynamic-tool-call`)continue;   (Ym row loop)
    //   site2: if(!(A||...||t.type===`dynamic-tool-call`||...))    (collapsed-row loop)
    // Removing the clause lets them flow to the Lm/el renderer (case dynamic-tool-call).
    if (!out.includes(`/*${RUNTIME_MARKER_SKIP}*/`)) {
      // site1: ||X.type===`dynamic-tool-call`)continue
      const s1 = /\|\|(?<v1>\w+)\.type===`dynamic-tool-call`\)continue;/.exec(out);
      if (s1) {
        const original = `||${s1.groups.v1}.type===\`dynamic-tool-call\`)continue;`;
        out = out.replace(original, `)continue;/*${RUNTIME_MARKER_SKIP}*/`);
      } else {
        warn("skip site 1 anchor not found; skipping gate 3c-s1");
      }
    }
    if (!out.includes(`/*${RUNTIME_MARKER_SKIP}2*/`)) {
      // site2: ||X.type===`dynamic-tool-call`||
      const s2 = /\|\|(?<v2>\w+)\.type===`dynamic-tool-call`\|\|/.exec(out);
      if (s2) {
        const original = `||${s2.groups.v2}.type===\`dynamic-tool-call\`||`;
        out = out.replace(original, `||/*${RUNTIME_MARKER_SKIP}2*/`);
      } else {
        warn("skip site 2 anchor not found; skipping gate 3c-s2");
      }
    }

    if (out === source) {
      if (!source.includes(`/*${RUNTIME_MARKER}*/`) && !source.includes(`/*${RUNTIME_MARKER_KM}*/`)) {
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
    id: "chat-bridge-tool-calls-recap",
    order: 20_970, // after visibility (20_960)
    phase: "webview-asset",
    ciPolicy: "optional",
    pattern: ASSET_PATTERN,
    missingDescription: "viewer chunk",
    skipDescription: "chat-bridge-tool-calls recap gate patch",
    apply: applyChatBridgeToolCallsRecapPatch,
  },
];

module.exports = {
  ASSET_PATTERN,
  RUNTIME_MARKER,
  RECAP_GATE_ANCHOR,
  applyChatBridgeToolCallsRecapPatch,
  descriptors,
};
