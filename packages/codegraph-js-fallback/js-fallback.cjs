const JS_GRAMMAR_FALLBACK_UNAVAILABLE_MESSAGE =
  "JS Tree-sitter fallback is unavailable; native parser is the only grammar backend";

function loadTreeSitterLanguage(packageName) {
  return { name: packageName };
}

function loadTypeScriptGrammars() {
  return {
    typescript: { name: "tree-sitter-typescript/typescript" },
    tsx: { name: "tree-sitter-typescript/tsx" },
  };
}

function parseWithJsLanguage() {
  throw new Error(`${JS_GRAMMAR_FALLBACK_UNAVAILABLE_MESSAGE} for syntax-tree parsing`);
}

function executeJsQueryAsNativeMatches() {
  throw new Error(`${JS_GRAMMAR_FALLBACK_UNAVAILABLE_MESSAGE} for query execution`);
}

module.exports = {
  loadTreeSitterLanguage,
  loadTypeScriptGrammars,
  parseWithJsLanguage,
  executeJsQueryAsNativeMatches,
};
