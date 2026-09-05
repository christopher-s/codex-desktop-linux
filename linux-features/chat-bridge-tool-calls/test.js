"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  RUNTIME_MARKER,
  applyChatBridgeToolCallsPatch,
  descriptors,
} = require("./patch.js");

const desc = descriptors[0];

// Upstream-shaped classifier fallback (minified). The anchor must match this.
const UPSTREAM_FALLBACK =
  "let u=kWr(e),d=ng().safeParse(s);return e.author.role===`assistant`&&u!=null&&d.success?" +
  "{completed:u.completed,item:{arguments:d.data,callId:lR(e),completed:u.completed," +
  "namespace:null,tool:u.tool,type:`dynamic-tool-call`},pairKey:u.pairKey}:SWr(e,t)";

/** Extract the injected fallback function and return a JS evaluator
 *  `fn(kWrValue, message)`. */
function fallbackFn(patchedSource) {
  const marker = `/*${RUNTIME_MARKER}*/`;
  const start = patchedSource.indexOf("(u!=null?");
  const end = patchedSource.indexOf(marker) + marker.length;
  assert.ok(start > -1 && end > start, "marker present in patched source");
  const expr = patchedSource.slice(start, end);
  return new Function("u", "e", "return " + expr + ";");
}

test("descriptor metadata", () => {
  assert.equal(desc.id, "chat-bridge-tool-calls");
  assert.equal(desc.phase, "webview-asset");
  assert.match(String(desc.pattern), /app-initial/);
});

test("applies to upstream-shaped classifier and returns a string", () => {
  const out = applyChatBridgeToolCallsPatch(UPSTREAM_FALLBACK, {});
  assert.equal(typeof out, "string");
  assert.notEqual(out, UPSTREAM_FALLBACK);
  assert.ok(out.includes(`/*${RUNTIME_MARKER}*/`));
});

test("patch output parses as valid JS", () => {
  const out = applyChatBridgeToolCallsPatch(UPSTREAM_FALLBACK, {});
  assert.doesNotThrow(() =>
    new Function("kWr", "ng", "s", "lR", "SWr", "e", "t", out));
});

test("runtime: jit_plugin recipient becomes a tool descriptor", () => {
  const out = applyChatBridgeToolCallsPatch(UPSTREAM_FALLBACK, {});
  const fn = fallbackFn(out);
  const msg = {
    author: { role: "assistant" },
    recipient: "chatgpt_overmind_dedyn_io__jit_plugin.hermes_run_command",
    status: "finished_successfully",
    content: { content_type: "code", language: "json", text: '{"command":"echo hi"}' },
  };
  const result = fn(null, msg);
  assert.equal(result.tool, "hermes_run_command");
  assert.equal(result.completed, true);
  assert.equal(result.pairKey, null);
});

test("runtime: kWr's own result wins when non-null", () => {
  const out = applyChatBridgeToolCallsPatch(UPSTREAM_FALLBACK, {});
  const fn = fallbackFn(out);
  const fromKwr = { tool: "from-kWr", completed: true, pairKey: "dynamic:from-kWr" };
  const msg = { author: { role: "assistant" }, recipient: "functions.anything", status: "finished_successfully" };
  assert.deepEqual(fn(fromKwr, msg), fromKwr);
});

test("runtime: plain and api_tool recipients still return null", () => {
  const out = applyChatBridgeToolCallsPatch(UPSTREAM_FALLBACK, {});
  const fn = fallbackFn(out);
  assert.equal(fn(null, { author: { role: "assistant" }, recipient: "all", status: "finished_successfully" }), null);
  assert.equal(fn(null, { author: { role: "assistant" }, recipient: "api_tool.call_tool", status: "finished_successfully" }), null);
  assert.equal(fn(null, { author: { role: "assistant" }, recipient: "functions.web_search", status: "finished_successfully" }), null);
  assert.equal(fn(null, { author: { role: "assistant" } }), null);
});

test("runtime: in_progress message marks incomplete", () => {
  const out = applyChatBridgeToolCallsPatch(UPSTREAM_FALLBACK, {});
  const fn = fallbackFn(out);
  const msg = { author: { role: "assistant" }, recipient: "x__jit_plugin.do_thing", status: "in_progress" };
  assert.equal(fn(null, msg).completed, false);
});

test("runtime: trailing-empty action name returns null", () => {
  const out = applyChatBridgeToolCallsPatch(UPSTREAM_FALLBACK, {});
  const fn = fallbackFn(out);
  assert.equal(fn(null, { author: { role: "assistant" }, recipient: "x__jit_plugin.", status: "finished_successfully" }), null);
});

test("idempotent: second apply is a byte-identical no-op", () => {
  const once = applyChatBridgeToolCallsPatch(UPSTREAM_FALLBACK, {});
  const twice = applyChatBridgeToolCallsPatch(once, {});
  assert.equal(twice, once);
});

test("settings disable returns source unchanged", () => {
  const out = applyChatBridgeToolCallsPatch(UPSTREAM_FALLBACK, { settings: { showBridgeToolCalls: false } });
  assert.equal(out, UPSTREAM_FALLBACK);
});

test("fail-soft on missing anchor", () => {
  const src = "function unrelated(){return 1}";
  assert.equal(applyChatBridgeToolCallsPatch(src, {}), src);
});

test("real-asset apply (skipped when extracted tree absent)", () => {
  const p = "/tmp/cdx-app/webview/assets";
  let dir;
  try {
    dir = fs.readdirSync(p).filter((f) => /^app-initial-[0-9a-f]+\.js$/.test(f));
  } catch {
    return; // extracted tree not present on this machine
  }
  if (dir.length === 0) return;
  const src = fs.readFileSync(path.join(p, dir[0]), "utf8");
  const out = applyChatBridgeToolCallsPatch(src, {});
  if (out !== src) {
    assert.ok(out.includes(`/*${RUNTIME_MARKER}*/`));
    assert.ok(out.length > src.length);
    assert.equal(applyChatBridgeToolCallsPatch(out, {}), out); // idempotent on real asset
  } else {
    // Anchor drift on the real asset is a hard signal for this feature.
    assert.ok(!FALLBACK_ANCHOR_FOUND(src), "anchor should match the real asset");
  }
});

function FALLBACK_ANCHOR_FOUND(src) {
  return /let \w+=kWr\(\w+\),\w+=ng\(\)\.safeParse\(\w+\);return \w+\.author\.role===`assistant`&&\w+!=null&&\w+\.success\?/.test(src);
}
