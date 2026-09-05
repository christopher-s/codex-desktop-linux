"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  ASSET_PATTERN,
  RUNTIME_MARKER,
  applyExpandToolActivityPatch,
  descriptors,
  expandToolActivityEnabled,
  looksLikeDisclosureBundle,
} = require("./patch.js");

// Minimal structural fixture mirroring the upstream disclosure component:
// one shared `let` with destructured props, comma-chained declarators, and the
// `X!==void 0&&X` defaultExpanded capture. Names differ per build, so the
// fixture uses different identifiers than the shipped asset.
function fixture(name) {
  const f = `import{n as e}from"./rolldown-runtime-x.js";function _(){let e=(0,y.c)(7),[t,n]=(0,b.useState)(0),r;return{borderBoxSize:e}}function ${name}(e){let t=(0,q.c)(25),{defaultExpanded:n,indentContent:i,icon:a,onExpand:s,summary:l,status:u,children:d}=e,f=n!==void 0&&n,p=i===void 0||i,[g,v]=(0,w.useState)(!1),[y,b]=(0,w.useState)(f);return{expanded:y,running:u===\`running\`,overflow:u===\`x\`?\`overflow-hidden\`:\`o\`,borderBoxSize:!0}}export{${name} as t};`;
  return f;
}

test("descriptor metadata is well-formed", () => {
  assert.equal(descriptors.length, 4);
  const d = descriptors[0];
  assert.equal(d.id, "expand-tool-activity");
  assert.equal(d.phase, "webview-asset");
  assert.match(d.pattern.source, /tool-activity-disclosure/);
  assert.equal(d.ciPolicy, "optional");
  assert.equal(typeof d.apply, "function");
});

test("asset pattern matches the disclosure bundle only", () => {
  assert.ok(ASSET_PATTERN.test("tool-activity-disclosure-da11c409681c.js"));
  assert.ok(!ASSET_PATTERN.test("agent-activity-item-fcffb86b2066.js"));
  assert.ok(!ASSET_PATTERN.test("app-initial-c8dbea294abe.js"));
});

test("patch rewrites the defaultExpanded capture to true", () => {
  const src = fixture("Sx");
  assert.ok(looksLikeDisclosureBundle(src));
  const out = applyExpandToolActivityPatch(src, {});
  assert.notEqual(out, src);
  assert.ok(out.includes("f=true/*" + RUNTIME_MARKER + "*/"));
  assert.ok(!out.includes("n!==void 0&&n"));
});

test("patch keeps the comma declarator chain intact (parses as ESM)", () => {
  const src = fixture("Sx");
  const out = applyExpandToolActivityPatch(src, {});
  // The declarator after the rewrite must still be part of the same let chain.
  assert.ok(/f=true\/\*[a-zA-Z]*\*\/,p=/.test(out));
});

test("patch is idempotent", () => {
  const src = fixture("Sx");
  const once = applyExpandToolActivityPatch(src, {});
  const twice = applyExpandToolActivityPatch(once, {});
  assert.equal(once, twice);
});

test("patch fails softly on unrelated sources", () => {
  const out = applyExpandToolActivityPatch("export const x = 1;", {});
  assert.equal(out, "export const x = 1;");
});

test("missing anchor leaves source untouched", () => {
  const noCapture = fixture("Sx").replace("f=n!==void 0&&n", "f=n");
  const out = applyExpandToolActivityPatch(noCapture, {});
  assert.equal(out, noCapture);
});

test("tweak can be disabled via settings", () => {
  const src = fixture("Sx");
  const out = applyExpandToolActivityPatch(src, {
    feature: { settings: { tweaks: { expandToolActivity: { enabled: false } } } },
  });
  assert.equal(out, src);
});

test("expandToolActivityEnabled defaults to enabled", () => {
  assert.equal(expandToolActivityEnabled({}), true);
  assert.equal(expandToolActivityEnabled(undefined), true);
});

test("applies cleanly against the real upstream asset when present", { skip: !fs.existsSync("/tmp/cdx-app/webview/assets/tool-activity-disclosure-da11c409681c.js") }, () => {
  const src = fs.readFileSync("/tmp/cdx-app/webview/assets/tool-activity-disclosure-da11c409681c.js", "utf8");
  const out = applyExpandToolAssetPatchSafe(src);
  assert.ok(out.includes("f=true"));
});

function applyExpandToolAssetPatchSafe(src) {
  return applyExpandToolActivityPatch(src, {});
}
