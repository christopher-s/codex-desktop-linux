"use strict";

/**
 * chat-tool-calls/search-domains patch: show the full list of searched
 * websites under "Searched N websites" summary chips in Chat threads.
 *
 * Background (verified on viewer-b286e659c89a.js, upstream 26.901.x):
 *   - Search-turn reasoning items carry `toolIcons`: favicon URLs of the
 *     form `https://www.google.com/s2/favicons?domain=<host>&sz=128`, one
 *     per site visited. The full domain list is present client-side in
 *     React state but never rendered: the icon resolver (`Zu`) drops these
 *     external URLs in the desktop egress-blocked environment, so the chip
 *     shows only the aggregate text "Searched 9 websites".
 *   - The chip renders through the summary row component (imported as
 *     `na`, exported `Jna` from app-initial) whose props include `body` —
 *     a slot `Wna` renders BELOW the header row, outside the `truncate`
 *     span. That slot is the natural place for the domain list.
 *
 * Patch strategy: at the single call site
 *   let p;return t[K]!==d||t[K]!==f?(p=(0,td.jsx)(na,{icon:f,summary:d}),...):p=t[K],p}
 * rewrite to pass `body:` — a muted, wrapped, plain-text domain list
 * derived from `n.toolIcons` (only when at least one URL carries a
 * `domain=` param, i.e. real web searches, not internal app icons). The
 * React-compiler memo check for `p` is dropped (recomputed per render) so
 * the body can never go stale against toolIcons changes during streaming.
 *
 * Domains render as text, not links: no egress-policy interaction with
 * `shouldBlockExternalEgress`.
 *
 * Fail-soft: anchor miss returns the source unchanged with a warning.
 * Idempotent via the /*MARKER* / comment. Disable via settings
 * { tweaks: { searchDomains: { enabled: false } } }.
 */

const RUNTIME_MARKER = "codexLinuxChatSearchDomainsRuntime";

const ASSET_PATTERN = /^viewer-[0-9a-f]+\.js$/;

// Anchor: the preamble/toolIcons guard through the summary jsx call.
// Structural; identifiers and cache slot numbers vary per build.
//   if(n.presentation===`preamble`||n.toolIcons==null||n.toolIcons.length===0)return d;
//   let f;<Zu icon memo block, comma-chained, no interior ';'>;let p;
//   return t[K]!==d||t[K]!==f?(p=(0,td.jsx)(na,{icon:f,summary:d}),t..):p=t[K],p}
const SUMMARY_ANCHOR =
  /(?<n>\w+)\.presentation===`preamble`\|\|\k<n>\.toolIcons==null\|\|\k<n>\.toolIcons\.length===0\)return (?<d>\w+);(?<mid>let (?<f>\w+);[^;]*;)let (?<p>\w+);return t\[\d+\]!==\k<d>\|\|t\[\d+\]!==\k<f>\?\(\k<p>=\(0,(?<td>\w+)\.jsx\)\((?<na>\w+),\{icon:\k<f>,summary:\k<d>\}\),t\[\d+\]=\k<d>,t\[\d+\]=\k<f>,t\[\d+\]=\k<p>\):\k<p>=t\[\d+\],\k<p>\}/;

function warn(message) {
  console.warn(`chat-tool-calls-search-domains: ${message}`);
}

function searchDomainsEnabled(context = {}) {
  const defaults = context?.feature?.manifest?.tweaks?.searchDomains;
  const settings = context?.feature?.settings?.tweaks?.searchDomains;
  const config = {
    ...(defaults != null && typeof defaults === "object" && !Array.isArray(defaults) ? defaults : {}),
    ...(settings != null && typeof settings === "object" && !Array.isArray(settings) ? settings : {}),
  };
  return config.enabled !== false;
}

function looksLikeViewerBundle(source) {
  return source.includes(".toolIcons==null") && source.includes("{icon:") &&
    source.includes("presentation===`preamble`");
}

function applySearchDomainsPatch(source, context = {}) {
  try {
    if (typeof source !== "string") {
      warn("Asset source is not a string");
      return source;
    }
    if (!searchDomainsEnabled(context)) {
      return source;
    }
    if (source.includes(RUNTIME_MARKER)) {
      return source; // already patched (idempotent)
    }
    if (!looksLikeViewerBundle(source)) {
      warn("Could not find search summary markers");
      return source;
    }

    const m = SUMMARY_ANCHOR.exec(source);
    if (!m) {
      warn("summary call-site anchor not found");
      return source;
    }
    const { n, d, mid, f, p, td, na } = m.groups;

    // Chat search reasoning items retain one favicon URL per searched domain,
    // but no query strings or exact result URLs. Render each retained domain as
    // its own disclosure row. The `presentation` + `toolIcons` path is specific
    // to Chat reasoning items; Codex `web-search` items use another renderer.
    const bodyExpr =
      "(((" + n + ".toolIcons)||[]).some(function(u){return typeof u===\"string\"&&u.indexOf(\"domain=\")>=0})" +
      "?(0," + td + ".jsx)(`div`,{className:`flex flex-col gap-1 pt-1.5 pl-0.5 text-xs text-text/60`," +
      "children:(" + n + ".toolIcons||[]).map(function(u,ci){var cm=/domain=([^&]+)/.exec(u);" +
      "if(!cm)return null;var ch;try{ch=decodeURIComponent(cm[1])}catch(ce){ch=cm[1]}" +
      "return (0," + td + ".jsxs)(`div`,{className:`flex min-w-0 items-start gap-2`,children:[" +
      "(0," + td + ".jsx)(`span`,{className:`mt-[0.15rem] shrink-0 text-[9px] leading-none text-text/40`,\"aria-hidden\":true,children:`●`})," +
      "(0," + td + ".jsx)(`span`,{className:`min-w-0 break-all`,children:ch})]},ch+\"-\"+String(ci))})})" +
      ":void 0)";

    const original = m[0];
    const replacement =
      n + ".presentation===`preamble`||" + n + ".toolIcons==null||" + n +
      ".toolIcons.length===0)return " + d + ";" + mid + "let " + p +
      ";return " + p + "=(0," + td + ".jsx)(" + na + ",{icon:" + f + ",summary:" + d +
      ",body:" + bodyExpr + "/*" + RUNTIME_MARKER + "*/})," + p + "}";

    const patched = source.replace(original, replacement);
    if (patched === source) {
      warn("summary replacement produced no change");
      return source;
    }
    return patched;
  } catch (error) {
    warn(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    return source;
  }
}

module.exports = {
  ASSET_PATTERN,
  RUNTIME_MARKER,
  SUMMARY_ANCHOR,
  applySearchDomainsPatch,
  searchDomainsEnabled,
  looksLikeViewerBundle,
  descriptors: [
    {
      id: "search-domains",
      phase: "webview-asset",
      order: 20_980,
      ciPolicy: "optional",
      pattern: ASSET_PATTERN,
      missingDescription: "viewer chunk",
      skipDescription: "chat-tool-calls search domains patch",
      apply: applySearchDomainsPatch,
    },
  ],
};
