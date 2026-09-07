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

// ---------------------------------------------------------------------------
// Visibility patch (chat-bridge-tool-calls-visibility)
// ---------------------------------------------------------------------------

const {
  applyChatBridgeToolCallsVisibilityPatch,
  DROP_GUARD_ANCHOR,
} = require("./patch.js").__testVisibility
  ? require("./patch.js").__testVisibility
  : (() => {
      // patch.js re-exports visibility functions for tests
      const p = require("./patch.js");
      return {
        applyChatBridgeToolCallsVisibilityPatch:
          p.applyChatBridgeToolCallsVisibilityPatch,
        DROP_GUARD_ANCHOR: require("./visibility.js").DROP_GUARD_ANCHOR,
      };
    })();

test("visibility: real-asset drop-guard anchor matches exactly once", () => {
  const assetPath =
    "/tmp/installed-check/webview/assets/app-initial-c89bb5bd3099.js";
  if (!fs.existsSync(assetPath)) return; // skip when probe dir absent
  const src = fs.readFileSync(assetPath, "utf8");
  const all = [...src.matchAll(new RegExp(DROP_GUARD_ANCHOR.source, "g"))];
  assert.strictEqual(all.length, 1);
});

test("visibility: patch keeps hidden group carrying dynamic-tool-call items", () => {
  // Shape lifted from the real asset (identifier names as minified):
  // let i=n.flatMap((e,t)=>{if(e.isVisuallyHiddenReasoningGroup===!0)return[];if(!xz(e))return[e];...});
  const src =
    "let i=n.flatMap((e,t)=>{if(e.isVisuallyHiddenReasoningGroup===!0)return[];if(!xz(e))return[e];let n=t!==r,i=-1;return[e];});";
  const out = applyChatBridgeToolCallsVisibilityPatch(src, {});
  assert.ok(out.includes("/*codexLinuxChatBridgeToolCallsVisRuntime*/"), "marker present");
  assert.ok(out.includes("some(function(it){return it&&it.type===`dynamic-tool-call`})"), "escape hatch inserted");
  // sanity: evaluate the patched flatMap body with stubs — hidden group WITH tool item kept
  const entries = [
    { isVisuallyHiddenReasoningGroup: true, item: { type: "chatgpt-reasoning-group", items: [{ type: "dynamic-tool-call", completed: true }] } },
    { isVisuallyHiddenReasoningGroup: true, item: { type: "chatgpt-reasoning-group", items: [{ type: "reasoning" }] } },
    { isVisuallyHiddenReasoningGroup: false, item: { type: "assistant-message" } },
  ];
  const xz = (e) => e?.item?.type === "chatgpt-reasoning-group";
  const body = out.slice(out.indexOf("flatMap((e,t)=>{") + "flatMap((e,t)=>{".length, out.lastIndexOf("});"));
  // reconstruct: run via Function with the inserted code as-is
  const fn = new Function("e", "t", "xz", "r", body.replace(/^if\(e\.isVisuallyHiddenReasoningGroup===!0\)return\[\];/, "") + ";return null;");
  const kept = entries.filter((en) => {
    const res = fn(en, 0, xz, -1);
    return res !== undefined && res !== null ? Array.isArray(res) ? res.length > 0 : true : true;
  });
  // group WITH dynamic-tool-call must survive; plain hidden reasoning group dropped
  assert.ok(kept.some((k) => k === entries[0]), "hidden group with tool items kept");
  assert.ok(!kept.some((k) => k === entries[1]), "hidden group without tool items dropped");
});

test("visibility: idempotent (second apply is no-op)", () => {
  const src =
    "let i=n.flatMap((e,t)=>{if(e.isVisuallyHiddenReasoningGroup===!0)return[];if(!xz(e))return[e];return[e];});";
  const once = applyChatBridgeToolCallsVisibilityPatch(src, {});
  const twice = applyChatBridgeToolCallsVisibilityPatch(once, {});
  assert.strictEqual(twice, once);
});

test("visibility: anchor miss returns source unchanged (fail-soft)", () => {
  const src = "let i=n.flatMap((e,t)=>{if(e.foo)return[];return[e];});";
  assert.strictEqual(applyChatBridgeToolCallsVisibilityPatch(src, {}), src);
});

test("visibility: settings toggle disables the patch", () => {
  const src =
    "let i=n.flatMap((e,t)=>{if(e.isVisuallyHiddenReasoningGroup===!0)return[];if(!xz(e))return[e];return[e];});";
  assert.strictEqual(
    applyChatBridgeToolCallsVisibilityPatch(src, { settings: { showBridgeToolCalls: false } }),
    src,
  );
});

// ---------------------------------------------------------------------------
// Recap patch (chat-bridge-tool-calls-recap) — viewer render gate
// ---------------------------------------------------------------------------

const {
  applyChatBridgeToolCallsRecapPatch,
  RECAP_GATE_ANCHOR,
} = require("./recap.js");

test("recap: real-asset viewer gate anchor matches exactly once", () => {
  const candidates = [
    "/tmp/payload-check2/webview/assets/viewer-b286e659c89a.js",
  ];
  const existing = candidates.filter((p) => fs.existsSync(p));
  if (!existing.length) return; // skip when probe dirs absent
  for (const assetPath of existing) {
    const src = fs.readFileSync(assetPath, "utf8");
    const all = [...src.matchAll(new RegExp(RECAP_GATE_ANCHOR.source, "g"))];
    assert.strictEqual(all.length, 1, `anchor count in ${assetPath}`);
  }
});

test("recap: gate condition rewritten to keep tool-carrying groups", () => {
  // Shape lifted from viewer-b286e659c89a.js:
  // Ve=S.items.flatMap((e,t)=>e.type===`chatgpt-reasoning-group`?t!==Ce||pe?.type===`hide_all`?[]:[{key:`reasoning`}]:[e])
  const src =
    "Ve=S.items.flatMap((e,t)=>e.type===`chatgpt-reasoning-group`?t!==Ce||pe?.type===`hide_all`?[]:[{key:`reasoning`}]:[e]);";
  const out = applyChatBridgeToolCallsRecapPatch(src, {});
  assert.ok(out.includes("/*codexLinuxChatBridgeToolCallsRecapRuntime*/"), "marker present");
  // evaluate the rewritten ternary for the two decisive cases
  const ce = 1; // group at index 1
  const mkGroup = (types) => ({ type: "chatgpt-reasoning-group", items: types.map((ty) => ({ type: ty })) });
  const cases = [
    { pe: { type: "hide_all" }, e: mkGroup(["dynamic-tool-call"]), expect: "keep" },
    { pe: { type: "hide_all" }, e: mkGroup(["reasoning"]), expect: "drop" },
    { pe: null, e: mkGroup(["reasoning"]), expect: "keep" },
    { pe: { type: "collapse" }, e: mkGroup(["reasoning"]), expect: "keep" },
  ];
  const cond = out.slice(out.indexOf("t!==Ce||("), out.lastIndexOf(")/*codexLinuxChatBridgeToolCallsRecapRuntime*/") + 1);
  const fn = new Function("t", "Ce", "pe", "e", "return (" + cond + ");");
  for (const c of cases) {
    const drops = fn(1, ce, c.pe, c.e);
    assert.strictEqual(drops, c.expect === "drop", `case pe=${JSON.stringify(c.pe && c.pe.type)} items=${JSON.stringify(c.e.items.map((i) => i.type))}`);
  }
});

test("recap: non-group entries untouched (condition still drops t!==Ce)", () => {
  const src =
    "Ve=S.items.flatMap((e,t)=>e.type===`chatgpt-reasoning-group`?t!==Ce||pe?.type===`hide_all`?[]:[{key:`reasoning`}]:[e]);";
  const out = applyChatBridgeToolCallsRecapPatch(src, {});
  const cond = out.slice(out.indexOf("t!==Ce||("), out.lastIndexOf(")/*codexLinuxChatBridgeToolCallsRecapRuntime*/") + 1);
  const fn = new Function("t", "Ce", "pe", "e", "return (" + cond + ");");
  // group at wrong index: dropped regardless of contents
  assert.strictEqual(fn(0, 1, { type: "hide_all" }, { type: "chatgpt-reasoning-group", items: [{ type: "dynamic-tool-call" }] }), true);
});

test("recap: idempotent (second apply is no-op)", () => {
  const src =
    "Ve=S.items.flatMap((e,t)=>e.type===`chatgpt-reasoning-group`?t!==Ce||pe?.type===`hide_all`?[]:[{key:`reasoning`}]:[e]);";
  const once = applyChatBridgeToolCallsRecapPatch(src, {});
  assert.strictEqual(applyChatBridgeToolCallsRecapPatch(once, {}), once);
});

test("recap: anchor miss returns source unchanged (fail-soft)", () => {
  const src = "Ve=S.items.flatMap((e,t)=>e.type===`other`?[e]:[e]);";
  assert.strictEqual(applyChatBridgeToolCallsRecapPatch(src, {}), src);
});

test("recap: settings toggle disables the patch", () => {
  const src =
    "Ve=S.items.flatMap((e,t)=>e.type===`chatgpt-reasoning-group`?t!==Ce||pe?.type===`hide_all`?[]:[{key:`reasoning`}]:[e]);";
  assert.strictEqual(
    applyChatBridgeToolCallsRecapPatch(src, { settings: { showBridgeToolCalls: false } }),
    src,
  );
});

// ---------------------------------------------------------------------------
// Recap patch gate 3b (Km component null-render)
// ---------------------------------------------------------------------------

test("recap Km: null-render rewritten to keep tool-carrying groups", () => {
  const src = "function Km(e){let t=(0,ih.c)(10);if(e.reasoningRecap?.type===`hide_all`)return null;let n,r;}";
  const out = applyChatBridgeToolCallsRecapPatch(src, {});
  assert.ok(out.includes("/*codexLinuxChatBridgeToolCallsKmRuntime*/"), "km marker present");
  // evaluate: hide_all + tool items => NO null (proceed); hide_all + no tools => null
  const at = out.indexOf("if(e.reasoningRecap?.type===`hide_all`&&");
  const end = out.indexOf("/*codexLinuxChatBridgeToolCallsKmRuntime*/;");
  const ifOpen = out.indexOf("(", at);
  let depth = 0, i = ifOpen;
  for (; i < out.length; i++) {
    if (out[i] === "(") depth++;
    else if (out[i] === ")") { depth--; if (depth === 0) break; }
  }
  const cond = out.slice(at + 3, i);
  const fn = new Function("e", "return (" + cond + ");");
  assert.strictEqual(fn({reasoningRecap: {type: "hide_all"}, items: [{type: "dynamic-tool-call"}]}), false, "hide_all+tools => renders");
  assert.strictEqual(fn({reasoningRecap: {type: "hide_all"}, items: [{type: "reasoning"}]}), true, "hide_all+no-tools => null");
  assert.strictEqual(fn({reasoningRecap: null, items: [{type: "reasoning"}]}), false, "no recap => renders");
});

test("recap Km: idempotent with gate 3a present", () => {
  const src = "function Km(e){let t=(0,ih.c)(10);if(e.reasoningRecap?.type===`hide_all`)return null;let n,r;}";
  const once = applyChatBridgeToolCallsRecapPatch(src, {});
  const twice = applyChatBridgeToolCallsRecapPatch(once, {});
  assert.strictEqual(twice, once);
});

test("recap Km: real-asset anchor present in viewer", () => {
  const assetPath = "/tmp/payload-check3/webview/assets/viewer-b286e659c89a.js";
  if (!fs.existsSync(assetPath)) return;
  const src = fs.readFileSync(assetPath, "utf8");
  const km = /function (?<fn>\w+)\((?<p>\w+)\)\{let \w+=\(0,\w+\.c\)\(\d+\);if\(\k<p>\.reasoningRecap\?\.type===`hide_all`\)return null;/.exec(src);
  assert.ok(km, "Km anchor in real viewer asset");
});

// ---------------------------------------------------------------------------
// Chip patch (chat-bridge-tool-calls-chip) — generic label enrichment
// ---------------------------------------------------------------------------

const {
  applyChatBridgeToolCallsChipPatch,
  LABEL_ANCHOR,
  ROW_START_ANCHOR,
  EXEC_PRIMITIVES_ANCHOR,
  NATIVE_CARD_ANCHOR,
} = require("./chip.js");
const { execFileSync } = require("node:child_process");
const CHIP_ASSET = "/tmp/codex-native-renderer/webview/assets/subagent-activity-chip-group-a5079589a6b4.js";
const realChipTest = fs.existsSync(CHIP_ASSET) ? test : test.skip;

function realChipAsset() {
  assert.ok(fs.existsSync(CHIP_ASSET), `required native asset missing: ${CHIP_ASSET}`);
  return fs.readFileSync(CHIP_ASSET, "utf8");
}

realChipTest("chip: structural anchors match the real native asset", () => {
  const src = realChipAsset();
  for (const [name, anchor] of Object.entries({LABEL_ANCHOR, ROW_START_ANCHOR, EXEC_PRIMITIVES_ANCHOR, NATIVE_CARD_ANCHOR})) {
    assert.strictEqual([...src.matchAll(new RegExp(anchor.source, "g"))].length, 1, name);
  }
});

realChipTest("chip: real asset gains native Sc disclosure with a compact recursive argument tree", () => {
  const src = realChipAsset();
  const out = applyChatBridgeToolCallsChipPatch(src, {});
  assert.notStrictEqual(out, src);
  assert.ok(out.includes(`/*${require("./chip.js").RUNTIME_MARKER}Native*/`));
  assert.match(out, /return\(0,[\w$]+\.jsx\)\(Sc,\{body:__cbtcBody,className:`relative overflow-clip`,disclosure:/);
  assert.match(out, /__cbtcBody=__cbtcOpen\?\(\(\)=>\{/);
  assert.ok(out.includes("__cbtcWalk(r.arguments,null,0,`root`)"));
  const injected = out.slice(out.indexOf("let __cbtcBody="), out.indexOf(`/*${require("./chip.js").RUNTIME_MARKER}Native*/`));
  assert.ok(!injected.includes("yh"), "shell renderer is not used");
});

realChipTest("chip: compact summary and Hermes prefix path stay unchanged", () => {
  const src = realChipAsset();
  const out = applyChatBridgeToolCallsChipPatch(src, {});
  assert.ok(out.includes("g=Pb(r,o)"), "original Hermes-prefixed compact label path retained");
  assert.ok(out.includes("summary:y"), "native card receives existing compact summary");
  assert.ok(out.includes("if(s!==`row`)return y"), "non-row compact variants retained");
});

realChipTest("chip: native disclosure is emitted only for row variants", () => {
  const out = applyChatBridgeToolCallsChipPatch(realChipAsset(), {});
  assert.match(out, /if\(s===`row`&&r\.namespace==null&&/);
});

realChipTest("chip: null-namespace Chat rows bypass the icon-only summary wrapper", () => {
  const out = applyChatBridgeToolCallsChipPatch(realChipAsset(), {});
  assert.match(
    out,
    /if\(l===`row`&&i!==void 0&&o\.namespace!=null\)\{/,
    "Chat bridge rows must reach Nb with variant=row so the disclosure body can mount",
  );
  assert.ok(
    out.includes("variant:`summary-text`"),
    "the native icon-only summary path remains available for non-Chat rows",
  );
});

realChipTest("chip: collapsed rows do not mount the arguments body", () => {
  const out = applyChatBridgeToolCallsChipPatch(realChipAsset(), {});
  assert.match(out, /__cbtcBody=__cbtcOpen\?/);
  assert.match(out, /__cbtcWalk\(r\.arguments,null,0,`root`\)/);
  const condition = out.indexOf("let __cbtcBody=__cbtcOpen?");
  const entries = out.indexOf("__cbtcWalk(r.arguments", condition);
  const closed = out.indexOf(":null;", entries);
  assert.ok(condition >= 0 && entries > condition && closed > entries,
    "argument row construction remains inside the expansion-only branch");
});

realChipTest("chip: expanded body renders a compact recursive code tree", () => {
  const out = applyChatBridgeToolCallsChipPatch(realChipAsset(), {});
  const injected = out.slice(out.indexOf("let __cbtcBody="), out.indexOf(`/*${require("./chip.js").RUNTIME_MARKER}Native*/`));
  assert.ok(injected.includes("JSON.parse"), "JSON embedded in string values is parsed recursively");
  assert.ok(injected.includes("__cbtcWalk"), "objects and arrays are traversed recursively");
  assert.ok(injected.includes("paddingLeft:`${__cbtcDepth}rem`"), "tree depth controls indentation");
  assert.ok(injected.includes("font-mono text-xs leading-4"), "the whole view uses compact code typography");
  assert.ok(injected.includes("__cbtcK}:"), "keys are rendered without JSON quotes");
  assert.ok(!injected.includes("grid-cols-["), "the wide key/value grid is removed");
  assert.ok(!injected.includes("JSON.stringify"), "nested values are not dumped as raw JSON");
  assert.ok(!injected.includes("command:"), "the shell-output renderer is not used");
  assert.ok(!injected.includes("yh"), "the shell-output component is not used");
  assert.ok(!injected.includes("max-h-"));
});

realChipTest("chip: disclosure has one icon by suppressing the summary's nested icon on rows", () => {
  const out = applyChatBridgeToolCallsChipPatch(realChipAsset(), {});
  assert.match(out, /s!==`summary-text`&&!\(s===`row`&&r\.namespace==null\)/);
  const injected = out.slice(out.indexOf("let __cbtcBody="), out.indexOf(`/*${require("./chip.js").RUNTIME_MARKER}Native*/`));
  assert.strictEqual((injected.match(/icon:/g) || []).length, 1, "only the card icon is emitted");
});

realChipTest("chip: card icon carries a stable marker for the gear-icon patch", () => {
  const out = applyChatBridgeToolCallsChipPatch(realChipAsset(), {});
  assert.ok(out.includes("codexLinuxChatBridgeToolCallsCardIcon"));
});

realChipTest("chip: transformed real asset passes node --check", () => {
  const out = applyChatBridgeToolCallsChipPatch(realChipAsset(), {});
  const target = "/tmp/chat-bridge-tool-calls-transformed.mjs";
  fs.writeFileSync(target, out);
  const checkOutput = execFileSync(process.execPath, ["--check", target], {encoding: "utf8"});
  assert.strictEqual(checkOutput, "");
});

realChipTest("chip: idempotent, disabled, and fail-soft", () => {
  const src = realChipAsset();
  const once = applyChatBridgeToolCallsChipPatch(src, {});
  assert.strictEqual(applyChatBridgeToolCallsChipPatch(once, {}), once);
  assert.strictEqual(applyChatBridgeToolCallsChipPatch(src, {settings: {showBridgeToolCalls: false}}), src);
  assert.strictEqual(applyChatBridgeToolCallsChipPatch("let a=1;", {}), "let a=1;");
});

// ---------------------------------------------------------------------------
// Icon patch (chat-bridge-tool-calls-icon) — generic agent-activity icon
// ---------------------------------------------------------------------------

const {
  applyChatBridgeToolCallsIconPatch,
  ICON_ANCHOR,
  NB_ANCHOR,
} = require("./icon.js");

test("icon: real-asset anchors match exactly once each", () => {
  const assetPath = "/tmp/p5/webview/assets/subagent-activity-chip-group-a5079589a6b4.js";
  if (!fs.existsSync(assetPath)) return;
  const src = fs.readFileSync(assetPath, "utf8");
  assert.strictEqual([...src.matchAll(new RegExp(ICON_ANCHOR.source, "g"))].length, 1, "icon anchor");
  assert.strictEqual([...src.matchAll(new RegExp(NB_ANCHOR.source, "g"))].length, 1, "nb anchor");
});

test("icon: generic null-namespace fallback uses the gear asset", () => {
  const src = "import{aa as x}from\"./app-primary-123abc.js\";" +
    "(0,s_.jsx)($a,{className:`shrink-0 text-text/60`,asset:Fg});" +
    "rh(n)?.renderAgentActivityIcon?.(n)??(n.namespace===`codex_app`?(0,s_.jsx)(th,{\"aria-hidden\":!0,className:c_}):null);" +
    "c=r.namespace===`codex_app`&&s!==`summary-text`;";
  const out = applyChatBridgeToolCallsIconPatch(src, {});
  assert.ok(out.includes("dh as __cbtcGear"), "gear asset imported");
  assert.ok(out.includes("asset:__cbtcGear"), "gear asset rendered through the asset-icon component");
  assert.ok(out.includes("/*codexLinuxChatBridgeToolCallsIconRuntimeA*/"), "marker A");
  assert.ok(out.includes("/*codexLinuxChatBridgeToolCallsIconRuntimeB*/"), "marker B");
  const condA = "(n.namespace===`codex_app`||n.namespace==null)";
  assert.ok(out.includes(condA), "A rewritten");
  assert.ok(out.includes("(r.namespace===`codex_app`||r.namespace==null)"), "B rewritten");
});

test("icon: native disclosure card icon is replaced with the gear asset", () => {
  const src = "import{aa as x}from\"./app-primary-123abc.js\";" +
    "(0,s_.jsx)($a,{className:`shrink-0 text-text/60`,asset:Fg});" +
    "rh(n)?.renderAgentActivityIcon?.(n)??(n.namespace===`codex_app`?(0,s_.jsx)(th,{\"aria-hidden\":!0,className:c_}):null);" +
    "c=r.namespace===`codex_app`&&s!==`summary-text`;" +
    "icon:(0,s_.jsx)(th,{className:`icon-xs shrink-0 text-secondary`,\"data-codex-linux-chat-bridge-card-icon\":`codexLinuxChatBridgeToolCallsCardIcon`})";
  const out = applyChatBridgeToolCallsIconPatch(src, {});
  assert.ok(out.includes("icon:(0,s_.jsx)($a,{className:`icon-xs shrink-0 text-secondary`,\"data-codex-linux-chat-bridge-card-icon\":`codexLinuxChatBridgeToolCallsCardIcon`,asset:__cbtcGear})"));
});

test("icon: full patched source parses as a module", () => {
  const src = "rh(n)?.renderAgentActivityIcon?.(n)??(n.namespace===`codex_app`?(0,s_.jsx)(th,{\"aria-hidden\":!0,className:c_}):null);c=r.namespace===`codex_app`&&s!==`summary-text`";
  const out = applyChatBridgeToolCallsIconPatch(src, {});
  new Function("rh", "n", "s_", "th", "c_", "r", "s", out + ";");
});

test("icon: idempotent and fail-soft", () => {
  const src = "rh(n)?.renderAgentActivityIcon?.(n)??(n.namespace===`codex_app`?(0,s_.jsx)(th,{\"aria-hidden\":!0,className:c_}):null);c=r.namespace===`codex_app`&&s!==`summary-text`";
  const once = applyChatBridgeToolCallsIconPatch(src, {});
  assert.strictEqual(applyChatBridgeToolCallsIconPatch(once, {}), once);
  assert.strictEqual(applyChatBridgeToolCallsIconPatch("let a=1;", {}), "let a=1;");
  assert.strictEqual(applyChatBridgeToolCallsIconPatch(src, {settings: {showBridgeToolCalls: false}}), src);
});

// ---------------------------------------------------------------------------
// Registry gear-icon patch (chat-bridge-tool-calls-icon-registry)
// ---------------------------------------------------------------------------

const {
  applyChatBridgeToolCallsRegistryIconPatch,
} = require("./icon.js");

test("registry gear: retired descriptor is a no-op", () => {
  assert.strictEqual(applyChatBridgeToolCallsRegistryIconPatch("anything", {}), "anything");
});
