import path from "node:path";
import { buildJsLikeLiteralMask, stripJsLikeComments, stripPythonCommentsAndStrings } from "./comments.js";
import { PYTHON_IDENTIFIER_SOURCE } from "./identifiers.js";
import { normalizePath } from "./paths.js";

export type ModuleSpecifierResolutionKind = "document" | "source" | "stylesheet";

export type ModuleSpecifierExportCondition = "import" | "require";

export type ModuleSpecifier = {
  spec: string;
  raw?: string;
  typeOnly?: boolean;
  phpImportType?: "class" | "function" | "const";
  resolutionKind?: ModuleSpecifierResolutionKind;
  exportCondition?: ModuleSpecifierExportCondition;
  dropIfUnresolved?: boolean;
  resolved?: "heuristic" | "precise";
  confidence?: number;
};

function matchStartsInCode(mask: Uint8Array | undefined, match: RegExpMatchArray): boolean {
  const index = match.index;
  if (index === undefined || !mask) return true;
  const text = match[0] ?? "";
  for (let offset = 0; offset < text.length; offset += 1) {
    const ch = text[offset]!;
    if (/\s/.test(ch)) continue;
    return mask[index + offset] === 0;
  }
  return true;
}

export function extractJsTsSpecifiers(source: string): ModuleSpecifier[] {
  const out: ModuleSpecifier[] = [];
  try {
    const src = stripJsLikeComments(source);
    const push = (spec: string, opts?: { typeOnly?: boolean; exportCondition?: ModuleSpecifierExportCondition }) => {
      if (!spec) return;
      out.push({
        spec,
        ...(opts?.typeOnly ? { typeOnly: true } : {}),
        ...(opts?.exportCondition ? { exportCondition: opts.exportCondition } : {}),
      });
    };
    const literalMask = buildJsLikeLiteralMask(src);
    // Capture groups: 1 import-from, 2 side-effect import, 3 export-from,
    // 4 destructured require, 5 require(), 6 import(), 7 import = require, 8 declare module.
    // JS/TS identifiers permit Unicode ID_Start/ID_Continue plus $/_, with ZWNJ and ZWJ as
    // continuation characters, so import-equals aliases must not use ASCII-only \w.
    const combined =
      /^\s*import\s+[^\n;]*?\s+from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']|\bexport\s+[^\n;]*?\s+from\s+["']([^"']+)["']|\b(?:const|let|var)\s*\{[^}]*\}\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)|(?<!["'`])\brequire\s*\(\s*["']([^"']+)["']\s*\)|(?<!["'`])\bimport\s*\(\s*["']([^"']+)["']\s*\)|^\s*import\s+[$_\p{ID_Start}][$_\p{ID_Continue}\u200c\u200d]*\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)|^\s*declare\s+module\s+["']([^"']+)["']/gmu;

    for (const match of src.matchAll(combined)) {
      if (!matchStartsInCode(literalMask, match)) continue;
      const spec = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? match[7] ?? match[8];
      if (!spec) continue;
      const text = match[0] ?? "";
      let typeOnly = false;
      if (match[1] !== undefined || match[2] !== undefined) {
        typeOnly = /\bimport\s+type\b/.test(text);
      } else if (match[3] !== undefined) {
        typeOnly = /\bexport\s+type\b/.test(text);
      } else if (match[8] !== undefined) {
        typeOnly = true;
      }
      const exportCondition: ModuleSpecifierExportCondition | undefined =
        match[4] !== undefined || match[5] !== undefined || match[7] !== undefined ? "require" : undefined;
      push(spec, {
        ...(typeOnly ? { typeOnly: true } : {}),
        ...(exportCondition ? { exportCondition } : {}),
      });
    }
  } catch {
    /* regex/parse fallback: ignore */
  }
  return out;
}

type DynamicBase = "fileDir" | "filePath" | "project";
type ParsedDynamicToken = { kind: "base"; base: DynamicBase } | { kind: "literal"; value: string };

function parseStringLiteralToken(token: string): string | null {
  const trimmed = token.trim();
  if (trimmed.length < 2) return null;
  const quote = trimmed[0];
  if (quote !== "'" && quote !== `"` && quote !== "`") return null;
  if (!trimmed.endsWith(quote)) return null;
  if (quote === "`" && trimmed.includes("${")) return null;
  return trimmed.slice(1, -1);
}

function splitTopLevelArgs(text: string): string[] | null {
  const args: string[] = [];
  let current = "";
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote) {
      current += ch;
      if (ch === "\\") {
        const next = text[i + 1];
        if (next) {
          current += next;
          i += 1;
        }
        continue;
      }
      if (quote === "`" && ch === "$" && text[i + 1] === "{") return null;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === `"` || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
      current += ch;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) return null;
      depth -= 1;
      current += ch;
      continue;
    }
    if (ch === "," && depth === 0) {
      const trimmed = current.trim();
      if (trimmed) args.push(trimmed);
      current = "";
      continue;
    }
    current += ch;
  }
  if (quote || depth !== 0) return null;
  const tail = current.trim();
  if (tail) args.push(tail);
  return args;
}

function parseDynamicToken(token: string): ParsedDynamicToken | null {
  const compact = token.replace(/\s+/g, "");
  if (compact === "__dirname") {
    return { kind: "base", base: "fileDir" };
  }
  if (compact === "__filename" || compact === "import.meta.url") {
    return { kind: "base", base: "filePath" };
  }
  if (compact === "process.cwd()") {
    return { kind: "base", base: "project" };
  }
  const literal = parseStringLiteralToken(token);
  if (literal !== null) {
    return { kind: "literal", value: literal };
  }
  return null;
}

function parsePathCallArg(argText: string): {
  base: DynamicBase;
  segments: string[];
} | null {
  const match = argText.match(/^\s*path\.(?:join|resolve)\s*\(([\s\S]*)\)\s*$/);
  if (!match) return null;
  const args = splitTopLevelArgs(match[1] ?? "");
  if (!args?.length) return null;
  let base: DynamicBase | null = null;
  const segments: string[] = [];
  for (const arg of args) {
    const token = parseDynamicToken(arg);
    if (!token) return null;
    if (token.kind === "base") {
      if (base && base !== token.base) return null;
      base = token.base;
    } else {
      segments.push(token.value);
    }
  }
  if (!base || !segments.length) return null;
  return { base, segments };
}

function parseNewUrlArg(argText: string): {
  base: DynamicBase;
  segments: string[];
} | null {
  const match = argText.match(/^\s*new\s+URL\s*\(([\s\S]*)\)\s*$/);
  if (!match) return null;
  const args = splitTopLevelArgs(match[1] ?? "");
  if (!args || args.length < 2) return null;
  const firstLiteral = parseStringLiteralToken(args[0] ?? "");
  if (!firstLiteral) return null;
  const baseToken = parseDynamicToken(args[1] ?? "");
  if (!baseToken || baseToken.kind !== "base") return null;
  if (baseToken.base !== "filePath") return null;
  return { base: baseToken.base, segments: [firstLiteral] };
}

function buildRelativeSpecifier(fromFile: string, targetPath: string): string | null {
  const fromDir = path.dirname(fromFile);
  const rel = normalizePath(path.relative(fromDir, targetPath));
  if (!rel) return null;
  return rel.startsWith(".") ? rel : `./${rel}`;
}

export function extractJsTsDynamicSpecifiers(source: string, fromFile: string, projectRoot: string): ModuleSpecifier[] {
  const out: ModuleSpecifier[] = [];
  try {
    const src = stripJsLikeComments(source);
    const literalMask = buildJsLikeLiteralMask(src);
    const seen = new Set<string>();
    const addSpec = (spec: string | null) => {
      if (!spec || seen.has(spec)) return;
      seen.add(spec);
      out.push({ spec, resolved: "heuristic", confidence: 0.7 });
    };
    const pathCallRe =
      /(?<!["'`])\b(?:require|import)\s*\(\s*(path\.(?:join|resolve)\s*\((?:[^()]|\([^()]*\))*\))\s*\)/g;
    for (const match of src.matchAll(pathCallRe)) {
      if (!matchStartsInCode(literalMask, match)) continue;
      const argText = match[1] ?? "";
      const parsed = parsePathCallArg(argText);
      if (!parsed) continue;
      let basePath = projectRoot;
      if (parsed.base === "fileDir") {
        basePath = path.dirname(fromFile);
      } else if (parsed.base === "filePath") {
        basePath = fromFile;
      }
      const targetPath = path.resolve(basePath, ...parsed.segments);
      addSpec(buildRelativeSpecifier(fromFile, targetPath));
    }
    const urlCallRe = /(?<!["'`])\b(?:require|import)\s*\(\s*(new\s+URL\s*\([^)]*\))\s*\)/g;
    for (const match of src.matchAll(urlCallRe)) {
      if (!matchStartsInCode(literalMask, match)) continue;
      const argText = match[1] ?? "";
      const parsed = parseNewUrlArg(argText);
      if (!parsed) continue;
      const baseDir = path.dirname(fromFile);
      const targetPath = path.resolve(baseDir, ...parsed.segments);
      addSpec(buildRelativeSpecifier(fromFile, targetPath));
    }
  } catch {
    /* parse fallback: ignore */
  }
  return out;
}

// Python module/package names are dotted sequences of PEP 3131 Unicode identifiers; a
// per-segment character class (rather than Unicode letters/digits spanning the dots) keeps
// a digit from matching directly after a `.` separator.
const PYTHON_DOTTED_NAME_SOURCE = String.raw`${PYTHON_IDENTIFIER_SOURCE}(?:\.${PYTHON_IDENTIFIER_SOURCE})*`;

function maskPythonString(source: string, mask: Uint8Array, start: number): number {
  const quote = source[start]!;
  const triple = source[start + 1] === quote && source[start + 2] === quote;
  const delimiterLength = triple ? 3 : 1;
  for (let offset = 0; offset < delimiterLength; offset += 1) {
    mask[start + offset] = 1;
  }

  let index = start + delimiterLength;
  while (index < source.length) {
    const ch = source[index]!;
    if (!triple && (ch === "\n" || ch === "\r")) return index;
    mask[index] = 1;
    if (ch === "\\") {
      const nextIndex = index + 1;
      if (nextIndex < source.length) mask[nextIndex] = 1;
      index += 2;
      continue;
    }
    if (ch === quote) {
      if (!triple) return index + 1;
      if (source[index + 1] === quote && source[index + 2] === quote) {
        mask[index + 1] = 1;
        mask[index + 2] = 1;
        return index + delimiterLength;
      }
    }
    index += 1;
  }
  return source.length;
}

function buildPythonNonCodeMask(source: string): Uint8Array | undefined {
  if (!source.includes("#") && !source.includes("'") && !source.includes('"')) return undefined;
  const mask = new Uint8Array(source.length);
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index]!;
    if (ch === "#") {
      while (index < source.length && source[index] !== "\n" && source[index] !== "\r") {
        mask[index] = 1;
        index += 1;
      }
      index -= 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      index = maskPythonString(source, mask, index) - 1;
    }
  }
  return mask;
}

const PYTHON_IMPORTLIB_ALIAS_PATTERN = new RegExp(
  String.raw`^importlib(?:\s+as\s+(${PYTHON_IDENTIFIER_SOURCE}))?$`,
  "u",
);
const PYTHON_IMPORT_MODULE_ALIAS_PATTERN = new RegExp(
  String.raw`^import_module(?:\s+as\s+(${PYTHON_IDENTIFIER_SOURCE}))?$`,
  "u",
);
const PYTHON_DYNAMIC_CALL_PATTERN = new RegExp(
  String.raw`(?<![._\p{XID_Continue}])(${PYTHON_IDENTIFIER_SOURCE})(?:\s*\.\s*(${PYTHON_IDENTIFIER_SOURCE}))?\s*\(\s*(?:name\s*=\s*)?(?:[rRuUfF]{0,2})(["'])([^"'\\\r\n]+)\3`,
  "gmu",
);
const PYTHON_DYNAMIC_MODULE_PATTERN = new RegExp(String.raw`^\.*${PYTHON_DOTTED_NAME_SOURCE}$`, "u");

function collectPythonDynamicImportAliases(source: string): {
  importlibAliases: Set<string>;
  importModuleAliases: Set<string>;
} {
  const importlibAliases = new Set(["importlib"]);
  const importModuleAliases = new Set<string>();
  const cleaned = stripPythonCommentsAndStrings(source);
  for (const match of cleaned.matchAll(/^\s*import\s+([^\r\n;]+)/gmu)) {
    for (const rawClause of (match[1] ?? "").split(",")) {
      const clause = rawClause.trim();
      const parsed = PYTHON_IMPORTLIB_ALIAS_PATTERN.exec(clause);
      if (parsed) importlibAliases.add(parsed[1] ?? "importlib");
    }
  }
  for (const match of cleaned.matchAll(/^\s*from\s+importlib\s+import\s+([^\r\n;]+)/gmu)) {
    for (const rawClause of (match[1] ?? "").split(",")) {
      const clause = rawClause.trim().replace(/^\(\s*|\s*\)$/g, "");
      const parsed = PYTHON_IMPORT_MODULE_ALIAS_PATTERN.exec(clause);
      if (parsed) importModuleAliases.add(parsed[1] ?? "import_module");
    }
  }
  return { importlibAliases, importModuleAliases };
}

/**
 * Extracts best-effort Python dynamic imports whose first argument is a static module
 * string. Alias recognition is intentionally limited to direct `importlib` imports;
 * assignment flow and computed module names remain outside graph construction.
 */
export function extractPythonDynamicSpecifiers(source: string): ModuleSpecifier[] {
  const out: ModuleSpecifier[] = [];
  try {
    const mask = buildPythonNonCodeMask(source);
    const { importlibAliases, importModuleAliases } = collectPythonDynamicImportAliases(source);
    const seen = new Set<string>();
    for (const match of source.matchAll(PYTHON_DYNAMIC_CALL_PATTERN)) {
      if (!matchStartsInCode(mask, match)) continue;
      const receiver = match[1] ?? "";
      const member = match[2];
      const isBuiltinImport = !member && receiver === "__import__";
      const isImportlibCall = member === "import_module" && importlibAliases.has(receiver);
      const isImportedFunctionCall = !member && importModuleAliases.has(receiver);
      if (!isBuiltinImport && !isImportlibCall && !isImportedFunctionCall) continue;
      const spec = match[4] ?? "";
      if (!PYTHON_DYNAMIC_MODULE_PATTERN.test(spec) || seen.has(spec)) continue;
      seen.add(spec);
      out.push({ spec, resolved: "heuristic", confidence: 0.7 });
    }
  } catch {
    /* parse fallback: ignore */
  }
  return out;
}

type DynamicImportSpecifierExtractor = (source: string, fromFile: string, projectRoot: string) => ModuleSpecifier[];

const DYNAMIC_IMPORT_SPECIFIER_EXTRACTORS: Readonly<Record<string, DynamicImportSpecifierExtractor>> = {
  js: extractJsTsDynamicSpecifiers,
  ts: extractJsTsDynamicSpecifiers,
  python: (source) => extractPythonDynamicSpecifiers(source),
};

/**
 * Shared adapter boundary for opt-in dynamic import heuristics. A language adapter
 * extracts only non-executed module candidates and leaves target resolution, provenance
 * merging, and graph construction to the common pipeline.
 */
export function extractDynamicImportSpecifiers(
  languageId: string,
  source: string,
  fromFile: string,
  projectRoot: string,
): ModuleSpecifier[] {
  const extractor = DYNAMIC_IMPORT_SPECIFIER_EXTRACTORS[languageId];
  if (!extractor) return [];
  return extractor(source, fromFile, projectRoot);
}

export function extractPythonSpecifiers(source: string): string[] {
  const out: string[] = [];
  try {
    const cleaned = stripPythonCommentsAndStrings(source);
    const reImport = new RegExp(String.raw`^\s*import\s+(${PYTHON_DOTTED_NAME_SOURCE})`, "gmu");
    for (const match of cleaned.matchAll(reImport)) out.push(match[1]!);
    const reFrom = new RegExp(
      String.raw`^\s*from\s+(\.+(?:${PYTHON_DOTTED_NAME_SOURCE})?|${PYTHON_DOTTED_NAME_SOURCE})\s+import`,
      "gmu",
    );
    for (const match of cleaned.matchAll(reFrom)) out.push(match[1]!);
  } catch {
    /* parse fallback: ignore */
  }
  return out;
}
