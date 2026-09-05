"use strict";

/** Chat-only web-search normalization and viewer admission. */

const DATA_MARKER = "codexLinuxChatSearchDataRuntime";
const VIEWER_MARKER = "codexLinuxChatSearchRowsRuntime";
const DATA_ASSET_PATTERN = /^app-initial-[0-9a-f]+\.js$/;
const VIEWER_ASSET_PATTERN = /^viewer-[0-9a-f]+\.js$/;

const METADATA_SEARCH_ANCHOR =
  /function (\w+)\((\w+)\)\{let (\w+)=(\w+)\(\w+\(\2\.metadata\)\);return \3\.length===0\?\[\]:\[(\w+)\(\2,\{queries:\3,query:\3\[0\]\?\?null,type:`search`\}\)\]\}/;
const ACTION_SEARCH_ANCHOR =
  /let (\w+)=(\w+)\(\w+\((\w+)\.action\)\);return\[\{action:\1,completed:\w+\(\3\.status\)!==`in_progress`,query:(\w+)\(\1,``\),type:`web-search`\}\]/;
const VIEWER_SKIP_ANCHOR =
  /(\.type===`web-search`&&!\(`chatGptWorkActivityId`in )(\w+)(\))/;

function warn(message) {
  console.warn(`chat-tool-calls-chat-search-rows: ${message}`);
}

function enabled(context = {}) {
  const defaults = context?.feature?.manifest?.tweaks?.chatSearchRows;
  const settings = context?.feature?.settings?.tweaks?.chatSearchRows;
  const config = {
    ...(defaults && typeof defaults === "object" && !Array.isArray(defaults) ? defaults : {}),
    ...(settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {}),
  };
  return config.enabled !== false;
}

function applyChatSearchDataPatch(source, context = {}) {
  try {
    if (typeof source !== "string" || !enabled(context) || source.includes(DATA_MARKER)) return source;
    if (!source.includes("search_model_queries") || !source.includes("web_search_call")) {
      warn("Chat search normalization markers not found");
      return source;
    }
    let metadataCount = 0;
    let actionCount = 0;
    let patched = source.replace(METADATA_SEARCH_ANCHOR,
      (match, fn, message, queries, normalize, makeItem) => {
        metadataCount += 1;
        return `function ${fn}(${message}){let ${queries}=${normalize}(NL(${message}.metadata));return ${queries}.map(${normalize}=>({...${makeItem}(${message},{queries:[${normalize}],query:${normalize},type:\`search\`}),chatGptChatWebSearch:!0/*${DATA_MARKER}*/}))}`;
      });
    patched = patched.replace(ACTION_SEARCH_ANCHOR,
      (match, action, normalize, event, queryOf) => {
        actionCount += 1;
        return `let ${action}=${normalize}(NL(${event}.action)),chatSearchQueries=${action}?.type===\`search\`&&${action}.queries?.length?${action}.queries:[${queryOf}(${action},\`\`)];return chatSearchQueries.map(chatSearchQuery=>({action:${action}?.type===\`search\`?{...${action},queries:[chatSearchQuery],query:chatSearchQuery}:${action},chatGptChatWebSearch:!0,completed:PL(${event}.status)!==\`in_progress\`,query:chatSearchQuery,type:\`web-search\`}))`;
      });
    if (metadataCount !== 1 || actionCount !== 1) {
      warn(`Expected one metadata and one action anchor; found ${metadataCount} and ${actionCount}`);
      return source;
    }
    return patched;
  } catch (error) {
    warn(error instanceof Error ? error.message : String(error));
    return source;
  }
}

function applyChatSearchViewerPatch(source, context = {}) {
  try {
    if (typeof source !== "string" || !enabled(context) || source.includes(VIEWER_MARKER)) return source;
    if (!source.includes("chatGptWorkActivityId") || !source.includes("type===`web-search`")) {
      warn("Viewer web-search markers not found");
      return source;
    }
    let count = 0;
    const patched = source.replace(VIEWER_SKIP_ANCHOR, (match, head, item, tail) => {
      count += 1;
      return `${head}${item}${tail}&&${item}.chatGptChatWebSearch!==!0/*${VIEWER_MARKER}*/`;
    });
    if (count !== 1) {
      warn(`Expected one viewer skip anchor; found ${count}`);
      return source;
    }
    return patched;
  } catch (error) {
    warn(error instanceof Error ? error.message : String(error));
    return source;
  }
}

const descriptors = [
  {
    id: "chat-search-data",
    phase: "webview-asset",
    order: 20_975,
    ciPolicy: "optional",
    pattern: DATA_ASSET_PATTERN,
    missingDescription: "app-initial Chat search normalization bundle",
    skipDescription: "chat-tool-calls Chat search data patch",
    apply: applyChatSearchDataPatch,
  },
  {
    id: "chat-search-rows",
    phase: "webview-asset",
    order: 20_980,
    ciPolicy: "optional",
    pattern: VIEWER_ASSET_PATTERN,
    missingDescription: "viewer Chat search activity bundle",
    skipDescription: "chat-tool-calls Chat search rows patch",
    apply: applyChatSearchViewerPatch,
  },
];

module.exports = {
  ACTION_SEARCH_ANCHOR,
  DATA_ASSET_PATTERN,
  DATA_MARKER,
  METADATA_SEARCH_ANCHOR,
  VIEWER_ASSET_PATTERN,
  VIEWER_MARKER,
  VIEWER_SKIP_ANCHOR,
  applyChatSearchDataPatch,
  applyChatSearchViewerPatch,
  descriptors,
  enabled,
};
