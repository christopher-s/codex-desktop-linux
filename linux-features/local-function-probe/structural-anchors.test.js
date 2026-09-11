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
  assert.match(patched, /codexP2CompletedResultHandoffV2Runtime/);
  assert.match(patched, /codex_local_function_result/);
  assert.match(patched, /sourceTool/);
  assert.match(patched, /local-function:/);
  assert.match(
    patched,
    /completed:!0,result:[\w$]+\.rawPayload,\/\*codexP2CompletedResultHandoffV2Runtime\*\/tool:([\w$]+)\.item\.tool/,
    "completed paired items keep native handoff viewer identity",
  );
  assert.doesNotMatch(
    patched,
    /completed:!0,result:[\w$]+\.rawPayload,tool:([\w$]+)\.item\.sourceTool\?\?\1\.item\.tool/,
  );
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

test("patchInitial migrates completed paired items back to native handoff viewer identity", () => {
  const source = asset("app-initial-");
  const current = patchInitial(source);
  const currentPattern = /\/\*codexP2CompletedResultHandoffV2Runtime\*\/tool:([\w$]+)\.item\.tool/;
  const match = current.match(currentPattern);
  assert.ok(match, "current patched asset contains completed-result handoff V2 marker");
  const previous = match[1];
  const legacy = current.replace(
    currentPattern,
    `tool:${previous}.item.sourceTool??${previous}.item.tool`,
  );
  assert.notEqual(legacy, current);
  assert.doesNotMatch(legacy, /codexP2CompletedResultHandoffV2Runtime/);
  assert.equal(patchInitial(legacy), current);
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

test("patchViewer keeps the native executor mounted and preserves completed local-tool disclosure", () => {
  const source = asset("viewer-");
  const patched = assertIdempotent(patchViewer, source);
  assert.match(patched, /codexP2ToolViewerRuntime/);
  assert.match(patched, /__codexP2LmItems=\[\.\.\.\(globalThis\.__codexP2LmItems\?\?\[\]\),codexP2LmSnapshot\]\.slice\(-40\)\}\/\*codexP2LmSnapshotV2Runtime\*\//);
  assert.match(patched, /codexP2ToolCompletedPresentationV2Runtime/);
  assert.match(patched, /codexP2CompletedSourceToolCardV1Runtime/);
  assert.match(patched, /codexLinuxChatBridgeToolCallsSkipRuntime/);
  assert.doesNotMatch(patched, /codexP2ToolCompletedPresentationRuntime/);
  assert.doesNotMatch(
    patched,
    /\|\|[\w$]+\.type===`dynamic-tool-call`\)continue;/,
    "regular Chat activity renderer does not drop dynamic tool items before Lm",
  );
  assert.match(
    patched,
    /\/\*codexP2CompletedSourceToolCardV1Runtime\*\/if\(([\w$]+)\.sourceTool&&\1\.completed&&\1\.result\?\.accepted===!0&&typeof \1\.result\.thread_id===`string`&&\1\.result\.thread_id\.length>0\)return\(0,([\w$]+)\.jsx\)\(([\w$]+),\{incomplete:!1,threadId:\1\.result\.thread_id\}\);/,
    "completed sourceTool-backed items render through the native completed handoff card",
  );
  assert.match(
    patched,
    /if\(f\.tool===`handoff`\)\{globalThis\.__codexP2ViewerRouted/,
    "handoff items still mount the native handoff component that drives local execution",
  );
  assert.doesNotMatch(
    patched,
    /if\(f\.tool===`handoff`&&!f\.sourceTool\)\{globalThis\.__codexP2ViewerRouted/,
  );
  assert.doesNotMatch(
    patched,
    /if\([\w$]+\.sourceTool&&[\w$]+!=null\)return null/,
    "published sourceTool-backed results continue into the native accepted presentation branch",
  );
});

test("patchViewer migrates installed viewer instrumentation to bounded handoff snapshots", () => {
  const source = asset("viewer-");
  const current = patchViewer(source);
  const snapshotPattern = /if\(([\w$]+)\.sourceTool\|\|\1\.tool===`handoff`\)\{let codexP2LmSnapshot=\{tool:\1\.tool,sourceTool:\1\.sourceTool,callId:\1\.callId,completed:\1\.completed,result:\1\.result\?\?null\};globalThis\.__codexP2LmItem=codexP2LmSnapshot,globalThis\.__codexP2LmItems=\[\.\.\.\(globalThis\.__codexP2LmItems\?\?\[\]\),codexP2LmSnapshot\]\.slice\(-40\)\}\/\*codexP2LmSnapshotV2Runtime\*\//;
  const match = current.match(snapshotPattern);
  assert.ok(match, "current viewer contains bounded handoff snapshot instrumentation");
  const item = match[1];
  const previous = current.replace(
    snapshotPattern,
    `if(${item}.sourceTool||${item}.tool===\`handoff\`)globalThis.__codexP2LmItem={tool:${item}.tool,sourceTool:${item}.sourceTool,completed:${item}.completed}`,
  );
  assert.notEqual(previous, current);
  assert.doesNotMatch(previous, /__codexP2LmItems=/);
  assert.equal(patchViewer(previous), current);
});

test("patchViewer migrates an installed viewer to keep dynamic tool activity visible", () => {
  const source = asset("viewer-");
  const current = patchViewer(source);
  const activityPattern = /\)continue;\/\*codexLinuxChatBridgeToolCallsSkipRuntime\*\/if\(([\w$]+)\.type===`reasoning`\)/;
  const match = current.match(activityPattern);
  assert.ok(match, "current viewer contains the historical Gate 3c visibility marker");
  const item = match[1];
  const previous = current.replace(
    activityPattern,
    `||${item}.type===\`dynamic-tool-call\`)continue;if(${item}.type===\`reasoning\`)`,
  );
  assert.notEqual(previous, current);
  assert.doesNotMatch(previous, activityPattern);
  assert.ok(previous.includes("||" + item + ".type===`dynamic-tool-call`)continue;"));
  assert.equal(patchViewer(previous), current);
});

test("patchViewer migrates an installed viewer to the persisted-result completed source-tool card", () => {
  const source = asset("viewer-");
  const current = patchViewer(source);
  const sourceCardPattern = /\/\*codexP2CompletedSourceToolCardV1Runtime\*\/if\(([\w$]+)\.sourceTool&&\1\.completed&&\1\.result\?\.accepted===!0&&typeof \1\.result\.thread_id===`string`&&\1\.result\.thread_id\.length>0\)return\(0,([\w$]+)\.jsx\)\(([\w$]+),\{incomplete:!1,threadId:\1\.result\.thread_id\}\);/;
  assert.match(current, sourceCardPattern);
  const previous = current.replace(sourceCardPattern, "");
  assert.notEqual(previous, current);
  assert.doesNotMatch(previous, /codexP2CompletedSourceToolCardV1Runtime/);
  assert.equal(patchViewer(previous), current);
});

test("patchViewer migrates completed-presentation suppression and the older top-level bypass", () => {
  const source = asset("viewer-");
  const current = patchViewer(source);
  const currentMarker = "/*codexP2ToolCompletedPresentationV2Runtime*/";
  const acceptedAnchor = /\{conversationId:([\w$]+),item:([\w$]+),onContinueSuccess:[\w$]+,shouldBlockExternalEgress:[\w$]+\}=([\w$]+),[\s\S]{0,2200}?\/\*codexP2ToolCompletedPresentationV2Runtime\*\/if\(!([\w$]+)&&\(([\w$]+)\?\.type===`accepted`\|\|\5\?\.type===`partial`\)\)\{/;
  const match = current.match(acceptedAnchor);
  assert.ok(match, "current viewer contains the completed-presentation V2 marker before the native accepted branch");
  const item = match[2];
  const result = match[5];
  const suppressed = current.replace(
    currentMarker,
    `if(${item}.sourceTool&&${result}!=null)return null;/*codexP2ToolCompletedPresentationRuntime*/`,
  );
  assert.notEqual(suppressed, current);
  assert.equal(patchViewer(suppressed), current);

  const previous = current
    .replace(
      "if(f.tool===`handoff`){globalThis.__codexP2ViewerRouted",
      "if(f.tool===`handoff`&&!f.sourceTool){globalThis.__codexP2ViewerRouted",
    )
    .replace(currentMarker, "");
  const migrated = patchViewer(previous);
  assert.match(migrated, /if\(f\.tool===`handoff`\)\{globalThis\.__codexP2ViewerRouted/);
  assert.doesNotMatch(migrated, /if\(f\.tool===`handoff`&&!f\.sourceTool\)\{/);
  assert.match(migrated, /codexP2ToolCompletedPresentationV2Runtime/);
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
