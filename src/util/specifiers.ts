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

export function extractJsTsSpecifiers(source: string): ModuleSpecifier[] {
  const out: ModuleSpecifier[] = [];
  try {
    const src = stripJsLikeComments(source);
    const push = (spec: string, typeOnly?: boolean) => {
      if (spec) out.push({ spec, ...(typeOnly ? { typeOnly: true } : {}) });
    };

    const combined =
      /^\s*import\s+[^\n;]*?\s+from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']|\bexport\s+[^\n;]*?\s+from\s+["']([^"']+)["']|\b(?:const|let|var)\s*\{[^}]*\}\s*=\s*require\(\s*["']([^"']+)["']\s*\)|(?<!["'`])\brequire\(\s*["']([^"']+)["']\s*\)|(?<!["'`])\bimport\(\s*["']([^"']+)["']\s*\)/gm;

    for (const m of src.matchAll(combined)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6];
      if (!spec) continue;
      const text = m[0] ?? "";
      let typeOnly = false;
      if (m[1] !== undefined || m[2] !== undefined) {
        typeOnly = /\bimport\s+type\b/.test(text);
      } else if (m[3] !== undefined) {
        typeOnly = /\bexport\s+type\b/.test(text);
      }
      push(spec, typeOnly);
    }
  } catch {
    /* regex/parse fallback: ignore */
  }
  return out;
}

type DynamicBase = "file" | "project";
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
  for (let i = 0; i < text.length; i++) {
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
  if (compact === "__dirname" || compact === "__filename" || compact === "import.meta.url") {
    return { kind: "base", base: "file" };
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
  if (!args || args.length === 0) return null;
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
  if (!base || segments.length === 0) return null;
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
  if (baseToken.base !== "file") return null;
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
    const seen = new Set<string>();
    const addSpec = (spec: string | null) => {
      if (!spec || seen.has(spec)) return;
      seen.add(spec);
      out.push({ spec, resolved: "heuristic", confidence: 0.7 });
    };
    const pathCallRe = /(?<!["'`])\b(?:require|import)\s*\(\s*(path\.(?:join|resolve)\s*\([^)]*\))\s*\)/g;
    for (const match of src.matchAll(pathCallRe)) {
      const argText = match[1] ?? "";
      const parsed = parsePathCallArg(argText);
      if (!parsed) continue;
      const baseDir = parsed.base === "file" ? path.dirname(fromFile) : projectRoot;
      const targetPath = path.resolve(baseDir, ...parsed.segments);
      addSpec(buildRelativeSpecifier(fromFile, targetPath));
    }
    const urlCallRe = /(?<!["'`])\b(?:require|import)\s*\(\s*(new\s+URL\s*\([^)]*\))\s*\)/g;
    for (const match of src.matchAll(urlCallRe)) {
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
    for (const m of cleaned.matchAll(reImport)) out.push(m[1]!);
    const reFrom = /^\s*from\s+(\.+(?:[A-Za-z_][\w.]*)?|[A-Za-z_][\w.]*)\s+import/gm;
    for (const m of cleaned.matchAll(reFrom)) out.push(m[1]!);
  } catch {
    /* parse fallback: ignore */
  }
  return out;
}
