#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
  IPC_CHANNEL,
  descriptors,
  mainRuntimeSource,
  patchMainBundle,
  patchPreload,
  patchRendererAsset,
} = require("./patch.js");

const HELPER = path.join(__dirname, "lifecycle_helper.py");

function applyTwice(fn, source) {
  const once = fn(source);
  assert.notEqual(once, source);
  assert.equal(fn(once), once);
  return once;
}

function manifestHarness(env = {}) {
  const warnings = [];
  const sandbox = {
    require,
    process: { env: { ...env } },
    console: { warn: (...args) => warnings.push(args.map(String).join(" ")) },
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(
    `${mainRuntimeSource()}\nglobalThis.__manifestApi={` +
      `path:()=>codexLinuxHermesRegistrationManifestPath(),` +
      `valid:e=>codexLinuxHermesValidGizmoId(e),` +
      `allowed:()=>JSON.stringify([...codexLinuxHermesAllowedGizmos()].sort()),` +
      `stubHost:()=>{codexLinuxHermesHostRequest=async e=>({ok:true,enabled:true,...e})},` +
      `invoke:e=>codexLinuxHermesLifecycleInvoke(e)` +
      `};`,
    sandbox,
  );
  return { api: sandbox.__manifestApi, warnings };
}

function parseAllowed(api) {
  return JSON.parse(api.allowed());
}

test("fresh plain-Chat identity provisions its session before the first tool call", async () => {
  const { api } = manifestHarness();
  api.stubHost();
  const localId = "local-chatgpt:11111111-1111-4111-8111-111111111111";
  const serverId = "22222222-2222-4222-8222-222222222222";

  const identity = await api.invoke({
    phase: "conversation_identity",
    client_conversation_id: localId,
    conversation_id: serverId,
    server_conversation_id: serverId,
  });

  assert.equal(identity.ok, true, JSON.stringify(identity));
  assert.match(identity.session_id, /^hs_codex_[0-9a-f]{32}$/);
  assert.equal(identity.client_conversation_id, localId);
  assert.equal(identity.server_conversation_id, serverId);

  const toolCall = await api.invoke({
    phase: "tool_call",
    client_conversation_id: localId,
    conversation_id: localId,
    name: "hermes_tool_call",
  });
  assert.equal(toolCall.session_id, identity.session_id);
});

test("project-less plain Chat lifecycle reuses one canonical session across model and tool phases", async () => {
  const { api } = manifestHarness();
  api.stubHost();
  const localId = "local-chatgpt:33333333-3333-4333-8333-333333333333";

  const probe = await api.invoke({ phase: "probe" });
  assert.equal(probe.enabled, true, JSON.stringify(probe));

  const begin = await api.invoke({
    phase: "begin_turn",
    client_conversation_id: localId,
    conversation_id: localId,
    turn_id: "turn-plain-1",
    user_message: "hello",
  });
  assert.equal(begin.enabled, true, JSON.stringify(begin));
  assert.match(begin.session_id, /^hs_codex_[0-9a-f]{32}$/);

  const pre = await api.invoke({
    phase: "pre_api_request",
    client_conversation_id: localId,
    conversation_id: localId,
    turn_id: "turn-plain-1",
  });
  assert.equal(pre.session_id, begin.session_id);

  const tool = await api.invoke({
    phase: "tool_call",
    client_conversation_id: localId,
    conversation_id: localId,
    name: "hermes_tool_search",
  });
  assert.equal(tool.session_id, begin.session_id);

  const complete = await api.invoke({
    phase: "complete_turn",
    client_conversation_id: localId,
    conversation_id: localId,
    turn_id: "turn-plain-1",
    assistant_message: "done",
  });
  assert.equal(complete.session_id, begin.session_id);

  const unregisteredGizmo = await api.invoke({
    phase: "probe",
    gizmo_id: "g-unregistered_123",
  });
  assert.equal(unregisteredGizmo.enabled, false);
  assert.equal(unregisteredGizmo.reason, "gizmo-not-registered");
});

function isolatedHermesPythonEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key === "PYTHONPATH" ||
      key === "PYTHONHOME" ||
      key.startsWith("HERMES_") ||
      key.startsWith("CODEX_HERMES_")
    ) {
      delete env[key];
    }
  }
  return { ...env, ...overrides };
}

function writeFakeDaemonPool(root) {
  const toolsDir = path.join(root, "tools");
  fs.mkdirSync(toolsDir, { recursive: true });
  fs.writeFileSync(path.join(toolsDir, "__init__.py"), "", "utf8");
  fs.writeFileSync(
    path.join(toolsDir, "daemon_pool.py"),
    [
      "from concurrent.futures import ThreadPoolExecutor",
      "class DaemonThreadPoolExecutor(ThreadPoolExecutor):",
      "    pass",
    ].join("\n"),
    "utf8",
  );
}

test("helper preserves cadence when Hermes already has an active background review", () => {
  const helperSource = fs.readFileSync(HELPER, "utf8");
  assert.match(helperSource, /current_run = getattr\(parent, "_background_review_run", None\)/);
  assert.match(helperSource, /"reason": "active-review"/);
  const activeGuard = helperSource.indexOf('"reason": "active-review"');
  const cadenceReset = helperSource.indexOf("runtime.review_iterations_since_skill = 0", activeGuard);
  assert.ok(activeGuard >= 0 && cadenceReset > activeGuard, "cadence reset must occur only after the active-review guard");
});

test("registration manifest loads enabled valid Gizmos and is re-read on every probe", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-chat-lifecycle-manifest-"));
  try {
    const manifestPath = path.join(root, "hermes-chat-lifecycle-gizmos.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        gizmos: {
          "g-enabled_123": { enabled: true, profile: "winston" },
          "g-default_456": { profile: "reserved" },
          "g-disabled789": { enabled: false },
          "g-stringenabled": { enabled: "false" },
          "g-zeroenabled0": { enabled: 0 },
          invalid: { enabled: true },
        },
      }),
      "utf8",
    );
    const { api } = manifestHarness({ CODEX_LINUX_APP_STATE_DIR: root });
    assert.equal(api.path(), manifestPath);
    assert.equal(api.valid("g-enabled_123"), true);
    assert.equal(api.valid("g-short"), false);
    assert.deepEqual(parseAllowed(api), ["g-default_456", "g-enabled_123"]);
    const registeredProbe = JSON.parse(JSON.stringify(await api.invoke({ phase: "probe", gizmo_id: "g-enabled_123" })));
    assert.deepEqual(registeredProbe, {
      ok: true,
      enabled: true,
      phase: "probe",
      qa_fault: null,
    });
    assert.equal((await api.invoke({ phase: "probe", gizmo_id: "g-disabled789" })).enabled, false);

    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ version: 1, gizmos: { "g-disabled789": { enabled: true }, "g-enabled_123": { enabled: false } } }),
      "utf8",
    );
    assert.deepEqual(parseAllowed(api), ["g-disabled789"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("registration manifest fails closed for malformed, wrong-version, and oversized files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-chat-lifecycle-manifest-bad-"));
  try {
    const manifestPath = path.join(root, "hermes-chat-lifecycle-gizmos.json");
    const { api } = manifestHarness({ CODEX_LINUX_APP_STATE_DIR: root, CODEX_HERMES_LIFECYCLE_DEBUG: "1" });

    fs.writeFileSync(manifestPath, "{broken", "utf8");
    assert.deepEqual(parseAllowed(api), []);

    fs.writeFileSync(manifestPath, JSON.stringify({ version: 2, gizmos: { "g-enabled_123": {} } }), "utf8");
    assert.deepEqual(parseAllowed(api), []);

    fs.writeFileSync(manifestPath, "x".repeat(262145), "utf8");
    assert.deepEqual(parseAllowed(api), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("registration env override has explicit precedence and custom manifest path is supported", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-chat-lifecycle-manifest-override-"));
  try {
    const customPath = path.join(root, "custom-gizmos.json");
    fs.writeFileSync(customPath, JSON.stringify({ version: 1, gizmos: { "g-manifest_123": { enabled: true } } }), "utf8");

    const custom = manifestHarness({ CODEX_HERMES_GIZMO_MANIFEST: customPath });
    assert.equal(custom.api.path(), customPath);
    assert.deepEqual(parseAllowed(custom.api), ["g-manifest_123"]);

    const override = manifestHarness({
      CODEX_HERMES_GIZMO_MANIFEST: customPath,
      CODEX_HERMES_GIZMO_IDS: "g-override_123,invalid,g-short",
    });
    assert.deepEqual(parseAllowed(override.api), ["g-override_123"]);

    const explicitInvalidOverride = manifestHarness({
      CODEX_HERMES_GIZMO_MANIFEST: customPath,
      CODEX_HERMES_GIZMO_IDS: "invalid,g-short",
    });
    assert.deepEqual(parseAllowed(explicitInvalidOverride.api), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("main runtime reuses a lifecycle session in-process and rotates it across process restart", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-chat-lifecycle-restart-"));
  try {
    const manifestPath = path.join(root, "hermes-chat-lifecycle-gizmos.json");
    const gizmo = "g-restart_123";
    fs.writeFileSync(manifestPath, JSON.stringify({ version: 1, gizmos: { [gizmo]: { enabled: true } } }), "utf8");
    const env = { CODEX_LINUX_APP_STATE_DIR: root };

    const firstProcess = manifestHarness(env);
    firstProcess.api.stubHost();
    const firstTurn = JSON.parse(JSON.stringify(await firstProcess.api.invoke({
      phase: "begin_turn",
      gizmo_id: gizmo,
      client_conversation_id: "conversation-stable",
      conversation_id: "conversation-stable",
      turn_id: "turn-1",
      user_message: "one",
    })));
    const secondTurn = JSON.parse(JSON.stringify(await firstProcess.api.invoke({
      phase: "begin_turn",
      gizmo_id: gizmo,
      client_conversation_id: "conversation-stable",
      conversation_id: "conversation-stable",
      turn_id: "turn-2",
      user_message: "two",
    })));
    assert.equal(firstTurn.session_id, secondTurn.session_id);
    assert.equal(firstTurn.is_first_turn, true);
    assert.equal(secondTurn.is_first_turn, false);

    const restartedProcess = manifestHarness(env);
    restartedProcess.api.stubHost();
    const afterRestart = JSON.parse(JSON.stringify(await restartedProcess.api.invoke({
      phase: "begin_turn",
      gizmo_id: gizmo,
      client_conversation_id: "conversation-stable",
      conversation_id: "conversation-stable",
      turn_id: "turn-3",
      user_message: "three",
    })));
    assert.notEqual(afterRestart.session_id, firstTurn.session_id);
    assert.equal(afterRestart.is_first_turn, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("feature descriptors are opt-in across main, extracted preload, and ChatGPT webview phases", () => {
  assert.deepEqual(
    descriptors.map((descriptor) => [descriptor.id, descriptor.phase, descriptor.ciPolicy]),
    [
      ["hermes-chat-lifecycle-main-ipc", "main-bundle", "opt-in"],
      ["hermes-chat-lifecycle-preload-ipc", "extracted-app:pre-webview", "opt-in"],
      ["hermes-chat-lifecycle-chatgpt-turn", "webview-asset", "opt-in"],
    ],
  );
});

test("main patch registers a trusted dedicated lifecycle IPC handler and is idempotent", () => {
  const source = [
    "let l={ipcMain:{on(){},handle(){}}},r={at:'a'};",
    "function hFe({buildFlavor:e,getContextForWebContents:t,isTrustedIpcEvent:n}){",
    "l.ipcMain.on(r.at,e=>{if(!n(e))return})}",
  ].join("");
  const patched = applyTwice(patchMainBundle, source);
  assert.match(patched, /codexLinuxHermesLifecycleInvoke/);
  assert.ok(patched.includes(`ipcMain.handle(\`${IPC_CHANNEL}\``));
  assert.match(patched, /if\(!n\(e\)\)return\{ok:!1,enabled:!1,error:`untrusted-ipc`\}/);
  assert.match(patched, /CODEX_HERMES_QA_FAULT===`model_call_error`/);
  assert.match(patched, /r\.phase===`close_session`&&a\?\.ok===!0/);
  assert.match(patched, /e\.phase===`conversation_identity`/);
  assert.ok(patched.includes('let k=codexLinuxHermesLifecycleKey({client_conversation_id:cn}),s=codexLinuxHermesLifecycleSessions.get(k)'));
  assert.ok(patched.includes('codexLinuxHermesLifecycleSessions.set(k,s),r.session_id=s.sessionId'));
  assert.match(patched, /codexLinuxHermesLifecycleSessions\.delete/);
  new vm.Script(patched);
});

test("main patch upgrades an already-patched owned runtime block to the current plain-Chat runtime", () => {
  const source = [
    "let l={ipcMain:{on(){},handle(){}}},r={at:'a'};",
    "function hFe({buildFlavor:e,getContextForWebContents:t,isTrustedIpcEvent:n}){",
    "l.ipcMain.on(r.at,e=>{if(!n(e))return})}",
  ].join("");
  const current = patchMainBundle(source);
  const currentGate = "if(t&&!n.has(t))return{ok:!0,enabled:!1,reason:`gizmo-not-registered`};";
  const legacyGate = "if(!t||!n.has(t))return{ok:!0,enabled:!1,reason:`gizmo-not-registered`};";
  assert.ok(current.includes(currentGate));
  const legacy = current.replace(currentGate, legacyGate);
  assert.notEqual(legacy, current);
  assert.equal(patchMainBundle(legacy), current);
  assert.equal(patchMainBundle(current), current);
  assert.throws(
    () => patchMainBundle(`prefix/*codexLinuxHermesLifecycleInvoke*/suffix`),
    /main runtime marker exists without one owned runtime block/,
  );
});

test("preload patch exposes hermesChatLifecycle on electronBridge and is idempotent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-chat-lifecycle-preload-"));
  try {
    const build = path.join(root, ".vite", "build");
    fs.mkdirSync(build, { recursive: true });
    const preload = path.join(build, "preload.js");
    fs.writeFileSync(
      preload,
      "let e=require('electron'),w='community';let F={getBuildFlavor:()=>w,isDeviceCheckSupported:()=>!0};",
      "utf8",
    );
    assert.deepEqual(patchPreload(root).changed, 1);
    assert.deepEqual(patchPreload(root).changed, 0);
    const patched = fs.readFileSync(preload, "utf8");
    assert.ok(patched.includes("hermesChatLifecycle:t=>e.ipcRenderer.invoke"));
    assert.ok(patched.includes(IPC_CHANNEL));
    new vm.Script(patched);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("renderer patch injects begin and terminal lifecycle calls into user ChatGPT turns", () => {
  const source = [
    "'oneTurnDeveloperInstructions conversation_mode startCompletionStream';",
    "async function Xgi(e,t){",
    "let u='client',d=null,o={author:{role:`user`},content:{content_type:`text`,parts:[`hi`]}},s='turn',r='model';",
    "let f=0,p0=0,m=t.projectId??e.get(rB,u),h=t.conversationOrigin===void 0?e.get(tB,u):t.conversationOrigin;",
    "let p=await e.get(yR).startCompletionStream();",
    "let be=t=>{ve(t,`completed`)&&(Vfi(t),done())},",
    "xe=n=>{if(!ve(n.requestId,`failed`))return;failed()},",
    "z={logCancellation:()=>ye({result:`canceled`})};",
    "let g='stream',x=(Lqr({scope:e,conversationId:u,streamRequestId:g}),{conversationId:u,serverConversationId:d,streamRequestId:g});return h}",
    "function Lz(e,t){return{currentNode:e(Hx,t),error:e(Kx,t),isDoNotRemember:e(Yx,t),moderationDisclaimersByMessageId:e(Zx,t),mapping:e(Xx,t),projectId:e(Qx,t),status:e(Ex,t),streamRequestId:e(Tx,t),title:e(Nx,t)}}",
    "async function e_i(e,t,n){if(e.get(CH,t)||e.get(wJr,t))return;return n}",
  ].join("");
  const patched = applyTwice(patchRendererAsset, source);
  assert.match(patched, /phase:`probe`/);
  assert.match(patched, /phase:`begin_turn`/);
  assert.match(patched, /if\(o\?\.author\.role===`user`\)try\{/);
  assert.doesNotMatch(patched, /o\?\.author\.role===`user`&&typeof m===`string`&&m\.length>0/);
  assert.match(patched, /phase:`pre_api_request`/);
  assert.match(patched, /codexLinuxHermesMessageText=m=>/);
  assert.match(patched, /user_message:codexLinuxHermesMessageText\(o\)/);
  assert.match(patched, /assistant_message:codexLinuxHermesMessageText\(g\)/);
  assert.match(
    patched,
    /\/\*codexLinuxHermesAssistantState\*\/let a=e\.get\(Hx,u\),h=e\.get\(Xx,u\)\?\?\{\},g=a==null\?null:h\[a\]\?\.message\?\?null;/,
  );
  assert.doesNotMatch(patched, /let a=e\.get\(Qx,u\),h=e\.get\(Nx,u\)/);
  assert.doesNotMatch(patched, /user_message:o[,}]/);
  assert.doesNotMatch(patched, /assistant_message:g[,}]/);
  assert.match(patched, /qaFault:q\.qa_fault\?\?null/);
  assert.match(patched, /qaFault===`model_call_error`/);
  assert.match(patched, /xe\(\{error:`qa-injected-model-call-error`/);
  assert.match(patched, /qa-injected-model-call-error/);
  assert.match(patched, /__codexLinuxHermesLifecyclePreflights/);
  assert.match(patched, /codexLinuxHermesPendingPreflight\.cancelled=!0;if\(!codexLinuxHermesPendingPreflight\.started\)return/);
  assert.match(patched, /codexLinuxHermesNotify\(`complete_turn`,\{server_conversation_id:ie\}\)/);
  assert.match(patched, /codexLinuxHermesNotify\(`model_call_error`/);
  assert.match(patched, /codexLinuxHermesNotify\(`abort_turn`\)/);
  assert.match(patched, /a_i\(n\.system_context,rp\(\),!0\)/);
  assert.match(patched, /i_i\(n\.user_context,\[\],\{is_visually_hidden_from_conversation:!0,is_contextual_retry_user_message:!0,exclude_after_next_user_message:!0\},\[\],rp\(\)\)/);
  assert.doesNotMatch(patched, /a_i\(n\.context/);
  assert.doesNotMatch(patched, /a_i\(n\.user_context/);
  new vm.Script(patched);
});

test("renderer patch upgrades project-gated and unversioned plain-Chat lifecycle patches", () => {
  const source = [
    "'oneTurnDeveloperInstructions conversation_mode startCompletionStream';",
    "async function Xgi(e,t){",
    "let u='client',d=null,o={author:{role:`user`},content:{content_type:`text`,parts:[`hi`]}},s='turn',r='model';",
    "let f=0,p0=0,m=t.projectId??e.get(rB,u),h=t.conversationOrigin===void 0?e.get(tB,u):t.conversationOrigin;",
    "let p=await e.get(yR).startCompletionStream();",
    "let be=t=>{ve(t,`completed`)&&(Vfi(t),done())},",
    "xe=n=>{if(!ve(n.requestId,`failed`))return;failed()},",
    "z={logCancellation:()=>ye({result:`canceled`})};",
    "let g='stream',x=(Lqr({scope:e,conversationId:u,streamRequestId:g}),{conversationId:u,serverConversationId:d,streamRequestId:g});return h}",
    "function Lz(e,t){return{currentNode:e(Hx,t),error:e(Kx,t),isDoNotRemember:e(Yx,t),moderationDisclaimersByMessageId:e(Zx,t),mapping:e(Xx,t),projectId:e(Qx,t),status:e(Ex,t),streamRequestId:e(Tx,t),title:e(Nx,t)}}",
    "async function e_i(e,t,n){if(e.get(CH,t)||e.get(wJr,t))return;return n}",
  ].join("");
  const current = patchRendererAsset(source);
  const marker = "/*codexLinuxHermesPlainChatLifecycle*/";
  const currentGate = `if(o?.author.role===\`user\`)try{${marker}`;
  const legacyGate = "if(o?.author.role===`user`&&typeof m===`string`&&m.length>0)try{";
  assert.ok(current.includes(currentGate));

  const legacy = current.replace(currentGate, legacyGate);
  assert.notEqual(legacy, current);
  assert.equal(patchRendererAsset(legacy), current);

  const unversioned = current.replace(marker, "");
  assert.notEqual(unversioned, current);
  assert.equal(patchRendererAsset(unversioned), current);

  const assistantMarker = "/*codexLinuxHermesAssistantState*/";
  const legacyAssistantState = current.replace(
    `${assistantMarker}let a=e.get(Hx,u),h=e.get(Xx,u)??{},g=a==null?null:h[a]?.message??null;`,
    "let a=e.get(Qx,u),h=e.get(Nx,u)??{},g=a==null?null:h[a]?.message??null;",
  );
  assert.notEqual(legacyAssistantState, current);
  assert.equal(patchRendererAsset(legacyAssistantState), current);

  const completionOrder = current.match(
    /([A-Za-z_$][\w$]*)\(t\),codexLinuxHermesNotify\(`complete_turn`,\{server_conversation_id:ie\}\)/,
  );
  assert.ok(completionOrder);
  const oldCompletionOrder = current.replace(
    completionOrder[0],
    `codexLinuxHermesNotify(\`complete_turn\`,{server_conversation_id:ie}),${completionOrder[1]}(t)`,
  );
  assert.notEqual(oldCompletionOrder, current);
  assert.equal(patchRendererAsset(oldCompletionOrder), current);
  assert.equal(patchRendererAsset(current), current);
});

test("renderer patch follows current upstream minified identifiers structurally", () => {
  const source = [
    "'oneTurnDeveloperInstructions conversation_mode startCompletionStream';",
    "async function Xgi(e,t){",
    "let u='client',d=null,o={author:{role:`user`},content:{content_type:`text`,parts:[`hi`]}},s='turn',r='model';",
    "let f=0,p0=0,m=t.projectId??e.get(dB,u),h=t.conversationOrigin===void 0?e.get(lB,u):t.conversationOrigin;",
    "let p=await e.get(wR).startCompletionStream();",
    "let be=t=>{ve(t,`completed`)&&(Gfi(t),done())},",
    "xe=n=>{if(!ve(n.requestId,`failed`))return;failed()},",
    "z={logCancellation:()=>ye({result:`canceled`})};",
    "let g='stream',x=(Nqr({scope:e,conversationId:u,streamRequestId:g}),{conversationId:u,serverConversationId:d,streamRequestId:g});return h}",
    "function Lz2(e,t){return{currentNode:e(H2,t),error:e(K2,t),isDoNotRemember:e(Y2,t),moderationDisclaimersByMessageId:e(Z2,t),mapping:e(X2,t),projectId:e(Q2,t),status:e(E2,t),streamRequestId:e(T2,t),title:e(N2,t)}}",
    "async function i_i(e,t,n){if(e.get(CH,t)||e.get(bJr,t))return;let r=e.get(aB,t),i=e.get(mB,t);if(r==null&&i==null)return n}",
  ].join("");
  const patched = patchRendererAsset(source);
  assert.notEqual(patched, source);
  assert.match(patched, /async function i_i\(e,t,n\)\{let codexLinuxHermesPendingPreflight=/);
  assert.match(patched, /Nqr\(\{scope:e,conversationId:u,streamRequestId:g\}\),codexLinuxHermesPreflightMap\.delete\(u\)/);
  assert.match(patched, /Gfi\(t\),codexLinuxHermesNotify\(`complete_turn`,\{server_conversation_id:ie\}\)/);
  assert.match(
    patched,
    /\/\*codexLinuxHermesAssistantState\*\/let a=e\.get\(H2,u\),h=e\.get\(X2,u\)\?\?\{\},g=a==null\?null:h\[a\]\?\.message\?\?null;/,
  );
});

test("renderer patch leaves unrelated assets unchanged", () => {
  const source = "console.log('ordinary asset')";
  assert.equal(patchRendererAsset(source), source);
});

test("Python helper persists distinct local-handle and server-id aliases across restart", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-chat-lifecycle-alias-"));
  try {
    const stateDir = path.join(root, "state");
    const localId = "local-chatgpt:7a2e7014-62a7-49b6-b54a-ed660474d8b1";
    const serverId = "6aa01de9-19d4-83e8-b789-6979e6ecbf3b";
    const run = (payload) => spawnSync(
      "python3",
      [
        "-c",
        [
          "import importlib.util, json, sys",
          "spec = importlib.util.spec_from_file_location('lifecycle_helper_under_test', sys.argv[1])",
          "module = importlib.util.module_from_spec(spec)",
          "sys.modules[spec.name] = module",
          "spec.loader.exec_module(module)",
          "payload = json.loads(sys.argv[2])",
          "print(module._canonical_conversation_id(payload))",
        ].join("; "),
        HELPER,
        JSON.stringify(payload),
      ],
      {
        encoding: "utf8",
        env: isolatedHermesPythonEnv({ CODEX_LINUX_APP_STATE_DIR: stateDir }),
      },
    );

    const created = run({ client_conversation_id: localId, conversation_id: localId });
    assert.equal(created.status, 0, created.stderr);
    assert.equal(created.stdout.trim(), localId);

    const assigned = run({ client_conversation_id: localId, conversation_id: localId, server_conversation_id: serverId });
    assert.equal(assigned.status, 0, assigned.stderr);
    assert.equal(assigned.stdout.trim(), localId);

    const reopened = run({ conversation_id: serverId });
    assert.equal(reopened.status, 0, reopened.stderr);
    assert.equal(reopened.stdout.trim(), localId);

    const resolvedLocalAlias = run({ client_conversation_id: localId, conversation_id: localId });
    assert.equal(resolvedLocalAlias.status, 0, resolvedLocalAlias.stderr);
    assert.equal(resolvedLocalAlias.stdout.trim(), localId);

    const conflictingServerId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const conflictingAssignment = run({ client_conversation_id: localId, conversation_id: conflictingServerId });
    assert.equal(conflictingAssignment.status, 0, conflictingAssignment.stderr);
    assert.equal(conflictingAssignment.stdout.trim(), localId);

    const aliases = JSON.parse(fs.readFileSync(path.join(stateDir, "hermes-chat-conversation-aliases.json"), "utf8"));
    assert.deepEqual(aliases, {
      version: 1,
      aliases: { [localId]: serverId },
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Python helper binds a reopened server-ID-only tool session to its saved local key", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-chat-lifecycle-tool-reopen-"));
  try {
    const stateDir = path.join(root, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const localId = "local-chatgpt:83800000-0000-4000-8000-000000000000";
    const serverId = "6aa0c239-0000-4000-8000-000000000000";
    fs.writeFileSync(
      path.join(stateDir, "hermes-chat-conversation-aliases.json"),
      JSON.stringify({ version: 1, aliases: { [localId]: serverId } }),
      "utf8",
    );

    const result = spawnSync(
      "python3",
      [
        "-c",
        [
          "import importlib.util, sys",
          "spec = importlib.util.spec_from_file_location('lifecycle_helper_under_test', sys.argv[1])",
          "module = importlib.util.module_from_spec(spec)",
          "sys.modules[spec.name] = module",
          "spec.loader.exec_module(module)",
          "module._create_memory_manager = lambda session_id: (None, '')",
          "module._load_hermes = lambda: {'get_plugin_context_engine': lambda: None, 'get_hermes_home': lambda: '', 'invoke_hook': lambda *args, **kwargs: []}",
          "runtime = module._ensure_tool_session('', sys.argv[2])",
          "print(runtime.conversation_id)",
          "print(runtime.task_id)",
        ].join("; "),
        HELPER,
        serverId,
      ],
      {
        encoding: "utf8",
        env: isolatedHermesPythonEnv({ CODEX_LINUX_APP_STATE_DIR: stateDir }),
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split("\n"), [localId, `chatgpt-codex:${localId}`]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Python helper derives stable task identity from canonical conversation across lifecycle rotation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-chat-lifecycle-task-id-"));
  try {
    const localId = "local-chatgpt:task-id-stable";
    const result = spawnSync(
      "python3",
      [
        "-c",
        [
          "import importlib.util, sys",
          "spec = importlib.util.spec_from_file_location('lifecycle_helper_under_test', sys.argv[1])",
          "module = importlib.util.module_from_spec(spec)",
          "sys.modules[spec.name] = module",
          "spec.loader.exec_module(module)",
          "print(module._task_id(sys.argv[2], 'hs_codex_epoch_one'))",
          "print(module._task_id(sys.argv[2], 'hs_codex_epoch_two'))",
          "print(module._task_id('', 'hs_codex_fallback'))",
        ].join("; "),
        HELPER,
        localId,
      ],
      {
        encoding: "utf8",
        env: isolatedHermesPythonEnv({ CODEX_LINUX_APP_STATE_DIR: path.join(root, "state") }),
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split("\n"), [
      `chatgpt-codex:${localId}`,
      `chatgpt-codex:${localId}`,
      "chatgpt-codex:hs_codex_fallback",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Python helper forwards native hook context without requiring the real Hermes install", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-chat-lifecycle-helper-"));
  try {
    writeFakeDaemonPool(root);
    const packageDir = path.join(root, "hermes_cli");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, "__init__.py"), "", "utf8");
    fs.writeFileSync(
      path.join(packageDir, "lifecycle.py"),
      [
        "def invoke_hook(name, **kwargs):",
        "    if name == 'pre_llm_call':",
        "        return [{'context': 'native plugin context'}]",
        "    if name == 'post_llm_call':",
        "        return [{'observed': True}]",
        "    return []",
        "def finalize_session(**kwargs):",
        "    return []",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(packageDir, "config.py"),
      [
        "def load_config():",
        "    return {'memory': {'provider': ''}}",
        "def cfg_get(cfg, *keys, default=None):",
        "    node = cfg",
        "    for key in keys:",
        "        if not isinstance(node, dict) or key not in node:",
        "            return default",
        "        node = node[key]",
        "    return node",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(path.join(packageDir, "profiles.py"), "def get_active_profile_name():\n    return ''\n", "utf8");
    fs.writeFileSync(path.join(packageDir, "plugins.py"), "def get_plugin_context_engine():\n    return None\n", "utf8");

    const agentDir = path.join(root, "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "__init__.py"), "", "utf8");
    fs.writeFileSync(
      path.join(agentDir, "memory_manager.py"),
      [
        "def build_memory_context_block(raw_context):",
        "    return '<memory-context>\\n' + raw_context + '\\n</memory-context>' if raw_context else ''",
        "class MemoryManager:",
        "    pass",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(agentDir, "memory_provider.py"),
      "def is_trivial_prompt(text):\n    return False\n",
      "utf8",
    );

    const pluginsMemoryDir = path.join(root, "plugins", "memory");
    fs.mkdirSync(pluginsMemoryDir, { recursive: true });
    fs.writeFileSync(path.join(root, "plugins", "__init__.py"), "", "utf8");
    fs.writeFileSync(
      path.join(pluginsMemoryDir, "__init__.py"),
      "def load_memory_provider(name):\n    return None\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(root, "hermes_constants.py"),
      "def get_hermes_home():\n    return '.'\n",
      "utf8",
    );
    const stateDir = path.join(root, "state");
    const begin = spawnSync("python3", [HELPER], {
      encoding: "utf8",
      env: isolatedHermesPythonEnv({ HERMES_AGENT_ROOT: root, CODEX_LINUX_APP_STATE_DIR: stateDir }),
      input: JSON.stringify({
        phase: "begin_turn",
        session_id: "hs_test",
        turn_id: "turn-1",
        gizmo_id: "g-test",
        conversation_id: "conversation-1",
        user_message: "hello",
        model: "test-model",
        is_first_turn: true,
      }),
    });
    assert.equal(begin.status, 0, begin.stderr || begin.stdout);
    const response = JSON.parse(begin.stdout);
    assert.equal(response.ok, true);
    assert.equal(response.system_context, "");
    assert.equal(response.user_context, "native plugin context");
    assert.equal(response.hook_result_count, 1);

    const complete = spawnSync("python3", [HELPER], {
      encoding: "utf8",
      env: isolatedHermesPythonEnv({ HERMES_AGENT_ROOT: root, CODEX_LINUX_APP_STATE_DIR: stateDir }),
      input: JSON.stringify({
        phase: "complete_turn",
        session_id: "hs_test",
        turn_id: "turn-1",
        gizmo_id: "g-test",
        conversation_id: "conversation-1",
        user_message: "hello",
        assistant_message: "world",
        model: "test-model",
      }),
    });
    assert.equal(complete.status, 0, complete.stderr || complete.stdout);
    assert.equal(JSON.parse(complete.stdout).hook_result_count, 1);

    const events = fs.readFileSync(path.join(stateDir, "hermes-chat-lifecycle.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.event), [
      "session_open",
      "begin_turn",
      "session_finalize",
      "session_open",
      "post_api_request",
      "on_session_end",
      "complete_turn",
      "session_finalize",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("persistent helper preserves one session runtime across multiple turns", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-chat-lifecycle-persistent-"));
  let child = null;
  try {
    writeFakeDaemonPool(root);
    const hermesCli = path.join(root, "hermes_cli");
    const agentDir = path.join(root, "agent");
    const pluginsMemoryDir = path.join(root, "plugins", "memory");
    fs.mkdirSync(hermesCli, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(pluginsMemoryDir, { recursive: true });
    for (const packageDir of [hermesCli, agentDir, path.join(root, "plugins")]) {
      fs.writeFileSync(path.join(packageDir, "__init__.py"), "", "utf8");
    }
    fs.writeFileSync(
      path.join(hermesCli, "lifecycle.py"),
      [
        "def invoke_hook(name, **kwargs):",
        "    if name == 'pre_llm_call':",
        "        return [{'context': 'plugin-turn-' + str(len(kwargs.get('conversation_history') or []))}]",
        "    return []",
        "def finalize_session(**kwargs):",
        "    return []",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(hermesCli, "config.py"),
      [
        "def load_config():",
        "    return {'memory': {'provider': 'fake'}, 'model': {'provider': 'fake-main', 'default': 'fake-model'}, 'skills': {'creation_nudge_interval': 15}, 'auxiliary': {'background_review': {'provider': 'fake-aux', 'model': 'fake-review'}}}",
        "def cfg_get(cfg, *keys, default=None):",
        "    node = cfg",
        "    for key in keys:",
        "        if not isinstance(node, dict) or key not in node:",
        "            return default",
        "        node = node[key]",
        "    return node",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(path.join(hermesCli, "profiles.py"), "def get_active_profile_name():\n    return 'test-profile'\n", "utf8");
    fs.writeFileSync(path.join(hermesCli, "plugins.py"), "def get_plugin_context_engine():\n    return None\n", "utf8");
    fs.writeFileSync(path.join(agentDir, "memory_provider.py"), "def is_trivial_prompt(text):\n    return False\n", "utf8");
    fs.writeFileSync(
      path.join(agentDir, "memory_manager.py"),
      [
        "def build_memory_context_block(raw_context):",
        "    return '<memory-context>\\n' + raw_context + '\\n</memory-context>' if raw_context else ''",
        "class MemoryManager:",
        "    def __init__(self):",
        "        self.turn = 0",
        "        self.synced = 0",
        "    def add_provider(self, provider):",
        "        self.provider = provider",
        "    def initialize_all(self, **kwargs):",
        "        self.session_id = kwargs.get('session_id')",
        "    def on_turn_start(self, turn_number, prompt, **kwargs):",
        "        self.turn = turn_number",
        "    def build_system_prompt(self):",
        "        return 'memory-prompt'",
        "    def prefetch_all(self, prompt, **kwargs):",
        "        return 'memory-turn-' + str(self.turn)",
        "    def describe_recall(self):",
        "        return 'recall-turn-' + str(self.turn)",
        "    def sync_all(self, user, assistant, **kwargs):",
        "        self.synced += 1",
        "    def queue_prefetch_all(self, prompt, **kwargs):",
        "        return None",
        "    def on_session_end(self, history):",
        "        return None",
        "    def shutdown_all(self):",
        "        return None",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginsMemoryDir, "__init__.py"),
      [
        "class FakeProvider:",
        "    def is_available(self):",
        "        return True",
        "def load_memory_provider(name):",
        "    return FakeProvider() if name == 'fake' else None",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(path.join(root, "hermes_constants.py"), "def get_hermes_home():\n    return '.'\n", "utf8");
    fs.writeFileSync(
      path.join(root, "run_agent.py"),
      [
        "import threading",
        "class _Run:",
        "    def __init__(self):",
        "        self.cancel_requested = threading.Event()",
        "        self.request_done = threading.Event()",
        "class AIAgent:",
        "    def __init__(self, provider=None, model='', session_id=None, **kwargs):",
        "        self.provider = provider",
        "        self.model = model",
        "        self.session_id = session_id",
        "        self._skill_nudge_interval = 15",
        "        self._background_review_run = None",
        "        self.background_review_callback = None",
        "    def _spawn_background_review(self, messages_snapshot, review_memory=False, review_skills=False, focus=None, explicit=False):",
        "        run = _Run()",
        "        self._background_review_run = run",
        "        if self.background_review_callback:",
        "            self.background_review_callback('fake skill review action')",
        "        run.request_done.set()",
        "    def close(self):",
        "        return None",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(agentDir, "background_review.py"),
      [
        "def cancel_background_review_for_live_turn(agent):",
        "    run = getattr(agent, '_background_review_run', None)",
        "    if run is not None and not run.request_done.is_set():",
        "        run.cancel_requested.set()",
        "        run.request_done.set()",
      ].join("\n"),
      "utf8",
    );

    const stateDir = path.join(root, "state");
    child = spawn("python3", [HELPER, "--persistent"], {
      env: isolatedHermesPythonEnv({ HERMES_AGENT_ROOT: root, CODEX_LINUX_APP_STATE_DIR: stateDir, CODEX_HERMES_QA_FORCE_SKILL_REVIEW: "1" }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    const waiting = [];
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        const resolve = waiting.shift();
        if (resolve) resolve(JSON.parse(line));
      }
    });
    const request = (payload, requestId) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("persistent helper response timeout")), 5_000);
      waiting.push((response) => {
        clearTimeout(timer);
        resolve(response);
      });
      child.stdin.write(`${JSON.stringify({ ...payload, _request_id: requestId })}\n`);
    });

    const localId = "local-chatgpt:11111111-1111-4111-8111-111111111111";
    const serverId = "22222222-2222-4222-8222-222222222222";
    const begin1 = await request({ phase: "begin_turn", session_id: "hs_persistent", turn_id: "turn-1", gizmo_id: "g-test", client_conversation_id: localId, conversation_id: localId, user_message: "first", model: "test-model" }, "1");
    assert.equal(begin1.ok, true, JSON.stringify(begin1));
    assert.equal(begin1.turn_number, 1);
    assert.equal(begin1.memory_active, true);
    assert.equal(begin1.memory_provider, "fake");
    assert.equal(begin1.system_context, "memory-prompt");
    assert.match(begin1.user_context, /<memory-context>\nmemory-turn-1\n<\/memory-context>/);
    assert.match(begin1.user_context, /plugin-turn-1/);
    assert.doesNotMatch(begin1.system_context, /memory-turn-1|plugin-turn/);

    const preApi1 = await request({ phase: "pre_api_request", session_id: "hs_persistent", turn_id: "turn-1", gizmo_id: "g-test", client_conversation_id: localId, conversation_id: localId, user_message: "first", model: "test-model" }, "2");
    assert.equal(preApi1.api_call_count, 1);
    assert.match(preApi1.api_request_id, /chatgpt-codex:hs_persistent:turn-1:1/);

    const identity = await request({ phase: "conversation_identity", session_id: "hs_persistent", client_conversation_id: localId, conversation_id: serverId, server_conversation_id: serverId }, "identity");
    assert.equal(identity.ok, true, JSON.stringify(identity));
    assert.equal(identity.conversation_id, localId);
    assert.equal(identity.server_conversation_id, serverId);

    const complete1 = await request({ phase: "complete_turn", session_id: "hs_persistent", turn_id: "turn-1", gizmo_id: "g-test", client_conversation_id: localId, conversation_id: serverId, user_message: "first", assistant_message: "one", model: "test-model" }, "3");
    assert.equal(complete1.history_messages, 2);
    assert.equal(complete1.memory_sync_queued, true);
    assert.equal(complete1.background_review.scheduled, true);
    assert.equal(complete1.background_review.forced, true);

    const begin2 = await request({ phase: "begin_turn", session_id: "hs_persistent", turn_id: "turn-2", gizmo_id: "g-test", conversation_id: "conversation-1", user_message: "second", model: "test-model" }, "4");
    assert.equal(begin2.turn_number, 2);
    assert.equal(begin2.system_context, "memory-prompt");
    assert.match(begin2.user_context, /memory-turn-2/);
    assert.match(begin2.user_context, /plugin-turn-3/);

    const close = await request({ phase: "close_session", session_id: "hs_persistent", gizmo_id: "g-test", conversation_id: "conversation-1", reason: "test-close" }, "5");
    assert.equal(close.ok, true);
    assert.equal(close.phase, "close_session");

    const beginAfterClose = await request({ phase: "begin_turn", session_id: "hs_persistent", turn_id: "turn-3", gizmo_id: "g-test", conversation_id: "conversation-1", user_message: "fresh", model: "test-model" }, "6");
    assert.equal(beginAfterClose.turn_number, 1);
    assert.equal(beginAfterClose.system_context, "memory-prompt");
    assert.match(beginAfterClose.user_context, /memory-turn-1/);

    const closeAgain = await request({ phase: "close_session", session_id: "hs_persistent", gizmo_id: "g-test", conversation_id: "conversation-1", reason: "test-close-again" }, "7");
    assert.equal(closeAgain.ok, true);

    await new Promise((resolve) => setTimeout(resolve, 50));
    child.stdin.end();
    await new Promise((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });

    const events = fs.readFileSync(path.join(stateDir, "hermes-chat-lifecycle.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events.filter((event) => event.event === "session_open").length, 2);
    assert.equal(events.filter((event) => event.event === "conversation_identity_promoted").length, 0);
    const aliases = JSON.parse(fs.readFileSync(path.join(stateDir, "hermes-chat-conversation-aliases.json"), "utf8"));
    assert.equal(aliases.aliases[localId], serverId);
    assert.equal(events.filter((event) => event.event === "begin_turn").length, 3);
    assert.equal(events.filter((event) => event.event === "pre_api_request").length, 1);
    assert.equal(events.filter((event) => event.event === "post_api_request").length, 1);
    assert.equal(events.filter((event) => event.event === "on_session_end").length, 1);
    assert.equal(events.filter((event) => event.event === "complete_turn").length, 1);
    assert.equal(events.filter((event) => event.event === "memory_session_end").length, 2);
    assert.equal(events.filter((event) => event.event === "memory_shutdown").length, 2);
    assert.equal(events.filter((event) => event.event === "session_finalize").length, 2);
    assert.equal(events.filter((event) => event.event === "session_close").length, 2);
    assert.equal(events.filter((event) => event.event === "background_review_host_ready").length, 1);
    assert.equal(events.filter((event) => event.event === "background_review_spawned").length, 1);
    assert.equal(events.filter((event) => event.event === "background_review_complete").length, 1);
    assert.equal(events.filter((event) => event.event === "background_review_action").length, 1);
    assert.equal(events.filter((event) => event.event === "background_review_host_close").length, 1);
  } finally {
    if (child && child.exitCode == null && !child.killed) child.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("persistent helper records tool_call phases into the shared transcript (plain Chat, no gizmo)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-chat-lifecycle-toolcall-"));
  let child = null;
  try {
    writeFakeDaemonPool(root);
    const hermesCli = path.join(root, "hermes_cli");
    const agentDir = path.join(root, "agent");
    const pluginsMemoryDir = path.join(root, "plugins", "memory");
    fs.mkdirSync(hermesCli, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(pluginsMemoryDir, { recursive: true });
    for (const packageDir of [hermesCli, agentDir, path.join(root, "plugins")]) {
      fs.writeFileSync(path.join(packageDir, "__init__.py"), "", "utf8");
    }
    fs.writeFileSync(
      path.join(hermesCli, "lifecycle.py"),
      [
        "def invoke_hook(name, **kwargs):",
        "    return []",
        "def finalize_session(**kwargs):",
        "    return []",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(hermesCli, "config.py"),
      [
        "def load_config():",
        "    return {'memory': {'provider': 'fake'}}",
        "def cfg_get(cfg, *keys, default=None):",
        "    node = cfg",
        "    for key in keys:",
        "        if not isinstance(node, dict) or key not in node:",
        "            return default",
        "        node = node[key]",
        "    return node",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(path.join(hermesCli, "profiles.py"), "def get_active_profile_name():\n    return 'test-profile'\n", "utf8");
    fs.writeFileSync(path.join(hermesCli, "plugins.py"), "def get_plugin_context_engine():\n    return None\n", "utf8");
    fs.writeFileSync(path.join(agentDir, "memory_provider.py"), "def is_trivial_prompt(text):\n    return False\n", "utf8");
    fs.writeFileSync(
      path.join(agentDir, "memory_manager.py"),
      [
        "def build_memory_context_block(raw_context):",
        "    return ''",
        "class MemoryManager:",
        "    def __init__(self):",
        "        pass",
        "    def add_provider(self, provider):",
        "        pass",
        "    def initialize_all(self, **kwargs):",
        "        pass",
        "    def on_turn_start(self, turn_number, prompt, **kwargs):",
        "        pass",
        "    def build_system_prompt(self):",
        "        return ''",
        "    def prefetch_all(self, prompt, **kwargs):",
        "        return ''",
        "    def sync_all(self, user, assistant, **kwargs):",
        "        pass",
        "    def on_session_end(self, history):",
        "        import json, os",
        "        p = os.path.join(os.environ.get('CODEX_LINUX_APP_STATE_DIR', '.'), 'session-end-history.json')",
        "        with open(p, 'a', encoding='utf-8') as f:",
        "            f.write(json.dumps({'history': history}) + '\\n')",
        "    def shutdown_all(self):",
        "        pass",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginsMemoryDir, "__init__.py"),
      [
        "class FakeProvider:",
        "    def is_available(self):",
        "        return True",
        "def load_memory_provider(name):",
        "    return FakeProvider() if name == 'fake' else None",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(path.join(root, "hermes_constants.py"), "def get_hermes_home():\n    return '.'\n", "utf8");
    // Fake registry: two bare tools plus the three bridge names (bridge names are
    // intercepted before the registry by handle_function_call, which this fake
    // mirrors by serving them directly from the same entry point).
    fs.writeFileSync(
      path.join(root, "model_tools.py"),
      [
        "import json, os",
        "def discover_builtin_tools():",
        "    pass",
        "def get_all_tool_names():",
        "    return ['read_file', 'search_files', 'web_search']",
        "def handle_function_call(function_name, function_args, task_id=None, tool_call_id=None, session_id=None, turn_id=None, **kwargs):",
        "    p = os.path.join(os.environ.get('CODEX_LINUX_APP_STATE_DIR', '.'), 'tool-exec.jsonl')",
        "    with open(p, 'a', encoding='utf-8') as f:",
        "        f.write(json.dumps({'name': function_name, 'args': function_args, 'task_id': task_id, 'session_id': session_id, 'tool_call_id': tool_call_id}) + '\\n')",
        "    if function_name == 'tool_search':",
        "        return json.dumps({'queries': ['x'], 'total_available': 1, 'results': [{'query': 'x', 'matches': ['read_file']}], 'tools': {}})",
        "    if function_name == 'tool_describe':",
        "        return json.dumps({'tools': {'read_file': {'description': 'd', 'parameters': {}}}})",
        "    if function_name == 'tool_call':",
        "        return json.dumps({'ok': True, 'underlying': function_args.get('name')})",
        "    if function_name not in get_all_tool_names():",
        "        raise ValueError('Unknown tool: ' + function_name)",
        "    return json.dumps({'content': 'FAKE-RESULT-' + function_name})",
      ].join("\n"),
      "utf8",
    );

    const stateDir = path.join(root, "state");
    const env = isolatedHermesPythonEnv({ HERMES_AGENT_ROOT: root, CODEX_LINUX_APP_STATE_DIR: stateDir });
    child = spawn("python3", [HELPER, "--persistent"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    const waiting = [];
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        const resolve = waiting.shift();
        if (resolve) resolve(JSON.parse(line));
      }
    });
    const request = (payload, requestId) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("persistent helper response timeout")), 5_000);
      waiting.push((response) => {
        clearTimeout(timer);
        resolve(response);
      });
      child.stdin.write(`${JSON.stringify({ ...payload, _request_id: requestId })}\n`);
    });

    const toolCall = {
      phase: "tool_call",
      name: "hermes_read_file",
      arguments: { path: "/tmp/fixture" },
      callId: "call-1",
      conversationId: "conversation-1",
      session_id: "hs_codex_tooltest1",
      client_conversation_id: "conversation-1",
      conversation_id: "conversation-1",
    };

    // 1) bare registry tool: executes, records tool_call + tool rows.
    const r1 = await request(toolCall, "1");
    assert.equal(r1.ok, true, JSON.stringify(r1));
    assert.equal(r1.phase, "tool_call");
    assert.equal(r1.name, "hermes_read_file");
    assert.equal(r1.registry_name, "read_file");
    assert.equal(r1.session_id, "hs_codex_tooltest1");
    assert.deepEqual(r1.result, { content: "FAKE-RESULT-read_file" });
    assert.equal(r1.history_messages, 2);

    // 2) bridge meta-tool: the hermes_ prefix maps onto the bridge dispatch.
    const r2 = await request({ ...toolCall, name: "hermes_tool_search", arguments: { queries: "read" }, callId: "call-2" }, "2");
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.equal(r2.registry_name, "tool_search");
    assert.equal(r2.session_id, "hs_codex_tooltest1");
    assert.equal(r2.history_messages, 4);
    assert.equal(r2.result.total_available, 1);

    // 3) unknown advertised name: truthful registry error, transcript untouched.
    const r3 = await request({ ...toolCall, name: "hermes_does_not_exist", arguments: {}, callId: "call-3" }, "3");
    assert.equal(r3.ok, false, JSON.stringify(r3));
    assert.equal(r3.enabled, true);
    assert.match(r3.error, /Unknown tool/);
    assert.equal(r3.history_messages, 4);

    // 4) close_session delivers the accumulated transcript to on_session_end.
    const close = await request({ phase: "close_session", session_id: "hs_codex_tooltest1", conversation_id: "conversation-1", reason: "qa" }, "4");
    assert.equal(close.ok, true);

    // 5) a different conversation gets a distinct runtime.
    const r5 = await request({ ...toolCall, conversationId: "conversation-2", session_id: "hs_codex_tooltest2", client_conversation_id: "conversation-2", conversation_id: "conversation-2", callId: "call-4" }, "5");
    assert.equal(r5.ok, true, JSON.stringify(r5));
    assert.equal(r5.session_id, "hs_codex_tooltest2");
    assert.equal(r5.history_messages, 2);

    await new Promise((resolve) => setTimeout(resolve, 50));
    child.stdin.end();
    await new Promise((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });

    // Executed registry calls: bare + bridge only; the unknown tool was refused
    // before execution; identity fields carried through.
    const execs = fs.readFileSync(path.join(stateDir, "tool-exec.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(
      execs.map((e) => [e.name, e.session_id, e.tool_call_id]),
      [
        ["read_file", "hs_codex_tooltest1", "call-1"],
        ["tool_search", "hs_codex_tooltest1", "call-2"],
        // The unknown hermes_* name is a pass-through: it reaches the registry
        // under its advertised name (prefix not stripped, because it is not a
        // known tool) and the registry's own "Unknown tool" error is surfaced.
        ["hermes_does_not_exist", "hs_codex_tooltest1", "call-3"],
        ["read_file", "hs_codex_tooltest2", "call-4"],
      ],
    );
    assert.equal(execs[0].task_id, "chatgpt-codex:conversation-1");
    assert.equal(execs[1].task_id, "chatgpt-codex:conversation-1");
    assert.equal(execs[2].task_id, "chatgpt-codex:conversation-1");
    assert.equal(execs[3].task_id, "chatgpt-codex:conversation-2");

    // Session close delivered the tool transcript to the memory provider.
    const endHistories = fs.readFileSync(path.join(stateDir, "session-end-history.json"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line).history);
    assert.equal(endHistories.length, 2);
    assert.deepEqual(
      endHistories[0].map((m) => [m.role, m.tool_name, m.tool_call_id]),
      [
        ["tool_call", "read_file", "call-1"],
        ["tool", "read_file", "call-1"],
        ["tool_call", "tool_search", "call-2"],
        ["tool", "tool_search", "call-2"],
      ],
    );
    assert.equal(endHistories[0][0].content, "read_file");
    assert.equal(endHistories[0][0].args.path, "/tmp/fixture");
    assert.deepEqual(endHistories[1].map((m) => [m.role, m.tool_name]), [["tool_call", "read_file"], ["tool", "read_file"]]);

    // Diagnostics log the calls with the host-owned session identity.
    const events = fs.readFileSync(path.join(stateDir, "hermes-chat-lifecycle.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.filter((event) => event.event === "tool_call").length, 3);
    assert.equal(events.filter((event) => event.event === "tool_call_error").length, 1);
    assert.equal(events.filter((event) => event.event === "session_open").length, 2);
    const openEvents = events.filter((event) => event.event === "session_open");
    assert.equal(openEvents[0].conversation_id, "conversation-1");
    assert.equal(openEvents[0].task_id, "chatgpt-codex:conversation-1");
    assert.equal(openEvents[1].conversation_id, "conversation-2");
    assert.equal(openEvents[1].task_id, "chatgpt-codex:conversation-2");
  } finally {
    if (child && child.exitCode == null && !child.killed) child.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
