import path from "node:path";
import { buildJsLikeLiteralMask, stripJsLikeComments, stripPythonCommentsAndStrings } from "./comments.js";
import {
  createDynamicImportEntries,
  type DynamicBase,
  type DynamicImportPreparation,
  type DynamicImportShapeContext,
  type FoldedPath,
  type PathFoldProfile,
} from "./dynamic-import-tables.js";
import { ECMASCRIPT_IDENTIFIER_SOURCE, PYTHON_IDENTIFIER_SOURCE } from "./identifiers.js";
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
  pathAttribute?: string;
  statementStartIndex?: number;
};

const JS_TS_NAMED_TYPE_SPECIFIER_PATTERN = new RegExp(
  String.raw`^type\s+(${ECMASCRIPT_IDENTIFIER_SOURCE})(?:\s+as\s+(${ECMASCRIPT_IDENTIFIER_SOURCE}))?$`,
  "u",
);

function splitJsTsNamedSpecifiers(namedBlock: string): string[] {
  return namedBlock
    .split(",")
    .map((spec) => spec.trim())
    .filter(Boolean);
}

/**
 * File-graph edges are per module specifier. A statement is type-only when it cannot
 * introduce a runtime binding: `import type` / `export type`, `declare module`, or a
 * named clause whose every specifier is inline `type`. Mixed clauses stay runtime.
 */
export function isJsTsTypeOnlySpecifierStatement(statement: string): boolean {
  const text = stripJsLikeComments(statement).trim();
  if (/^declare\s+module\s*["']/.test(text)) return true;
  const fromMatch = /^(?:import|export)\b\s*([\s\S]*?)\bfrom\s*["']/.exec(text);
  if (!fromMatch) return false;
  const clause = fromMatch[1]!.trim();
  if (/^type(?:\s+|(?=\{))/.test(clause) && !clause.slice(4).trimStart().startsWith(",")) return true;
  if (!clause.startsWith("{") || !clause.endsWith("}")) return false;
  const specs = splitJsTsNamedSpecifiers(clause.slice(1, -1));
  if (!specs.length) return false;
  return specs.every((spec) => JS_TS_NAMED_TYPE_SPECIFIER_PATTERN.test(spec));
}

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
      /^\s*import\b\s*[^\n;]*?\bfrom\s*["']([^"']+)["']|^\s*import\s+["']([^"']+)["']|\bexport\b\s*[^\n;]*?\bfrom\s*["']([^"']+)["']|\b(?:const|let|var)\s*\{[^}]*\}\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)|(?<!["'`])\brequire\s*\(\s*["']([^"']+)["']\s*\)|(?<!["'`])\bimport\s*\(\s*["']([^"']+)["']\s*\)|^\s*import\s+[$_\p{ID_Start}][$_\p{ID_Continue}\u200c\u200d]*\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)|^\s*declare\s+module\s+["']([^"']+)["']/gmu;

    for (const match of src.matchAll(combined)) {
      if (!matchStartsInCode(literalMask, match)) continue;
      const spec = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? match[7] ?? match[8];
      if (!spec) continue;
      const text = match[0] ?? "";
      let typeOnly = false;
      if (match[1] !== undefined || match[2] !== undefined || match[3] !== undefined) {
        typeOnly = isJsTsTypeOnlySpecifierStatement(text);
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

type ParsedDynamicToken = { kind: "base"; base: DynamicBase } | { kind: "literal"; value: string };

function parseQuotedStringToken(token: string): string | null {
  const trimmed = token.trim();
  if (trimmed.length < 2) return null;
  const quote = trimmed[0];
  if (quote !== "'" && quote !== `"` && quote !== "`") return null;
  if (!trimmed.endsWith(quote)) return null;
  if (quote === "`" && trimmed.includes("${")) return null;
  return trimmed.slice(1, -1);
}

function splitTopLevelDelimited(text: string, delimiter: string): string[] | null {
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
    if (ch === delimiter && depth === 0) {
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

function parsePathToken(token: string, profile: PathFoldProfile): ParsedDynamicToken | null {
  const compact = token.replace(/\s+/g, "");
  const base = profile.bases[compact];
  if (base) return { kind: "base", base };
  const literal = parseQuotedStringToken(token);
  if (literal !== null) {
    return { kind: "literal", value: literal };
  }
  return null;
}

const JOIN_HELPER_PATTERNS = new WeakMap<PathFoldProfile, RegExp | null>();

function joinHelperPatternFor(profile: PathFoldProfile): RegExp | null {
  let pattern = JOIN_HELPER_PATTERNS.get(profile);
  if (pattern === undefined) {
    pattern = profile.joinHelpers.length
      ? new RegExp(
          `^\\s*(?:${profile.joinHelpers
            .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join("|")})\\s*\\(([\\s\\S]*)\\)\\s*$`,
        )
      : null;
    JOIN_HELPER_PATTERNS.set(profile, pattern);
  }
  return pattern;
}

/** Folds an already-split argument list into one rooted base plus literal segments; mixed
 * bases, missing bases, and unparseable tokens fold to null. */
function foldPathTokens(args: string[], profile: PathFoldProfile): FoldedPath | null {
  if (!args.length) return null;
  let base: DynamicBase | null = null;
  const segments: string[] = [];
  for (const arg of args) {
    const token = parsePathToken(arg, profile);
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

/**
 * Shared constant-path fold for dynamic-import heuristics: either a join-helper call such as
 * `path.join(__dirname, "src")` or, where the language declares a concatenation operator, a
 * constant chain such as `__DIR__ . "/config.php"`. Anything needing runtime evaluation
 * (variables, template placeholders, mixed bases) folds to null.
 */
function foldPathArgument(argText: string, profile: PathFoldProfile): FoldedPath | null {
  const joinPattern = joinHelperPatternFor(profile);
  const joinMatch = joinPattern ? joinPattern.exec(argText) : null;
  if (joinMatch) {
    const args = splitTopLevelDelimited(joinMatch[1] ?? "", ",");
    return args ? foldPathTokens(args, profile) : null;
  }
  if (profile.concat !== undefined) {
    const parts = splitTopLevelDelimited(argText, profile.concat);
    return parts ? foldPathTokens(parts, profile) : null;
  }
  return null;
}

function foldNewUrlArgument(argText: string, profile: PathFoldProfile): FoldedPath | null {
  const match = argText.match(/^\s*new\s+URL\s*\(([\s\S]*)\)\s*$/);
  if (!match) return null;
  const args = splitTopLevelDelimited(match[1] ?? "", ",");
  if (!args || args.length < 2) return null;
  const firstLiteral = parseQuotedStringToken(args[0] ?? "");
  if (!firstLiteral) return null;
  const baseToken = parsePathToken(args[1] ?? "", profile);
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

/** Resolves a folded path against the root its base names: fileDir names the file's
 * directory, filePath the file itself, project the project root. */
function resolveFoldedPathAgainstBase(folded: FoldedPath, fromFile: string, projectRoot: string): string | null {
  let basePath = projectRoot;
  if (folded.base === "fileDir") {
    basePath = path.dirname(fromFile);
  } else if (folded.base === "filePath") {
    basePath = fromFile;
  }
  return buildRelativeSpecifier(fromFile, path.resolve(basePath, ...folded.segments));
}

/** Resolves a folded path against the containing file's directory regardless of the named
 * base: `new URL("./x", import.meta.url)` lives next to the file. */
function resolveFoldedPathAgainstFileDir(folded: FoldedPath, fromFile: string): string | null {
  return buildRelativeSpecifier(fromFile, path.resolve(path.dirname(fromFile), ...folded.segments));
}

/** Resolves a folded path by concatenation onto the containing file's directory, the way
 * `File.join` and PHP's `.` operator build paths: a leading separator in a segment stays part
 * of the file-relative path instead of resetting to a filesystem root. */
function resolveFoldedPathByConcatenation(folded: FoldedPath, fromFile: string): string | null {
  return buildRelativeSpecifier(fromFile, path.join(path.dirname(fromFile), ...folded.segments));
}

function foldCapturedPath(
  profile: PathFoldProfile,
  resolve: (folded: FoldedPath, fromFile: string, projectRoot: string) => string | null,
): (context: DynamicImportShapeContext) => string | null {
  return ({ match, fromFile, projectRoot }) => {
    const folded = foldPathArgument(match[1] ?? "", profile);
    return folded ? resolve(folded, fromFile, projectRoot) : null;
  };
}

// Python module/package names are dotted sequences of PEP 3131 Unicode identifiers; a
// per-segment character class (rather than Unicode letters/digits spanning the dots) keeps
// a digit from matching directly after a `.` separator.
const PYTHON_DOTTED_NAME_SOURCE = String.raw`${PYTHON_IDENTIFIER_SOURCE}(?:\.${PYTHON_IDENTIFIER_SOURCE})*`;

const PYTHON_IMPORTLIB_ALIAS_PATTERN = new RegExp(
  String.raw`^importlib(?:\s+as\s+(${PYTHON_IDENTIFIER_SOURCE}))?$`,
  "u",
);
const PYTHON_IMPORT_MODULE_ALIAS_PATTERN = new RegExp(
  String.raw`^import_module(?:\s+as\s+(${PYTHON_IDENTIFIER_SOURCE}))?$`,
  "u",
);
const PYTHON_DYNAMIC_MODULE_PATTERN = new RegExp(String.raw`^\.*${PYTHON_DOTTED_NAME_SOURCE}$`, "u");
const PYTHON_FROM_IMPORTLIB_PATTERN = /^\s*from\s+importlib\s+import\s+(?:\(([\s\S]*?)\)|([^\r\n;]+))/gmu;

type ParsedPythonStaticStringLiteral = {
  value: string;
  end: number;
};

const PYTHON_SIMPLE_STRING_ESCAPES: Readonly<Record<string, string>> = {
  "\\": "\\",
  "'": "'",
  '"': '"',
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
};

function decodePythonStringContent(content: string, prefix: string): string | null {
  if (prefix.includes("r")) return content;
  let decoded = "";
  for (let index = 0; index < content.length; index += 1) {
    const ch = content[index]!;
    if (ch !== "\\") {
      decoded += ch;
      continue;
    }
    index += 1;
    const escape = content[index];
    if (escape === undefined) return null;
    const simpleEscape = PYTHON_SIMPLE_STRING_ESCAPES[escape];
    if (simpleEscape !== undefined) {
      decoded += simpleEscape;
      continue;
    }
    if (escape === "\n") continue;
    if (escape === "\r") {
      if (content[index + 1] === "\n") index += 1;
      continue;
    }
    let hexLength = 0;
    if (escape === "x") hexLength = 2;
    else if (escape === "u") hexLength = 4;
    else if (escape === "U") hexLength = 8;
    if (hexLength) {
      const digits = content.slice(index + 1, index + 1 + hexLength);
      if (digits.length !== hexLength || !/^[0-9a-fA-F]+$/.test(digits)) return null;
      const codePoint = Number.parseInt(digits, 16);
      if (codePoint > 0x10ffff) return null;
      decoded += String.fromCodePoint(codePoint);
      index += hexLength;
      continue;
    }
    if (escape >= "0" && escape <= "7") {
      let end = index + 1;
      while (end < content.length && end - index < 3) {
        const digit = content[end]!;
        if (digit < "0" || digit > "7") break;
        end += 1;
      }
      decoded += String.fromCodePoint(Number.parseInt(content.slice(index, end), 8));
      index = end - 1;
      continue;
    }
    decoded += `\\${escape}`;
  }
  return decoded;
}

function parsePythonStaticStringLiteral(source: string, start: number): ParsedPythonStaticStringLiteral | null {
  let quoteIndex = start;
  let prefixLength = 0;
  while (prefixLength < 2) {
    const prefixCharacter = source[quoteIndex];
    if (!prefixCharacter || !"rRuUfF".includes(prefixCharacter)) break;
    quoteIndex += 1;
    prefixLength += 1;
  }
  const prefix = source.slice(start, quoteIndex).toLowerCase();
  if (!["", "r", "u", "f", "fr", "rf"].includes(prefix)) return null;
  const quote = source[quoteIndex];
  if (quote !== "'" && quote !== '"') return null;
  const triple = source[quoteIndex + 1] === quote && source[quoteIndex + 2] === quote;
  const delimiterLength = triple ? 3 : 1;
  const contentStart = quoteIndex + delimiterLength;
  for (let index = contentStart; index < source.length; index += 1) {
    const ch = source[index]!;
    if (!triple && (ch === "\n" || ch === "\r")) return null;
    if (ch === "\\") {
      index += 1;
      continue;
    }
    if (ch !== quote) continue;
    if (triple && (source[index + 1] !== quote || source[index + 2] !== quote)) continue;
    const value = decodePythonStringContent(source.slice(contentStart, index), prefix);
    if (value === null) return null;
    return { value, end: index + delimiterLength };
  }
  return null;
}

function skipPythonExpressionTrivia(source: string, start: number): number {
  let index = start;
  while (index < source.length) {
    while (index < source.length && /\s/.test(source[index]!)) index += 1;
    if (source[index] !== "#") break;
    while (index < source.length && source[index] !== "\n" && source[index] !== "\r") index += 1;
  }
  return index;
}

function parsePythonStaticStringExpression(source: string, start: number): string | null {
  let index = skipPythonExpressionTrivia(source, start);
  let value = "";
  let literalCount = 0;
  while (true) {
    const literal = parsePythonStaticStringLiteral(source, index);
    if (!literal) break;
    value += literal.value;
    literalCount += 1;
    index = skipPythonExpressionTrivia(source, literal.end);
  }
  if (!literalCount || (source[index] !== "," && source[index] !== ")")) return null;
  return value;
}

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
  for (const match of cleaned.matchAll(PYTHON_FROM_IMPORTLIB_PATTERN)) {
    const importList = match[1] ?? match[2] ?? "";
    for (const rawClause of importList.split(",")) {
      const clause = rawClause.trim();
      const parsed = PYTHON_IMPORT_MODULE_ALIAS_PATTERN.exec(clause);
      if (parsed) importModuleAliases.add(parsed[1] ?? "import_module");
    }
  }
  return { importlibAliases, importModuleAliases };
}

/** Folds the argument of a Python dynamic import call into a static module string. Alias
 * recognition is intentionally limited to direct `importlib` imports; assignment flow and
 * computed module names remain outside graph construction. */
function foldPythonDynamicModuleArgument(
  source: string,
  match: RegExpMatchArray,
  preparation: DynamicImportPreparation,
): string | null {
  const importlibAliases = preparation.pythonImportlibAliases;
  const importModuleAliases = preparation.pythonImportModuleAliases;
  if (!importlibAliases || !importModuleAliases) return null;
  const receiver = match[1] ?? "";
  const member = match[2];
  const isBuiltinImport = !member && receiver === "__import__";
  const isImportlibCall = member === "import_module" && importlibAliases.has(receiver);
  const isImportedFunctionCall = !member && importModuleAliases.has(receiver);
  if (!isBuiltinImport && !isImportlibCall && !isImportedFunctionCall) return null;
  const argumentStart = (match.index ?? 0) + (match[0]?.length ?? 0);
  const spec = parsePythonStaticStringExpression(source, argumentStart);
  if (!spec || !PYTHON_DYNAMIC_MODULE_PATTERN.test(spec)) return null;
  // `__import__` cannot take a package argument, so a leading dot names nothing resolvable.
  if (isBuiltinImport && spec.startsWith(".")) return null;
  return spec;
}

const DYNAMIC_IMPORT_SPECIFIER_EXTRACTORS = createDynamicImportEntries({
  foldCapturedPath,
  foldNewUrlArgument,
  resolveFoldedPathAgainstBase,
  resolveFoldedPathAgainstFileDir,
  resolveFoldedPathByConcatenation,
  foldPythonDynamicModuleArgument,
  collectPythonDynamicImportAliases,
});

/**
 * Shared adapter boundary for opt-in dynamic import heuristics. A language entry supplies only
 * its call shapes and trivia mask; the shared fold turns constant arguments into candidates,
 * while target resolution, provenance merging, and graph construction stay in the common
 * pipeline.
 */
export function extractDynamicImportSpecifiers(
  languageId: string,
  source: string,
  fromFile: string,
  projectRoot: string,
): ModuleSpecifier[] {
  const entry = DYNAMIC_IMPORT_SPECIFIER_EXTRACTORS[languageId];
  if (!entry) return [];
  const out: ModuleSpecifier[] = [];
  const seen = new Set<string>();
  try {
    const text = entry.text(source);
    const guard = entry.guard(text);
    const preparation = entry.prepare ? entry.prepare(source) : {};
    for (const shape of entry.shapes) {
      for (const match of text.matchAll(shape.pattern)) {
        if (!matchStartsInCode(guard, match)) continue;
        const spec = shape.fold({ text, match, fromFile, projectRoot, preparation });
        if (!spec || seen.has(spec)) continue;
        seen.add(spec);
        out.push({ spec, resolved: "heuristic", confidence: 0.7 });
      }
    }
  } catch {
    /* parse fallback: ignore */
  }
  return out;
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
