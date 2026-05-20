export const SQL_IDENTIFIER_PART_PATTERN =
  String.raw`(?:"(?:""|[^"])+"|` + "`[^`]+`" + String.raw`|\[[^\]]+\]|[A-Za-z_][\w$]*)`;

export const SQL_OBJECT_NAME_PATTERN = String.raw`${SQL_IDENTIFIER_PART_PATTERN}(?:\s*\.\s*${SQL_IDENTIFIER_PART_PATTERN}){0,2}`;

export function createSqlObjectNameRegExp(flags = "iy"): RegExp {
  return new RegExp(SQL_OBJECT_NAME_PATTERN, flags);
}

export function normalizeSqlIdentifierPart(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/""/g, '"');
  }
  if (trimmed.startsWith("`") && trimmed.endsWith("`")) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function normalizeSqlObjectName(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const parts = trimmed.match(new RegExp(SQL_IDENTIFIER_PART_PATTERN, "g")) ?? [];
  const normalizedParts = parts.map(normalizeSqlIdentifierPart).filter(Boolean);
  if (!normalizedParts.length) return null;
  return normalizedParts.join(".");
}

export function sqlObjectBaseName(name: string): string {
  const parts = name.split(".").filter(Boolean);
  return parts.at(-1) ?? name;
}

export function sqlParenDepthAt(text: string, index: number): number {
  let depth = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    const char = text[cursor];
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
  }
  return depth;
}

export function splitTopLevelCommaSeparated(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

export function maskSqlStringsAndComments(statement: string): string {
  let out = "";
  let i = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  let backtickQuoted = false;
  let bracketQuoted = false;
  let lineComment = false;
  let blockComment = false;
  let dollarQuote: string | null = null;

  while (i < statement.length) {
    const char = statement[i] ?? "";
    const next = statement[i + 1] ?? "";

    if (char === "\n") {
      lineComment = false;
      out += "\n";
      i += 1;
      continue;
    }

    if (lineComment || blockComment || dollarQuote || singleQuoted) {
      if (blockComment && char === "*" && next === "/") {
        blockComment = false;
        out += "  ";
        i += 2;
        continue;
      }
      if (dollarQuote && statement.startsWith(dollarQuote, i)) {
        out += " ".repeat(dollarQuote.length);
        i += dollarQuote.length;
        dollarQuote = null;
        continue;
      }
      if (singleQuoted && char === "'" && next === "'") {
        out += "  ";
        i += 2;
        continue;
      }
      if (singleQuoted && char === "'") {
        singleQuoted = false;
      }
      out += char === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }

    if (doubleQuoted || backtickQuoted || bracketQuoted) {
      out += char;
      if (doubleQuoted && char === '"' && next === '"') {
        out += next;
        i += 2;
        continue;
      }
      if (doubleQuoted && char === '"') doubleQuoted = false;
      if (backtickQuoted && char === "`") backtickQuoted = false;
      if (bracketQuoted && char === "]") bracketQuoted = false;
      i += 1;
      continue;
    }

    if (char === "-" && next === "-") {
      lineComment = true;
      out += "  ";
      i += 2;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      out += "  ";
      i += 2;
      continue;
    }
    if (char === "'") {
      singleQuoted = true;
      out += " ";
      i += 1;
      continue;
    }
    if (char === '"') doubleQuoted = true;
    if (char === "`") backtickQuoted = true;
    if (char === "[") bracketQuoted = true;
    if (char === "$") {
      const tagMatch = statement.slice(i).match(/^\$[A-Za-z_][\w$]*\$|^\$\$/);
      if (tagMatch?.[0]) {
        dollarQuote = tagMatch[0];
        out += " ".repeat(dollarQuote.length);
        i += dollarQuote.length;
        continue;
      }
    }
    out += char;
    i += 1;
  }
  return out;
}
