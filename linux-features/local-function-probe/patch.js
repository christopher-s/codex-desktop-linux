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

function patchInitial(source) {
  if (source.includes(INITIAL_MARKER)) return source;
  let out = source;
  // Advertise the whole tool table instead of the built-in handoff.
  const oldSignature =
    "function tWr({config:e,isEverydayWorkMode:t,isTemporaryChat:n}){if(n)return[];let r=t?`Work mode`:`Codex`;return[{description:qUr(e.toolDescription,r),name:nWr,params:[{name:`prompt`,required:!0,type:{description:qUr(e.toolPromptParamDescription,r),type:`string`}},{name:`reason`,required:!0,type:{description:qUr(e.toolReasonParamDescription,r),type:`string`}}],type:`kwargs`}]}";
  const newSignature = `function tWr({config:e,isEverydayWorkMode:t,isTemporaryChat:n}){if(n)return[];globalThis.__codexP2SignatureBuilds=(globalThis.__codexP2SignatureBuilds??0)+1;/*${INITIAL_MARKER}*/return ${signaturesSrc()}}`;
  out = replaceExactlyOnce(out, oldSignature, newSignature, "replace local signature with tool table");
  // Allow local_function_signatures through both request gates.
  out = replaceExactlyOnce(
    out,
    "local_function_signatures:y||!r?void 0:tWr({config:l,isEverydayWorkMode:v,isTemporaryChat:g})",
    "local_function_signatures:y?void 0:tWr({config:l,isEverydayWorkMode:v,isTemporaryChat:g})",
    "real request local-function gate"
  );
  out = replaceExactlyOnce(
    out,
    "local_function_signatures:C||!r?void 0:tWr({config:GUr(e,T),isEverydayWorkMode:u,isTemporaryChat:c})",
    "local_function_signatures:C?void 0:tWr({config:GUr(e,T),isEverydayWorkMode:u,isTemporaryChat:c})",
    "prepare request local-function gate"
  );
  // Instrument the generic result submitter.
  out = replaceExactlyOnce(
    out,
    "async function Ygi(e,{callId:t,conversationId:n,isTemporaryChat:r,model:i,onServerThreadIdChange:a,result:o,thinkingEffort:s,toolName:c}){let l=dL();return Xgi(e,{",
    "async function Ygi(e,{callId:t,conversationId:n,isTemporaryChat:r,model:i,onServerThreadIdChange:a,result:o,thinkingEffort:s,toolName:c}){globalThis.__codexP2ResultsSubmitted=(globalThis.__codexP2ResultsSubmitted??0)+1;globalThis.__codexP2LastResult={callId:t,result:o,toolName:c};let l=dL();return Xgi(e,{",
    "generic local result submitter"
  );
  // Mark the hidden tool-role result so the classifier can pair it.
  out = replaceExactlyOnce(
    out,
    "function r_i({callId:e,id:t,result:n,toolName:r}){return{author:{metadata:{},name:r,role:`tool`},channel:`commentary`,content:{content_type:`code`,text:JSON.stringify({call_id:e,result:n,tool:r})},create_time:Date.now()/1e3,end_turn:null,id:t,metadata:{is_visually_hidden_from_conversation:!0},recipient:`all`,status:`finished_successfully`,update_time:null,weight:1}}",
    `function r_i({callId:e,id:t,result:n,toolName:r}){return{author:{metadata:{},name:r,role:\`tool\`},channel:\`commentary\`,content:{content_type:\`code\`,text:JSON.stringify({call_id:e,result:n,tool:r})},create_time:Date.now()/1e3,end_turn:null,id:t,metadata:{is_visually_hidden_from_conversation:!0,codex_local_function_result:!0},recipient:\`all\`,status:\`finished_successfully\`,update_time:null,weight:1}}/*${RESULT_PAIR_MARKER}*/`,
    "mark hidden local function result"
  );
  // Normalize ANY advertised tool call to a handoff-shaped item so the native
  // executor mounts, paired by call id; keep the bare tool name in sourceTool.
  out = replaceExactlyOnce(
    out,
    "function uGr(e){let t=PL(e.recipient);if(t?.startsWith(`functions.`)===!0){let e=t.slice(10);return{completed:!1,pairKey:`dynamic:${e}`,tool:e}}return t?.startsWith(`local.`)===!0?{completed:e.status!==`in_progress`,pairKey:null,tool:t.slice(6)}:null}",
    `function uGr(e){let t=PL(e.recipient);if(t?.startsWith(\`functions.\`)===!0){let n=t.slice(10),r=[${SIG_NAMES.map((x) => `\`${x}\``).join(",")}].includes(n);r&&(globalThis.__codexP2Normalized=(globalThis.__codexP2Normalized??0)+1);return{completed:!1,pairKey:r?\`local-function:\${jL(e)}\`:\`dynamic:\${n}\`,sourceTool:r?n:void 0,tool:r?\`handoff\`:n}}return t?.startsWith(\`local.\`)===!0?(()=>{let n=t.slice(6),r=[${SIG_NAMES.map((x) => `\`${x}\``).join(",")}].includes(n);return r&&(globalThis.__codexP2Normalized=(globalThis.__codexP2Normalized??0)+1),{completed:r?!1:e.status!==\`in_progress\`,pairKey:r?\`local-function:\${jL(e)}\`:null,sourceTool:r?n:void 0,tool:r?\`handoff\`:n}})():null}`,
    "normalize advertised tool calls for native executor and pair by call id"
  );
  out = replaceExactlyOnce(
    out,
    "return e.author.role===`assistant`&&u!=null&&d.success?{completed:u.completed,item:{arguments:d.data,callId:jL(e),completed:u.completed,namespace:null,tool:u.tool,type:`dynamic-tool-call`},pairKey:u.pairKey}",
    "return e.author.role===`assistant`&&u!=null&&d.success?{completed:u.completed,item:{arguments:d.data,callId:jL(e),completed:u.completed,namespace:null,sourceTool:u.sourceTool,tool:u.tool,type:`dynamic-tool-call`},pairKey:u.pairKey}",
    "propagate sourceTool onto dynamic tool call item"
  );
  // Classify the marked hidden result and attach it back to the call item.
  out = replaceExactlyOnce(
    out,
    "function rGr(e,t){let n=NL(NL(e.metadata)?.invoked_resource);if(e.author.role!==`tool`||n==null&&e.metadata?.chatgpt_sdk==null)return null;let r=t??AL(e),i;",
    "function rGr(e,t){if(e.author.role===`tool`&&e.metadata?.codex_local_function_result===!0){let n=t??AL(e);if(n!=null&&typeof n===`object`&&typeof n.call_id===`string`&&typeof n.tool===`string`)return{completed:!0,item:null,pairKey:`local-function:${n.call_id}`,rawPayload:n.result,localFunctionResult:!0}}let n=NL(NL(e.metadata)?.invoked_resource);if(e.author.role!==`tool`||n==null&&e.metadata?.chatgpt_sdk==null)return null;let r=t??AL(e),i;",
    "classify marked hidden local result"
  );
  out = replaceExactlyOnce(
    out,
    "function eGr(e,t,n){let r=(t.pairKey==null?null:KWr(e,n))??t.item;return r==null?n?.item.type===`mcp-tool-call`?{...n,item:t.rawPayload===void 0&&t.error==null?{...n.item,completed:!0}:iGr({item:n.item,rawPayload:t.rawPayload,error:t.error,toolIcons:t.toolIcons}),sourceMessage:e}:null:{item:r,role:e.author.role===`assistant`?`assistant`:`tool`,sourceMessage:e,turnId:kL(e)??n?.turnId??null}}",
    "function eGr(e,t,n){let r=(t.pairKey==null?null:KWr(e,n))??t.item;return r==null?t.localFunctionResult===!0&&n?.item.type===`dynamic-tool-call`?(globalThis.__codexP2ResultAttached=(globalThis.__codexP2ResultAttached??0)+1,globalThis.__codexP2AttachedItem={tool:n.item.sourceTool??n.item.tool,callId:n.item.callId,result:t.rawPayload},{...n,item:{...n.item,completed:!0,result:t.rawPayload,tool:n.item.sourceTool??n.item.tool},sourceMessage:e}):n?.item.type===`mcp-tool-call`?{...n,item:t.rawPayload===void 0&&t.error==null?{...n.item,completed:!0}:iGr({item:n.item,rawPayload:t.rawPayload,error:t.error,toolIcons:t.toolIcons}),sourceMessage:e}:null:{item:r,role:e.author.role===`assistant`?`assistant`:`tool`,sourceMessage:e,turnId:kL(e)??n?.turnId??null}}",
    "attach marked result to dynamic tool call"
  );
  return out;
}

function patchPrimary(source) {
  if (source.includes(PRIMARY_MARKER)) return source;
  let out = source;
  // Detector: accept ANY advertised tool (functions./local.); recover the bare
  // name and pass the RAW args object through (the executor validates/dispatch
  // is generic — we no longer pin a single zod schema). isEqual keys on callId.
  out = replaceExactlyOnce(
    out,
    "I0t=$n(yi,(e,{get:t})=>{if(!t(ly))return null;let n=t(b_,e),r=t(hv,e);if(n==null||r==null)return null;let i=r[n]?.message,a=Ov(i?.recipient);if(i?.author.role!==`assistant`||i.status===`in_progress`||a!==`functions.handoff`&&a!==`local.handoff`)return null;let o=N0t.safeParse(wVe(i));return o.success?{callId:Jae(i),...o.data}:null},{isEqual:(e,t)=>e?.callId===t?.callId&&e?.prompt===t?.prompt&&e?.reason===t?.reason})",
    `I0t=$n(yi,(e,{get:t})=>{let n=t(b_,e),r=t(hv,e);if(n==null||r==null)return null;let i=r[n]?.message,a=Ov(i?.recipient),__tool=${recipientPred("a")};__tool&&(globalThis.__codexP2Detected=(globalThis.__codexP2Detected??0)+1,globalThis.__codexP2LastRecipient=a);/*${PRIMARY_MARKER}*/if(i?.author.role!==\`assistant\`||__tool==null)return null;let __args=wVe(i);return{callId:Jae(i),__p2tool:__tool,__p2args:__args}},{isEqual:(e,t)=>e?.callId===t?.callId})`,
    "multi-tool detector for advertised tools"
  );
  // Executor: read the raw args + bare tool name from the message recipient,
  // then dispatch through the Hermes lifecycle host IPC (tool_call phase) so the
  // call executes against the SAME Hermes runtime/session the lifecycle feature
  // maintains — no HTTP endpoint, no bridge, no second process. Falls back to
  // the loopback endpoint only if the lifecycle bridge is unavailable.
  const oldExec =
    "async function D0t(e,{callId:t,conversationId:n,isTemporaryChat:r,model:i,thinkingEffort:a}){if(!(e.get(EU,{callId:t,conversationId:n})!=null||e.get(R0t,t))){e.set(DU,t,{pending:!0,decision:null,failedPublication:null});try{await yme(e,{callId:t,conversationId:n,...r?{isTemporaryChat:!0}:{},result:{accepted:!1,message:lwe(e).rejectedResponse},model:i,thinkingEffort:a,toolName:hke}),O0t(e)}catch(e){mp.error(`Failed to reject ChatGPT Codex suggestion`,{safe:{},sensitive:{error:e}})}finally{e.set(DU,t,e=>({...e,pending:!1}))}}}";
  const newExec =
    "async function D0t(e,{callId:t,conversationId:n,isTemporaryChat:r,model:i,thinkingEffort:a}){if(!(e.get(EU,{callId:t,conversationId:n})!=null||e.get(R0t,t))){e.set(DU,t,{pending:!0,decision:null,failedPublication:null});try{" +
    "let __p2Msg=e.get(hv,n)?.[t]?.message,__p2Rec=Ov(__p2Msg?.recipient),__p2Tool=" + recipientPred("__p2Rec") + ",__p2Args=wVe(__p2Msg);" +
    "globalThis.__codexP2ExecCalls=(globalThis.__codexP2ExecCalls??[]).concat([{callId:t,tool:__p2Tool,args:__p2Args}]);/*" + EXEC_MARKER + "*/" +
    "let __p2Text;" +
    "try{" +
      "let __p2Bridge=globalThis.electronBridge?.hermesChatLifecycle,__p2Json=null;" +
      "if(typeof __p2Bridge===\"function\"){" +
        "__p2Json=await __p2Bridge({phase:\"tool_call\",name:__p2Tool,arguments:__p2Args,callId:t,conversationId:n,session_id:n,client_conversation_id:n});" +
        "globalThis.__codexP2Dispatch=\"ipc\";" +
      "}else{" +
        "let __p2Resp=await fetch(\"" + ENDPOINT + "\",{method:\"POST\",headers:{\"content-type\":\"application/json\"},body:JSON.stringify({name:__p2Tool,arguments:__p2Args})});" +
        "__p2Json=await __p2Resp.json();globalThis.__codexP2Dispatch=\"http-fallback\";" +
      "}" +
      "globalThis.__codexP2EndpointResp=(globalThis.__codexP2EndpointResp??[]).concat([{tool:__p2Tool,resp:__p2Json}]);" +
      "__p2Text=__p2Json&&__p2Json.ok?JSON.stringify(__p2Json.result):\"P2-TOOL-ERROR: \"+JSON.stringify(__p2Json)" +
    "}catch(__p2Err){__p2Text=\"P2-DISPATCH-ERROR: \"+String(__p2Err&&__p2Err.message);globalThis.__codexP2FetchError=String(__p2Err)}" +
    "await yme(e,{callId:t,conversationId:n,...r?{isTemporaryChat:!0}:{},result:{accepted:!1,message:__p2Text},model:i,thinkingEffort:a,toolName:hke}),O0t(e)" +
    "}catch(e){mp.error(`Failed to reject ChatGPT Codex suggestion`,{safe:{},sensitive:{error:e}})}finally{e.set(DU,t,e=>({...e,pending:!1}))}}}";
  out = replaceExactlyOnce(out, oldExec, newExec, "generic executor dispatches via lifecycle IPC");
  return out;
}

function patchViewer(source) {
  if (source.includes(VIEWER_MARKER)) return source;
  return replaceExactlyOnce(
    source,
    "if(f.type===`dynamic-tool-call`){if(f.tool===`handoff`){",
    `if(f.type===\`dynamic-tool-call\`){globalThis.__codexP2LmSeen=(globalThis.__codexP2LmSeen??0)+1;if(f.sourceTool||f.tool===\`handoff\`)globalThis.__codexP2LmItem={tool:f.tool,sourceTool:f.sourceTool,completed:f.completed};if(f.tool===\`handoff\`){globalThis.__codexP2ViewerRouted=(globalThis.__codexP2ViewerRouted??0)+1;/*${VIEWER_MARKER}*/`,
    "route advertised tool calls through native executor"
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
