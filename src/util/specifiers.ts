import path from "node:path";
import { buildJsLikeLiteralMask, stripJsLikeComments, stripPythonCommentsAndStrings } from "./comments.js";
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
    // JS/TS identifiers permit Unicode ID_Start/ID_Continue plus $/_, not just ASCII, so the
    // import-equals alias uses \p{L}\p{N} rather than \w (which is ASCII-only).
    const combined =
      /^\s*import\s+[^\n;]*?\s+from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']|\bexport\s+[^\n;]*?\s+from\s+["']([^"']+)["']|\b(?:const|let|var)\s*\{[^}]*\}\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)|(?<!["'`])\brequire\s*\(\s*["']([^"']+)["']\s*\)|(?<!["'`])\bimport\s*\(\s*["']([^"']+)["']\s*\)|^\s*import\s+[\p{L}_$][\p{L}\p{N}_$]*\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)|^\s*declare\s+module\s+["']([^"']+)["']/gmu;

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

export function extractPythonSpecifiers(source: string): string[] {
  const out: string[] = [];
  try {
    const cleaned = stripPythonCommentsAndStrings(source);
    // Python module/package names permit Unicode identifiers (PEP 3131).
    const reImport = /^\s*import\s+([\p{L}_][\p{L}\p{N}_.]*)/gmu;
    for (const match of cleaned.matchAll(reImport)) out.push(match[1]!);
    const reFrom = /^\s*from\s+(\.+(?:[\p{L}_][\p{L}\p{N}_.]*)?|[\p{L}_][\p{L}\p{N}_.]*)\s+import/gmu;
    for (const match of cleaned.matchAll(reFrom)) out.push(match[1]!);
  } catch {
    /* parse fallback: ignore */
  }
  return out;
}
