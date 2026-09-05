"use strict";

/**
 * chat-bridge-tool-calls: rewrite the turn-item classifier so that assistant
 * messages addressed to custom-GPT Actions recipients
 * (`<sanitized-domain>__jit_plugin.<action>`) become `dynamic-tool-call`
 * items (action name + arguments) instead of being dropped.
 *
 * Verified wire facts (mitmproxy TLS capture, 2026-09-04):
 *   author.role      = "assistant"
 *   recipient        = "chatgpt_overmind_dedyn_io__jit_plugin.hermes_run_command"
 *   content          = { content_type: "code", language: "json", text: "<args JSON>" }
 *   channel          = "commentary"
 *
 * The upstream classifier (app-initial-*.js) only produces tool items for:
 * role==="tool" nodes, recipient==="api_tool.call_tool",
 * recipient.startsWith("functions."), recipient.startsWith("local.").
 * Custom-GPT jit_plugin recipients match none, classify to null, and never
 * reach turn.items - the transcript drops them even though both the live SSE
 * stream and conversation history deliver them.
 *
 * This patch extends the dynamic-tool fallback: when the built-in `kWr`
 * helper returns null and the message recipient contains `__jit_plugin.`,
 * synthesize { completed, pairKey: null, tool: <action> } so the message
 * renders as a `dynamic-tool-call` item - the same presentation as
 * `functions.*` calls (action chip + arguments, chronological placement).
 *
 * Fail-soft: anchor miss returns the source unchanged with a warning.
 * Idempotent via the /*MARKER* / comment. Disable via settings
 * { showBridgeToolCalls: false }.
 */

const RUNTIME_MARKER = "codexLinuxChatBridgeToolCallsRuntime";

const ASSET_PATTERN = /^app-initial-[0-9a-f]+\.js$/;

// Structural anchor on the classifier's dynamic-tool fallback. Minifier
// names differ per build (upstream: kWr/ng; repacked: uGr/Uh), so capture
// identifiers instead of hardcoding them:
//   let u=kWr(e),d=ng().safeParse(s);return e.author.role===`assistant`&&u!=null&&d.success?{...dynamic-tool-call...}
const FALLBACK_ANCHOR =
  /let (?<helper>\w+)=(?<kwr>[a-zA-Z_$][\w$]*)\((?<msg>\w+)\),(?<parsed>\w+)=(?<ng>[a-zA-Z_$][\w$]*)\(\)\.safeParse\((?<raw>\w+)\);return \k<msg>\.author\.role===`assistant`&&\k<helper>!=null&&\k<parsed>\.success\?/;

function warn(message) {
  console.warn(`WARN: chat-bridge-tool-calls: ${message}`);
}

function showBridgeToolCallsEnabled(context = {}) {
  const settings =
    context.settings && typeof context.settings === "object"
      ? context.settings
      : {};
  return settings.showBridgeToolCalls !== false;
}

function applyChatBridgeToolCallsPatch(source, context = {}) {
  try {
    if (!showBridgeToolCallsEnabled(context)) {
      return source;
    }
    if (source.includes(`/*${RUNTIME_MARKER}*/`)) {
      return source; // already patched (idempotent)
    }

    const m = FALLBACK_ANCHOR.exec(source);
    if (!m) {
      warn(
        "classifier fallback anchor not found (upstream bundle changed); source unchanged",
      );
      return source;
    }

    const helper = m.groups.helper;
    const msg = m.groups.msg;
    // Pure INSERTION between `let u=kWr(e),d=ng().safeParse(s);` and the
    // `return ...` that follows: reassign `u` from the jit_plugin fallback
    // when kWr returned null. The original expression (which dereferences
    // u.completed / u.tool / u.pairKey) stays byte-identical, so it can never
    // see a null `u` it wasn't already prepared for.
    const insertion =
      `var __cbtcP="__jit_plugin.",__cbtcIdx;` +
      `${helper}=${helper}==null&&typeof ${msg}.recipient==="string"&&` +
      `(__cbtcIdx=${msg}.recipient.indexOf(__cbtcP))!==-1&&` +
      `__cbtcIdx+__cbtcP.length<${msg}.recipient.length?` +
      `{completed:${msg}.status!=="in_progress",pairKey:null,` +
      `tool:${msg}.recipient.slice(__cbtcIdx+__cbtcP.length)}:${helper};` +
      `/*${RUNTIME_MARKER}*/`;

    const target = "return";
    const targetIndex = m.index + m[0].indexOf(target);
    const patched =
      source.slice(0, targetIndex) +
      insertion +
      source.slice(targetIndex);

    if (patched === source) {
      warn("replacement produced no change; source unchanged");
      return source;
    }
    return patched;
  } catch (error) {
    warn(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    return source;
  }
}

const visibility = require("./visibility.js");
const recap = require("./recap.js");
const chip = require("./chip.js");
const icon = require("./icon.js");

const descriptors = [
  {
    id: "chat-bridge-tool-calls",
    phase: "webview-asset",
    order: 20_950,
    ciPolicy: "optional",
    pattern: ASSET_PATTERN,
    missingDescription: "app-initial chunk",
    skipDescription: "chat-bridge-tool-calls classifier patch",
    apply: applyChatBridgeToolCallsPatch,
  },
  ...visibility.descriptors,
  ...recap.descriptors,
  ...chip.descriptors,
  ...icon.descriptors,
];

module.exports = {
  ASSET_PATTERN,
  RUNTIME_MARKER,
  FALLBACK_ANCHOR,
  applyChatBridgeToolCallsPatch,
  descriptors,
  showBridgeToolCallsEnabled,
  visibilityDescriptors: visibility.descriptors,
  applyChatBridgeToolCallsVisibilityPatch: visibility.applyChatBridgeToolCallsVisibilityPatch,
};
