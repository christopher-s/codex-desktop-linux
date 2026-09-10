"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  extractedAppPatch,
  mainBundlePatch,
  webviewAssetPatch,
} = require("../../scripts/patches/descriptor.js");

const IPC_CHANNEL = "codex_desktop:hermes-chat-lifecycle";
const MAIN_MARKER = "codexLinuxHermesLifecycleInvoke";
const PRELOAD_MARKER = "hermesChatLifecycle";
const RENDERER_MARKER = "codexLinuxHermesLifecycle";
const PLAIN_CHAT_RENDERER_MARKER = "codexLinuxHermesPlainChatLifecycle";
const APP_INITIAL_PATTERN = /^app-initial-[^.]+\.js$/;

function countOf(source, needle) {
  return source.split(needle).length - 1;
}

function mainRuntimeSource() {
  return `
const codexLinuxHermesLifecycleSessions=new Map;
let codexLinuxHermesHost=null,codexLinuxHermesHostSeq=0,codexLinuxHermesHostBuffer=\`\`,codexLinuxHermesHostPending=new Map;
function codexLinuxHermesRegistrationManifestPath(){let e=process.env.CODEX_HERMES_GIZMO_MANIFEST;if(e&&String(e).trim())return require(\`node:path\`).resolve(String(e));let t=process.env.CODEX_LINUX_APP_STATE_DIR||require(\`node:path\`).join(require(\`node:os\`).homedir(),\`.local\`,\`state\`,\`codex-desktop\`);return require(\`node:path\`).join(t,\`hermes-chat-lifecycle-gizmos.json\`)}
function codexLinuxHermesValidGizmoId(e){return typeof e===\`string\`&&/^g-[A-Za-z0-9_-]{8,128}$/.test(e)}
function codexLinuxHermesAllowedGizmos(){
  let e=String(process.env.CODEX_HERMES_GIZMO_IDS||\`\`);if(e.trim())return new Set(e.split(\`,\`).map(e=>e.trim()).filter(codexLinuxHermesValidGizmoId));
  let t=codexLinuxHermesRegistrationManifestPath();try{let e=require(\`node:fs\`);if(!e.existsSync(t))return new Set;let i=e.statSync(t);if(!i.isFile()||i.size>262144)throw new Error(\`invalid-registration-manifest-file\`);let n=JSON.parse(e.readFileSync(t,\`utf8\`));if(n==null||typeof n!==\`object\`||Array.isArray(n)||n.version!==1||n.gizmos==null||typeof n.gizmos!==\`object\`||Array.isArray(n.gizmos))throw new Error(\`invalid-registration-manifest\`);let r=[];for(let[e,t]of Object.entries(n.gizmos))codexLinuxHermesValidGizmoId(e)&&t!=null&&typeof t===\`object\`&&!Array.isArray(t)&&(t.enabled===void 0||t.enabled===!0)&&r.push(e);return new Set(r)}catch(e){return process.env.CODEX_HERMES_LIFECYCLE_DEBUG===\`1\`&&console.warn(\`[hermes-chat-lifecycle] registration manifest rejected:\`,String(e?.message||e)),new Set}
}
function codexLinuxHermesLifecycleKey(e){let t=String(e?.gizmo_id||\`\`),n=String(e?.client_conversation_id||e?.conversation_id||\`\`);if(!n)return null;return t?\`${"${t}"}\\0${"${n}"}\`:\`chat\\0${"${n}"}\`}
function codexLinuxHermesRejectHostPending(e){for(let[,t]of codexLinuxHermesHostPending){clearTimeout(t.timer),t.resolve({ok:!1,enabled:!1,error:e})}codexLinuxHermesHostPending.clear()}
function codexLinuxHermesEnsureHost(){
  if(codexLinuxHermesHost&&codexLinuxHermesHost.exitCode==null&&!codexLinuxHermesHost.killed)return codexLinuxHermesHost;
  let e=process.env.CODEX_LINUX_FEATURES_DIR;
  if(!e)throw new Error(\`features-dir-unavailable\`);
  let t=require(\`node:path\`).join(e,\`hermes-chat-lifecycle\`,\`lifecycle_helper.py\`);
  if(!require(\`node:fs\`).existsSync(t))throw new Error(\`lifecycle-helper-missing\`);
  let r=process.env.CODEX_HERMES_PYTHON;if(!r){let n=process.env.HERMES_AGENT_ROOT||require(\`node:path\`).join(require(\`node:os\`).homedir(),\`.hermes\`,\`hermes-agent\`),i=require(\`node:path\`).join(n,\`venv\`,\`bin\`,\`python3\`);r=require(\`node:fs\`).existsSync(i)?i:\`python3\`}
  let n=require(\`node:child_process\`).spawn(r,[t,\`--persistent\`],{env:process.env,stdio:[\`pipe\`,\`pipe\`,\`pipe\`]});
  codexLinuxHermesHost=n,codexLinuxHermesHostBuffer=\`\`;
  n.stdout.on(\`data\`,e=>{codexLinuxHermesHostBuffer+=String(e);for(;;){let e=codexLinuxHermesHostBuffer.indexOf(\`\\n\`);if(e<0)break;let t=codexLinuxHermesHostBuffer.slice(0,e);codexLinuxHermesHostBuffer=codexLinuxHermesHostBuffer.slice(e+1);if(!t.trim())continue;let n;try{n=JSON.parse(t)}catch{continue}let r=String(n?._request_id??\`\`),i=codexLinuxHermesHostPending.get(r);i&&(codexLinuxHermesHostPending.delete(r),clearTimeout(i.timer),delete n._request_id,i.resolve(n))}}),n.stderr.on(\`data\`,e=>{process.env.CODEX_HERMES_LIFECYCLE_DEBUG===\`1\`&&String(e).trim()&&console.warn(\`[hermes-chat-lifecycle] helper stderr:\`,String(e).trim())}),n.on(\`error\`,e=>{codexLinuxHermesRejectHostPending(String(e?.message||e)),codexLinuxHermesHost=null}),n.on(\`close\`,e=>{codexLinuxHermesRejectHostPending(\`lifecycle-helper-exited-${"${e}"}\`),codexLinuxHermesHost=null});
  return n
}
async function codexLinuxHermesHostRequest(e){
  return await new Promise(t=>{let n;try{n=codexLinuxHermesEnsureHost()}catch(e){t({ok:!1,enabled:!1,error:String(e?.message||e)});return}let r=String(++codexLinuxHermesHostSeq),i=setTimeout(()=>{let e=codexLinuxHermesHostPending.get(r);e&&(codexLinuxHermesHostPending.delete(r),e.resolve({ok:!1,enabled:!1,error:\`lifecycle-helper-timeout\`}))},2e4);i.unref?.(),codexLinuxHermesHostPending.set(r,{resolve:t,timer:i}),n.stdin.write(JSON.stringify({...e,_request_id:r})+\`\\n\`,e=>{if(!e)return;let n=codexLinuxHermesHostPending.get(r);n&&(codexLinuxHermesHostPending.delete(r),clearTimeout(n.timer),n.resolve({ok:!1,enabled:!1,error:String(e?.message||e)}))})})
}
async function codexLinuxHermesLifecycleInvoke(e){
  if(e==null||typeof e!==\`object\`||Array.isArray(e))return{ok:!1,enabled:!1,error:\`invalid-request\`};
  // Plain-Chat tool dispatch: tool_call is keyed by the conversation, not a
  // Custom-GPT gizmo, so it bypasses the gizmo-registration gate. It still runs
  // against the shared lifecycle host (and thus the same Hermes runtime/session)
  // when a local Hermes is installed; otherwise the host returns enabled:false.
  // Session identity is host-owned: a missing or non-canonical (non hs_codex_*)
  // session id is key-mapped to a process-local session and normalized, so the
  // host never stores a raw conversation id as a session id.
  if(e.phase===\`conversation_identity\`){
    let r={...e},cn=String(r.client_conversation_id||\`\`);
    if(!cn)return{ok:!1,enabled:!1,error:\`missing-conversation-identity\`};
    let k=codexLinuxHermesLifecycleKey({client_conversation_id:cn}),s=codexLinuxHermesLifecycleSessions.get(k);
    s??={sessionId:\`hs_codex_${"${require(\"node:crypto\").randomUUID().replaceAll(\"-\",\"\")}"}\`,turnCount:0};
    codexLinuxHermesLifecycleSessions.set(k,s),r.session_id=s.sessionId;
    return await codexLinuxHermesHostRequest(r);
  }
  if(e.phase===\`tool_call\`){
    let r={...e},cn=String(r.client_conversation_id||r.conversation_id||\`\`);
    if(cn){r.client_conversation_id=cn;r.conversation_id=cn}
    if(typeof r.session_id!==\`string\`||r.session_id.length===0||r.session_id.indexOf(\`hs_codex_\`)!==0){
      let k=codexLinuxHermesLifecycleKey({client_conversation_id:cn}),s=codexLinuxHermesLifecycleSessions.get(k);
      s??={sessionId:\`hs_codex_${"${require(\"node:crypto\").randomUUID().replaceAll(\"-\",\"\")}"}\`,turnCount:0};
      codexLinuxHermesLifecycleSessions.set(k,s),r.session_id=s.sessionId;
    }
    return await codexLinuxHermesHostRequest(r);
  }
  let t=typeof e.gizmo_id===\`string\`?e.gizmo_id:\`\`,n=codexLinuxHermesAllowedGizmos();
  if(t&&!n.has(t))return{ok:!0,enabled:!1,reason:\`gizmo-not-registered\`};
  if(e.phase===\`probe\`)return{ok:!0,enabled:!0,phase:\`probe\`,qa_fault:process.env.CODEX_HERMES_QA_FAULT===\`model_call_error\`?\`model_call_error\`:null};
  let r={...e},i=codexLinuxHermesLifecycleKey(r);
  if(r.phase===\`begin_turn\`){
    if(i==null)return{ok:!1,enabled:!1,error:\`missing-conversation-identity\`};
    let e=codexLinuxHermesLifecycleSessions.get(i);
    e??={sessionId:\`hs_codex_${"${require(\"node:crypto\").randomUUID().replaceAll(\"-\",\"\")}"}\`,turnCount:0};
    r.session_id=e.sessionId,r.is_first_turn=e.turnCount===0,e.turnCount+=1,codexLinuxHermesLifecycleSessions.set(i,e);
  }else if(typeof r.session_id!==\`string\`||r.session_id.length===0){
    let e=i==null?null:codexLinuxHermesLifecycleSessions.get(i);
    if(e==null)return{ok:!1,enabled:!1,error:\`unknown-session\`};
    r.session_id=e.sessionId;
  }
  let a=await codexLinuxHermesHostRequest(r);
  if(r.phase===\`close_session\`&&a?.ok===!0){if(i!=null)codexLinuxHermesLifecycleSessions.delete(i);else for(let[e,t]of codexLinuxHermesLifecycleSessions)t?.sessionId===r.session_id&&codexLinuxHermesLifecycleSessions.delete(e)}
  return a
}
/*${MAIN_MARKER}*/
`;
}

function upgradeInjectedMainRuntime(source) {
  const marker = `/*${MAIN_MARKER}*/`;
  if (countOf(source, marker) !== 1) return source;
  const startNeedle = "const codexLinuxHermesLifecycleSessions=new Map;";
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(marker, start);
  if (start < 0 || end < 0 || source.indexOf(startNeedle, start + startNeedle.length) >= 0) {
    throw new Error("Hermes lifecycle main runtime marker exists without one owned runtime block");
  }
  const desired = mainRuntimeSource().trim();
  const current = source.slice(start, end + marker.length);
  if (current === desired) return source;
  return source.slice(0, start) + desired + source.slice(end + marker.length);
}

function patchMainBundle(source) {
  if (countOf(source, `/*${MAIN_MARKER}*/`) === 1) return upgradeInjectedMainRuntime(source);
  const contract = /function ([A-Za-z_$][\w$]*)\(\{buildFlavor:([A-Za-z_$][\w$]*),getContextForWebContents:([A-Za-z_$][\w$]*),isTrustedIpcEvent:([A-Za-z_$][\w$]*)\}\)\{([A-Za-z_$][\w$]*)\.ipcMain\.on/u;
  const matches = [...source.matchAll(new RegExp(contract.source, "gu"))];
  if (matches.length !== 1) {
    console.warn(`WARN: Expected one trusted IPC initializer for Hermes lifecycle, found ${matches.length}`);
    return source;
  }
  const [match] = matches;
  const [full, fnName, buildFlavorVar, contextVar, trustedVar, electronVar] = match;
  const replacement =
    `${mainRuntimeSource()}function ${fnName}({buildFlavor:${buildFlavorVar},getContextForWebContents:${contextVar},isTrustedIpcEvent:${trustedVar}}){` +
    `${electronVar}.ipcMain.handle(\`${IPC_CHANNEL}\`,async(e,t)=>{` +
    `if(!${trustedVar}(e))return{ok:!1,enabled:!1,error:\`untrusted-ipc\`};` +
    `try{return await codexLinuxHermesLifecycleInvoke(t)}catch(e){return console.warn(\`[hermes-chat-lifecycle] IPC failure\`,e),{ok:!1,enabled:!1,error:String(e?.message||e)}}});` +
    `${electronVar}.ipcMain.on`;
  return source.replace(full, replacement);
}

function patchPreload(extractedDir) {
  const preloadPath = path.join(extractedDir, ".vite", "build", "preload.js");
  if (!fs.existsSync(preloadPath)) {
    const reason = "preload.js not found";
    console.warn(`WARN: ${reason} - skipping Hermes lifecycle preload patch`);
    return { matched: 0, changed: 0, reason };
  }
  const source = fs.readFileSync(preloadPath, "utf8");
  if (source.includes(`${PRELOAD_MARKER}:`)) {
    return { matched: 1, changed: 0, reason: null, target: path.relative(extractedDir, preloadPath) };
  }
  const anchor = "getBuildFlavor:()=>w,isDeviceCheckSupported:";
  const count = countOf(source, anchor);
  if (count !== 1) {
    const reason = `Expected one preload bridge anchor, found ${count}`;
    console.warn(`WARN: ${reason} - skipping Hermes lifecycle preload patch`);
    return { matched: 0, changed: 0, reason };
  }
  const replacement =
    `getBuildFlavor:()=>w,${PRELOAD_MARKER}:t=>e.ipcRenderer.invoke(\`${IPC_CHANNEL}\`,t),isDeviceCheckSupported:`;
  fs.writeFileSync(preloadPath, source.replace(anchor, replacement), "utf8");
  return { matched: 1, changed: 1, reason: null, target: path.relative(extractedDir, preloadPath) };
}

function upgradeRendererPlainChatLifecycle(source) {
  if (!source.includes(`let ${RENDERER_MARKER}=null`)) return source;
  if (source.includes(`/*${PLAIN_CHAT_RENDERER_MARKER}*/`)) return source;
  const probeLookahead = "let q=await globalThis.electronBridge?.hermesChatLifecycle?.({phase:`probe`";
  const legacyGate = /if\(o\?\.author\.role===`user`&&typeof ([A-Za-z_$][\w$]*)===`string`&&\1\.length>0\)try\{/gu;
  const legacyMatches = [...source.matchAll(legacyGate)].filter((match) => source.startsWith(probeLookahead, match.index + match[0].length));
  if (legacyMatches.length === 1) {
    const match = legacyMatches[0];
    return source.slice(0, match.index) + `if(o?.author.role===\`user\`)try{/*${PLAIN_CHAT_RENDERER_MARKER}*/` + source.slice(match.index + match[0].length);
  }
  if (legacyMatches.length > 1) {
    throw new Error(`Hermes lifecycle renderer legacy plain-Chat gate is ambiguous: ${legacyMatches.length}`);
  }
  const currentGate = "if(o?.author.role===`user`)try{";
  const currentMatches = [];
  for (let at = source.indexOf(currentGate); at >= 0; at = source.indexOf(currentGate, at + currentGate.length)) {
    if (source.startsWith(probeLookahead, at + currentGate.length)) currentMatches.push(at);
  }
  if (currentMatches.length !== 1) {
    throw new Error(`Hermes lifecycle renderer marker exists without one plain-Chat gate: ${currentMatches.length}`);
  }
  const at = currentMatches[0];
  return source.slice(0, at) + `${currentGate}/*${PLAIN_CHAT_RENDERER_MARKER}*/` + source.slice(at + currentGate.length);
}

function patchRendererAsset(source) {
  if (source.includes(`let ${RENDERER_MARKER}=null`)) return upgradeRendererPlainChatLifecycle(source);

  const turnContract = /([A-Za-z_$][\w$]*)=t\.projectId\?\?e\.get\(([A-Za-z_$][\w$]*),u\),([A-Za-z_$][\w$]*)=t\.conversationOrigin===void 0\?e\.get\(([A-Za-z_$][\w$]*),u\):t\.conversationOrigin/u;
  const match = source.match(turnContract);
  if (match == null) {
    console.warn("WARN: ChatGPT resolved-project turn contract not found - skipping Hermes lifecycle renderer patch");
    return source;
  }
  if ([...source.matchAll(new RegExp(turnContract.source, "gu"))].length !== 1) {
    console.warn("WARN: ChatGPT resolved-project turn contract is ambiguous - skipping Hermes lifecycle renderer patch");
    return source;
  }

  const [full, projectVar, projectAtom, originVar, originAtom] = match;
  const injected =
    `${projectVar}=t.projectId??e.get(${projectAtom},u);` +
    `let ${RENDERER_MARKER}=null,codexLinuxHermesTerminalSent=!1,codexLinuxHermesPreflight=null,` +
    `codexLinuxHermesMessageText=m=>typeof m===\`string\`?m:Array.isArray(m?.content?.parts)?m.content.parts.filter(x=>typeof x===\`string\`).join(\`\\n\`):typeof m?.content?.text===\`string\`?m.content.text:\`\`,` +
    `codexLinuxHermesPreflightMap=globalThis.__codexLinuxHermesLifecyclePreflights??=(new Map),` +
    `codexLinuxHermesNotify=(n,i={})=>{if(${RENDERER_MARKER}?.enabled!==!0||codexLinuxHermesTerminalSent)return;codexLinuxHermesTerminalSent=!0,codexLinuxHermesPreflightMap.delete(u);` +
    `let a=e.get(Qz,u),h=e.get(nB,u)??{},g=a==null?null:h[a]?.message??null;` +
    `globalThis.electronBridge?.hermesChatLifecycle?.({phase:n,session_id:${RENDERER_MARKER}.session_id,gizmo_id:${projectVar},conversation_id:d??u,client_conversation_id:u,turn_id:s,user_message:codexLinuxHermesMessageText(o),assistant_message:codexLinuxHermesMessageText(g),model:r,...i}).catch(()=>{})};` +
    `if(o?.author.role===\`user\`)try{/*${PLAIN_CHAT_RENDERER_MARKER}*/` +
    `let q=await globalThis.electronBridge?.hermesChatLifecycle?.({phase:\`probe\`,gizmo_id:${projectVar}});if(q?.enabled===!0){` +
    `codexLinuxHermesPreflight={cancelled:!1,started:!1,qaFault:q.qa_fault??null},codexLinuxHermesPreflightMap.set(u,codexLinuxHermesPreflight);` +
    `let n=await globalThis.electronBridge?.hermesChatLifecycle?.({phase:\`begin_turn\`,gizmo_id:${projectVar},conversation_id:d??u,client_conversation_id:u,turn_id:s,user_message:codexLinuxHermesMessageText(o),model:r});` +
    `if(n?.enabled===!0){${RENDERER_MARKER}=n;let codexLinuxHermesContextMessages=[];` +
    `typeof n.system_context===\`string\`&&n.system_context.trim().length>0&&codexLinuxHermesContextMessages.push(a_i(n.system_context,rp(),!0));` +
    `typeof n.user_context===\`string\`&&n.user_context.trim().length>0&&codexLinuxHermesContextMessages.push(i_i(n.user_context,[],{is_visually_hidden_from_conversation:!0,is_contextual_retry_user_message:!0,exclude_after_next_user_message:!0},[],rp()));` +
    `codexLinuxHermesContextMessages.length>0&&(t.extraDeveloperInstructionMessages=[...t.extraDeveloperInstructionMessages??[],...codexLinuxHermesContextMessages])}` +
    `if(codexLinuxHermesPreflight.cancelled){codexLinuxHermesNotify(\`abort_turn\`),codexLinuxHermesPreflightMap.delete(u);return{conversationId:u,serverConversationId:d,streamRequestId:null}}}}` +
    `catch(e){codexLinuxHermesPreflightMap.delete(u),console.warn(\`[hermes-chat-lifecycle] begin_turn failed\`,e)}` +
    `let ${originVar}=t.conversationOrigin===void 0?e.get(${originAtom},u):t.conversationOrigin`;

  let patched = source.replace(full, injected);

  const apiStartContract = /let p=await e\.get\(([A-Za-z_$][\w$]*)\)\.startCompletionStream\(/gu;
  const apiStartMatches = [...patched.matchAll(apiStartContract)];
  if (apiStartMatches.length !== 1) {
    console.warn("WARN: ChatGPT completion stream start contract not found uniquely - skipping Hermes lifecycle renderer patch");
    return source;
  }
  const apiStartAnchor = apiStartMatches[0][0];
  const streamAtom = apiStartMatches[0][1];
  patched = patched.replace(
    apiStartAnchor,
    `if(codexLinuxHermesPreflight?.cancelled){codexLinuxHermesNotify(\`abort_turn\`),codexLinuxHermesPreflightMap.delete(u);return{conversationId:u,serverConversationId:d,streamRequestId:null}}` +
      `if(${RENDERER_MARKER}?.enabled===!0)try{await globalThis.electronBridge?.hermesChatLifecycle?.({phase:\`pre_api_request\`,session_id:${RENDERER_MARKER}.session_id,gizmo_id:${projectVar},conversation_id:d??u,client_conversation_id:u,turn_id:s,user_message:codexLinuxHermesMessageText(o),model:r})}catch(e){console.warn(\`[hermes-chat-lifecycle] pre_api_request failed\`,e)}` +
      `if(codexLinuxHermesPreflight?.qaFault===\`model_call_error\`){xe({error:\`qa-injected-model-call-error\`,errorKind:\`network\`,requestId:s,type:\`fetch-stream-error\`}),codexLinuxHermesPreflightMap.delete(u);return{conversationId:u,serverConversationId:d,streamRequestId:null}}` +
      `if(codexLinuxHermesPreflight?.cancelled){codexLinuxHermesNotify(\`abort_turn\`),codexLinuxHermesPreflightMap.delete(u);return{conversationId:u,serverConversationId:d,streamRequestId:null}}` +
      `codexLinuxHermesPreflight&&(codexLinuxHermesPreflight.started=!0);let p=await e.get(${streamAtom}).startCompletionStream(`,
  );

  const stopHandlerContract = /(async function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{)(if\(\3\.get\(([A-Za-z_$][\w$]*),\4\)\|\|\3\.get\(([A-Za-z_$][\w$]*),\4\)\)return;)/gu;
  const stopHandlerMatches = [...patched.matchAll(stopHandlerContract)];
  if (stopHandlerMatches.length !== 1) {
    console.warn("WARN: ChatGPT stop handler contract not found uniquely - skipping Hermes lifecycle renderer patch");
    return source;
  }
  const stopHandler = stopHandlerMatches[0];
  patched = patched.replace(
    stopHandler[0],
    `${stopHandler[1]}let codexLinuxHermesPendingPreflight=globalThis.__codexLinuxHermesLifecyclePreflights?.get(${stopHandler[4]});if(codexLinuxHermesPendingPreflight){codexLinuxHermesPendingPreflight.cancelled=!0;if(!codexLinuxHermesPendingPreflight.started)return}${stopHandler[6]}`,
  );

  const streamRegisteredContract = /([A-Za-z_$][\w$]*)\(\{scope:([A-Za-z_$][\w$]*),conversationId:([A-Za-z_$][\w$]*),streamRequestId:([A-Za-z_$][\w$]*)\}\),\{conversationId:\3,/gu;
  const streamRegisteredMatches = [...patched.matchAll(streamRegisteredContract)];
  if (streamRegisteredMatches.length !== 1) {
    console.warn("WARN: ChatGPT stream registration contract not found uniquely - skipping Hermes lifecycle renderer patch");
    return source;
  }
  const streamRegistered = streamRegisteredMatches[0];
  patched = patched.replace(
    streamRegistered[0],
    `${streamRegistered[1]}({scope:${streamRegistered[2]},conversationId:${streamRegistered[3]},streamRequestId:${streamRegistered[4]}}),codexLinuxHermesPreflightMap.delete(${streamRegistered[3]}),codexLinuxHermesPreflight?.cancelled&&$gi(${streamRegistered[2]},${streamRegistered[3]}),{conversationId:${streamRegistered[3]},`,
  );

  const successContract = /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)=>\{([A-Za-z_$][\w$]*)\(\2,`completed`\)&&\(([A-Za-z_$][\w$]*)\(\2\),/gu;
  const successMatches = [...patched.matchAll(successContract)];
  if (successMatches.length !== 1) {
    console.warn("WARN: ChatGPT completion success contract not found uniquely - skipping Hermes lifecycle renderer patch");
    return source;
  }
  const success = successMatches[0];
  patched = patched.replace(
    success[0],
    `${success[1]}=${success[2]}=>{${success[3]}(${success[2]},\`completed\`)&&(codexLinuxHermesNotify(\`complete_turn\`,{server_conversation_id:ie}),${success[4]}(${success[2]}),`,
  );

  const errorAnchor = "xe=n=>{if(!ve(n.requestId,`failed`))return;";
  if (countOf(patched, errorAnchor) !== 1) {
    console.warn("WARN: ChatGPT completion error contract not found uniquely - skipping Hermes lifecycle renderer patch");
    return source;
  }
  patched = patched.replace(
    errorAnchor,
    "xe=n=>{if(!ve(n.requestId,`failed`))return;codexLinuxHermesNotify(`model_call_error`,{error:n.error});",
  );

  const cancelAnchor = "logCancellation:()=>ye({result:`canceled`})";
  if (countOf(patched, cancelAnchor) !== 1) {
    console.warn("WARN: ChatGPT cancellation contract not found uniquely - skipping Hermes lifecycle renderer patch");
    return source;
  }
  patched = patched.replace(
    cancelAnchor,
    "logCancellation:()=>(codexLinuxHermesNotify(`abort_turn`),ye({result:`canceled`}))",
  );
  return patched;
}

function matchesRendererContract(source) {
  return source.includes("oneTurnDeveloperInstructions") &&
    source.includes("conversation_mode") &&
    source.includes("startCompletionStream") &&
    /\.projectId\?\?e\.get\(/u.test(source);
}

module.exports = {
  APP_INITIAL_PATTERN,
  IPC_CHANNEL,
  MAIN_MARKER,
  PRELOAD_MARKER,
  RENDERER_MARKER,
  mainRuntimeSource,
  matchesRendererContract,
  patchMainBundle,
  patchPreload,
  patchRendererAsset,
  descriptors: [
    mainBundlePatch({
      id: "hermes-chat-lifecycle-main-ipc",
      order: 29_700,
      ciPolicy: "opt-in",
      apply: patchMainBundle,
    }),
    extractedAppPatch({
      id: "hermes-chat-lifecycle-preload-ipc",
      phase: "extracted-app:pre-webview",
      order: 29_710,
      ciPolicy: "opt-in",
      apply: patchPreload,
      status: (result, warnings) => {
        if (result?.matched !== 1) {
          return { status: "skipped-optional", reason: result?.reason ?? warnings[0] ?? null };
        }
        return result.changed === 1 ? "applied" : "already-applied";
      },
    }),
    webviewAssetPatch({
      id: "hermes-chat-lifecycle-chatgpt-turn",
      order: 29_720,
      ciPolicy: "opt-in",
      pattern: APP_INITIAL_PATTERN,
      assetMatch: matchesRendererContract,
      missingDescription: "ChatGPT app-initial bundle with semantic turn contracts",
      skipDescription: "Hermes ChatGPT lifecycle renderer patch",
      apply: patchRendererAsset,
    }),
  ],
};
