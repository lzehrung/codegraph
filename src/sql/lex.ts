export const SQL_IDENTIFIER_PART_PATTERN =
  String.raw`(?:"(?:""|[^"])+"|` +
  "`[^`]+`" +
  String.raw`|\[[^\]]+\]|` +
  // T-SQL local/global temp table names start with one or two "#" characters
  // (#Temp, ##GlobalTemp), which the bare identifier form must permit.
  String.raw`#{1,2}[A-Za-z_][\w$]*|[A-Za-z_][\w$]*)`;

export const SQL_OBJECT_NAME_PATTERN = String.raw`${SQL_IDENTIFIER_PART_PATTERN}(?:\s*\.\s*${SQL_IDENTIFIER_PART_PATTERN}){0,2}`;

export function createSqlObjectNameRegExp(flags = "iy"): RegExp {
  return new RegExp(SQL_OBJECT_NAME_PATTERN, flags);
}

export function normalizeSqlIdentifierPart(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return `"${trimmed.slice(1, -1).replace(/""/g, '"')}"`;
  }
  if (trimmed.startsWith("`") && trimmed.endsWith("`")) {
    return `\`${trimmed.slice(1, -1)}\``;
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return `[${trimmed.slice(1, -1)}]`;
  }
  return trimmed;
}
export function sqlObjectLookupKey(name: string): string {
  return name
    .split(".")
    .map((part) => {
      const trimmed = part.trim();
      const quoted =
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("`") && trimmed.endsWith("`")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"));
      return quoted ? trimmed : trimmed.toLowerCase();
    })
    .join(".");
}

export function sqlObjectBaseNameLookupKey(name: string): string {
  return sqlObjectLookupKey(sqlObjectBaseName(name));
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

export type SqlMaskOptions = {
  /**
   * Decides which dollar-quoted blocks keep their body visible. `before` is the masked text ahead of
   * the block, so a caller can read the words that introduce it, as in `AS $$`. A routine body is
   * code, so its calls count. Strings, comments, and nested dollar-quoted blocks inside a kept body
   * stay masked, and every other block is masked whole.
   */
  keepDollarQuotedBody?: (before: string) => boolean;
  /**
   * Read a `[` as a PostgreSQL array constructor or subscript when it follows `ARRAY`, a `)`, a `]`, a
   * quote, or an identifier that is neither a keyword nor a number, as in `ARRAY[...]` and `x[1]`. The
   * content is code, so strings and comments inside it are masked, and both brackets are blanked. Any
   * other `[` opens a quoted identifier, as in `SELECT[col]` and `FROM [dbo].[t]`. Off by default:
   * SQLite and T-SQL read every `[` as a quoted identifier whose content stays as written, and the
   * read-only query guard relies on that.
   */
  arrayBrackets?: boolean;
  /**
   * Let a block comment hold block comments, as PostgreSQL and SQL Server do. Off by default: SQLite
   * and MySQL end a comment at the first closing delimiter, and the read-only query guard relies on that.
   */
  nestedBlockComments?: boolean;
  /**
   * Read a backslash in an `E'...'` string as an escape, as PostgreSQL does, so `E'can\'t'` is one
   * string. Off by default: SQLite has no such string, and the read-only query guard relies on that.
   */
  escapeStrings?: boolean;
};

// A `[` directly after one of these characters opens an array subscript, not a quoted identifier.
const SUBSCRIPT_PREVIOUS_RE = /[)\]"`]/;
// So does a `[` after the word `ARRAY` and whitespace, as in `ARRAY [1, 2]`.
const ARRAY_KEYWORD_BEFORE_RE = /\barray\s+$/i;
const ARRAY_KEYWORD_WINDOW = 64;
// Words that stand directly before an identifier and never before a subscript, as in `SELECT[col]`.
const NON_SUBSCRIPT_WORDS: Readonly<Record<string, true>> = {
  select: true,
  from: true,
  where: true,
  and: true,
  or: true,
  not: true,
  as: true,
  on: true,
  by: true,
  in: true,
  is: true,
  join: true,
  inner: true,
  left: true,
  right: true,
  full: true,
  cross: true,
  outer: true,
  natural: true,
  set: true,
  then: true,
  else: true,
  when: true,
  case: true,
  values: true,
  into: true,
  having: true,
  union: true,
  distinct: true,
  all: true,
  like: true,
  between: true,
  using: true,
  with: true,
  limit: true,
  offset: true,
  order: true,
  group: true,
  table: true,
  update: true,
  delete: true,
  insert: true,
  exec: true,
  execute: true,
  call: true,
  top: true,
  returning: true,
  exists: true,
  over: true,
};

function opensArrayBracket(statement: string, bracketIndex: number): boolean {
  if (SUBSCRIPT_PREVIOUS_RE.test(statement[bracketIndex - 1] ?? "")) return true;
  let wordStart = bracketIndex;
  while (wordStart > 0 && /[\w$]/.test(statement[wordStart - 1] ?? "")) wordStart -= 1;
  if (wordStart < bracketIndex) {
    const word = statement.slice(wordStart, bracketIndex).toLowerCase();
    // A number has no subscript, and a keyword is followed by an identifier: `SELECT 1[alias]`.
    return !/^\d/.test(word) && !Object.hasOwn(NON_SUBSCRIPT_WORDS, word);
  }
  return ARRAY_KEYWORD_BEFORE_RE.test(statement.slice(Math.max(0, bracketIndex - ARRAY_KEYWORD_WINDOW), bracketIndex));
}

export function maskSqlStringsAndComments(statement: string, options?: SqlMaskOptions): string {
  let out = "";
  let i = 0;
  let singleQuoted = false;
  let escapeString = false;
  let doubleQuoted = false;
  let backtickQuoted = false;
  let bracketQuoted = false;
  let arrayDepth = 0;
  let lineComment = false;
  let blockDepth = 0;
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

    if (lineComment || blockDepth || dollarQuote || singleQuoted) {
      if (blockDepth && options?.nestedBlockComments && char === "/" && next === "*") {
        blockDepth += 1;
        out += "  ";
        i += 2;
        continue;
      }
      if (blockDepth && char === "*" && next === "/") {
        blockDepth -= 1;
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
      if (singleQuoted && escapeString && char === "\\" && next) {
        // A backslash escapes the character after it, so `\'` does not end the string.
        out += next === "\n" ? " \n" : "  ";
        i += 2;
        continue;
      }
      if (singleQuoted && char === "'" && next === "'") {
        out += "  ";
        i += 2;
        continue;
      }
      if (singleQuoted && char === "'") {
        singleQuoted = false;
        escapeString = false;
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
      blockDepth = 1;
      out += "  ";
      i += 2;
      continue;
    }
    if (char === "'") {
      singleQuoted = true;
      // `E'...'` is a PostgreSQL escape string. A word that merely ends in `e`, as in `date'...'`, is not.
      escapeString =
        !!options?.escapeStrings && /[eE]/.test(statement[i - 1] ?? "") && !/[\w$]/.test(statement[i - 2] ?? "");
      out += " ";
      i += 1;
      continue;
    }
    if (char === '"') doubleQuoted = true;
    if (char === "`") backtickQuoted = true;
    if (char === "[") {
      if (options?.arrayBrackets && opensArrayBracket(statement, i)) {
        arrayDepth += 1;
        out += " ";
        i += 1;
        continue;
      }
      bracketQuoted = true;
    }
    if (char === "]" && arrayDepth) {
      arrayDepth -= 1;
      out += " ";
      i += 1;
      continue;
    }
    if (char === "$") {
      const tagMatch = statement.slice(i).match(/^\$[A-Za-z_][\w$]*\$|^\$\$/);
      const tag = tagMatch?.[0];
      if (tag && options?.keepDollarQuotedBody?.(out)) {
        const bodyStart = i + tag.length;
        const closeIndex = statement.indexOf(tag, bodyStart);
        const bodyEnd = closeIndex < 0 ? statement.length : closeIndex;
        // Nested dollar-quoted blocks inside the body stay masked, so the body takes no such callback.
        const bodyOptions: SqlMaskOptions = {
          ...(options.arrayBrackets ? { arrayBrackets: true } : {}),
          ...(options.nestedBlockComments ? { nestedBlockComments: true } : {}),
          ...(options.escapeStrings ? { escapeStrings: true } : {}),
        };
        out += " ".repeat(tag.length) + maskSqlStringsAndComments(statement.slice(bodyStart, bodyEnd), bodyOptions);
        i = bodyEnd;
        if (closeIndex >= 0) {
          out += " ".repeat(tag.length);
          i += tag.length;
        }
        continue;
      }
      if (tag) {
        dollarQuote = tag;
        out += " ".repeat(tag.length);
        i += tag.length;
        continue;
      }
    }
    out += char;
    i += 1;
  }
  return out;
}

// Every `[` left in text from `maskSqlStringsAndComments` opens a quoted identifier: array brackets are blank.
const QUOTED_IDENTIFIER_RE = /"(?:""|[^"])*(?:"|$)|`[^`]*(?:`|$)|\[[^\]]*(?:\]|$)/g;

/**
 * Replaces each quoted identifier in text from `maskSqlStringsAndComments` with underscores of the
 * same length: a double-quoted, backtick-quoted, or bracketed one. A scan for keywords, calls, and
 * parentheses then reads an identifier as one bare word: nothing inside it can read as syntax.
 */
export function maskSqlQuotedIdentifiers(masked: string): string {
  return masked.replace(QUOTED_IDENTIFIER_RE, (identifier) => identifier.replace(/[^\n]/g, "_"));
}

/** Track each SELECT's lexical query level, restoring its parent after a subquery closes. */
export function sqlQueryScopes(scan: string): {
  at: (offset: number) => number;
  selectDepthAt: (offset: number) => number;
  parent: ReadonlyMap<number, number>;
} {
  const changes = [{ start: 0, scope: 0, selectDepth: 0 }];
  const parent = new Map<number, number>();
  const stack: Array<{ scope: number; selectDepth: number }> = [];
  let scope = 0;
  let selectDepth = 0;
  for (const match of scan.matchAll(/[A-Za-z_][\w$]*|[()]/g)) {
    const start = match.index ?? 0;
    if (match[0] === "(") {
      stack.push({ scope, selectDepth });
    } else if (match[0] === ")") {
      const enclosing = stack.pop();
      if (enclosing && (scope !== enclosing.scope || selectDepth !== enclosing.selectDepth)) {
        scope = enclosing.scope;
        selectDepth = enclosing.selectDepth;
        changes.push({ start: start + 1, scope, selectDepth });
      }
    } else if (match[0].toLowerCase() === "select") {
      scope = start + 1;
      selectDepth = stack.length;
      parent.set(scope, stack.at(-1)?.scope ?? 0);
      changes.push({ start, scope, selectDepth });
    }
  }
  const changeAt = (offset: number): { scope: number; selectDepth: number } => {
    let low = 0;
    let high = changes.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((changes[middle]?.start ?? 0) <= offset) low = middle;
      else high = middle - 1;
    }
    return changes[low] ?? changes[0]!;
  };
  return {
    at: (offset) => changeAt(offset).scope,
    selectDepthAt: (offset) => changeAt(offset).selectDepth,
    parent,
  };
}
