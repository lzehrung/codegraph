const path = require("node:path");
const { createRequire } = require("node:module");
const Parser = require("tree-sitter");

const requireFromHere = createRequire(__filename);
const languageCache = new Map();
let typescriptCache = null;

function isObject(value) {
  return typeof value === "object" && value !== null;
}

function extractDefaultExport(value) {
  if (isObject(value) && "default" in value) {
    return value.default;
  }
  return value;
}

function packageLanguageExportName(packageName) {
  if (!packageName.startsWith("tree-sitter-")) return null;
  return packageName.slice("tree-sitter-".length).replace(/-/g, "_");
}

function resolveLanguageCandidate(packageName, value) {
  const candidate = extractDefaultExport(value);
  if (isObject(candidate) && "language" in candidate) {
    return candidate;
  }
  const exportName = packageLanguageExportName(packageName);
  if (
    exportName &&
    isObject(candidate) &&
    exportName in candidate &&
    isObject(candidate[exportName]) &&
    "language" in candidate[exportName]
  ) {
    return candidate[exportName];
  }
  return candidate;
}

function shouldFallbackToBinding(error) {
  if (isObject(error) && "code" in error) {
    const { code } = error;
    if (typeof code === "string" && code === "ERR_REQUIRE_ESM") return true;
  }
  if (error instanceof Error) {
    return (
      error.message.includes("require() cannot be used on an ESM graph") ||
      error.message.includes("Top-level await is currently not supported")
    );
  }
  return false;
}

function loadBindingFromPackage(packageName) {
  const packageJsonPath = requireFromHere.resolve(`${packageName}/package.json`);
  const packageRoot = path.dirname(packageJsonPath);
  const packageRequire = createRequire(packageJsonPath);
  const nodeGypBuild = packageRequire("node-gyp-build");
  const binding = nodeGypBuild(packageRoot);
  try {
    const nodeTypes = packageRequire(
      path.join(packageRoot, "src", "node-types.json"),
    );
    if (isObject(binding)) {
      binding.nodeTypeInfo = nodeTypes;
    }
  } catch {
    // Optional node-types metadata.
  }
  return binding;
}

function loadPackageModule(packageName) {
  try {
    return requireFromHere(packageName);
  } catch (error) {
    if (shouldFallbackToBinding(error)) {
      return loadBindingFromPackage(packageName);
    }
    throw error;
  }
}

function loadTreeSitterLanguage(packageName) {
  const cached = languageCache.get(packageName);
  if (cached) return cached;

  const mod = loadPackageModule(packageName);
  const candidate = resolveLanguageCandidate(packageName, mod);
  if (!candidate) {
    throw new Error(`Failed to load Tree-sitter language from ${packageName}`);
  }
  languageCache.set(packageName, candidate);
  return candidate;
}

function loadTypeScriptGrammars() {
  if (typescriptCache) return typescriptCache;
  const mod = loadPackageModule("tree-sitter-typescript");
  const candidate = extractDefaultExport(mod);
  if (isObject(candidate) && candidate.typescript && candidate.tsx) {
    typescriptCache = {
      typescript: candidate.typescript,
      tsx: candidate.tsx,
    };
    return typescriptCache;
  }
  throw new Error("Failed to load tree-sitter-typescript grammars");
}

function parseWithJsLanguage(source, language) {
  const parser = new Parser();
  parser.setLanguage(language);
  return parser.parse(source);
}

function toNativeMatch(match) {
  return {
    patternIndex: match.pattern,
    captures: match.captures.map((capture) => ({
      name: capture.name,
      text: capture.node.text,
      nodeType: capture.node.type,
      start: {
        row: capture.node.startPosition.row,
        column: capture.node.startPosition.column,
        index: capture.node.startIndex,
      },
      end: {
        row: capture.node.endPosition.row,
        column: capture.node.endPosition.column,
        index: capture.node.endIndex,
      },
    })),
  };
}

function executeJsQueryAsNativeMatches(source, language, queryText, tree) {
  const resolvedTree = tree ?? parseWithJsLanguage(source, language);
  const query = new Parser.Query(language, queryText);
  return query.matches(resolvedTree.rootNode).map(toNativeMatch);
}

module.exports = {
  loadTreeSitterLanguage,
  loadTypeScriptGrammars,
  parseWithJsLanguage,
  executeJsQueryAsNativeMatches,
};
