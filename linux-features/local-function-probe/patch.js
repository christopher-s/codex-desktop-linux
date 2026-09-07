"use strict";

const INITIAL_PATTERN = /^app-initial-[^.]+\.js$/;
const PRIMARY_PATTERN = /^app-primary-[^.]+\.js$/;
const VIEWER_PATTERN = /^viewer-[^.]+\.js$/;
const CHIP_PATTERN = /^subagent-activity-chip-group-[0-9a-f]+\.js$/;
const INITIAL_MARKER = "codexLocalFunctionProbeSignatureRuntime";
const PRIMARY_MARKER = "codexLocalFunctionProbeDetectorRuntime";
const VIEWER_MARKER = "codexLocalFunctionProbeViewerRuntime";
const RESULT_PAIR_MARKER = "codexLocalFunctionProbeResultPairRuntime";
const CHIP_RESULT_MARKER = "codexLocalFunctionProbeChipResultRuntime";

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
  out = replaceExactlyOnce(out, "nWr=`handoff`", "nWr=`qa_local_echo`", "rename local function");
  const oldSignature = "function tWr({config:e,isEverydayWorkMode:t,isTemporaryChat:n}){if(n)return[];let r=t?`Work mode`:`Codex`;return[{description:qUr(e.toolDescription,r),name:nWr,params:[{name:`prompt`,required:!0,type:{description:qUr(e.toolPromptParamDescription,r),type:`string`}},{name:`reason`,required:!0,type:{description:qUr(e.toolReasonParamDescription,r),type:`string`}}],type:`kwargs`}]}";
  const newSignature = `function tWr({config:e,isEverydayWorkMode:t,isTemporaryChat:n}){if(n)return[];globalThis.__codexLocalFnQaSignatureBuilds=(globalThis.__codexLocalFnQaSignatureBuilds??0)+1;/*${INITIAL_MARKER}*/return[{description:\`QA-only local echo. Call exactly when the user explicitly asks to invoke qa_local_echo.\`,name:nWr,params:[{name:\`prompt\`,required:!0,type:{description:\`Echo input\`,type:\`string\`}},{name:\`reason\`,required:!0,type:{description:\`QA reason\`,type:\`string\`}}],type:\`kwargs\`}]} `;
  out = replaceExactlyOnce(out, oldSignature, newSignature, "replace local signature");
  out = replaceExactlyOnce(out,
    "local_function_signatures:y||!r?void 0:tWr({config:l,isEverydayWorkMode:v,isTemporaryChat:g})",
    "local_function_signatures:y?void 0:tWr({config:l,isEverydayWorkMode:v,isTemporaryChat:g})",
    "real request local-function gate");
  out = replaceExactlyOnce(out,
    "local_function_signatures:C||!r?void 0:tWr({config:GUr(e,T),isEverydayWorkMode:u,isTemporaryChat:c})",
    "local_function_signatures:C?void 0:tWr({config:GUr(e,T),isEverydayWorkMode:u,isTemporaryChat:c})",
    "prepare request local-function gate");
  out = replaceExactlyOnce(out,
    "consumer_lockdown_mode_disabled:S,conversation_mode:h==null?void 0:{kind:`gizmo_interaction`,gizmo_id:h},gizmo_id:h??void 0",
    "consumer_lockdown_mode_disabled:S,conversation_mode:h==null?void 0:(globalThis.__codexLocalFnQaGizmoModeStripped=(globalThis.__codexLocalFnQaGizmoModeStripped??0)+1,void 0),gizmo_id:h??void 0",
    "prepare Gizmo mode strip");
  out = replaceExactlyOnce(out,
    "consumer_lockdown_mode_disabled:a,conversation_mode:h==null?void 0:{kind:`gizmo_interaction`,gizmo_id:h},gizmo_id:h??void 0",
    "consumer_lockdown_mode_disabled:a,conversation_mode:h==null?void 0:(globalThis.__codexLocalFnQaGizmoModeStripped=(globalThis.__codexLocalFnQaGizmoModeStripped??0)+1,void 0),gizmo_id:h??void 0",
    "live Gizmo mode strip");
  out = replaceExactlyOnce(out,
    "async function Ygi(e,{callId:t,conversationId:n,isTemporaryChat:r,model:i,onServerThreadIdChange:a,result:o,thinkingEffort:s,toolName:c}){let l=dL();return Xgi(e,{",
    "async function Ygi(e,{callId:t,conversationId:n,isTemporaryChat:r,model:i,onServerThreadIdChange:a,result:o,thinkingEffort:s,toolName:c}){globalThis.__codexLocalFnQaResultsSubmitted=(globalThis.__codexLocalFnQaResultsSubmitted??0)+1;globalThis.__codexLocalFnQaLastResult={callId:t,conversationId:n,result:o,toolName:c};let l=dL();return Xgi(e,{",
    "generic local result submitter");
  out = replaceExactlyOnce(out,
    "function r_i({callId:e,id:t,result:n,toolName:r}){return{author:{metadata:{},name:r,role:`tool`},channel:`commentary`,content:{content_type:`code`,text:JSON.stringify({call_id:e,result:n,tool:r})},create_time:Date.now()/1e3,end_turn:null,id:t,metadata:{is_visually_hidden_from_conversation:!0},recipient:`all`,status:`finished_successfully`,update_time:null,weight:1}}",
    `function r_i({callId:e,id:t,result:n,toolName:r}){return{author:{metadata:{},name:r,role:\`tool\`},channel:\`commentary\`,content:{content_type:\`code\`,text:JSON.stringify({call_id:e,result:n,tool:r})},create_time:Date.now()/1e3,end_turn:null,id:t,metadata:{is_visually_hidden_from_conversation:!0,codex_local_function_result:!0},recipient:\`all\`,status:\`finished_successfully\`,update_time:null,weight:1}}/*${RESULT_PAIR_MARKER}*/`,
    "mark hidden local function result");
  out = replaceExactlyOnce(out,
    "function uGr(e){let t=PL(e.recipient);if(t?.startsWith(`functions.`)===!0){let e=t.slice(10);return{completed:!1,pairKey:`dynamic:${e}`,tool:e}}return t?.startsWith(`local.`)===!0?{completed:e.status!==`in_progress`,pairKey:null,tool:t.slice(6)}:null}",
    "function uGr(e){let t=PL(e.recipient);if(t?.startsWith(`functions.`)===!0){let n=t.slice(10),r=n===`qa_local_echo`?`handoff`:n;n===`qa_local_echo`&&(globalThis.__codexLocalFnQaNormalized=(globalThis.__codexLocalFnQaNormalized??0)+1);return{completed:!1,pairKey:n===`qa_local_echo`?`local-function:${jL(e)}`:`dynamic:${n}`,sourceTool:n,tool:r}}return t?.startsWith(`local.`)===!0?(t.slice(6)===`qa_local_echo`&&(globalThis.__codexLocalFnQaNormalized=(globalThis.__codexLocalFnQaNormalized??0)+1),{completed:t.slice(6)===`qa_local_echo`?!1:e.status!==`in_progress`,pairKey:t.slice(6)===`qa_local_echo`?`local-function:${jL(e)}`:null,tool:t.slice(6)===`qa_local_echo`?`handoff`:t.slice(6)}):null}",
    "normalize QA call for native executor and pair by call id");
  out = replaceExactlyOnce(out,
    "function $Wr(e){let t=FL(e),n=_Tr(e),[r,i]=e.author.name?.split(`.`)??[];",
    "function $Wr(e){globalThis.__codexLocalFnQaWrCalled=(globalThis.__codexLocalFnQaWrCalled??0)+1;if(e.recipient?.includes(`qa_local_echo`)||e.recipient?.includes(`handoff`))globalThis.__codexLocalFnQaWrRecipient=e.recipient;let t=FL(e),n=_Tr(e),[r,i]=e.author.name?.split(`.`)??[];",
    "instrument Wr entry");
  out = replaceExactlyOnce(out,
    'let r=_Gr.safeParse(t);if(r.success){let e=r.data,t=aGr(e.status);return{completed:t,item:{arguments:e.arguments,callId:e.id,completed:t,contentItems:e.contentItems??null,namespace:e.namespace??null,success:e.success??null,tool:e.tool,type:`dynamic-tool-call`},pairKey:`dynamic:${e.tool}`}',
    'let r=_Gr.safeParse(t);if(r.success){let e=r.data,t=aGr(e.status);e.tool===`qa_local_echo`&&(globalThis.__codexLocalFnQaNormalized=(globalThis.__codexLocalFnQaNormalized??0)+1);return e.tool===`qa_local_echo`?{completed:!1,item:{arguments:e.arguments,callId:e.id,completed:!1,contentItems:e.contentItems??null,namespace:e.namespace??null,success:e.success??null,tool:`handoff`,sourceTool:`qa_local_echo`,type:`dynamic-tool-call`},pairKey:`local-function:${e.id}`}:{completed:t,item:{arguments:e.arguments,callId:e.id,completed:t,contentItems:e.contentItems??null,namespace:e.namespace??null,success:e.success??null,tool:e.tool,type:`dynamic-tool-call`},pairKey:`dynamic:${e.tool}`}',
    "normalize qa_local_echo in primary dynamic-tool-call classification");
  out = replaceExactlyOnce(out,
    'var __cbtcP="__jit_plugin.",__cbtcIdx;u=u==null&&typeof e.recipient==="string"&&(__cbtcIdx=e.recipient.indexOf(__cbtcP))!==-1&&__cbtcIdx+__cbtcP.length<e.recipient.length?{completed:e.status!=="in_progress",pairKey:null,tool:e.recipient.slice(__cbtcIdx+__cbtcP.length)}:u;/*codexLinuxChatBridgeToolCallsRuntime*/',
    'var __cbtcP="__jit_plugin.",__cbtcIdx,__codexLocalFnQaEmbeddedTool;u=u==null&&typeof e.recipient==="string"&&(__cbtcIdx=e.recipient.indexOf(__cbtcP))!==-1&&__cbtcIdx+__cbtcP.length<e.recipient.length?((__codexLocalFnQaEmbeddedTool=e.recipient.slice(__cbtcIdx+__cbtcP.length)),globalThis.__codexLocalFnQaBridgeFallback=(globalThis.__codexLocalFnQaBridgeFallback??0)+1,globalThis.__codexLocalFnQaLastBridgeRecipient=e.recipient,__codexLocalFnQaEmbeddedTool===`qa_local_echo`?(globalThis.__codexLocalFnQaNormalized=(globalThis.__codexLocalFnQaNormalized??0)+1,{completed:!1,pairKey:`local-function:${jL(e)}`,sourceTool:__codexLocalFnQaEmbeddedTool,tool:`handoff`}):{completed:e.status!=="in_progress",pairKey:null,tool:__codexLocalFnQaEmbeddedTool}):u;/*codexLinuxChatBridgeToolCallsRuntime*/',
    "normalize embedded QA recipient before generic bridge fallback");
  out = replaceExactlyOnce(out,
    "function rGr(e,t){let n=NL(NL(e.metadata)?.invoked_resource);if(e.author.role!==`tool`||n==null&&e.metadata?.chatgpt_sdk==null)return null;let r=t??AL(e),i;",
    "function rGr(e,t){if(e.author.role===`tool`&&e.metadata?.codex_local_function_result===!0){let n=t??AL(e);if(n!=null&&typeof n===`object`&&typeof n.call_id===`string`&&typeof n.tool===`string`)return{completed:!0,item:null,pairKey:`local-function:${n.call_id}`,rawPayload:n.result,localFunctionResult:!0}}let n=NL(NL(e.metadata)?.invoked_resource);if(e.author.role!==`tool`||n==null&&e.metadata?.chatgpt_sdk==null)return null;let r=t??AL(e),i;",
    "classify marked hidden local result");
  out = replaceExactlyOnce(out,
    "function eGr(e,t,n){let r=(t.pairKey==null?null:KWr(e,n))??t.item;return r==null?n?.item.type===`mcp-tool-call`?{...n,item:t.rawPayload===void 0&&t.error==null?{...n.item,completed:!0}:iGr({item:n.item,rawPayload:t.rawPayload,error:t.error,toolIcons:t.toolIcons}),sourceMessage:e}:null:{item:r,role:e.author.role===`assistant`?`assistant`:`tool`,sourceMessage:e,turnId:kL(e)??n?.turnId??null}}",
    "function eGr(e,t,n){let r=(t.pairKey==null?null:KWr(e,n))??t.item;return r==null?t.localFunctionResult===!0&&n?.item.type===`dynamic-tool-call`?{...n,item:{...n.item,completed:!0,result:t.rawPayload},sourceMessage:e}:n?.item.type===`mcp-tool-call`?{...n,item:t.rawPayload===void 0&&t.error==null?{...n.item,completed:!0}:iGr({item:n.item,rawPayload:t.rawPayload,error:t.error,toolIcons:t.toolIcons}),sourceMessage:e}:null:{item:r,role:e.author.role===`assistant`?`assistant`:`tool`,sourceMessage:e,turnId:kL(e)??n?.turnId??null}}",
    "attach marked result to dynamic tool call");
  return out;
}

function patchPrimary(source) {
  if (source.includes(PRIMARY_MARKER)) return source;
  let out = source;
  out = replaceExactlyOnce(out,
    "I0t=$n(yi,(e,{get:t})=>{if(!t(ly))return null;let n=t(b_,e),r=t(hv,e);if(n==null||r==null)return null;let i=r[n]?.message,a=Ov(i?.recipient);if(i?.author.role!==`assistant`||i.status===`in_progress`||a!==`functions.handoff`&&a!==`local.handoff`)return null;",
    `I0t=$n(yi,(e,{get:t})=>{let n=t(b_,e),r=t(hv,e);if(n==null||r==null)return null;let i=r[n]?.message,a=Ov(i?.recipient),__codexLocalFnQaEmbedded=typeof a===\`string\`&&a.includes(\`__jit_plugin.qa_local_echo\`);(a===\`functions.qa_local_echo\`||a===\`local.qa_local_echo\`||__codexLocalFnQaEmbedded)&&(globalThis.__codexLocalFnQaDetected=(globalThis.__codexLocalFnQaDetected??0)+1,globalThis.__codexLocalFnQaLastRecipient=a);/*${PRIMARY_MARKER}*/if(i?.author.role!==\`assistant\`||a!==\`functions.qa_local_echo\`&&a!==\`local.qa_local_echo\`&&!__codexLocalFnQaEmbedded)return null;`,
    "local function detector");
  out = replaceExactlyOnce(out,
    "result:{accepted:!1,message:lwe(e).rejectedResponse}",
    "result:{accepted:!1,message:`LOCAL-QA-RESULT-73`}",
    "rejected local result marker");
  return out;
}

function patchViewer(source) {
  if (source.includes(VIEWER_MARKER)) return source;
  return replaceExactlyOnce(
    source,
    "if(f.type===`dynamic-tool-call`){if(f.tool===`handoff`){",
    `if(f.type===\`dynamic-tool-call\`){if(f.tool===\`handoff\`||f.tool===\`qa_local_echo\`){globalThis.__codexLocalFnQaViewerRouted=(globalThis.__codexLocalFnQaViewerRouted??0)+1;/*${VIEWER_MARKER}*/`,
    "route incomplete QA local call through native executor",
  );
}

function patchChip(source) {
  if (source.includes(CHIP_RESULT_MARKER)) return source;
  return replaceExactlyOnce(
    source,
    "__cbtcWalk(r.arguments,null,0,`root`);",
    `globalThis.__codexLocalFnQaChipItem={tool:r.tool,completed:r.completed,result:r.result,arguments:r.arguments,keys:Object.keys(r)};let __cbtcPayload={arguments:r.arguments};Object.prototype.hasOwnProperty.call(r,\`result\`)&&(__cbtcPayload.result=r.result);__cbtcWalk(__cbtcPayload,null,0,\`root\`);/*${CHIP_RESULT_MARKER}*/`,
    "render arguments and exact local result",
  );
}

module.exports = {
  descriptors: [
    {
      id: "qa-local-function-initial",
      phase: "webview-asset",
      order: 99_900,
      ciPolicy: "required-upstream",
      pattern: INITIAL_PATTERN,
      missingDescription: "app-initial bundle for QA local function",
      apply: patchInitial,
    },
    {
      id: "qa-local-function-primary",
      phase: "webview-asset",
      order: 99_910,
      ciPolicy: "required-upstream",
      pattern: PRIMARY_PATTERN,
      missingDescription: "app-primary bundle for QA local function",
      apply: patchPrimary,
    },
    {
      id: "qa-local-function-viewer",
      phase: "webview-asset",
      order: 99_920,
      ciPolicy: "required-upstream",
      pattern: VIEWER_PATTERN,
      missingDescription: "viewer bundle for QA local function",
      apply: patchViewer,
    },
    {
      id: "qa-local-function-chip-result",
      phase: "webview-asset",
      order: 99_930,
      ciPolicy: "required-upstream",
      pattern: CHIP_PATTERN,
      missingDescription: "patched generic disclosure chip for QA local result",
      apply: patchChip,
    },
  ],
  patchInitial,
  patchPrimary,
  patchViewer,
  patchChip,
};
