#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { patchInitial, patchPrimary, patchViewer } = require("./patch.js");

const ASSETS = "/tmp/codex-drift-2690151231/extracted/webview/assets";
const FALLBACK_ASAR =
  "/home/chris/.cache/codex-update-manager/workspaces/26.901.51231/codex-app/resources/app.asar";
const FALLBACK_ASSET_PATHS = {
  "app-initial-": "webview/assets/app-initial-9e28b0395ba3.js",
  "app-primary-": "webview/assets/app-primary-bd4b894ed032.js",
  "viewer-": "webview/assets/viewer-e9246054b1c4.js",
};

function asset(prefix) {
  if (fs.existsSync(ASSETS)) {
    const names = fs.readdirSync(ASSETS).filter((name) => name.startsWith(prefix) && name.endsWith(".js"));
    assert.equal(names.length, 1, `expected exactly one ${prefix} asset, found ${names.length}`);
    return fs.readFileSync(path.join(ASSETS, names[0]), "utf8");
  }
  const assetPath = FALLBACK_ASSET_PATHS[prefix];
  assert.ok(assetPath, `no fallback asset registered for ${prefix}`);
  assert.ok(fs.existsSync(FALLBACK_ASAR), `fallback ASAR missing: ${FALLBACK_ASAR}`);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "p2-structural-asset-"));
  try {
    childProcess.execFileSync(
      "npx",
      ["--yes", "@electron/asar", "extract-file", FALLBACK_ASAR, assetPath],
      { cwd: temporary, stdio: "ignore" },
    );
    return fs.readFileSync(path.join(temporary, path.basename(assetPath)), "utf8");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
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
  assert.match(
    patched,
    /sourceTool:r\?[\w$]+:void 0,tool:r\?`handoff`:/,
    "advertised local functions preserve native handoff identity for execution",
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

test("patchInitial restores exactly two presentation-only local tools to native handoff execution identity", () => {
  const presentationOnly = [
    "codexP2ToolSignatureRuntime",
    "sourceTool:r?a:void 0,tool:a",
    "sourceTool:x?b:void 0,tool:b",
  ].join(";");
  const restored = patchInitial(presentationOnly);
  assert.equal(
    restored,
    [
      "codexP2ToolSignatureRuntime",
      "sourceTool:r?a:void 0,tool:r?`handoff`:a",
      "sourceTool:x?b:void 0,tool:x?`handoff`:b",
    ].join(";"),
  );
  assert.equal(patchInitial(restored), restored);
});

test("patchInitial fails closed on a partial execution-handoff restoration", () => {
  const partial = [
    "codexP2ToolSignatureRuntime",
    "sourceTool:r?a:void 0,tool:a",
  ].join(";");
  assert.throws(
    () => patchInitial(partial),
    /restore local-tool execution handoff: expected exactly two anchors, found 1/,
  );
});

test("patchViewer keeps the native executor mounted and suppresses only completed local-tool handoff presentation", () => {
  const source = asset("viewer-");
  const patched = assertIdempotent(patchViewer, source);
  assert.match(patched, /codexP2ToolViewerRuntime/);
  assert.match(patched, /codexP2ToolCompletedPresentationRuntime/);
  assert.match(
    patched,
    /if\(f\.tool===`handoff`\)\{globalThis\.__codexP2ViewerRouted/,
    "handoff items still mount the native handoff component that drives local execution",
  );
  assert.doesNotMatch(
    patched,
    /if\(f\.tool===`handoff`&&!f\.sourceTool\)\{globalThis\.__codexP2ViewerRouted/,
  );
  assert.match(
    patched,
    /if\([\w$]+\.sourceTool&&[\w$]+!=null\)return null;\/\*codexP2ToolCompletedPresentationRuntime\*\//,
    "published sourceTool-backed results suppress only the terminal native handoff card",
  );
});

test("patchViewer migrates the earlier top-level sourceTool bypass back to an executor-mounted post-result suppression", () => {
  const source = asset("viewer-");
  const current = patchViewer(source);
  const completedPattern = /if\([\w$]+\.sourceTool&&[\w$]+!=null\)return null;\/\*codexP2ToolCompletedPresentationRuntime\*\//;
  const previous = current
    .replace(
      "if(f.tool===`handoff`){globalThis.__codexP2ViewerRouted",
      "if(f.tool===`handoff`&&!f.sourceTool){globalThis.__codexP2ViewerRouted",
    )
    .replace(completedPattern, "");
  const migrated = patchViewer(previous);
  assert.match(migrated, /if\(f\.tool===`handoff`\)\{globalThis\.__codexP2ViewerRouted/);
  assert.doesNotMatch(migrated, /if\(f\.tool===`handoff`&&!f\.sourceTool\)\{/);
  assert.match(migrated, /codexP2ToolCompletedPresentationRuntime/);
  assert.equal(patchViewer(migrated), migrated);

  const duplicatedBypass = previous.replace(
    "if(f.tool===`handoff`&&!f.sourceTool){globalThis.__codexP2ViewerRouted",
    "if(f.tool===`handoff`&&!f.sourceTool){globalThis.__codexP2ViewerRouted;if(f.tool===`handoff`&&!f.sourceTool){globalThis.__codexP2ViewerRouted",
  );
  assert.throws(
    () => patchViewer(duplicatedBypass),
    /restore handoff viewer execution mount: expected exactly one bypassed viewer anchor, found 2/,
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
