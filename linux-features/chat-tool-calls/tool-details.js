"use strict";

const ASSET_PATTERN = /^viewer-[0-9a-f]+\.js$/;
const RUNTIME_MARKER = "codexLinuxChatToolDetailsRuntime";
const RENDER_ANCHOR = /function (\w+)\((\w+)\)\{let (\w+)=\(0,([\w$]+)\.c\)\(227\),\{/;

function warn(message) {
  console.warn(`chat-tool-calls-tool-details: ${message}`);
}

function enabled(context = {}) {
  const defaults = context?.feature?.manifest?.tweaks?.toolDetails;
  const settings = context?.feature?.settings?.tweaks?.toolDetails;
  const config = {
    ...(defaults && typeof defaults === "object" && !Array.isArray(defaults) ? defaults : {}),
    ...(settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {}),
  };
  return config.enabled !== false;
}

function helper(jsx) {
  return `function codexLinuxChatToolDetails(e){let t=e.source?[{label:\`Source\`,value:e.source}]:[],n=[{label:\`Request\`,value:e.request},{label:\`Action\`,value:e.action},{label:\`Status\`,value:e.status},{label:\`Presentation\`,value:e.presentation},...t].filter(e=>e.value!=null&&String(e.value).trim().length>0);return n.length===0?null:(0,${jsx}.jsxs)(\`details\`,{className:\`my-1 rounded-md border border-token-border-light bg-token-bg-secondary/40 px-2 py-1 text-xs text-secondary\`,open:!1,children:[(0,${jsx}.jsx)(\`summary\`,{className:\`cursor-pointer select-none font-medium\`,children:\`Tool details\`}),(0,${jsx}.jsx)(\`dl\`,{className:\`mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5\`,children:n.flatMap((e,t)=>[(0,${jsx}.jsx)(\`dt\`,{className:\`font-medium\`,children:e.label},\`dt-\${t}\`),(0,${jsx}.jsx)(\`dd\`,{className:\`min-w-0 break-words\`,children:String(e.value)},\`dd-\${t}\`)])})]})}/*${RUNTIME_MARKER}*/`;
}

function applyToolDetailsPatch(source, context = {}) {
  try {
    if (typeof source !== "string" || !enabled(context) || source.includes(RUNTIME_MARKER)) return source;
    if (!source.includes("chatgpt-python-execution") || !source.includes("chatGptChatWebSearch")) {
      warn("Chat activity markers not found");
      return source;
    }
    const match = source.match(RENDER_ANCHOR);
    if (!match) {
      warn("Viewer item renderer anchor not found");
      return source;
    }
    const [anchor, fn, props, cache, compiler] = match;
    const jsxImport = source.match(/import\{[^}]*\b(?:j|jsx) as ([\w$]+)[^}]*\}from"\.\/jsx-runtime-[^"]+\.js"/)?.[1] ||
      source.match(/import\{[^}]*\}from"\.\/rolldown-runtime-[^"]+\.js";import\{[^}]* as ([\w$]+)[^}]*\}from/)?.[1] || "Q";
    const replacement = `${helper(jsxImport)}function ${fn}(${props}){let ${cache}=(0,${compiler}.c)(227),{`;
    let patched = source.replace(anchor, replacement);
    let webCount = 0;
    patched = patched.replace(/(if\((\w+)\.type===`web-search`\)\{let \w+;)/, (m, head, item) => {
      webCount += 1;
      return `${head}let codexLinuxDetails=${item}.chatGptChatWebSearch===!0?codexLinuxChatToolDetails({request:\`Web search\`,action:${item}.query,status:${item}.completed?\`Completed\`:\`Running\`,source:${item}.action?.url}):null;`;
    });
    let pythonCount = 0;
    patched = patched.replace(/(if\((\w+)\.type===`chatgpt-python-execution`\)\{let \w+;)/, (m, head, item) => {
      pythonCount += 1;
      return `${head}let codexLinuxDetails=codexLinuxChatToolDetails({request:\`Python analysis\`,action:\`Run data analysis\`,status:${item}.status,presentation:${item}.images?.length?\`Image or chart\`:${item}.output?.length?\`Text output\`:\`No separate output\`});`;
    });
    let returnCount = 0;
    patched = patched.replace(/(if\(f\.type===`web-search`\)[\s\S]{0,700}?return [^?]+\?\(n=D\()e(\),)/, (m, pre, post) => {
      returnCount += 1;
      return `${pre}(0,${jsxImport}.jsxs)(${jsxImport}.Fragment,{children:[e,codexLinuxDetails]})${post}`;
    });
    patched = patched.replace(/(if\(f\.type===`chatgpt-python-execution`\)[\s\S]{0,700}?return [^?]+\?\(n=D\()e(\),)/, (m, pre, post) => {
      returnCount += 1;
      return `${pre}(0,${jsxImport}.jsxs)(${jsxImport}.Fragment,{children:[e,codexLinuxDetails]})${post}`;
    });
    if (webCount !== 1 || pythonCount !== 1 || returnCount !== 2) {
      warn(`Expected web/Python/render anchors 1/1/2; found ${webCount}/${pythonCount}/${returnCount}`);
      return source;
    }
    return patched;
  } catch (error) {
    warn(error instanceof Error ? error.message : String(error));
    return source;
  }
}

const descriptors = [{
  id: "chat-tool-details",
  phase: "webview-asset",
  order: 20_985,
  ciPolicy: "optional",
  pattern: ASSET_PATTERN,
  missingDescription: "viewer Chat activity renderer bundle",
  skipDescription: "chat-tool-calls compact details patch",
  apply: applyToolDetailsPatch,
}];

module.exports = { ASSET_PATTERN, RUNTIME_MARKER, applyToolDetailsPatch, descriptors, enabled };
