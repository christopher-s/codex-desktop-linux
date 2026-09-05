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

// Upstream-shaped classifier fallback (minified).
const UPSTREAM_FALLBACK =
  "let u=kWr(e),d=ng().safeParse(s);return e.author.role===`assistant`&&u!=null&&d.success?" +
  "{completed:u.completed,item:{arguments:d.data,callId:lR(e),completed:u.completed," +
  "namespace:null,tool:u.tool,type:`dynamic-tool-call`},pairKey:u.pairKey}:SWr(e,t)";

/** Run the patched statement with correctly-wired stubs.
 *  Signature in the patched source: kWr, ng, s, lR, SWr, e, t  — but `s` is
 *  only read via ng().safeParse(s), so we pass argsValue as `s` and let `ng`
 *  succeed on it. `d.data` therefore === argsValue. */
function runPatched(patchedSource, kWrValue, message, argsValue) {
  const fn = new Function("kWr", "ng", "s", "lR", "SWr", "e", "t", patchedSource);
  return fn(
    () => kWrValue,                                  // kWr(e)
    () => ({ safeParse: (v) => ({ success: true, data: v }) }), // ng()
    argsValue,                                       // s
    () => "callid",                                  // lR(e)
    () => null,                                      // SWr(e,t)
    message,                                         // e
    {}                                               // t
  );
}

test("descriptor metadata", () => {
  assert.equal(desc.id, "chat-bridge-tool-calls");
  assert.equal(desc.phase, "webview-asset");
  assert.match(String(desc.pattern), /app-initial/);
});

test("applies to upstream-shaped classifier (insertion)", () => {
  const out = applyChatBridgeToolCallsPatch(UPSTREAM_FALLBACK, {});
  assert.equal(typeof out, "string");
  assert.notEqual(out, UPSTREAM_FALLBACK);
  assert.ok(out.includes(`/*${RUNTIME_MARKER}*/`));
  // insertion preserves the original expression text byte-for-byte
  const markerIdx = out.indexOf(`/*${RUNTIME_MARKER}*/`);
  const after = out.slice(markerIdx + `/*${RUNTIME_MARKER}*/`.length);
  assert.equal(after, UPSTREAM_FALLBACK.slice(UPSTREAM_FALLBACK.indexOf("return")));
});

test("patch output parses as valid JS", () => {
  const out = applyChatBridgeToolCallsPatch(UPSTREAM_FALLBACK, {});
  assert.doesNotThrow(() =>
    new Function("kWr", "ng", "s", "lR", "SWr", "e", "t", out));
});

test("runtime: jit_plugin recipient produces a dynamic-tool-call item", () => {
  const out = applyChatBridgeToolCallsPatch(UPSTREAM_FALLBACK, {});
  const msg = {
    author: { role: "assistant" },
    recipient: "chatgpt_overmind_dedyn_io__jit_plugin.hermes_run_command",
    status: "finished_successfully",
    content: { content_type: "code", language: "json", text: '{"command":"echo hi"}' },
  };
  const args = { command: "echo hi" };
  const result = runPatched(out, null, msg, args);
  assert.deepEqual(result, {
    completed: true,
    item: { arguments: args, callId: "callid", completed: true, namespace: null,
            tool: "hermes_run_command", type: "dynamic-tool-call" },
    pairKey: null,
  });
});

test("runtime: kWr result wins when non-null", () => {
  const out = applyChatBridgeToolCallsPatch(UPSTREAM_FALLBACK, {});
  const msg = {
    author: { role: "assistant" },
    recipient: "chatgpt_overmind_dedyn_io__jit_plugin.hermes_run_command",
    status: "finished_successfully",
  };
  const fromKwr = { completed: false, pairKey: "dynamic:from-kWr", tool: "web_search" };
  const result = runPatched(out, fromKwr, msg, {});
  assert.equal(result.completed, false);
  assert.equal(result.pairKey, "dynamic:from-kWr");
  assert.equal(result.item.tool, "web_search");
});

test("runtime: non-jit recipients fall through to SWr", () => {
  const out = applyChatBridgeToolCallsPatch(UPSTREAM_FALLBACK, {});
  const plain = { author: { role: "assistant" }, recipient: "all", status: "finished_successfully" };
  const result = runPatched(out, null, plain, {});
  assert.equal(result, null); // SWr stub returns null
});

test("runtime: trailing-empty action name does not match", () => {
  const out = applyChatBridgeToolCallsPatch(UPSTREAM_FALLBACK, {});
  const msg = { author: { role: "assistant" }, recipient: "x__jit_plugin.", status: "finished_successfully" };
  const result = runPatched(out, null, msg, {});
  assert.equal(result, null);
});

test("runtime: in_progress marks incomplete", () => {
  const out = applyChatBridgeToolCallsPatch(UPSTREAM_FALLBACK, {});
  const msg = { author: { role: "assistant" }, recipient: "x__jit_plugin.do_thing", status: "in_progress" };
  const result = runPatched(out, null, msg, {});
  assert.equal(result.completed, false);
  assert.equal(result.item.completed, false);
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
  }
});
