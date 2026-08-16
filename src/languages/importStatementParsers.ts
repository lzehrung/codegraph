import path from "node:path";
import { PHP_IDENTIFIER_SOURCE, XID_IDENTIFIER_SOURCE } from "../util/identifiers.js";
import { isAbsoluteFilePath, normalizePath } from "../util/paths.js";

export type ParsedRustImportStatement =
  | {
      kind: "member";
      from: string;
      imported: string;
      local: string;
    }
  | {
      kind: "module";
      from: string;
      local: string;
      isExternCrate: boolean;
    }
  | {
      kind: "star";
      from: string;
    };

const RUST_MODULE_PATTERN = new RegExp(String.raw`^mod\s+(${XID_IDENTIFIER_SOURCE})\s*;?$`, "u");
const RUST_EXTERN_CRATE_PATTERN = new RegExp(
  String.raw`^extern\s+crate\s+(${XID_IDENTIFIER_SOURCE})(?:\s+as\s+(${XID_IDENTIFIER_SOURCE}))?\s*;?$`,
  "u",
);
const RUST_USE_ALIAS_PATTERN = new RegExp(String.raw`^(.*?)\s+as\s+(${XID_IDENTIFIER_SOURCE})$`, "u");

export function parseRustImportStatement(stmtText: string): ParsedRustImportStatement | null {
  const trimmed = stmtText.trim();

  // Rust identifiers permit Unicode XID_Start/XID_Continue, not just ASCII.
  const modMatch = trimmed.match(RUST_MODULE_PATTERN);
  if (modMatch?.[1]) {
    return {
      kind: "module",
      from: modMatch[1],
      local: modMatch[1],
      isExternCrate: false,
    };
  }

  const externMatch = trimmed.match(RUST_EXTERN_CRATE_PATTERN);
  if (externMatch?.[1]) {
    return {
      kind: "module",
      from: externMatch[1],
      local: externMatch[2] ?? externMatch[1],
      isExternCrate: true,
    };
  }

  const useMatch = trimmed.match(/^(?:pub(?:\s*\([^)]*\))?\s+)?use\s+(.+?)\s*;?$/);
  const useBody = useMatch?.[1]?.trim();
  if (!useBody) return null;
  if (useBody.includes("{") || useBody.includes(",")) return null;

  const aliasMatch = useBody.match(RUST_USE_ALIAS_PATTERN);
  const rawPath = aliasMatch?.[1]?.trim() ?? useBody;
  const alias = aliasMatch?.[2];

  if (rawPath.endsWith("::*")) {
    return { kind: "star", from: rawPath };
  }

  const parts = rawPath.split("::").filter(Boolean);
  if (!parts.length) return null;
  if (parts.length === 1) {
    const moduleName = parts[0];
    if (!moduleName) return null;
    return {
      kind: "module",
      from: moduleName,
      local: alias ?? moduleName,
      isExternCrate: false,
    };
  }

  const imported = parts[parts.length - 1];
  const from = parts.slice(0, -1).join("::");
  if (!imported || !from) return null;
  return {
    kind: "member",
    from,
    imported,
    local: alias ?? imported,
  };
}

export type ParsedCsharpUsingDirective = {
  from: string;
  alias?: string;
  isStatic: boolean;
};

export type ParsedPhpImportStatement =
  | {
      kind: "include";
      from: string;
    }
  | {
      kind: "named";
      from: string;
      imported: string;
      local: string;
      importType: PhpImportType;
    };

export type PhpImportType = "class" | "function" | "const";

const PHP_USE_ALIAS_PATTERN = new RegExp(String.raw`^(.*?)\s+as\s+(${PHP_IDENTIFIER_SOURCE})$`, "iu");

function splitTopLevelCommaList(input: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let current = "";

  for (const ch of input) {
    if (ch === "{") depth += 1;
    if (ch === "}") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      const trimmed = current.trim();
      if (trimmed) items.push(trimmed);
      current = "";
      continue;
    }
    current += ch;
  }

  const trimmed = current.trim();
  if (trimmed) items.push(trimmed);
  return items;
}

function parsePhpImportClause(rawClause: string, importType: PhpImportType): ParsedPhpImportStatement[] {
  const clause = rawClause.trim().replace(/;$/, "");
  if (!clause) return [];

  const groupMatch = clause.match(/^(.+?\\)\{(.+)\}$/);
  if (groupMatch?.[1] && groupMatch[2]) {
    const prefix = groupMatch[1];
    const members = splitTopLevelCommaList(groupMatch[2]);
    const results: ParsedPhpImportStatement[] = [];

    for (const member of members) {
      const typedMemberMatch = member.match(/^(function|const)\s+(.+)$/);
      let memberType = importType;
      if (typedMemberMatch?.[1] === "function") {
        memberType = "function";
      } else if (typedMemberMatch?.[1] === "const") {
        memberType = "const";
      }
      const body = (typedMemberMatch?.[2] ?? member).trim();
      const aliasMatch = body.match(PHP_USE_ALIAS_PATTERN);
      const fullPath = `${prefix}${(aliasMatch?.[1] ?? body).trim()}`;
      const parts = fullPath.split("\\").filter(Boolean);
      const imported = parts[parts.length - 1];
      if (!imported) continue;
      results.push({
        kind: "named",
        from: fullPath,
        imported,
        local: aliasMatch?.[2] ?? imported,
        importType: memberType,
      });
    }

    return results;
  }

  const aliasMatch = clause.match(PHP_USE_ALIAS_PATTERN);
  const fullPath = (aliasMatch?.[1] ?? clause).trim();
  const parts = fullPath.split("\\").filter(Boolean);
  const imported = parts[parts.length - 1];
  if (!imported) return [];
  return [
    {
      kind: "named",
      from: fullPath,
      imported,
      local: aliasMatch?.[2] ?? imported,
      importType,
    },
  ];
}

export function parsePhpImportStatement(stmtText: string, fromFile?: string): ParsedPhpImportStatement[] {
  const trimmed = stmtText.trim();
  if (!trimmed) return [];

  const includeMatch = trimmed.match(/^(?:require_once|include_once|require|include)\s*(?<expr>.+?)\s*;?$/is);
  const includeExpr = includeMatch?.groups?.expr?.trim();
  if (includeExpr) {
    const includePath = resolvePhpIncludePath(includeExpr, fromFile);
    if (includePath) {
      return [{ kind: "include", from: includePath }];
    }
  }

  const useMatch = trimmed.match(/^(?:use)\s+(.+?)\s*;?$/is);
  const useBody = useMatch?.[1]?.trim();
  if (!useBody) return [];

  const clauses = splitTopLevelCommaList(useBody);
  const results: ParsedPhpImportStatement[] = [];
  for (const clause of clauses) {
    const typedClauseMatch = clause.match(/^(function|const)\s+(.+)$/is);
    let importType: "class" | "function" | "const" = "class";
    if (typedClauseMatch?.[1] === "function") {
      importType = "function";
    } else if (typedClauseMatch?.[1] === "const") {
      importType = "const";
    }
    const body = (typedClauseMatch?.[2] ?? clause).trim();
    results.push(...parsePhpImportClause(body, importType));
  }
  return results;
}

function stripOuterParens(input: string): string {
  let current = input.trim();
  while (current.startsWith("(") && current.endsWith(")")) {
    let depth = 0;
    let isWrapped = true;
    for (let i = 0; i < current.length; i += 1) {
      const ch = current[i];
      if (ch === "(") depth += 1;
      if (ch === ")") {
        depth -= 1;
        if (depth === 0 && i < current.length - 1) {
          isWrapped = false;
          break;
        }
      }
    }
    if (!isWrapped || depth !== 0) break;
    current = current.slice(1, -1).trim();
  }
  return current;
}

function splitPhpConcatenation(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const prev = i > 0 ? input[i - 1] : "";
    if (quote) {
      current += ch;
      if (ch === quote && prev !== "\\") {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "." && depth === 0) {
      const trimmed = current.trim();
      if (trimmed) parts.push(trimmed);
      current = "";
      continue;
    }
    current += ch;
  }

  const trimmed = current.trim();
  if (trimmed) parts.push(trimmed);
  return parts;
}

function parsePhpStringLiteral(token: string): string | null {
  if (token.length < 2) return null;
  const quote = token[0];
  if ((quote !== "'" && quote !== '"') || token[token.length - 1] !== quote) {
    return null;
  }
  const body = token.slice(1, -1);
  if (quote === "'") {
    return body.replace(/\\\\/g, "\\").replace(/\\'/g, "'");
  }
  return body.replace(/\\\\/g, "\\").replace(/\\"/g, '"').replace(/\\'/g, "'");
}

function evaluatePhpIncludeToken(token: string, fromFile?: string): string | null {
  const trimmed = stripOuterParens(token.trim());
  const literal = parsePhpStringLiteral(trimmed);
  if (literal !== null) {
    return literal;
  }

  if (!fromFile) {
    return null;
  }

  if (/^__DIR__$/i.test(trimmed)) {
    return path.dirname(fromFile);
  }
  if (/^__FILE__$/i.test(trimmed)) {
    return fromFile;
  }

  const dirnameMatch = trimmed.match(/^dirname\s*\((.+)\)$/is);
  if (dirnameMatch?.[1]) {
    const innerValue = evaluatePhpIncludeToken(dirnameMatch[1], fromFile);
    return innerValue ? path.dirname(innerValue) : null;
  }

  return null;
}

function resolvePhpIncludePath(expr: string, fromFile?: string): string | null {
  const normalizedExpr = stripOuterParens(expr.trim().replace(/;$/, ""));
  const parts = splitPhpConcatenation(normalizedExpr);
  if (!parts.length) {
    return null;
  }

  let combined = "";
  for (const part of parts) {
    const evaluated = evaluatePhpIncludeToken(part, fromFile);
    if (evaluated === null) {
      return null;
    }
    combined += evaluated;
  }

  if (!combined) {
    return null;
  }

  if (!fromFile) {
    return combined.replace(/\\/g, "/");
  }

  const normalizedPath = path.normalize(combined);
  if (!isAbsoluteFilePath(normalizedPath)) {
    const relativePath = normalizedPath.replace(/\\/g, "/");
    if (relativePath.startsWith("./") || relativePath.startsWith("../")) {
      return relativePath;
    }
    return `./${relativePath}`;
  }

  const relativePath =
    path.win32.isAbsolute(fromFile) && path.win32.isAbsolute(normalizedPath)
      ? normalizePath(path.win32.relative(normalizePath(path.win32.dirname(fromFile)), normalizePath(normalizedPath)))
      : path.relative(path.dirname(fromFile), normalizedPath).replace(/\\/g, "/");
  if (relativePath.startsWith(".") || relativePath.startsWith("/")) {
    return relativePath;
  }
  return `./${relativePath}`;
}

export type ParsedKotlinImportStatement =
  | {
      kind: "named";
      from: string;
      imported: string;
      local: string;
    }
  | {
      kind: "star";
      from: string;
    };

export function parseKotlinImportStatement(stmtText: string): ParsedKotlinImportStatement | null {
  // Kotlin identifiers permit Unicode letters, not just ASCII.
  const match = stmtText
    .trim()
    .match(/^\s*import\s+([\p{L}_][\p{L}\p{N}_.]*(?:\.\*)?)(?:\s+as\s+([\p{L}_][\p{L}\p{N}_]*))?\s*$/mu);
  const rawSpec = match?.[1];
  if (!rawSpec) return null;
  if (rawSpec.endsWith(".*")) {
    return {
      kind: "star",
      from: rawSpec.slice(0, -2),
    };
  }

  const parts = rawSpec.split(".");
  const imported = parts[parts.length - 1];
  if (!imported) return null;
  return {
    kind: "named",
    from: rawSpec,
    imported,
    local: match?.[2] ?? imported,
  };
}

export type ParsedJavaImportStatement =
  | {
      kind: "named";
      from: string;
      imported: string;
      isStatic: boolean;
    }
  | {
      kind: "star";
      from: string;
      isStatic: boolean;
    };

export function parseJavaImportStatement(stmtText: string): ParsedJavaImportStatement | null {
  // Java identifiers permit Unicode letters, not just ASCII.
  const match = stmtText.trim().match(/^\s*import\s+(static\s+)?([\p{L}_][\p{L}\p{N}_.]*(?:\.\*)?)\s*;?\s*$/u);
  const rawSpec = match?.[2];
  if (!rawSpec) return null;
  const isStatic = !!match?.[1];
  if (rawSpec.endsWith(".*")) {
    return {
      kind: "star",
      from: rawSpec.slice(0, -2),
      isStatic,
    };
  }

  const parts = rawSpec.split(".");
  const imported = parts[parts.length - 1];
  if (!imported) return null;
  return {
    kind: "named",
    from: isStatic ? parts.slice(0, -1).join(".") : rawSpec,
    imported,
    isStatic,
  };
}

export function parseCsharpUsingDirective(stmtText: string): ParsedCsharpUsingDirective | null {
  const trimmed = stmtText.trim();

  // C# identifiers permit Unicode letter categories, not just ASCII.
  const aliasMatch = trimmed.match(
    /^(?:global\s+)?using\s+([\p{L}_][\p{L}\p{N}_]*)\s*=\s*([\p{L}_][\p{L}\p{N}_.]*)\s*;?$/u,
  );
  if (aliasMatch?.[1] && aliasMatch[2]) {
    return {
      from: aliasMatch[2],
      alias: aliasMatch[1],
      isStatic: false,
    };
  }

  const staticMatch = trimmed.match(/^(?:global\s+)?using\s+static\s+([\p{L}_][\p{L}\p{N}_.]*)\s*;?$/u);
  if (staticMatch?.[1]) {
    return {
      from: staticMatch[1],
      isStatic: true,
    };
  }

  const plainMatch = trimmed.match(/^(?:global\s+)?using\s+([\p{L}_][\p{L}\p{N}_.]*)\s*;?$/u);
  if (!plainMatch?.[1]) return null;
  return {
    from: plainMatch[1],
    isStatic: false,
  };
}
