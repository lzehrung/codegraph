import path from "node:path";
import { createRequire } from "node:module";
import Parser from "tree-sitter";

const require = createRequire(import.meta.url);
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
  const packageJsonPath = require.resolve(`${packageName}/package.json`);
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
    return require(packageName);
  } catch (error) {
    if (shouldFallbackToBinding(error)) {
      return loadBindingFromPackage(packageName);
    }
    throw error;
  }
}

export function loadTreeSitterLanguage(packageName) {
  const cached = languageCache.get(packageName);
  if (cached) return cached;

  const mod = loadPackageModule(packageName);
  const candidate = extractDefaultExport(mod);
  if (!candidate) {
    throw new Error(`Failed to load Tree-sitter language from ${packageName}`);
  }
  languageCache.set(packageName, candidate);
  return candidate;
}

export function loadTypeScriptGrammars() {
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

export function parseWithJsLanguage(source, language) {
  const parser = new Parser();
  parser.setLanguage(language);
  return parser.parse(source);
}

export function isJsSyntaxTree(tree) {
  return (
    typeof tree === "object" &&
    tree !== null &&
    "rootNode" in tree &&
    "walk" in tree
  );
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

export function executeJsQueryAsNativeMatches(source, language, queryText, tree) {
  const resolvedTree = tree ?? parseWithJsLanguage(source, language);
  const query = new Parser.Query(language, queryText);
  return query.matches(resolvedTree.rootNode).map(toNativeMatch);
}
