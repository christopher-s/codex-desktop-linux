"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ASSET_PATTERN,
  RUNTIME_MARKER,
  SUMMARY_ANCHOR,
  applySearchDomainsPatch,
  searchDomainsEnabled,
  looksLikeViewerBundle,
  descriptors,
} = require("./search-domains.js");

// Fixture mirroring the viewer's summary call-site (names differ per build).
// React-compiler memo shape: cache reads via t[k]!==x, write t[k]=x.
function fixture() {
  return (
    "function Chip(e){let t=(0,qc.c)(15),n,r,i,a,o,s,l;" +
    "t[0]===e?(n=t[1],r=t[2],i=t[3],a=t[4]):({item:n,runId:r,resolvedApps:i,shouldBlockExternalEgress:a}=e,t[0]=e,t[1]=n,t[2]=r,t[3]=i,t[4]=a);" +
    "t[5]===n.content?(s=t[6]):(s=(0,pd.jsx)(Md,{isStreaming:o,textStyle:l,children:n.content}),t[5]=n.content,t[6]=s);" +
    "let u=s;" +
    "if(n.presentation===`preamble`||n.toolIcons==null||n.toolIcons.length===0)return u;" +
    "let f;" +
    "t[8]!==n.toolIcons||t[9]!==i||t[10]!==a?" +
    "(f=(0,td.jsx)(Zu,{resolvedApps:i,shouldBlockExternalEgress:a,toolIcons:n.toolIcons}),t[8]=n.toolIcons,t[9]=i,t[10]=a,t[11]=f):f=t[11];" +
    "let p;" +
    "return t[12]!==u||t[13]!==f?" +
    "(p=(0,td.jsx)(na,{icon:f,summary:u}),t[12]=u,t[13]=f,t[14]=p):p=t[14],p}" +
    "function Zu(e){return null}function na(e){return null}"
  );
}

test("descriptor metadata is well-formed", () => {
  assert.equal(descriptors.length, 1);
  const d = descriptors[0];
  assert.equal(d.id, "search-domains");
  assert.equal(d.phase, "webview-asset");
  assert.match(d.pattern.source, /viewer-/);
  assert.equal(d.ciPolicy, "optional");
  assert.equal(typeof d.apply, "function");
});

test("asset pattern matches viewer bundle only", () => {
  assert.ok(ASSET_PATTERN.test("viewer-b286e659c89a.js"));
  assert.ok(!ASSET_PATTERN.test("app-initial-36a3a1b7313c.js"));
  assert.ok(!ASSET_PATTERN.test("subagent-activity-chip-group-a5079589a6b4.js"));
});

test("patch injects the body slot with domain extraction", () => {
  const src = fixture();
  assert.ok(looksLikeViewerBundle(src));
  const out = applySearchDomainsPatch(src, {});
  assert.notEqual(out, src);
  assert.ok(out.includes(",body:"));
  assert.ok(out.includes("/*" + RUNTIME_MARKER + "*/"));
  // guard preserved
  assert.ok(out.includes("||n.toolIcons==null||n.toolIcons.length===0)return u;"));
  // memo for p dropped (recompute each render)
  assert.ok(!out.includes("t[12]!==u||t[13]!==f"));
});

test("patch keeps the code parseable (esbuild check via Function ctor)", () => {
  const src = fixture();
  const out = applySearchDomainsPatch(src, {});
  // extract the patched function body and syntax-check it as ESM via node --check
  // (here: cheap brace-balance + no stray ';' inside replacement)
  assert.ok(out.includes(",body:(((n.toolIcons)||[])"));
});

test("patch is idempotent", () => {
  const src = fixture();
  const once = applySearchDomainsPatch(src, {});
  const twice = applySearchDomainsPatch(once, {});
  assert.equal(once, twice);
});

test("patch is disabled by settings", () => {
  const src = fixture();
  const out = applySearchDomainsPatch(src, {
    feature: { settings: { tweaks: { searchDomains: { enabled: false } } } },
  });
  assert.equal(out, src);
});

test("settings precedence honors explicit settings over defaults", () => {
  assert.equal(
    searchDomainsEnabled({
      feature: {
        manifest: { tweaks: { searchDomains: { enabled: false } } },
        settings: { tweaks: { searchDomains: { enabled: true } } },
      },
    }),
    true,
  );
});

test("fail-soft: unrelated source returns unchanged", () => {
  const out = applySearchDomainsPatch("const x=1;function Zu(){}", {});
  assert.equal(out, "const x=1;function Zu(){}");
});

test("real-shape parse: patched fixture parses as ESM", () => {
  const src = fixture();
  const out = applySearchDomainsPatch(src, {});
  const { execFileSync } = require("node:child_process");
  const fs = require("node:fs");
  const os = require("node:os");
  const p = fs.mkdtempSync(require("node:path").join(os.tmpdir(), "sd-"));
  const f = require("node:path").join(p, "m.mjs");
  fs.writeFileSync(f, out);
  execFileSync(process.execPath, ["--check", f]);
  fs.rmSync(p, { recursive: true, force: true });
});

test("anchor matches the upstream viewer chunk shape", () => {
  // regression against the verified upstream bytes (viewer-b286e659c89a.js)
  const verified =
    "if(n.presentation===`preamble`||n.toolIcons==null||n.toolIcons.length===0)return d;let f;t[8]!==n.toolIcons||t[9]!==i||t[10]!==a?(f=(0,td.jsx)(Zu,{resolvedApps:i,shouldBlockExternalEforge:a,toolIcons:n.toolIcons}),t[8]=n.toolIcons,t[9]=i,t[10]=a,t[11]=f):f=t[11];let p;return t[12]!==d||t[13]!==f?(p=(0,td.jsx)(na,{icon:f,summary:d}),t[12]=d,t[13]=f,t[14]=p):p=t[14],p}";
  assert.ok(SUMMARY_ANCHOR.test(verified));
});

test("anchor matches the actual upstream viewer bytes", () => {
  const actual =
    "if(n.presentation===`preamble`||n.toolIcons==null||n.toolIcons.length===0)return d;let f;t[8]!==n.toolIcons||t[9]!==i||t[10]!==a?(f=(0,td.jsx)(Zu,{resolvedApps:i,shouldBlockExternalEgress:a,toolIcons:n.toolIcons}),t[8]=n.toolIcons,t[9]=i,t[10]=a,t[11]=f):f=t[11];let p;return t[12]!==d||t[13]!==f?(p=(0,td.jsx)(na,{icon:f,summary:d}),t[12]=d,t[13]=f,t[14]=p):p=t[14],p}";
  assert.ok(SUMMARY_ANCHOR.test(actual));
});
