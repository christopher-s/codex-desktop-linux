#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { patchInitial, patchPrimary } = require("./patch.js");

const ASSETS = "/tmp/codex-drift-2690151231/extracted/webview/assets";

function asset(prefix) {
  const names = fs.readdirSync(ASSETS).filter((name) => name.startsWith(prefix) && name.endsWith(".js"));
  assert.equal(names.length, 1, `expected exactly one ${prefix} asset, found ${names.length}`);
  return fs.readFileSync(path.join(ASSETS, names[0]), "utf8");
}

function assertIdempotent(patch, source) {
  const once = patch(source);
  assert.notEqual(once, source);
  assert.equal(patch(once), once);
  return once;
}

test("patchInitial follows 26.901.51231 structures without pinning minified identifiers", () => {
  const source = asset("app-initial-");
  const patched = assertIdempotent(patchInitial, source);
  assert.match(patched, /codexP2ToolSignatureRuntime/);
  assert.match(patched, /codexP2ToolResultPairRuntime/);
  assert.match(patched, /codex_local_function_result/);
  assert.match(patched, /sourceTool/);
  assert.match(patched, /local-function:/);
  assert.doesNotMatch(
    patched,
    /sourceTool:r\?[\w$]+:void 0,tool:r\?`handoff`:/,
    "advertised local functions must stay ordinary dynamic tools instead of entering the native handoff viewer",
  );
  assert.match(
    patched,
    /sourceTool:r\?([\w$]+):void 0,tool:\1/,
    "advertised local functions preserve their source tool name for presentation",
  );
  assert.match(patched, /phase:"conversation_identity"/);
  assert.match(patched, /server_conversation_id:/);
  assert.match(patched, /onServerThreadIdChange:/);
  assert.doesNotMatch(
    patched,
    /async function [\w$]+\([^)]*onServerThreadIdChange:\(\.\.\.__p2ServerArgs\)=>/,
    "must not replace the callback binding inside the function parameter destructuring",
  );
  assert.match(
    patched,
    /return [\w$]+\([\w$]+,\{[\s\S]*onServerThreadIdChange:\(\.\.\.__p2ServerArgs\)=>/,
    "wraps the callback only in the downstream submit-call object",
  );
});

test("patchPrimary follows 26.901.51231 detector and executor structures without pinning minified identifiers", () => {
  const source = asset("app-primary-");
  const patched = assertIdempotent(patchPrimary, source);
  assert.match(patched, /codexP2ToolDetectorRuntime/);
  assert.match(patched, /codexP2ToolExecRuntime/);
  assert.match(patched, /hermesChatLifecycle/);
  assert.match(patched, /CODEX_CHATGPT_HANDOFF_LIFECYCLE_ACTION_ACCEPTED/);
});

test("structural patches fail closed when a required unique anchor is absent", () => {
  assert.throws(() => patchInitial("ordinary asset"), /expected exactly one structural anchor, found 0/);
  assert.throws(() => patchPrimary("ordinary asset"), /expected exactly one structural anchor, found 0/);
});
