"use strict";

/**
 * chat-tool-calls: expand collapsed tool-activity disclosures in the webview.
 *
 * The upstream webview ships a shared `tool-activity-disclosure` component
 * (the "Ran 3 commands, called 2 tools" collapsible). Its `defaultExpanded`
 * prop defaults to collapsed, so rich tool-call detail (commands, diffs,
 * MCP calls) is hidden behind one summary row per turn.
 *
 * This patch rewrites the component's expansion logic so disclosures render
 * expanded by default. The anchor is structural and idempotent:
 *
 *   let f = n !== void 0 && n;   // f = defaultExpanded ?? false
 *
 * becomes:
 *
 *   let f = true;
 *
 * The rest of the component (running-state auto-expand, manual toggle) is
 * untouched, so users can still collapse rows after the fact.
 */

const ASSET_PATTERN = /^tool-activity-disclosure-[^.]+\.js$/;

// `defaultExpanded:n` destructured; then `let f=n!==void 0&&n` captures it.
// Minifier names differ per build, so anchor on the structural shape.
const DEFAULT_EXPANDED_PATTERN =
  /\{defaultExpanded:(\w+),indentContent:(\w+)\}=\w+;let \w+=(?:\(0,\w+\.c\)\(\d+\),)?\{/;
const CAPTURE_PATTERN =
  /(\w+)!==void 0&&\w+;let (\w+)=\1/g;

const RUNTIME_MARKER = "codexLinuxChatToolCallsExpandedRuntime";

function warn(message) {
  console.warn(`WARN: ${message} - skipping chat-tool-calls patch`);
}

function expandToolActivityEnabled(context = {}) {
  const defaults = context?.feature?.manifest?.tweaks?.expandToolActivity;
  const settings = context?.feature?.settings?.tweaks?.expandToolActivity;
  const config = {
    ...(defaults != null && typeof defaults === "object" && !Array.isArray(defaults) ? defaults : {}),
    ...(settings != null && typeof settings === "object" && !Array.isArray(settings) ? settings : {}),
  };
  return config.enabled !== false;
}

function looksLikeDisclosureBundle(source) {
  return source.includes("`running`") && source.includes("`overflow-hidden`") &&
    /function \w+\(\)\{let \w+=\(0,\w\.c\)\(\d+\),\[/.test(source) &&
    source.includes("borderBoxSize");
}

function applyExpandToolActivityPatch(source, context = {}) {
  try {
    if (typeof source !== "string") {
      warn("Asset source is not a string");
      return source;
    }
    if (!expandToolActivityEnabled(context)) {
      return source;
    }
    if (source.includes(RUNTIME_MARKER)) {
      return source; // already patched (idempotent)
    }

    if (!looksLikeDisclosureBundle(source)) {
      warn("Could not find tool-activity disclosure markers");
      return source;
    }

    // Comma-chained declarator: `let {...defaultExpanded:n...}=e,f=n!==void 0&&n,p=...`
    // where `n` is the defaultExpanded prop and `f` its captured boolean. The
    // declarators share ONE `let`, so the replacement must NOT introduce a
    // statement separator - keep the comma chain intact.
    const patched = source.replace(
      /(\{[^{}]*defaultExpanded:(\w+)[^{}]*\}=\w+,)(\w+)=\2!==void 0&&\2/g,
      (match, head, prop, captured) => `${head}${captured}=true/*${RUNTIME_MARKER}*/`,
    );

    if (patched === source) {
      warn("defaultExpanded capture pattern not found");
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
    id: "expand-tool-activity",
    phase: "webview-asset",
    order: 20_990,
    ciPolicy: "optional",
    pattern: ASSET_PATTERN,
    missingDescription: "tool-activity disclosure bundle",
    skipDescription: "chat-tool-calls expand tool activity patch",
    apply: applyExpandToolActivityPatch,
  },
];

module.exports = {
  ASSET_PATTERN,
  RUNTIME_MARKER,
  applyExpandToolActivityPatch,
  descriptors,
  expandToolActivityEnabled,
  looksLikeDisclosureBundle,
};
