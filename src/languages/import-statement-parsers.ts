import path from "node:path";
import {
  CSHARP_IDENTIFIER_SOURCE,
  JAVA_IDENTIFIER_SOURCE,
  KOTLIN_IDENTIFIER_SOURCE,
  PHP_IDENTIFIER_SOURCE,
  XID_IDENTIFIER_SOURCE,
} from "../util/identifiers.js";
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
      pathAttribute?: string;
    }
  | {
      kind: "star";
      from: string;
    };

const RUST_MODULE_PATTERN = new RegExp(
  String.raw`^(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+(${XID_IDENTIFIER_SOURCE})\s*;?$`,
  "u",
);
const RUST_EXTERN_CRATE_PATTERN = new RegExp(
  String.raw`^extern\s+crate\s+(${XID_IDENTIFIER_SOURCE})(?:\s+as\s+(${XID_IDENTIFIER_SOURCE}))?\s*;?$`,
  "u",
);
const RUST_IDENTIFIER_PATTERN = new RegExp(String.raw`^${XID_IDENTIFIER_SOURCE}$`, "u");
const RUST_ATTRIBUTE_PREFIX_PATTERN = /^(?:#\s*\[[\s\S]*?\]\s*)+/;
const RUST_PATH_ATTRIBUTE_PATTERN = /#\s*\[\s*path\s*=\s*(?:r(#*)"([\s\S]*?)"\1|"([^"]*)")\s*\]/gu;
const RUST_USE_PATTERN = /^(?:pub(?:\s*\([^)]*\))?\s+)?use\s+([\s\S]+?)\s*;?$/;

export function parseRustImportStatement(stmtText: string): ParsedRustImportStatement | null {
  const parsed = parseRustImportStatements(stmtText);
  return parsed.length === 1 ? parsed[0]! : null;
}

export function parseRustImportStatements(stmtText: string): ParsedRustImportStatement[] {
  const trimmed = stmtText.trim();
  if (!trimmed) return [];

  const attributePrefix = trimmed.match(RUST_ATTRIBUTE_PREFIX_PATTERN)?.[0] ?? "";
  const pathAttribute = rustPathAttributeFromText(attributePrefix);
  const statement = attributePrefix ? trimmed.slice(attributePrefix.length).trim() : trimmed;

  const modMatch = statement.match(RUST_MODULE_PATTERN);
  if (modMatch?.[1]) {
    return [
      {
        kind: "module",
        from: modMatch[1],
        local: modMatch[1],
        isExternCrate: false,
        ...(pathAttribute ? { pathAttribute } : {}),
      },
    ];
  }

  const externMatch = statement.match(RUST_EXTERN_CRATE_PATTERN);
  if (externMatch?.[1]) {
    return [
      {
        kind: "module",
        from: externMatch[1],
        local: externMatch[2] ?? externMatch[1],
        isExternCrate: true,
      },
    ];
  }

  const useMatch = statement.match(RUST_USE_PATTERN);
  const useBody = useMatch?.[1]?.trim();
  if (!useBody) return [];
  return flattenRustUseTree([], useBody);
}

function rustPathAttributeFromText(text: string): string | undefined {
  let last: string | undefined;
  RUST_PATH_ATTRIBUTE_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(RUST_PATH_ATTRIBUTE_PATTERN)) {
    last = match[2] ?? match[3];
  }
  return last;
}

function rustPathSegments(spec: string): string[] {
  return spec
    .split("::")
    .map((part) => part.trim())
    .filter(Boolean);
}

function splitTopLevelRustAlias(input: string): { path: string; alias?: string } {
  let depth = 0;
  let asIndex = -1;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === "{") depth += 1;
    else if (character === "}") depth = Math.max(0, depth - 1);
    if (depth === 0 && input.startsWith(" as ", index)) {
      asIndex = index;
    }
  }
  if (asIndex < 0) return { path: input.trim() };
  const path = input.slice(0, asIndex).trim();
  const alias = input.slice(asIndex + 4).trim();
  if (!path || !RUST_IDENTIFIER_PATTERN.test(alias)) return { path: input.trim() };
  return { path, alias };
}

function splitRustUseGroup(item: string): { prefix: string; inner: string } | null {
  let depth = 0;
  let open = -1;
  for (let index = 0; index < item.length; index += 1) {
    const character = item[index];
    if (character === "{") {
      if (depth === 0) open = index;
      depth += 1;
      continue;
    }
    if (character !== "}") continue;
    depth -= 1;
    if (depth !== 0 || open < 0) continue;
    if (item.slice(index + 1).trim()) return null;
    return {
      prefix: item.slice(0, open).replace(/::$/, "").trim(),
      inner: item.slice(open + 1, index),
    };
  }
  return null;
}

function flattenRustUseTree(prefix: readonly string[], item: string): ParsedRustImportStatement[] {
  const trimmed = item.trim();
  if (!trimmed) return [];

  const group = splitRustUseGroup(trimmed);
  if (group) {
    const nextPrefix = group.prefix ? [...prefix, ...rustPathSegments(group.prefix)] : [...prefix];
    const nested: ParsedRustImportStatement[] = [];
    for (const piece of splitTopLevelCommaList(group.inner)) {
      nested.push(...flattenRustUseTree(nextPrefix, piece));
    }
    return nested;
  }

  const { path: rawPath, alias } = splitTopLevelRustAlias(trimmed);
  if (!rawPath) return [];

  if (rawPath === "*" || rawPath.endsWith("::*")) {
    const base =
      rawPath === "*"
        ? prefix.join("::")
        : [...prefix, ...rustPathSegments(rawPath.slice(0, -"::*".length))].join("::");
    if (!base) return [];
    return [{ kind: "star", from: `${base}::*` }];
  }

  if (rawPath === "self") {
    const from = prefix.join("::");
    if (!from) return [];
    const segments = rustPathSegments(from);
    const local = alias ?? segments[segments.length - 1];
    if (!local) return [];
    return [{ kind: "module", from, local, isExternCrate: false }];
  }

  const parts = [...prefix, ...rustPathSegments(rawPath)];
  if (!parts.length) return [];
  if (parts.length === 1) {
    const moduleName = parts[0];
    if (!moduleName) return [];
    return [
      {
        kind: "module",
        from: moduleName,
        local: alias ?? moduleName,
        isExternCrate: false,
      },
    ];
  }

  const imported = parts[parts.length - 1];
  const from = parts.slice(0, -1).join("::");
  if (!imported || !from) return [];
  return [
    {
      kind: "member",
      from,
      imported,
      local: alias ?? imported,
    },
  ];
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

export const KOTLIN_DOTTED_NAME_SOURCE = String.raw`${KOTLIN_IDENTIFIER_SOURCE}(?:\.${KOTLIN_IDENTIFIER_SOURCE})*`;
const KOTLIN_IMPORT_PATTERN = new RegExp(
  String.raw`^\s*import\s+(${KOTLIN_DOTTED_NAME_SOURCE}(?:\.\*)?)(?:\s+as\s+(${KOTLIN_IDENTIFIER_SOURCE}))?\s*;?\s*$`,
  "mu",
);
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
  const match = stmtText.trim().match(KOTLIN_IMPORT_PATTERN);
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

export const JAVA_DOTTED_NAME_SOURCE = String.raw`${JAVA_IDENTIFIER_SOURCE}(?:\.${JAVA_IDENTIFIER_SOURCE})*`;
const JAVA_IMPORT_PATTERN = new RegExp(
  String.raw`^\s*import\s+(static\s+)?(${JAVA_DOTTED_NAME_SOURCE}(?:\.\*)?)\s*;?\s*$`,
  "u",
);

const CSHARP_DOTTED_NAME_SOURCE = String.raw`${CSHARP_IDENTIFIER_SOURCE}(?:\.${CSHARP_IDENTIFIER_SOURCE})*`;
const CSHARP_USING_ALIAS_PATTERN = new RegExp(
  String.raw`^(?:global\s+)?using\s+(${CSHARP_IDENTIFIER_SOURCE})\s*=\s*(${CSHARP_DOTTED_NAME_SOURCE})\s*;?$`,
  "u",
);
const CSHARP_USING_STATIC_PATTERN = new RegExp(
  String.raw`^(?:global\s+)?using\s+static\s+(${CSHARP_DOTTED_NAME_SOURCE})\s*;?$`,
  "u",
);
const CSHARP_USING_PLAIN_PATTERN = new RegExp(
  String.raw`^(?:global\s+)?using\s+(${CSHARP_DOTTED_NAME_SOURCE})\s*;?$`,
  "u",
);
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
  const match = stmtText.trim().match(JAVA_IMPORT_PATTERN);
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

  const aliasMatch = trimmed.match(CSHARP_USING_ALIAS_PATTERN);
  if (aliasMatch?.[1] && aliasMatch[2]) {
    return {
      from: aliasMatch[2],
      alias: aliasMatch[1],
      isStatic: false,
    };
  }

  const staticMatch = trimmed.match(CSHARP_USING_STATIC_PATTERN);
  if (staticMatch?.[1]) {
    return {
      from: staticMatch[1],
      isStatic: true,
    };
  }

  const plainMatch = trimmed.match(CSHARP_USING_PLAIN_PATTERN);
  if (!plainMatch?.[1]) return null;
  return {
    from: plainMatch[1],
    isStatic: false,
  };
}
