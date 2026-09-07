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
  assert.match(patched, /codexLinuxHermesLifecycleSessions\.delete/);
  new vm.Script(patched);
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
    "async function e_i(e,t,n){if(e.get(CH,t)||e.get(wJr,t))return;return n}",
  ].join("");
  const patched = applyTwice(patchRendererAsset, source);
  assert.match(patched, /phase:`probe`/);
  assert.match(patched, /phase:`begin_turn`/);
  assert.match(patched, /phase:`pre_api_request`/);
  assert.match(patched, /codexLinuxHermesMessageText=m=>/);
  assert.match(patched, /user_message:codexLinuxHermesMessageText\(o\)/);
  assert.match(patched, /assistant_message:codexLinuxHermesMessageText\(g\)/);
  assert.doesNotMatch(patched, /user_message:o[,}]/);
  assert.doesNotMatch(patched, /assistant_message:g[,}]/);
  assert.match(patched, /qaFault:q\.qa_fault\?\?null/);
  assert.match(patched, /qaFault===`model_call_error`/);
  assert.match(patched, /xe\(\{error:`qa-injected-model-call-error`/);
  assert.match(patched, /qa-injected-model-call-error/);
  assert.match(patched, /__codexLinuxHermesLifecyclePreflights/);
  assert.match(patched, /codexLinuxHermesPendingPreflight\.cancelled=!0;if\(!codexLinuxHermesPendingPreflight\.started\)return/);
  assert.match(patched, /codexLinuxHermesNotify\(`complete_turn`\)/);
  assert.match(patched, /codexLinuxHermesNotify\(`model_call_error`/);
  assert.match(patched, /codexLinuxHermesNotify\(`abort_turn`\)/);
  assert.match(patched, /a_i\(n\.system_context,rp\(\),!0\)/);
  assert.match(patched, /i_i\(n\.user_context,\[\],\{is_visually_hidden_from_conversation:!0,is_contextual_retry_user_message:!0,exclude_after_next_user_message:!0\},\[\],rp\(\)\)/);
  assert.doesNotMatch(patched, /a_i\(n\.context/);
  assert.doesNotMatch(patched, /a_i\(n\.user_context/);
  new vm.Script(patched);
});

test("renderer patch leaves unrelated assets unchanged", () => {
  const source = "console.log('ordinary asset')";
  assert.equal(patchRendererAsset(source), source);
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

    const begin1 = await request({ phase: "begin_turn", session_id: "hs_persistent", turn_id: "turn-1", gizmo_id: "g-test", conversation_id: "conversation-1", user_message: "first", model: "test-model" }, "1");
    assert.equal(begin1.ok, true, JSON.stringify(begin1));
    assert.equal(begin1.turn_number, 1);
    assert.equal(begin1.memory_active, true);
    assert.equal(begin1.memory_provider, "fake");
    assert.equal(begin1.system_context, "memory-prompt");
    assert.match(begin1.user_context, /<memory-context>\nmemory-turn-1\n<\/memory-context>/);
    assert.match(begin1.user_context, /plugin-turn-1/);
    assert.doesNotMatch(begin1.system_context, /memory-turn-1|plugin-turn/);

    const preApi1 = await request({ phase: "pre_api_request", session_id: "hs_persistent", turn_id: "turn-1", gizmo_id: "g-test", conversation_id: "conversation-1", user_message: "first", model: "test-model" }, "2");
    assert.equal(preApi1.api_call_count, 1);
    assert.match(preApi1.api_request_id, /chatgpt-codex:hs_persistent:turn-1:1/);

    const complete1 = await request({ phase: "complete_turn", session_id: "hs_persistent", turn_id: "turn-1", gizmo_id: "g-test", conversation_id: "conversation-1", user_message: "first", assistant_message: "one", model: "test-model" }, "3");
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
