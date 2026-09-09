"use strict";

// Phase 2 PROBE: does local_function_signatures honor MULTIPLE advertised
// functions, and can the model call each by its bare name? Advertise a small
// tool table (3 tools, distinct schemas), generalize the detector/executor to
// recover the called tool from the message recipient, and dispatch generically
// to the loopback endpoint. Disposable QA harness — lives under /tmp.

const fs = require("fs");
const path = require("path");

const INITIAL_PATTERN = /^app-initial-[^.]+\.js$/;
const PRIMARY_PATTERN = /^app-primary-[^.]+\.js$/;
const VIEWER_PATTERN = /^viewer-[^.]+\.js$/;
const INITIAL_MARKER = "codexP2ToolSignatureRuntime";
const PRIMARY_MARKER = "codexP2ToolDetectorRuntime";
const VIEWER_MARKER = "codexP2ToolViewerRuntime";
const RESULT_PAIR_MARKER = "codexP2ToolResultPairRuntime";
const EXEC_MARKER = "codexP2ToolExecRuntime";

const ENDPOINT = "http://127.0.0.1:9473/call"; // legacy fallback only; executor now routes via lifecycle IPC

// The advertised tool table. name = model-facing bare name; the endpoint maps
// it to a Hermes registry tool (here all three are real registry tools so the
// round trip executes genuinely). schemas are JSON Schema fragments rendered
// into the signature params array.
const TOOLS = [
  {
    sig: "hermes_read_file",
    call: "read_file",
    desc: "Read a local file and return its contents. Call exactly when the user asks to read or inspect a local file.",
    params: [{ name: "path", required: true, type: "string", pdesc: "Absolute path of the file to read" }],
  },
  {
    sig: "hermes_search_files",
    call: "search_files",
    desc: "Search file contents by regex or find files by name under a directory. Call when the user asks to find or grep files.",
    params: [
      { name: "pattern", required: true, type: "string", pdesc: "Regex pattern or glob" },
      { name: "path", required: false, type: "string", pdesc: "Directory to search in" },
    ],
  },
  {
    sig: "hermes_web_search",
    call: "web_search",
    desc: "Search the web for current information. Call when the user asks a factual or current-events question.",
    params: [{ name: "query", required: true, type: "string", pdesc: "The search query" }],
  },
  {
    sig: "hermes_tool_search",
    call: "tool_search",
    desc: "Search the available Hermes tool catalog by description fragments and return matching tool names plus brief descriptions. Use to discover tools beyond the three always-visible ones (read_file, search_files, web_search).",
    params: [{ name: "queries", required: true, type: "string", pdesc: "One or more short description fragments, separated by commas" }],
  },
  {
    sig: "hermes_tool_describe",
    call: "tool_describe",
    desc: "Get the full parameter schema for named Hermes tools. Call after hermes_tool_search finds candidate names, before calling hermes_tool_call on them.",
    params: [{ name: "names", required: true, type: "string", pdesc: "One or more tool names, separated by commas" }],
  },
  {
    sig: "hermes_tool_call",
    call: "tool_call",
    desc: "Execute a named Hermes tool with its arguments. Use for any capability not covered by the three always-visible tools, after locating it with hermes_tool_search and reading its schema with hermes_tool_describe.",
    params: [
      { name: "name", required: true, type: "string", pdesc: "The Hermes tool name to execute" },
      { name: "arguments", required: false, type: "string", pdesc: "JSON object string of the tool's arguments" },
    ],
  },
];

const SIG_NAMES = TOOLS.map((t) => t.sig);
// JS source for the params array of one tool.
function paramsSrc(t) {
  return (
    "[" +
    t.params
      .map(
        (p) =>
          `{name:\`${p.name}\`,required:${p.required},type:{description:\`${p.pdesc}\`,type:\`${p.type}\`}}`
      )
      .join(",") +
    "]"
  );
}
function signaturesSrc() {
  return (
    "[" +
    TOOLS.map(
      (t) =>
        `{description:\`${t.desc}\`,name:\`${t.sig}\`,params:${paramsSrc(t)},type:\`kwargs\`}`
    ).join(",") +
    "]"
  );
}
// A JS predicate: is recipient `a` one of our tools (functions./local.)?
function recipientPred(aVar) {
  const names = SIG_NAMES.map((n) => `\`${n}\``).join(",");
  return `(e=>{let n=e.startsWith(\`functions.\`)?e.slice(10):e.startsWith(\`local.\`)?e.slice(6):null;return n!=null&&[${names}].includes(n)?n:null})(${aVar})`;
}

function replaceExactlyOnce(source, oldText, newText, label) {
  const count = source.split(oldText).length - 1;
  if (count !== 1) {
    throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  }
  return source.replace(oldText, newText);
}

function replaceStructuralExactlyOnce(source, pattern, replacement, label) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const matches = [...source.matchAll(new RegExp(pattern.source, flags))];
  if (matches.length !== 1) {
    throw new Error(`${label}: expected exactly one structural anchor, found ${matches.length}`);
  }
  return source.replace(pattern, replacement);
}

function replaceBalancedFunctionExactlyOnce(source, startPattern, replacement, label) {
  const flags = startPattern.flags.includes("g") ? startPattern.flags : `${startPattern.flags}g`;
  const matches = [...source.matchAll(new RegExp(startPattern.source, flags))];
  if (matches.length !== 1) {
    throw new Error(`${label}: expected exactly one structural anchor, found ${matches.length}`);
  }
  const match = matches[0];
  const start = match.index;
  const bodyBoundary = match[0].indexOf("){if");
  if (bodyBoundary < 0) throw new Error(`${label}: function body anchor missing`);
  const open = start + bodyBoundary + 1;
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote != null) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "`" || char === "'" || char === '"') quote = char;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) {
      const whole = source.slice(start, index + 1);
      return source.slice(0, start) + replacement(whole, ...match.slice(1)) + source.slice(index + 1);
    }
  }
  throw new Error(`${label}: unterminated structural function`);
}

function restoreLocalToolExecutionHandoff(source) {
  const presentationOnly = /sourceTool:([\w$]+)\?([\w$]+):void 0,tool:\2/g;
  const matches = [...source.matchAll(presentationOnly)];
  if (matches.length === 0) return source;
  if (matches.length !== 2) {
    throw new Error(`restore local-tool execution handoff: expected exactly two anchors, found ${matches.length}`);
  }
  return source.replace(presentationOnly, "sourceTool:$1?$2:void 0,tool:$1?`handoff`:$2");
}

function patchInitial(source) {
  if (source.includes(INITIAL_MARKER)) return restoreLocalToolExecutionHandoff(source);
  let out = source;
  out = replaceStructuralExactlyOnce(
    out,
    /function ([\w$]+)\(\{config:([\w$]+),isEverydayWorkMode:([\w$]+),isTemporaryChat:([\w$]+)\}\)\{if\(\4\)return\[\];let ([\w$]+)=\3\?`Work mode`:`Codex`;return\[\{description:([\w$]+)\(\2\.toolDescription,\5\),name:([\w$]+),params:\[\{name:`prompt`,required:!0,type:\{description:\6\(\2\.toolPromptParamDescription,\5\),type:`string`\}\},\{name:`reason`,required:!0,type:\{description:\6\(\2\.toolReasonParamDescription,\5\),type:`string`\}\}\],type:`kwargs`\}\]\}/,
    (_match, signatureFn, config, everyday, temporary) =>
      `function ${signatureFn}({config:${config},isEverydayWorkMode:${everyday},isTemporaryChat:${temporary}}){if(${temporary})return[];globalThis.__codexP2SignatureBuilds=(globalThis.__codexP2SignatureBuilds??0)+1;/*${INITIAL_MARKER}*/return ${signaturesSrc()}}`,
    "replace local signature with tool table",
  );
  out = replaceStructuralExactlyOnce(
    out,
    /local_function_signatures:([\w$]+)\|\|!([\w$]+)\?void 0:([\w$]+)\(\{config:([\w$]+),isEverydayWorkMode:([\w$]+),isTemporaryChat:([\w$]+)\}\)/g,
    (_match, disabled, _gate, signatureFn, config, everyday, temporary) =>
      `local_function_signatures:${disabled}?void 0:${signatureFn}({config:${config},isEverydayWorkMode:${everyday},isTemporaryChat:${temporary}})`,
    "local-function request gates",
  );
  out = replaceStructuralExactlyOnce(
    out,
    /async function ([\w$]+)\(([\w$]+),\{callId:([\w$]+),conversationId:([\w$]+),isTemporaryChat:([\w$]+),model:([\w$]+),onServerThreadIdChange:([\w$]+),result:([\w$]+),thinkingEffort:([\w$]+),toolName:([\w$]+)\}\)\{let ([\w$]+)=([\w$]+)\(\);return ([\w$]+)\(\2,\{[\s\S]{0,2000}?onServerThreadIdChange:\7/,
    (match, fn, scope, callId, conversationId, _temporary, _model, serverChange, result, _effort, toolName, clockVar, clockFn, submitFn) => {
      const wrappedServerChange = `(...__p2ServerArgs)=>{let __p2ServerId=__p2ServerArgs[0];typeof __p2ServerId===\`string\`&&__p2ServerId&&globalThis.electronBridge?.hermesChatLifecycle?.({phase:\"conversation_identity\",conversation_id:__p2ServerId,client_conversation_id:${conversationId},server_conversation_id:__p2ServerId}).catch(()=>{});return ${serverChange}?.(...__p2ServerArgs)}`;
      let patched = match.replace(`{let ${clockVar}=${clockFn}();return ${submitFn}(${scope},{`, `{globalThis.__codexP2ResultsSubmitted=(globalThis.__codexP2ResultsSubmitted??0)+1;globalThis.__codexP2LastResult={callId:${callId},result:${result},toolName:${toolName}};let ${clockVar}=${clockFn}();return ${submitFn}(${scope},{`);
      const submitStart = patched.indexOf(`return ${submitFn}(${scope},{`);
      if (submitStart < 0) throw new Error("generic local result submitter: submit call missing");
      const callbackAnchor = `onServerThreadIdChange:${serverChange}`;
      const callbackIndex = patched.indexOf(callbackAnchor, submitStart);
      if (callbackIndex < 0) throw new Error("generic local result submitter: downstream callback anchor missing");
      return patched.slice(0, callbackIndex) + `onServerThreadIdChange:${wrappedServerChange}` + patched.slice(callbackIndex + callbackAnchor.length);
    },
    "generic local result submitter",
  );
  out = replaceStructuralExactlyOnce(
    out,
    /function ([\w$]+)\(\{callId:([\w$]+),id:([\w$]+),result:([\w$]+),toolName:([\w$]+)\}\)\{return\{author:\{metadata:\{\},name:\5,role:`tool`\},channel:`commentary`,content:\{content_type:`code`,text:JSON\.stringify\(\{call_id:\2,result:\4,tool:\5\}\)\},create_time:Date\.now\(\)\/1e3,end_turn:null,id:\3,metadata:\{is_visually_hidden_from_conversation:!0\},recipient:`all`,status:`finished_successfully`,update_time:null,weight:1\}\}/,
    (match) => match.replace("metadata:{is_visually_hidden_from_conversation:!0}", "metadata:{is_visually_hidden_from_conversation:!0,codex_local_function_result:!0}") + `/*${RESULT_PAIR_MARKER}*/`,
    "mark hidden local function result",
  );
  out = replaceStructuralExactlyOnce(
    out,
    /function ([\w$]+)\(([\w$]+)\)\{let ([\w$]+)=([\w$]+)\(\2\.recipient\);if\(\3\?\.startsWith\(`functions\.`\)===!0\)\{let ([\w$]+)=\3\.slice\(10\);return\{completed:!1,pairKey:`dynamic:\$\{\5\}`,tool:\5\}\}return \3\?\.startsWith\(`local\.`\)===!0\?\{completed:\2\.status!==`in_progress`,pairKey:null,tool:\3\.slice\(6\)\}:null\}/,
    (_match, fn, message, recipient, stringNormalizer, tool) => `function ${fn}(${message}){let ${recipient}=${stringNormalizer}(${message}.recipient);if(${recipient}?.startsWith(\`functions.\`)===!0){let ${tool}=${recipient}.slice(10),r=[${SIG_NAMES.map((x) => `\`${x}\``).join(",")}].includes(${tool});r&&(globalThis.__codexP2Normalized=(globalThis.__codexP2Normalized??0)+1);return{completed:!1,pairKey:r?\`local-function:\${IL(${message})}\`:\`dynamic:\${${tool}}\`,sourceTool:r?${tool}:void 0,tool:r?\`handoff\`:${tool}}}return ${recipient}?.startsWith(\`local.\`)===!0?(()=>{let n=${recipient}.slice(6),r=[${SIG_NAMES.map((x) => `\`${x}\``).join(",")}].includes(n);return r&&(globalThis.__codexP2Normalized=(globalThis.__codexP2Normalized??0)+1),{completed:r?!1:${message}.status!==\`in_progress\`,pairKey:r?\`local-function:\${IL(${message})}\`:null,sourceTool:r?n:void 0,tool:r?\`handoff\`:n}})():null}`,
    "normalize advertised tool calls for native executor and pair by call id",
  );
  out = replaceStructuralExactlyOnce(
    out,
    /return ([\w$]+)\.author\.role===`assistant`&&([\w$]+)!=null&&([\w$]+)\.success\?\{completed:\2\.completed,item:\{arguments:\3\.data,callId:([\w$]+)\(\1\),completed:\2\.completed,namespace:null,tool:\2\.tool,type:`dynamic-tool-call`\},pairKey:\2\.pairKey\}/,
    (match, _message, normalized) => match.replace("namespace:null,tool:", `namespace:null,sourceTool:${normalized}.sourceTool,tool:`),
    "propagate sourceTool onto dynamic tool call item",
  );
  out = replaceStructuralExactlyOnce(
    out,
    /function ([\w$]+)\(([\w$]+),([\w$]+)\)\{let ([\w$]+)=([\w$]+)\(\5\(\2\.metadata\)\?\.invoked_resource\);if\(\2\.author\.role!==`tool`\|\|\4==null&&\2\.metadata\?\.chatgpt_sdk==null\)return null;let ([\w$]+)=\3\?\?([\w$]+)\(\2\),([\w$]+);/,
    (match, _fn, message, parsed, _invoked, _objectNormalizer, _payload, parser) => match.replace("{let", `{if(${message}.author.role===\`tool\`&&${message}.metadata?.codex_local_function_result===!0){let n=${parsed}??${parser}(${message});if(n!=null&&typeof n===\`object\`&&typeof n.call_id===\`string\`&&typeof n.tool===\`string\`)return{completed:!0,item:null,pairKey:\`local-function:\${n.call_id}\`,rawPayload:n.result,localFunctionResult:!0}}let`),
    "classify marked hidden local result",
  );
  out = replaceStructuralExactlyOnce(
    out,
    /function ([\w$]+)\(([\w$]+),([\w$]+),([\w$]+)\)\{let ([\w$]+)=\(\3\.pairKey==null\?null:([\w$]+)\(\2,\4\)\)\?\?\3\.item;return \5==null\?\4\?\.item\.type===`mcp-tool-call`\?\{[^{}]*\.\.\.\4,item:[^{}]*\{\.\.\.\4\.item,completed:!0\}:[\w$]+\(\{item:\4\.item,rawPayload:\3\.rawPayload,error:\3\.error,toolIcons:\3\.toolIcons\}\),sourceMessage:\2\}:null:\{item:\5,role:\2\.author\.role===`assistant`\?`assistant`:`tool`,sourceMessage:\2,turnId:([\w$]+)\(\2\)\?\?\4\?\.turnId\?\?null\}\}/,
    (match, fn, message, classified, previous, item, hostedCombiner, turnId) => {
      const fallback = match.slice(match.indexOf(`${previous}?.item.type===\`mcp-tool-call\``));
      const colon = fallback.lastIndexOf(":null:{item:");
      const tail = fallback.slice(colon);
      return `function ${fn}(${message},${classified},${previous}){let ${item}=(${classified}.pairKey==null?null:${hostedCombiner}(${message},${previous}))??${classified}.item;return ${item}==null?${classified}.localFunctionResult===!0&&${previous}?.item.type===\`dynamic-tool-call\`?(globalThis.__codexP2ResultAttached=(globalThis.__codexP2ResultAttached??0)+1,globalThis.__codexP2AttachedItem={tool:${previous}.item.sourceTool??${previous}.item.tool,callId:${previous}.item.callId,result:${classified}.rawPayload},{...${previous},item:{...${previous}.item,completed:!0,result:${classified}.rawPayload,tool:${previous}.item.sourceTool??${previous}.item.tool},sourceMessage:${message}}):${fallback.slice(0, colon)}${tail}`;
    },
    "attach marked result to dynamic tool call",
  );
  out = replaceStructuralExactlyOnce(
    out,
    /([\w$]+)=([\w$]+)=>\{\2!==([\w$]+)&&\(([\w$]+)\(([\w$]+),([\w$]+),\2\),([\w$]+)\(\5,\6\),\3=([\w$]+)\(\2\),([\w$]+)\.serverConversationId=\3,([\w$]+)\.onServerThreadIdChange\?\.?\(\3\)\)\}/,
    (_match, fn, arg, serverId, mapFn, scope, localId, fn2, canonicalFn, record, opts) =>
      `${fn}=${arg}=>{${arg}!==${serverId}&&(${mapFn}(${scope},${localId},${arg}),${fn2}(${scope},${localId}),${serverId}=${canonicalFn}(${arg}),typeof ${serverId}===\`string\`&&${serverId}&&globalThis.electronBridge?.hermesChatLifecycle?.({phase:"conversation_identity",conversation_id:${serverId},client_conversation_id:${localId},server_conversation_id:${serverId}}).catch(()=>{}),${record}.serverConversationId=${serverId},${opts}.onServerThreadIdChange?.(${serverId}))}`,
    "dispatch conversation identity on completion stream server thread id change",
  );
  return out;
}

function patchPrimary(source) {
  if (source.includes(PRIMARY_MARKER)) return source;
  let out = source;
  let detectorStructure = null;
  out = replaceStructuralExactlyOnce(
    out,
    /([\w$]+)=([\w$]+)\(([\w$]+),\(([\w$]+),\{get:([\w$]+)\}\)=>\{if\(!\5\(([\w$]+)\)\)return null;let ([\w$]+)=\5\(([\w$]+),\4\),([\w$]+)=\5\(([\w$]+),\4\);if\(\7==null\|\|\9==null\)return null;let ([\w$]+)=\9\[\7\]\?\.message,([\w$]+)=([\w$]+)\(\11\?\.recipient\);if\(\11\?\.author\.role!==`assistant`\|\|\11\.status===`in_progress`\|\|\12!==`functions\.handoff`&&\12!==`local\.handoff`\)return null;let ([\w$]+)=([\w$]+)\.safeParse\(([\w$]+)\(\11\)\);return \14\.success\?\{callId:([\w$]+)\(\11\),\.\.\.\14\.data\}:null\},\{isEqual:\(([\w$]+),([\w$]+)\)=>\18\?\.callId===\19\?\.callId&&\18\?\.prompt===\19\?\.prompt&&\18\?\.reason===\19\?\.reason\}\)/,
    (_match, detector, selector, store, key, get, _gate, node, currentNodeAtom, mapping, mappingAtom, message, recipient, recipientNormalizer, _parsed, _schema, argsParser, callId, left, right) => {
      detectorStructure = { mappingAtom, recipientNormalizer, argsParser };
      return `${detector}=${selector}(${store},(${key},{get:${get}})=>{let ${node}=${get}(${currentNodeAtom},${key}),${mapping}=${get}(${mappingAtom},${key});if(${node}==null||${mapping}==null)return null;let ${message}=${mapping}[${node}]?.message,${recipient}=${recipientNormalizer}(${message}?.recipient),__tool=${recipientPred(recipient)};__tool&&(globalThis.__codexP2Detected=(globalThis.__codexP2Detected??0)+1,globalThis.__codexP2LastRecipient=${recipient});/*${PRIMARY_MARKER}*/if(${message}?.author.role!==\`assistant\`||__tool==null)return null;let __args=${argsParser}(${message});return{callId:${callId}(${message}),__p2tool:__tool,__p2args:__args}},{isEqual:(${left},${right})=>${left}?.callId===${right}?.callId})`;
    },
    "multi-tool detector for advertised tools",
  );
  out = replaceBalancedFunctionExactlyOnce(
    out,
    /async function ([\w$]+)\(([\w$]+),\{callId:([\w$]+),conversationId:([\w$]+),isTemporaryChat:([\w$]+),model:([\w$]+),thinkingEffort:([\w$]+)\}\)\{if\(!\(\2\.get\(([\w$]+),\{callId:\3,conversationId:\4\}\)!=null\|\|\2\.get\(([\w$]+),\3\)\)\)\{\2\.set\(([\w$]+),\3,\{pending:!0,decision:null,failedPublication:null\}\);try\{await ([\w$]+)\(\2,\{callId:\3,conversationId:\4/,
    (whole, fn, scope, callId, conversationId, temporary, model, effort, resultAtom, pendingAtom, stateAtom, submitter) => {
      const escapedScope = scope.replace(/[$]/g, "\\$");
      const escapedStateAtom = stateAtom.replace(/[$]/g, "\\$");
      const escapedCallId = callId.replace(/[$]/g, "\\$");
      const responseFn = whole.match(new RegExp(`message:([\\w$]+)\\(${escapedScope}\\)\\.rejectedResponse`))?.[1];
      const toolName = whole.match(/toolName:([\w$]+)\}\)/)?.[1];
      const action = whole.match(new RegExp(`\\),([\\w$]+)\\(${escapedScope}\\)\\}catch`))?.[1];
      const caught = whole.match(/catch\(([\w$]+)\)/)?.[1];
      const logger = whole.match(/catch\([\w$]+\)\{([\w$]+)\.error/)?.[1];
      const state = whole.match(new RegExp(`\\.set\\(${escapedStateAtom},${escapedCallId},([\\w$]+)=>`))?.[1];
      if (![responseFn, toolName, action, caught, logger, state].every(Boolean)) throw new Error(`generic executor dispatches via lifecycle IPC: incomplete structural captures ${JSON.stringify({ responseFn, toolName, action, caught, logger, state })}`);
      return `async function ${fn}(${scope},{callId:${callId},conversationId:${conversationId},isTemporaryChat:${temporary},model:${model},thinkingEffort:${effort}}){if(!(${scope}.get(${resultAtom},{callId:${callId},conversationId:${conversationId}})!=null||${scope}.get(${pendingAtom},${callId}))){${scope}.set(${stateAtom},${callId},{pending:!0,decision:null,failedPublication:null});try{let __p2Msg=${scope}.get(${detectorStructure.mappingAtom},${conversationId})?.[${callId}]?.message,__p2Rec=${detectorStructure.recipientNormalizer}(__p2Msg?.recipient),__p2Tool=${recipientPred("__p2Rec")},__p2Args=${detectorStructure.argsParser}(__p2Msg);globalThis.__codexP2ExecCalls=(globalThis.__codexP2ExecCalls??[]).concat([{callId:${callId},tool:__p2Tool,args:__p2Args}]);/*${EXEC_MARKER}*/let __p2Text;try{let __p2Bridge=globalThis.electronBridge?.hermesChatLifecycle,__p2Json=null;if(typeof __p2Bridge===\"function\"){__p2Json=await __p2Bridge({phase:\"tool_call\",name:__p2Tool,arguments:__p2Args,callId:${callId},conversationId:${conversationId},session_id:${conversationId},client_conversation_id:${conversationId}});globalThis.__codexP2Dispatch=\"ipc\"}else{let __p2Resp=await fetch(\"${ENDPOINT}\",{method:\"POST\",headers:{\"content-type\":\"application/json\"},body:JSON.stringify({name:__p2Tool,arguments:__p2Args})});__p2Json=await __p2Resp.json();globalThis.__codexP2Dispatch=\"http-fallback\"}globalThis.__codexP2EndpointResp=(globalThis.__codexP2EndpointResp??[]).concat([{tool:__p2Tool,resp:__p2Json}]);__p2Text=__p2Json&&__p2Json.ok?JSON.stringify(__p2Json.result):\"P2-TOOL-ERROR: \"+JSON.stringify(__p2Json)}catch(__p2Err){__p2Text=\"P2-DISPATCH-ERROR: \"+String(__p2Err&&__p2Err.message);globalThis.__codexP2FetchError=String(__p2Err)}await ${submitter}(${scope},{callId:${callId},conversationId:${conversationId},...${temporary}?{isTemporaryChat:!0}:{},result:{accepted:!0,thread_id:\`p2ok-\${${callId}}\`,message:__p2Text},model:${model},thinkingEffort:${effort},toolName:${toolName}}),${action}(${scope},${acceptedActionEnumFromSource(out)}.CODEX_CHATGPT_HANDOFF_LIFECYCLE_ACTION_ACCEPTED)}catch(${caught}){${logger}.error(\`Failed to reject ChatGPT Codex suggestion\`,{safe:{},sensitive:{error:${caught}}})}finally{${scope}.set(${stateAtom},${callId},${state}=>({...${state},pending:!1}))}}}`;
    },
    "generic executor dispatches via lifecycle IPC",
  );
  return out;
}

function acceptedActionEnumFromSource(source) {
  const match = source.match(/function [\w$]+\([\w$]+\)\{([\w$]+)\([\w$]+,([\w$]+)\.CODEX_CHATGPT_HANDOFF_LIFECYCLE_ACTION_REJECTED\)\}/);
  if (!match) throw new Error("accepted action enum: expected exactly one structural anchor, found 0");
  return match[2];
}

function upgradeLegacyViewerPresentation(source) {
  const upgraded = "if(f.tool===`handoff`&&!f.sourceTool){globalThis.__codexP2ViewerRouted";
  if (source.includes(upgraded)) return source;
  const legacy = "if(f.tool===`handoff`){globalThis.__codexP2ViewerRouted";
  if (!source.includes(VIEWER_MARKER)) return source;
  const count = source.split(legacy).length - 1;
  if (count !== 1) {
    throw new Error(`upgrade local-tool viewer presentation: expected exactly one legacy handoff viewer anchor, found ${count}`);
  }
  return source.replace(legacy, upgraded);
}

function patchViewer(source) {
  if (source.includes(VIEWER_MARKER)) return upgradeLegacyViewerPresentation(source);
  return replaceExactlyOnce(
    source,
    "if(f.type===`dynamic-tool-call`){if(f.tool===`handoff`){",
    `if(f.type===\`dynamic-tool-call\`){globalThis.__codexP2LmSeen=(globalThis.__codexP2LmSeen??0)+1;if(f.sourceTool||f.tool===\`handoff\`)globalThis.__codexP2LmItem={tool:f.tool,sourceTool:f.sourceTool,completed:f.completed};if(f.tool===\`handoff\`&&!f.sourceTool){globalThis.__codexP2ViewerRouted=(globalThis.__codexP2ViewerRouted??0)+1;/*${VIEWER_MARKER}*/`,
    "route local tools through generic dynamic-tool viewer while preserving native handoff execution state"
  );
}

const PHASE1_ONLY = process.env.PHASE1_ONLY || ""; // "initial" | "primary" | "viewer" | ""
const _want = (name) => !PHASE1_ONLY || PHASE1_ONLY === name;

module.exports = {
  descriptors: [
    _want("initial") && {
      id: "p2-tool-initial",
      phase: "webview-asset",
      order: 99_900,
      ciPolicy: "required-upstream",
      pattern: INITIAL_PATTERN,
      missingDescription: "app-initial bundle for P2 multi-tool probe",
      apply: patchInitial,
    },
    _want("primary") && {
      id: "p2-tool-primary",
      phase: "webview-asset",
      order: 99_910,
      ciPolicy: "required-upstream",
      pattern: PRIMARY_PATTERN,
      missingDescription: "app-primary bundle for P2 multi-tool probe",
      apply: patchPrimary,
    },
    _want("viewer") && {
      id: "p2-tool-viewer",
      phase: "webview-asset",
      order: 99_920,
      ciPolicy: "required-upstream",
      pattern: VIEWER_PATTERN,
      missingDescription: "viewer bundle for P2 multi-tool probe",
      apply: patchViewer,
    },
    {
      id: "p2-tool-csp",
      phase: "extracted-app:post-webview",
      order: 99_940,
      ciPolicy: "required-upstream",
      apply: (extractedDir) => {
        const indexPath = path.join(extractedDir, "webview", "index.html");
        if (!fs.existsSync(indexPath)) return { matched: false, reason: "index.html missing" };
        const html = fs.readFileSync(indexPath, "utf8");
        if (html.includes("connect-src &#39;self&#39; http://127.0.0.1:*")) return { matched: true, changed: 0 };
        const anchor = "connect-src &#39;self&#39; ";
        if (!html.includes(anchor)) return { matched: false, reason: "connect-src anchor missing" };
        fs.writeFileSync(indexPath, html.replace(anchor, "connect-src &#39;self&#39; http://127.0.0.1:* "), "utf8");
        return { matched: true, changed: 1 };
      },
      status: (result) =>
        result?.matched === false
          ? { status: "skipped-optional", reason: result.reason ?? "connect-src anchor missing" }
          : (result?.changed ?? 0) > 0
            ? "applied"
            : "already-applied",
    },
  ].filter(Boolean),
  patchInitial,
  patchPrimary,
  patchViewer,
};
