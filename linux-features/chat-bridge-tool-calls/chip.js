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
const INNER_ICON_GATE_ANCHOR =
  /(?<gate>\w+)=(?:\((?<itemPatched>\w+)\.namespace===`codex_app`\|\|\k<itemPatched>\.namespace==null\)\/\*codexLinuxChatBridgeToolCallsIconRuntimeB\*\/|(?<itemPlain>\w+)\.namespace===`codex_app`)&&(?<variant>\w+)!==`summary-text`/;
const ICON_SUMMARY_WRAPPER_ANCHOR =
  /if\((?<variant>\w+)===`row`&&(?<icon>\w+)!==void 0\)\{/;
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
    const innerIconGate = INNER_ICON_GATE_ANCHOR.exec(rowSlice);
    if (!innerIconGate || (innerIconGate.groups.itemPatched ?? innerIconGate.groups.itemPlain) !== item || innerIconGate.groups.variant !== variant) {
      warn("generic row inner-icon gate anchor not found; source unchanged");
      return source;
    }
    const state = `let[__cbtcOpen,__cbtcSetOpen]=(0,${react.groups.react}.useState)(!1);`;
    const bodyStart = cleanSource.indexOf("{", start.index) + 1;
    let patched = cleanSource.slice(0, bodyStart) + state + cleanSource.slice(bodyStart);

    const originalReturnIndex = start.index + ret.index;
    const shiftedReturnIndex = originalReturnIndex + state.length;
    const replacement =
      `let ${summary}=${summaryValue};` +
      `if(${variant}===\`row\`&&${item}.namespace==null&&${zb}[${item}.tool]==null&&${bb}[${item}.tool]==null&&` +
      `${item}.arguments!=null&&typeof ${item}.arguments===\`object\`&&!Array.isArray(${item}.arguments)){` +
      `let __cbtcBody=__cbtcOpen?(()=>{let __cbtcParse=__cbtcV=>{if(typeof __cbtcV!==\`string\`)return __cbtcV;let __cbtcS=__cbtcV.trim();` +
      `if(!((__cbtcS.startsWith(\`{\`)&&__cbtcS.endsWith(\`}\`))||(__cbtcS.startsWith(\`[\`)&&__cbtcS.endsWith(\`]\`))))return __cbtcV;` +
      `try{return __cbtcParse(JSON.parse(__cbtcS))}catch{return __cbtcV}},__cbtcRows=[],__cbtcWalk=(__cbtcV,__cbtcK,__cbtcDepth,__cbtcPath)=>{` +
      `__cbtcV=__cbtcParse(__cbtcV);if(__cbtcV!=null&&typeof __cbtcV===\`object\`){if(__cbtcK!=null)__cbtcRows.push((0,${exec.groups.jsx}.jsx)(\`div\`,` +
      `{className:\`text-secondary\`,style:{paddingLeft:\`${'${__cbtcDepth}'}rem\`},children:\`${'${__cbtcK}'}:\`},__cbtcPath));` +
      `Object.entries(__cbtcV).forEach(([__cbtcChildK,__cbtcChildV],__cbtcI)=>__cbtcWalk(__cbtcChildV,Array.isArray(__cbtcV)?\`[${'${__cbtcI}'}]\`:__cbtcChildK,__cbtcDepth+(__cbtcK==null?0:1),\`${'${__cbtcPath}'}.${'${__cbtcChildK}'}\`));return}` +
      `let __cbtcText=__cbtcV===null?\`null\`:String(__cbtcV);__cbtcRows.push((0,${exec.groups.jsx}.jsxs)(\`div\`,{className:\`break-words whitespace-pre-wrap\`,` +
      `style:{paddingLeft:\`${'${__cbtcDepth}'}rem\`},children:[__cbtcK==null?null:(0,${exec.groups.jsx}.jsx)(\`span\`,{className:\`text-secondary\`,children:\`${'${__cbtcK}'}: \`}),` +
      `(0,${exec.groups.jsx}.jsx)(\`span\`,{className:\`text-primary\`,children:__cbtcText})]},__cbtcPath))};__cbtcWalk(${item}.arguments,null,0,\`root\`);` +
      `return(0,${exec.groups.jsx}.jsx)(\`div\`,{className:\`overflow-hidden rounded-md border border-border bg-surface-secondary/40 px-3 py-2 font-mono text-xs leading-4\`,children:__cbtcRows})})():null;` +
      `return(0,${card.groups.jsx}.jsx)(${card.groups.card},{body:__cbtcBody,className:\`relative overflow-clip\`,` +
      `disclosure:{expanded:__cbtcOpen,onToggle:()=>__cbtcSetOpen(e=>!e)},` +
      `icon:(0,${icon.groups.jsx}.jsx)(${icon.groups.icon},{className:\`icon-xs shrink-0 text-secondary\`,\"data-codex-linux-chat-bridge-card-icon\":\`codexLinuxChatBridgeToolCallsCardIcon\`}),summary:${summary}})}` +
      `${nativeMarker}if(${variant}!==\`row\`)return ${summary};`;

    patched = patched.slice(0, shiftedReturnIndex) + replacement +
      patched.slice(shiftedReturnIndex + ret[0].length);

    // The native card owns the row icon. Suppress Nb's inline icon for these
    // null-namespace row summaries so the card does not display two glyphs.
    const shiftedInnerGateIndex = start.index + innerIconGate.index + state.length;
    const innerGateOriginal = innerIconGate[0];
    const innerGateReplacement =
      `${innerIconGate.groups.gate}=(${item}.namespace===\`codex_app\`||${item}.namespace==null)&&` +
      `${variant}!==\`summary-text\`&&!(${variant}===\`row\`&&${item}.namespace==null)`;
    patched = patched.slice(0, shiftedInnerGateIndex) + innerGateReplacement +
      patched.slice(shiftedInnerGateIndex + innerGateOriginal.length);

    // Ub normally wraps every row carrying an externally supplied icon in a
    // summary-only Sc card and calls Nb with variant="summary-text". Chat
    // bridge items use a null namespace and must reach Nb as variant="row" so
    // its argument disclosure branch above can execute.
    const wrapper = ICON_SUMMARY_WRAPPER_ANCHOR.exec(patched);
    if (!wrapper) {
      warn("icon-only summary wrapper anchor not found; source unchanged");
      return source;
    }
    const wrapperCondition = wrapper[0].slice(0, -2) + "&&o.namespace!=null){";
    patched = patched.slice(0, wrapper.index) + wrapperCondition +
      patched.slice(wrapper.index + wrapper[0].length);
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
  ICON_SUMMARY_WRAPPER_ANCHOR,
  EXEC_PRIMITIVES_ANCHOR,
  NATIVE_CARD_ANCHOR,
  applyChatBridgeToolCallsChipPatch,
  descriptors,
};
