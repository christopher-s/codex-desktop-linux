"use strict";

/** Expand generic custom-GPT Action rows with Codex native disclosure UI. */
const RUNTIME_MARKER = "codexLinuxChatBridgeToolCallsChipRuntime";
const ASSET_PATTERN = /^subagent-activity-chip-group-[0-9a-f]+\.js$/;

const LABEL_ANCHOR =
  /let (?<n>\w+)=\((?<e>\w+)\.completed\?(?<zb>\w+)\[\k<e>\.tool\]:(?<bb>\w+)\[\k<e>\.tool\]\)\?\?\(0,(?<ib>[\w$]+)\.default\)\(\k<e>\.tool\);/;
const ROW_START_ANCHOR =
  /function (?<fn>\w+)\((?<props>\w+)\)\{let (?<cache>\w+)=\(0,(?<cachemod>[\w$]+)\.c\)\((?<slots>\d+)\),(?<destructure>\{[^}]*item:(?<item>\w+)[^}]*\}=\k<props>,)[\s\S]{0,1400}?\b\w+=Pb\(\k<item>,/;
const LEGACY_SUMMARY_ANCHOR =
  /try\{if\([\s\S]{0,1200}?\}\}catch\(\w+\)\{\}\/\*codexLinuxChatBridgeToolCallsChipRuntime\*\//;
const ROW_RETURN_ANCHOR =
  /let (?<summary>\w+)=(?<summaryValue>\w+);if\((?<variant>\w+)!==`row`\)return \k<summary>;/;
const REACT_STATE_ANCHOR = /\(0,(?<react>[\w$]+)\.useState\)\(/g;
const EXEC_PRIMITIVES_ANCHOR =
  /\(0,(?<jsx>[\w$]+)\.jsxs\)\((?<inset>[\w$]+),\{[\s\S]{0,500}?children:\[[\s\S]{0,800}?\(0,\k<jsx>\.jsx\)\((?<output>[\w$]+),\{command:/;
const NATIVE_CARD_ANCHOR =
  /\(0,(?<jsx>[\w$]+)\.jsx\)\((?<card>[\w$]+),\{accessory:(?<accessory>[\w$]+),body:(?<body>[\w$]+),className:`relative overflow-clip`,disclosure:(?<disclosure>[\w$]+),icon:(?<icon>[\w$]+),summary:(?<summary>[\w$]+)\}\)/;

function warn(message) {
  console.warn(`WARN: chat-bridge-tool-calls-chip: ${message}`);
}

function showBridgeToolCallsEnabled(context = {}) {
  const settings = context.settings && typeof context.settings === "object" ? context.settings : {};
  return settings.showBridgeToolCalls !== false;
}

function applyChatBridgeToolCallsChipPatch(source, context = {}) {
  try {
    if (!showBridgeToolCallsEnabled(context)) return source;
    const nativeMarker = `/*${RUNTIME_MARKER}Native*/`;
    if (source.includes(nativeMarker)) return source;

    // The captured working asset may already contain the retired compact-label
    // enrichment. Remove only its marker-bounded structural insertion first.
    const legacy = LEGACY_SUMMARY_ANCHOR.exec(source);
    const cleanSource = legacy
      ? source.slice(0, legacy.index) + source.slice(legacy.index + legacy[0].length)
      : source;

    const label = LABEL_ANCHOR.exec(cleanSource);
    const start = ROW_START_ANCHOR.exec(cleanSource);
    const exec = EXEC_PRIMITIVES_ANCHOR.exec(cleanSource);
    const card = NATIVE_CARD_ANCHOR.exec(cleanSource);
    if (!label || !start || !exec || !card) {
      warn("generic row/native Sc+fc+yh anchors not found; source unchanged");
      return source;
    }

    const nextFunction = cleanSource.indexOf("function ", start.index + start[0].length);
    const rowEnd = nextFunction < 0 ? cleanSource.length : nextFunction;
    const rowSlice = cleanSource.slice(start.index, rowEnd);
    const ret = ROW_RETURN_ANCHOR.exec(rowSlice);
    const icon = /\(0,(?<jsx>[\w$]+)\.jsx\)\((?<icon>[\w$]+),\{className:`icon-xs shrink-0 text-secondary`\}\)/.exec(rowSlice);
    if (!ret || !icon) {
      warn("generic row return/icon anchor not found; source unchanged");
      return source;
    }

    // Use the closest structurally captured React namespace before this component.
    let react = null;
    REACT_STATE_ANCHOR.lastIndex = 0;
    for (let m; (m = REACT_STATE_ANCHOR.exec(cleanSource)) && m.index < start.index;) react = m;
    REACT_STATE_ANCHOR.lastIndex = 0;
    if (!react) {
      warn("React useState namespace anchor not found; source unchanged");
      return source;
    }

    const { item } = start.groups;
    const { zb, bb } = label.groups;
    const { summary, summaryValue, variant } = ret.groups;
    const state = `let[__cbtcOpen,__cbtcSetOpen]=(0,${react.groups.react}.useState)(!1);`;
    const bodyStart = cleanSource.indexOf("{", start.index) + 1;
    let patched = cleanSource.slice(0, bodyStart) + state + cleanSource.slice(bodyStart);

    const originalReturnIndex = start.index + ret.index;
    const shiftedReturnIndex = originalReturnIndex + state.length;
    const replacement =
      `let ${summary}=${summaryValue};` +
      `if(${item}.namespace==null&&${zb}[${item}.tool]==null&&${bb}[${item}.tool]==null&&` +
      `${item}.arguments!=null&&typeof ${item}.arguments===\`object\`&&!Array.isArray(${item}.arguments)){` +
      `let __cbtcBody=(0,${exec.groups.jsx}.jsx)(${exec.groups.inset},{children:(0,${exec.groups.jsx}.jsx)(${exec.groups.output},{` +
      `command:\`\`,cwd:void 0,output:JSON.stringify(${item}.arguments,null,2),isInProgress:!1})});` +
      `return(0,${card.groups.jsx}.jsx)(${card.groups.card},{body:__cbtcBody,className:\`relative overflow-clip\`,` +
      `disclosure:{expanded:__cbtcOpen,onToggle:()=>__cbtcSetOpen(e=>!e)},` +
      `icon:(0,${icon.groups.jsx}.jsx)(${icon.groups.icon},{className:\`icon-xs shrink-0 text-secondary\`}),summary:${summary}})}` +
      `${nativeMarker}if(${variant}!==\`row\`)return ${summary};`;

    patched = patched.slice(0, shiftedReturnIndex) + replacement +
      patched.slice(shiftedReturnIndex + ret[0].length);
    return patched;
  } catch (error) {
    warn(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    return source;
  }
}

const descriptors = [{
  id: "chat-bridge-tool-calls-chip",
  order: 20_980,
  phase: "webview-asset",
  ciPolicy: "optional",
  pattern: ASSET_PATTERN,
  missingDescription: "subagent-activity-chip-group chunk",
  skipDescription: "chat-bridge-tool-calls native disclosure patch",
  apply: applyChatBridgeToolCallsChipPatch,
}];

module.exports = {
  ASSET_PATTERN,
  RUNTIME_MARKER,
  LABEL_ANCHOR,
  ROW_START_ANCHOR,
  ROW_RETURN_ANCHOR,
  EXEC_PRIMITIVES_ANCHOR,
  NATIVE_CARD_ANCHOR,
  applyChatBridgeToolCallsChipPatch,
  descriptors,
};
