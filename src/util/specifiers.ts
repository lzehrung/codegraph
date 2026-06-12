import path from "node:path";
import { stripJsLikeComments, stripPythonCommentsAndStrings } from "./comments.js";
import { normalizePath } from "./paths.js";

export type ModuleSpecifier = {
  spec: string;
  raw?: string;
  typeOnly?: boolean;
  phpImportType?: "class" | "function" | "const";
  resolutionKind?: "document" | "source";
  dropIfUnresolved?: boolean;
  resolved?: "heuristic" | "precise";
  confidence?: number;
};

function hasLiteralDelimiter(source: string): boolean {
  return source.includes("'") || source.includes(`"`) || source.includes("`") || source.includes("/");
}

function maskQuotedString(source: string, mask: Uint8Array, start: number, quote: "'" | `"`): number {
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]!;
    mask[i] = 1;
    if (ch === "\\") {
      const nextIndex = i + 1;
      if (nextIndex < source.length) {
        mask[nextIndex] = 1;
        i = nextIndex;
      }
      continue;
    }
    if (i > start && ch === quote) return i + 1;
  }
  return source.length;
}

function maskTemplateLiteral(source: string, mask: Uint8Array, start: number): number {
  mask[start] = 1;
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source[i]!;
    mask[i] = 1;
    if (ch === "\\") {
      const nextIndex = i + 1;
      if (nextIndex < source.length) {
        mask[nextIndex] = 1;
        i = nextIndex;
      }
      continue;
    }
    if (ch === "`") return i + 1;
    if (ch === "$" && source[i + 1] === "{") {
      mask[i + 1] = 1;
      i = scanTemplateExpression(source, mask, i + 2) - 1;
    }
  }
  return source.length;
}

function scanTemplateExpression(source: string, mask: Uint8Array, start: number): number {
  let depth = 1;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]!;
    if (ch === "'" || ch === `"`) {
      i = maskQuotedString(source, mask, i, ch) - 1;
      continue;
    }
    if (ch === "`") {
      i = maskTemplateLiteral(source, mask, i) - 1;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (!depth) {
        mask[i] = 1;
        return i + 1;
      }
    }
  }
  return source.length;
}

function previousVisibleIndex(source: string, mask: Uint8Array, start: number): number {
  for (let i = start; i >= 0; i -= 1) {
    if (mask[i]) continue;
    if (/\s/.test(source[i] ?? "")) continue;
    return i;
  }
  return -1;
}

function precedingKeywordAllowsRegex(source: string, mask: Uint8Array, prevIndex: number): boolean {
  let end = prevIndex + 1;
  while (end > 0 && (mask[end - 1] || /\s/.test(source[end - 1] ?? ""))) {
    end -= 1;
  }
  let start = end;
  while (start > 0 && !mask[start - 1] && /[A-Za-z]/.test(source[start - 1] ?? "")) {
    start -= 1;
  }
  const keyword = source.slice(start, end);
  return keyword === "return" || keyword === "case" || keyword === "throw" || keyword === "yield";
}

function keywordBeforeParenAllowsRegex(source: string, mask: Uint8Array, closeParenIndex: number): boolean {
  let depth = 1;
  for (let i = closeParenIndex - 1; i >= 0; i -= 1) {
    if (mask[i]) continue;
    const ch = source[i] ?? "";
    if (ch === ")") {
      depth += 1;
      continue;
    }
    if (ch === "(") {
      depth -= 1;
      if (!depth) {
        const keywordIndex = previousVisibleIndex(source, mask, i - 1);
        if (keywordIndex < 0) return false;
        const end = keywordIndex + 1;
        let start = end;
        while (start > 0 && !mask[start - 1] && /[A-Za-z]/.test(source[start - 1] ?? "")) {
          start -= 1;
        }
        const keyword = source.slice(start, end);
        return (
          keyword === "if" ||
          keyword === "while" ||
          keyword === "for" ||
          keyword === "switch" ||
          keyword === "catch" ||
          keyword === "with"
        );
      }
    }
  }
  return false;
}

function canStartRegex(source: string, mask: Uint8Array, slashIndex: number): boolean {
  if (mask[slashIndex]) return false;
  const prevIndex = previousVisibleIndex(source, mask, slashIndex - 1);
  if (prevIndex < 0) return true;
  const prev = source[prevIndex] ?? "";
  if ("([{,:;=!?&|^~<>+-*%".includes(prev)) return true;
  if (prev === ")" && keywordBeforeParenAllowsRegex(source, mask, prevIndex)) return true;
  return precedingKeywordAllowsRegex(source, mask, prevIndex);
}

function maskRegexLiteral(source: string, mask: Uint8Array, start: number): number {
  let inClass = false;
  mask[start] = 1;
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source[i]!;
    mask[i] = 1;
    if (ch === "\n" || ch === "\r") return start + 1;
    if (ch === "\\") {
      const nextIndex = i + 1;
      if (nextIndex < source.length) {
        mask[nextIndex] = 1;
        i = nextIndex;
      }
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (ch === "]" && inClass) {
      inClass = false;
      continue;
    }
    if (ch === "/" && !inClass) {
      let end = i + 1;
      while (/[A-Za-z]/.test(source[end] ?? "")) {
        mask[end] = 1;
        end += 1;
      }
      return end;
    }
  }
  return source.length;
}

function buildLiteralMask(source: string): Uint8Array | undefined {
  if (!hasLiteralDelimiter(source)) return undefined;
  const mask = new Uint8Array(source.length);
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    if (ch === "'" || ch === `"`) {
      i = maskQuotedString(source, mask, i, ch) - 1;
      continue;
    }
    if (ch === "`") {
      i = maskTemplateLiteral(source, mask, i) - 1;
      continue;
    }
    if (ch === "/" && canStartRegex(source, mask, i)) {
      i = maskRegexLiteral(source, mask, i) - 1;
    }
  }
  return mask;
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
    const literalMask = buildLiteralMask(src);
    const push = (spec: string, typeOnly?: boolean) => {
      if (spec) out.push({ spec, ...(typeOnly ? { typeOnly: true } : {}) });
    };

    const combined =
      /^\s*import\s+[^\n;]*?\s+from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']|\bexport\s+[^\n;]*?\s+from\s+["']([^"']+)["']|\b(?:const|let|var)\s*\{[^}]*\}\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)|(?<!["'`])\brequire\s*\(\s*["']([^"']+)["']\s*\)|(?<!["'`])\bimport\s*\(\s*["']([^"']+)["']\s*\)|^\s*import\s+[A-Za-z_$][\w$]*\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)|^\s*declare\s+module\s+["']([^"']+)["']/gm;

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
      push(spec, typeOnly);
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
    const literalMask = buildLiteralMask(src);
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
    const reImport = /^\s*import\s+([A-Za-z_][\w.]*)/gm;
    for (const match of cleaned.matchAll(reImport)) out.push(match[1]!);
    const reFrom = /^\s*from\s+(\.+(?:[A-Za-z_][\w.]*)?|[A-Za-z_][\w.]*)\s+import/gm;
    for (const match of cleaned.matchAll(reFrom)) out.push(match[1]!);
  } catch {
    /* parse fallback: ignore */
  }
  return out;
}
