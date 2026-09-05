"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const patch = require("./chat-search-rows.js");

function dataFixture() {
  return "function hWr(e){let t=_Wr(NL(e.metadata));return t.length===0?[]:[gWr(e,{queries:t,query:t[0]??null,type:`search`})]}" +
    "function _Wr(e){let t=NL(e),n=vWr(t?.search_queries);return n.length>0?n:vWr(NL(t?.search_model_queries)?.queries)}" +
    "function vWr(e){return Array.isArray(e)?e.flatMap(e=>typeof e==`string`?[e]:[e.q??e.query]):[]}" +
    "function oWr(e){let t=[...hWr(e),..._Tr(e).flatMap(e=>{if(e.type!==`web_search_call`)return[];let t=yWr(NL(e.action));return[{action:t,completed:PL(e.status)!==`in_progress`,query:bWr(t,``),type:`web-search`}]})],n=new Set;return t.filter(e=>{let t=e.query.trim();return t.length===0?!0:n.has(t)?!1:(n.add(t),!0)})}" +
    "const search_model_queries=1,web_search_call=1;";
}
function viewerFixture() {
  return "for(let[t,a]of d.entries()){if(a.type===`web-search`&&!(`chatGptWorkActivityId`in a)||a.type===`dynamic-tool-call`)continue;render(a)}";
}
function checkModule(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-search-"));
  const file = path.join(dir, "asset.mjs");
  fs.writeFileSync(file, source);
  execFileSync(process.execPath, ["--check", file]);
  fs.rmSync(dir, { recursive: true, force: true });
}

test("descriptors target app-initial then viewer", () => {
  assert.deepEqual(patch.descriptors.map(d => [d.id, d.order, d.phase]), [
    ["chat-search-data", 20975, "webview-asset"],
    ["chat-search-rows", 20980, "webview-asset"],
  ]);
  assert.ok(patch.DATA_ASSET_PATTERN.test("app-initial-c89bb5bd3099.js"));
  assert.ok(patch.VIEWER_ASSET_PATTERN.test("viewer-774c0527d5ac.js"));
});

test("app-initial expands metadata and action query arrays into tagged rows", () => {
  const out = patch.applyChatSearchDataPatch(dataFixture());
  assert.match(out, /\.map\([^=]+=>\(\{\.\.\.gWr/);
  assert.ok(out.includes("queries:[chatSearchQuery],query:chatSearchQuery"));
  assert.equal((out.match(/chatGptChatWebSearch:!0/g) || []).length, 2);
  assert.ok(out.includes("[bWr(t,``)]")); // openPage/findInPage remain one row
  assert.ok(out.includes("n.has(t)?!1")); // existing dedupe remains unchanged
  checkModule(out);
});

test("viewer admits only tagged Chat searches", () => {
  const out = patch.applyChatSearchViewerPatch(viewerFixture());
  assert.ok(out.includes("&&!(`chatGptWorkActivityId`in a)&&a.chatGptChatWebSearch!==!0"));
  const shouldSkip = item => item.type === "web-search" && !("chatGptWorkActivityId" in item) && item.chatGptChatWebSearch !== true;
  assert.equal(shouldSkip({ type: "web-search", chatGptChatWebSearch: true }), false);
  assert.equal(shouldSkip({ type: "web-search" }), true); // untagged Codex/shared item
  assert.equal(shouldSkip({ type: "web-search", chatGptWorkActivityId: "work" }), false);
  checkModule(out);
});

test("patches are idempotent, configurable, and fail soft", () => {
  const data = patch.applyChatSearchDataPatch(dataFixture());
  const viewer = patch.applyChatSearchViewerPatch(viewerFixture());
  assert.equal(patch.applyChatSearchDataPatch(data), data);
  assert.equal(patch.applyChatSearchViewerPatch(viewer), viewer);
  const disabled = { feature: { settings: { tweaks: { chatSearchRows: { enabled: false } } } } };
  assert.equal(patch.applyChatSearchDataPatch(dataFixture(), disabled), dataFixture());
  assert.equal(patch.applyChatSearchViewerPatch(viewerFixture(), disabled), viewerFixture());
  assert.equal(patch.applyChatSearchDataPatch("const x=1"), "const x=1");
  assert.equal(patch.applyChatSearchViewerPatch("const x=1"), "const x=1");
});

test("actual extracted assets patch exactly once and parse", { skip: !fs.existsSync("/tmp/chat-row-asar/app-initial.js") || !fs.existsSync("/tmp/chat-row-asar/viewer.js") }, () => {
  const app = fs.readFileSync("/tmp/chat-row-asar/app-initial.js", "utf8");
  const viewer = fs.readFileSync("/tmp/chat-row-asar/viewer.js", "utf8");
  const appOut = patch.applyChatSearchDataPatch(app);
  const viewerOut = patch.applyChatSearchViewerPatch(viewer);
  assert.notEqual(appOut, app);
  assert.notEqual(viewerOut, viewer);
  assert.equal((appOut.match(/codexLinuxChatSearchDataRuntime/g) || []).length, 1);
  assert.equal((viewerOut.match(/codexLinuxChatSearchRowsRuntime/g) || []).length, 1);
  checkModule(appOut);
  checkModule(viewerOut);
});

test("does not fabricate or label query-to-URL results", () => {
  const combined = patch.applyChatSearchDataPatch(dataFixture()) + patch.applyChatSearchViewerPatch(viewerFixture());
  assert.ok(!combined.includes("citedUrls"));
  assert.ok(!combined.includes("Cited sources"));
  assert.ok(!combined.includes("search results"));
});
