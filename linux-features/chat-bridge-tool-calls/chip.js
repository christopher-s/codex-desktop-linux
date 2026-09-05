"use strict";

/**
 * chat-bridge-tool-calls/chip patch: give generic dynamic-tool-call chips an
 * inline argument summary — the same presentation the web extension uses
 * (tool name + "key: value · key: value") — for ANY tool without a
 * specialized label/renderer. Fully generic: fires for every custom-GPT
 * Action (jit_plugin) call and any other unregistered dynamic tool.
 *
 * Verified shape (subagent-activity-chip-group-*.js, 2026-09-04):
 *   function Pb(e,t){...
 *     let n=(e.completed?zb[e.tool]:Bb[e.tool])??(0,Ib.default)(e.tool);
 *     return(0,Rb.jsx)(Y,{id:`localConversation.dynamicToolCall`,
 *       defaultMessage:`{toolName}`,...,values:{toolName:t?(0,Lb.default)(n):n}})}
 * Pb builds the chip label for tools NOT in the specialized registry
 * (agent-activity-item-*.js `sn` = [...Ct,...$t,...kt], matched on
 * namespace+tool). The fallback label shows only the humanized tool name —
 * arguments the item already carries are never surfaced.
 *
 * Patch strategy: pure INSERTION after the `let n=...;` label lookup. When
 * the tool has no label-table entry (zb/Bb miss) and the item carries a
 * plain-object `arguments`, append the first two `key: value` pairs
 * (values truncated to 40 chars) to the label string n. The FormattedMessage
 * {toolName} then renders "hermes_run_command · command: echo hi".
 *
 * Fail-soft: anchor miss returns the source unchanged with a warning.
 * Idempotent via the /*MARKER* / comment. Disable via settings
 * { showBridgeToolCalls: false } (shared with the classifier patch).
 */

const RUNTIME_MARKER = "codexLinuxChatBridgeToolCallsChipRuntime";

const ASSET_PATTERN = /^subagent-activity-chip-group-[0-9a-f]+\.js$/;

// Anchor: Pb's generic-label lookup.
//   let n=(e.completed?zb[e.tool]:Bb[e.tool])??(0,Ib.default)(e.tool);
const LABEL_ANCHOR =
  /let (?<n>\w+)=\((?<e>\w+)\.completed\?(?<zb>\w+)\[\k<e>\.tool\]:(?<bb>\w+)\[\k<e>\.tool\]\)\?\?\(0,(?<ib>\w+)\.default\)\(\k<e>\.tool\);/;

function warn(message) {
  console.warn(`WARN: chat-bridge-tool-calls-chip: ${message}`);
}

function showBridgeToolCallsEnabled(context = {}) {
  const settings =
    context.settings && typeof context.settings === "object"
      ? context.settings
      : {};
  return settings.showBridgeToolCalls !== false;
}

function applyChatBridgeToolCallsChipPatch(source, context = {}) {
  try {
    if (!showBridgeToolCallsEnabled(context)) {
      return source;
    }
    if (source.includes(`/*${RUNTIME_MARKER}*/`)) {
      return source; // already patched (idempotent)
    }

    const m = LABEL_ANCHOR.exec(source);
    if (!m) {
      warn(
        "generic-label anchor not found (upstream bundle changed); source unchanged",
      );
      return source;
    }

    const n = m.groups.n;
    const e = m.groups.e;
    const zb = m.groups.zb;
    const bb = m.groups.bb;

    const insertion =
      `try{if(${zb}[${e}.tool]==null&&${bb}[${e}.tool]==null&&` +
      `${e}.arguments!=null&&typeof ${e}.arguments===\`object\`&&!Array.isArray(${e}.arguments)){` +
      `var __cbtcK=Object.keys(${e}.arguments).filter(function(k){return k!==\`session_id\`&&k!==\`request_id\`}),__cbtcR=[];` +
      `for(var __cbtcI=0;__cbtcI<__cbtcK.length&&__cbtcR.length<2;__cbtcI++){` +
      `var __cbtcV=${e}.arguments[__cbtcK[__cbtcI]],__cbtcS=typeof __cbtcV===\`string\`?__cbtcV:JSON.stringify(__cbtcV);` +
      `if(typeof __cbtcS!==\`string\`)continue;` +
      `if(__cbtcS.length>40)__cbtcS=__cbtcS.slice(0,37)+\`…\`;` +
      `__cbtcR.push(__cbtcK[__cbtcI]+\`: \`+__cbtcS)}` +
      `if(__cbtcR.length)${n}=${n}+\`  ·  \`+__cbtcR.join(\`  ·  \`)}}catch(x){}` +
      `/*${RUNTIME_MARKER}*/`;

    const at = m.index + m[0].length;
    const patched = source.slice(0, at) + insertion + source.slice(at);

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
    id: "chat-bridge-tool-calls-chip",
    order: 20_980, // after recap (20_970)
    phase: "webview-asset",
    ciPolicy: "optional",
    pattern: ASSET_PATTERN,
    missingDescription: "subagent-activity-chip-group chunk",
    skipDescription: "chat-bridge-tool-calls chip label patch",
    apply: applyChatBridgeToolCallsChipPatch,
  },
];

module.exports = {
  ASSET_PATTERN,
  RUNTIME_MARKER,
  LABEL_ANCHOR,
  applyChatBridgeToolCallsChipPatch,
  descriptors,
};
