"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const patch = require("./tool-details.js");

function fixture() {
  // Za deliberately resembles a JSX import but is not the runtime used by the
  // activity renderer. The patch must derive Q from the anchored JSX calls.
  return 'import{j as Za}from"./jsx-runtime-fake.js";import{j as Q}from"./jsx.js";function Lm(e){let t=(0,ih.c)(227),{item:f}=e,D=e=>e;f.chatGptChatWebSearch; if(f.type===`web-search`){let e;t[132]===f?e=t[133]:(e=(0,Q.jsx)(Ac,{item:f}),t[132]=f,t[133]=e);let n;return t[134]!==e||t[135]!==D?(n=D(e),t[134]=e,t[135]=D,t[136]=n):n=t[136],n}if(f.type===`chatgpt-python-execution`){let e;t[153]!==f?(e=(0,Q.jsx)(_p,{item:f}),t[153]=f,t[155]=e):e=t[155];let n;return t[156]!==e||t[157]!==D?(n=D(e),t[156]=e,t[157]=D,t[158]=n):n=t[158],n}}';
}

function checkModule(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-tool-details-"));
  const file = path.join(dir, "asset.mjs");
  fs.writeFileSync(file, source);
  execFileSync(process.execPath, ["--check", file]);
  fs.rmSync(dir, { recursive: true, force: true });
}

test("descriptor targets the viewer asset", () => {
  assert.equal(patch.descriptors.length, 1);
  assert.deepEqual([patch.descriptors[0].id, patch.descriptors[0].order, patch.descriptors[0].phase], ["chat-tool-details", 20985, "webview-asset"]);
  assert.ok(patch.ASSET_PATTERN.test("viewer-b286e659c89a.js"));
});

test("adds compact collapsed details to tagged Chat web searches", () => {
  const out = patch.applyToolDetailsPatch(fixture());
  assert.match(out, /function codexLinuxChatToolDetails\(/);
  assert.match(out, /f\.chatGptChatWebSearch===!0\?/);
  assert.match(out, /request:`Web search`/);
  assert.match(out, /action:f\.query/);
  assert.match(out, /status:f\.completed\?`Completed`:`Running`/);
  assert.match(out, /source:f\.action\?\.url/);
  assert.match(out, /children:`Tool details`/);
  assert.match(out, /open:!1/);
  assert.match(out, /function codexLinuxChatToolDetails[\s\S]*\(0,Q\.jsxs\)/);
  assert.doesNotMatch(out, /function codexLinuxChatToolDetails[\s\S]*\(0,Za\.jsxs\)/);
  checkModule(out);
});

test("adds Python type/status/presentation details without duplicating output", () => {
  const out = patch.applyToolDetailsPatch(fixture());
  assert.match(out, /request:`Python analysis`/);
  assert.match(out, /status:f\.status/);
  assert.match(out, /presentation:f\.images\?\.length\?`Image or chart`/);
  assert.doesNotMatch(out, /output:f\.output/);
  assert.doesNotMatch(out, /code:f\.code/);
  checkModule(out);
});

test("helper excludes raw/internal metadata fields", () => {
  const out = patch.applyToolDetailsPatch(fixture());
  for (const forbidden of ["messageId", "callId", "requestId", "citation", "offset", "contextMenu", "JSON.stringify"]) assert.ok(!out.includes(forbidden));
});

test("patch is idempotent, configurable, and fail soft", () => {
  const once = patch.applyToolDetailsPatch(fixture());
  assert.equal(patch.applyToolDetailsPatch(once), once);
  const disabled = { feature: { settings: { tweaks: { toolDetails: { enabled: false } } } } };
  assert.equal(patch.applyToolDetailsPatch(fixture(), disabled), fixture());
  assert.equal(patch.applyToolDetailsPatch("const x=1"), "const x=1");
});

test("actual extracted viewer patches once and parses", { skip: !fs.existsSync("/tmp/chat-details-asar/webview/assets/viewer-b286e659c89a.js") }, () => {
  const src = fs.readFileSync("/tmp/chat-details-asar/webview/assets/viewer-b286e659c89a.js", "utf8");
  const out = patch.applyToolDetailsPatch(src);
  assert.notEqual(out, src);
  assert.equal((out.match(/codexLinuxChatToolDetailsRuntime/g) || []).length, 1);
  checkModule(out);
});
