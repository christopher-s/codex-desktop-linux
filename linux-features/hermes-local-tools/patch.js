"use strict";

// Phase 1: advertise ONE deterministic Hermes tool (read_file) through the
// client-local function protocol and execute it locally via a loopback HTTP
// endpoint, replacing the fixed QA echo marker with a real tool round trip.
// Disposable QA harness — lives under /tmp, not production feature code.

const fs = require("fs");
const path = require("path");

const INITIAL_PATTERN = /^app-initial-[^.]+\.js$/;
const PRIMARY_PATTERN = /^app-primary-[^.]+\.js$/;
const VIEWER_PATTERN = /^viewer-[^.]+\.js$/;
const CHIP_PATTERN = /^subagent-activity-chip-group-[0-9a-f]+\.js$/;
const INITIAL_MARKER = "codexPhase1ToolSignatureRuntime";
const PRIMARY_MARKER = "codexPhase1ToolDetectorRuntime";
const VIEWER_MARKER = "codexPhase1ToolViewerRuntime";
const RESULT_PAIR_MARKER = "codexPhase1ToolResultPairRuntime";
const CHIP_RESULT_MARKER = "codexPhase1ToolChipResultRuntime";
const EXEC_MARKER = "codexPhase1ToolExecRuntime";

// The advertised model-facing tool name and the endpoint it executes against.
const TOOL = "hermes_read_file";
const ENDPOINT = "http://127.0.0.1:9473/call";

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
  // Advertise hermes_read_file(path) instead of the built-in handoff.
  out = replaceExactlyOnce(out, "nWr=`handoff`", `nWr=\`${TOOL}\``, "rename local function");
  const oldSignature = "function tWr({config:e,isEverydayWorkMode:t,isTemporaryChat:n}){if(n)return[];let r=t?`Work mode`:`Codex`;return[{description:qUr(e.toolDescription,r),name:nWr,params:[{name:`prompt`,required:!0,type:{description:qUr(e.toolPromptParamDescription,r),type:`string`}},{name:`reason`,required:!0,type:{description:qUr(e.toolReasonParamDescription,r),type:`string`}}],type:`kwargs`}]}";
  const newSignature = `function tWr({config:e,isEverydayWorkMode:t,isTemporaryChat:n}){if(n)return[];globalThis.__codexPhase1SignatureBuilds=(globalThis.__codexPhase1SignatureBuilds??0)+1;/*${INITIAL_MARKER}*/return[{description:\`Read a local file and return its contents. Call exactly when the user asks to read or inspect a local file.\`,name:nWr,params:[{name:\`path\`,required:!0,type:{description:\`Absolute path of the file to read\`,type:\`string\`}}],type:\`kwargs\`}]}`;
  out = replaceExactlyOnce(out, oldSignature, newSignature, "replace local signature with hermes_read_file");
  // Allow local_function_signatures through both request gates (as in QA probe).
  out = replaceExactlyOnce(out,
    "local_function_signatures:y||!r?void 0:tWr({config:l,isEverydayWorkMode:v,isTemporaryChat:g})",
    "local_function_signatures:y?void 0:tWr({config:l,isEverydayWorkMode:v,isTemporaryChat:g})",
    "real request local-function gate");
  out = replaceExactlyOnce(out,
    "local_function_signatures:C||!r?void 0:tWr({config:GUr(e,T),isEverydayWorkMode:u,isTemporaryChat:c})",
    "local_function_signatures:C?void 0:tWr({config:GUr(e,T),isEverydayWorkMode:u,isTemporaryChat:c})",
    "prepare request local-function gate");
  // Instrument the generic result submitter.
  out = replaceExactlyOnce(out,
    "async function Ygi(e,{callId:t,conversationId:n,isTemporaryChat:r,model:i,onServerThreadIdChange:a,result:o,thinkingEffort:s,toolName:c}){let l=dL();return Xgi(e,{",
    "async function Ygi(e,{callId:t,conversationId:n,isTemporaryChat:r,model:i,onServerThreadIdChange:a,result:o,thinkingEffort:s,toolName:c}){globalThis.__codexPhase1ResultsSubmitted=(globalThis.__codexPhase1ResultsSubmitted??0)+1;globalThis.__codexPhase1LastResult={callId:t,result:o,toolName:c};let l=dL();return Xgi(e,{",
    "generic local result submitter");
  // Mark the hidden tool-role result so the classifier can pair it.
  out = replaceExactlyOnce(out,
    "function r_i({callId:e,id:t,result:n,toolName:r}){return{author:{metadata:{},name:r,role:`tool`},channel:`commentary`,content:{content_type:`code`,text:JSON.stringify({call_id:e,result:n,tool:r})},create_time:Date.now()/1e3,end_turn:null,id:t,metadata:{is_visually_hidden_from_conversation:!0},recipient:`all`,status:`finished_successfully`,update_time:null,weight:1}}",
    `function r_i({callId:e,id:t,result:n,toolName:r}){return{author:{metadata:{},name:r,role:\`tool\`},channel:\`commentary\`,content:{content_type:\`code\`,text:JSON.stringify({call_id:e,result:n,tool:r})},create_time:Date.now()/1e3,end_turn:null,id:t,metadata:{is_visually_hidden_from_conversation:!0,codex_local_function_result:!0},recipient:\`all\`,status:\`finished_successfully\`,update_time:null,weight:1}}/*${RESULT_PAIR_MARKER}*/`,
    "mark hidden local function result");
  // Normalize the emitted hermes_read_file call to a handoff-shaped item so the
  // native executor mounts, paired by call id.
  out = replaceExactlyOnce(out,
    "function uGr(e){let t=PL(e.recipient);if(t?.startsWith(`functions.`)===!0){let e=t.slice(10);return{completed:!1,pairKey:`dynamic:${e}`,tool:e}}return t?.startsWith(`local.`)===!0?{completed:e.status!==`in_progress`,pairKey:null,tool:t.slice(6)}:null}",
    `function uGr(e){let t=PL(e.recipient);if(t?.startsWith(\`functions.\`)===!0){let n=t.slice(10),r=n===\`${TOOL}\`?\`handoff\`:n;n===\`${TOOL}\`&&(globalThis.__codexPhase1Normalized=(globalThis.__codexPhase1Normalized??0)+1);return{completed:!1,pairKey:n===\`${TOOL}\`?\`local-function:\${jL(e)}\`:\`dynamic:\${n}\`,sourceTool:n,tool:r}}return t?.startsWith(\`local.\`)===!0?(t.slice(6)===\`${TOOL}\`&&(globalThis.__codexPhase1Normalized=(globalThis.__codexPhase1Normalized??0)+1),{completed:t.slice(6)===\`${TOOL}\`?!1:e.status!==\`in_progress\`,pairKey:t.slice(6)===\`${TOOL}\`?\`local-function:\${jL(e)}\`:null,sourceTool:t.slice(6),tool:t.slice(6)===\`${TOOL}\`?\`handoff\`:t.slice(6)}):null}`,
    "normalize hermes_read_file call for native executor and pair by call id");
  out = replaceExactlyOnce(out,
    "return e.author.role===`assistant`&&u!=null&&d.success?{completed:u.completed,item:{arguments:d.data,callId:jL(e),completed:u.completed,namespace:null,tool:u.tool,type:`dynamic-tool-call`},pairKey:u.pairKey}",
    "return e.author.role===`assistant`&&u!=null&&d.success?{completed:u.completed,item:{arguments:d.data,callId:jL(e),completed:u.completed,namespace:null,sourceTool:u.sourceTool,tool:u.tool,type:`dynamic-tool-call`},pairKey:u.pairKey}",
    "propagate sourceTool onto dynamic tool call item");
  // Classify the marked hidden result and attach it back to the call item.
  out = replaceExactlyOnce(out,
    "function rGr(e,t){let n=NL(NL(e.metadata)?.invoked_resource);if(e.author.role!==`tool`||n==null&&e.metadata?.chatgpt_sdk==null)return null;let r=t??AL(e),i;",
    "function rGr(e,t){if(e.author.role===`tool`&&e.metadata?.codex_local_function_result===!0){let n=t??AL(e);if(n!=null&&typeof n===`object`&&typeof n.call_id===`string`&&typeof n.tool===`string`)return{completed:!0,item:null,pairKey:`local-function:${n.call_id}`,rawPayload:n.result,localFunctionResult:!0}}let n=NL(NL(e.metadata)?.invoked_resource);if(e.author.role!==`tool`||n==null&&e.metadata?.chatgpt_sdk==null)return null;let r=t??AL(e),i;",
    "classify marked hidden local result");
  out = replaceExactlyOnce(out,
    "function eGr(e,t,n){let r=(t.pairKey==null?null:KWr(e,n))??t.item;return r==null?n?.item.type===`mcp-tool-call`?{...n,item:t.rawPayload===void 0&&t.error==null?{...n.item,completed:!0}:iGr({item:n.item,rawPayload:t.rawPayload,error:t.error,toolIcons:t.toolIcons}),sourceMessage:e}:null:{item:r,role:e.author.role===`assistant`?`assistant`:`tool`,sourceMessage:e,turnId:kL(e)??n?.turnId??null}}",
    "function eGr(e,t,n){let r=(t.pairKey==null?null:KWr(e,n))??t.item;return r==null?t.localFunctionResult===!0&&n?.item.type===`dynamic-tool-call`?(globalThis.__codexPhase1ResultAttached=(globalThis.__codexPhase1ResultAttached??0)+1,globalThis.__codexPhase1AttachedItem={tool:n.item.sourceTool??n.item.tool,callId:n.item.callId,result:t.rawPayload},{...n,item:{...n.item,completed:!0,result:t.rawPayload,tool:n.item.sourceTool??n.item.tool},sourceMessage:e}):n?.item.type===`mcp-tool-call`?{...n,item:t.rawPayload===void 0&&t.error==null?{...n.item,completed:!0}:iGr({item:n.item,rawPayload:t.rawPayload,error:t.error,toolIcons:t.toolIcons}),sourceMessage:e}:null:{item:r,role:e.author.role===`assistant`?`assistant`:`tool`,sourceMessage:e,turnId:kL(e)??n?.turnId??null}}",
    "attach marked result to dynamic tool call");
  return out;
}

function patchPrimary(source) {
  if (source.includes(PRIMARY_MARKER)) return source;
  let out = source;
  // Detector: accept functions./local. hermes_read_file, drop the ly gate and
  // in_progress exclusion. Parse `path` instead of prompt/reason.
  out = replaceExactlyOnce(out,
    "I0t=$n(yi,(e,{get:t})=>{if(!t(ly))return null;let n=t(b_,e),r=t(hv,e);if(n==null||r==null)return null;let i=r[n]?.message,a=Ov(i?.recipient);if(i?.author.role!==`assistant`||i.status===`in_progress`||a!==`functions.handoff`&&a!==`local.handoff`)return null;let o=N0t.safeParse(wVe(i));return o.success?{callId:Jae(i),...o.data}:null},{isEqual:(e,t)=>e?.callId===t?.callId&&e?.prompt===t?.prompt&&e?.reason===t?.reason})",
    `I0t=$n(yi,(e,{get:t})=>{let n=t(b_,e),r=t(hv,e);if(n==null||r==null)return null;let i=r[n]?.message,a=Ov(i?.recipient);(a===\`functions.${TOOL}\`||a===\`local.${TOOL}\`)&&(globalThis.__codexPhase1Detected=(globalThis.__codexPhase1Detected??0)+1,globalThis.__codexPhase1LastRecipient=a);/*${PRIMARY_MARKER}*/if(i?.author.role!==\`assistant\`||a!==\`functions.${TOOL}\`&&a!==\`local.${TOOL}\`)return null;let o=N0t.safeParse(wVe(i));return o.success?{callId:Jae(i),...o.data}:null},{isEqual:(e,t)=>e?.callId===t?.callId&&e?.path===t?.path})`,
    "local function detector for hermes_read_file");
  // Args schema: accept `path` (string) instead of {prompt, reason}.
  out = replaceExactlyOnce(out,
    "N0t=Xg({prompt:kl().trim().min(1),reason:kl().trim().min(1)})",
    "N0t=Xg({path:kl().trim().min(1)})",
    "args schema path");
  // Executor: parse `path` from the message and fetch the loopback tool
  // endpoint, submitting the real tool result instead of a fixed marker.
  const oldExec = "async function D0t(e,{callId:t,conversationId:n,isTemporaryChat:r,model:i,thinkingEffort:a}){if(!(e.get(EU,{callId:t,conversationId:n})!=null||e.get(R0t,t))){e.set(DU,t,{pending:!0,decision:null,failedPublication:null});try{await yme(e,{callId:t,conversationId:n,...r?{isTemporaryChat:!0}:{},result:{accepted:!1,message:lwe(e).rejectedResponse},model:i,thinkingEffort:a,toolName:hke}),O0t(e)}catch(e){mp.error(`Failed to reject ChatGPT Codex suggestion`,{safe:{},sensitive:{error:e}})}finally{e.set(DU,t,e=>({...e,pending:!1}))}}}";
  const newExec = `async function D0t(e,{callId:t,conversationId:n,isTemporaryChat:r,model:i,thinkingEffort:a}){if(!(e.get(EU,{callId:t,conversationId:n})!=null||e.get(R0t,t))){e.set(DU,t,{pending:!0,decision:null,failedPublication:null});try{let __p1Msg=e.get(hv,n)?.[t]?.message,__p1Args=N0t.safeParse(wVe(__p1Msg)),__p1Path=__p1Args.success?__p1Args.data.path:null;globalThis.__codexPhase1ExecArgs=(globalThis.__codexPhase1ExecArgs??[]).concat([{callId:t,path:__p1Path}]);/*${EXEC_MARKER}*/let __p1Text;try{let __p1Resp=await fetch("${ENDPOINT}",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"read_file",arguments:{path:__p1Path}})}),__p1Json=await __p1Resp.json();globalThis.__codexPhase1EndpointResp=__p1Json;__p1Text=__p1Json&&__p1Json.ok?JSON.stringify(__p1Json.result):"PHASE1-TOOL-ERROR: "+JSON.stringify(__p1Json)}catch(__p1Err){__p1Text="PHASE1-FETCH-ERROR: "+String(__p1Err&&__p1Err.message);globalThis.__codexPhase1FetchError=String(__p1Err)}await yme(e,{callId:t,conversationId:n,...r?{isTemporaryChat:!0}:{},result:{accepted:!1,message:__p1Text},model:i,thinkingEffort:a,toolName:hke}),O0t(e)}catch(e){mp.error(\`Failed to reject ChatGPT Codex suggestion\`,{safe:{},sensitive:{error:e}})}finally{e.set(DU,t,e=>({...e,pending:!1}))}}}`;
  out = replaceExactlyOnce(out, oldExec, newExec, "executor fetches loopback tool endpoint");
  return out;
}

function patchViewer(source) {
  if (source.includes(VIEWER_MARKER)) return source;
  return replaceExactlyOnce(
    source,
    "if(f.type===`dynamic-tool-call`){if(f.tool===`handoff`){",
    `if(f.type===\`dynamic-tool-call\`){globalThis.__codexPhase1LmSeen=(globalThis.__codexPhase1LmSeen??0)+1;if(f.sourceTool===\`${TOOL}\`||f.tool===\`${TOOL}\`||f.tool===\`handoff\`)globalThis.__codexPhase1LmItem={tool:f.tool,sourceTool:f.sourceTool,completed:f.completed,hasResult:Object.prototype.hasOwnProperty.call(f,\`result\`)};if(f.tool===\`handoff\`||f.tool===\`${TOOL}\`&&f.completed===!1){globalThis.__codexPhase1ViewerRouted=(globalThis.__codexPhase1ViewerRouted??0)+1;/*${VIEWER_MARKER}*/`,
    "route incomplete hermes_read_file call through native executor",
  );
}

function patchChip(source) {
  if (source.includes(CHIP_RESULT_MARKER)) return source;
  return replaceExactlyOnce(
    source,
    "__cbtcWalk(r.arguments,null,0,`root`);",
    `globalThis.__codexPhase1ChipItem={tool:r.tool,completed:r.completed,result:r.result,arguments:r.arguments,keys:Object.keys(r)};let __cbtcPayload={arguments:r.arguments};Object.prototype.hasOwnProperty.call(r,\`result\`)&&(__cbtcPayload.result=r.result);__cbtcWalk(__cbtcPayload,null,0,\`root\`);/*${CHIP_RESULT_MARKER}*/`,
    "render arguments and exact tool result",
  );
}

// The webview CSP connect-src allows only 'self' + named https hosts, which
// blocks the executor's fetch to the loopback tool endpoint. Add loopback to
// connect-src in webview/index.html so the app:// origin can reach 127.0.0.1.
function patchCsp(extractedDir) {
  const indexPath = path.join(extractedDir, "webview", "index.html");
  if (!fs.existsSync(indexPath)) return { matched: false, reason: "index.html missing" };
  const html = fs.readFileSync(indexPath, "utf8");
  if (html.includes("connect-src &#39;self&#39; http://127.0.0.1:*")) {
    return { matched: true, changed: 0 };
  }
  const anchor = "connect-src &#39;self&#39; ";
  if (!html.includes(anchor)) return { matched: false, reason: "connect-src anchor missing" };
  const out = html.replace(anchor, "connect-src &#39;self&#39; http://127.0.0.1:* ");
  fs.writeFileSync(indexPath, out, "utf8");
  return { matched: true, changed: 1 };
}

const PHASE1_ONLY = process.env.PHASE1_ONLY || ""; // "initial" | "primary" | "viewer" | "chip" | ""
const _want = (name) => !PHASE1_ONLY || PHASE1_ONLY === name;

module.exports = {
  descriptors: [
    _want("initial") && {
      id: "phase1-tool-initial",
      phase: "webview-asset",
      order: 99_900,
      ciPolicy: "required-upstream",
      pattern: INITIAL_PATTERN,
      missingDescription: "app-initial bundle for Phase 1 tool",
      apply: patchInitial,
    },
    _want("primary") && {
      id: "phase1-tool-primary",
      phase: "webview-asset",
      order: 99_910,
      ciPolicy: "required-upstream",
      pattern: PRIMARY_PATTERN,
      missingDescription: "app-primary bundle for Phase 1 tool",
      apply: patchPrimary,
    },
    _want("viewer") && {
      id: "phase1-tool-viewer",
      phase: "webview-asset",
      order: 99_920,
      ciPolicy: "required-upstream",
      pattern: VIEWER_PATTERN,
      missingDescription: "viewer bundle for Phase 1 tool",
      apply: patchViewer,
    },
    _want("chip") && {
      id: "phase1-tool-chip-result",
      phase: "webview-asset",
      order: 99_930,
      ciPolicy: "required-upstream",
      pattern: CHIP_PATTERN,
      missingDescription: "patched generic disclosure chip for Phase 1 result",
      apply: patchChip,
    },
    {
      id: "phase1-tool-csp",
      phase: "extracted-app:post-webview",
      order: 99_940,
      ciPolicy: "required-upstream",
      apply: (extractedDir) => patchCsp(extractedDir),
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
  patchChip,
  patchCsp,
};
