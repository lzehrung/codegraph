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
  /**
   * Decides which single-quoted string keeps its body visible. `before` is the masked text ahead of
   * the opening quote, so a caller can recognize `AS '...'` as a routine body. A doubled quote inside
   * that body stays two characters: it is an escaped quote, and later offsets do not move. Every other
   * string stays masked.
   */
  keepSingleQuotedBody?: (before: string) => boolean;
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

/**
 * The body of one single-quoted routine string, masked as SQL and the same length as the source.
 * `''` becomes a quote and a space, so the inner scan reads an escaped quote without moving offsets.
 */
function keepSingleQuotedSqlBody(
  statement: string,
  open: number,
  options: SqlMaskOptions,
): { masked: string; next: number } {
  let cursor = open + 1;
  let body = "";
  while (cursor < statement.length) {
    if (statement[cursor] === "'" && statement[cursor + 1] === "'") {
      body += "' ";
      cursor += 2;
      continue;
    }
    if (statement[cursor] === "'") break;
    body += statement[cursor] ?? "";
    cursor += 1;
  }
  const bodyOptions: SqlMaskOptions = {
    ...(options.arrayBrackets ? { arrayBrackets: true } : {}),
    ...(options.nestedBlockComments ? { nestedBlockComments: true } : {}),
    ...(options.escapeStrings ? { escapeStrings: true } : {}),
  };
  let masked = " " + maskSqlStringsAndComments(body, bodyOptions);
  if (statement[cursor] === "'") {
    masked += " ";
    cursor += 1;
  }
  return { masked, next: cursor };
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
      if (options?.keepSingleQuotedBody?.(out)) {
        const kept = keepSingleQuotedSqlBody(statement, i, options);
        out += kept.masked;
        i = kept.next;
        continue;
      }
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

/** A word before UPDATE, DELETE, INSERT, or MERGE that belongs to the surrounding statement. */
const SQL_NONSTATEMENT_PREDECESSOR = new Set(["after", "before", "for", "instead", "of", "on", "or", "then"]);

/** Keywords that end a source clause because they start another statement. */
const SQL_STATEMENT_BOUNDARY = new Set(["select", "update", "delete", "insert", "merge"]);

/** A keyword is syntax only as a bare token, not a variable or a part of a dotted identifier. */
export function isBareSqlKeyword(scan: string, start: number, end: number): boolean {
  if (/[\w$@#:]/.test(scan[start - 1] ?? "") || /[\w$@#:]/.test(scan[end] ?? "")) return false;
  let before = start - 1;
  while (before >= 0 && /\s/.test(scan[before] ?? "")) before -= 1;
  if (scan[before] === ".") return false;
  let after = end;
  while (after < scan.length && /\s/.test(scan[after] ?? "")) after += 1;
  return scan[after] !== ".";
}

/**
 * SELECT always opens a binding scope, including a subquery. UPDATE, DELETE, INSERT, and MERGE open
 * one only as their own statement, so `FOR UPDATE` and `WHEN MATCHED THEN UPDATE` stay in the query
 * that contains them.
 */
function opensSqlBindingScope(scan: string, wordStart: number, word: string): boolean {
  if (!SQL_STATEMENT_BOUNDARY.has(word) || !isBareSqlKeyword(scan, wordStart, wordStart + word.length)) return false;
  if (word === "select") return true;
  const previous = previousSignificantWord(scan, wordStart);
  return !previous || !SQL_NONSTATEMENT_PREDECESSOR.has(previous.word);
}

/** Track statement scopes and the parentheses enclosing each source clause in one lexical scan. */
export function sqlQueryScopes(scan: string): {
  at: (offset: number) => number;
  depthAt: (offset: number) => number;
  selectDepthAt: (offset: number) => number;
  enclosingEndAt: (offset: number) => number;
  parent: ReadonlyMap<number, number>;
} {
  const changes = [{ start: 0, scope: 0, selectDepth: 0, depth: 0, open: -1 }];
  const parent = new Map<number, number>();
  const closes = new Map<number, number>();
  const stack: Array<{ scope: number; selectDepth: number; open: number }> = [];
  let scope = 0;
  let selectDepth = 0;
  for (const match of scan.matchAll(/[A-Za-z_][\w$]*|[()]/g)) {
    const start = match.index ?? 0;
    if (match[0] === "(") {
      stack.push({ scope, selectDepth, open: start });
      changes.push({ start: start + 1, scope, selectDepth, depth: stack.length, open: start });
    } else if (match[0] === ")") {
      const enclosing = stack.pop();
      if (enclosing) {
        closes.set(enclosing.open, start);
        scope = enclosing.scope;
        selectDepth = enclosing.selectDepth;
        changes.push({ start: start + 1, scope, selectDepth, depth: stack.length, open: stack.at(-1)?.open ?? -1 });
      }
    } else if (opensSqlBindingScope(scan, start, match[0].toLowerCase())) {
      // A new statement or subquery. Its parent is the enclosing query, so a correlated
      // subquery still sees that statement's aliases and a sibling statement does not.
      scope = start + 1;
      selectDepth = stack.length;
      parent.set(scope, stack.at(-1)?.scope ?? 0);
      changes.push({ start, scope, selectDepth, depth: stack.length, open: stack.at(-1)?.open ?? -1 });
    }
  }
  const changeAt = (offset: number): (typeof changes)[number] => {
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
    depthAt: (offset) => changeAt(offset).depth,
    selectDepthAt: (offset) => changeAt(offset).selectDepth,
    enclosingEndAt: (offset) => closes.get(changeAt(offset).open) ?? scan.length,
    parent,
  };
}

/** Where the block comment that ends at `end` opens, or -1 when it never does. `end` is the index just after the closing delimiter. */
function blockCommentStart(text: string, end: number): number {
  let depth = 1;
  let cursor = end - 2;
  while (cursor > 0) {
    cursor -= 1;
    if (text[cursor] === "/" && text[cursor - 1] === "*") {
      depth += 1;
      cursor -= 1;
      continue;
    }
    if (text[cursor] === "*" && text[cursor - 1] === "/") {
      depth -= 1;
      if (depth === 0) return cursor - 1;
      cursor -= 1;
    }
  }
  return -1;
}

/**
 * The index after the significant token that ends at `index`. Whitespace, line comments, and block
 * comments between tokens are skipped, however long they are.
 */
function skipTriviaBackward(text: string, index: number): number {
  let cursor = index;
  while (cursor > 0) {
    const previous = text[cursor - 1] ?? "";
    if (/\s/.test(previous)) {
      cursor -= 1;
      continue;
    }
    if (previous === "/" && text[cursor - 2] === "*") {
      const open = blockCommentStart(text, cursor);
      if (open < 0 || open >= cursor) return cursor;
      cursor = open;
      continue;
    }
    const lineStart = text.lastIndexOf("\n", cursor - 1) + 1;
    const lineComment = text.lastIndexOf("--", cursor - 1);
    if (lineComment >= lineStart) {
      cursor = lineComment;
      continue;
    }
    return cursor;
  }
  return cursor;
}

function previousSignificantWord(text: string, index: number): { word: string; from: number } | null {
  const end = skipTriviaBackward(text, index);
  let start = end;
  while (start > 0 && /[A-Za-z0-9_$]/.test(text[start - 1] ?? "")) start -= 1;
  if (start === end) return null;
  return { word: text.slice(start, end).toLowerCase(), from: start };
}

/** `IS [NOT] DISTINCT FROM` compares values. The `FROM` is not a table source. */
function isDistinctFromPredicate(scan: string, fromIndex: number): boolean {
  const distinct = previousSignificantWord(scan, fromIndex);
  if (distinct?.word !== "distinct") return false;
  const middle = previousSignificantWord(scan, distinct.from);
  if (!middle) return false;
  if (middle.word === "is") return true;
  if (middle.word !== "not") return false;
  return previousSignificantWord(scan, middle.from)?.word === "is";
}

/**
 * Real FROM/USING/JOIN/APPLY sources at their query level. A clause stops at the enclosing
 * parenthesis, at the next clause keyword of the same query, at a statement-ending `;`, and at the
 * next statement (`SELECT`, `UPDATE`, `DELETE`, `INSERT`, or `MERGE`) at the same parenthesis
 * depth. A later statement in a `BEGIN`/`END` body therefore cannot become part of an earlier source list.
 */
export function sqlSourceClauses(scan: string): Array<{
  kind: "from" | "using" | "join" | "apply";
  start: number;
  end: number;
  clauseEnd: number;
  depth: number;
}> {
  const scopes = sqlQueryScopes(scan);
  const sources: Array<{
    kind: "from" | "using" | "join" | "apply";
    start: number;
    end: number;
    clauseEnd: number;
    depth: number;
  }> = [];
  const boundaryRe =
    /\b(?:where|group|order|having|limit|offset|returning|union|intersect|except|join|apply|on|from|using|select|update|delete|insert|merge)\b|;/gi;
  for (const match of scan.matchAll(/\b(from|using|join|apply)\b/gi)) {
    const start = match.index ?? 0;
    const depth = scopes.depthAt(start);
    if (!isBareSqlKeyword(scan, start, start + match[0].length)) continue;
    if (depth !== scopes.selectDepthAt(start)) continue;
    const kind = match[1]!.toLowerCase() as "from" | "using" | "join" | "apply";
    if (kind === "from" && isDistinctFromPredicate(scan, start)) continue;
    const end = start + match[0].length;
    const scope = scopes.at(start);
    let clauseEnd = scopes.enclosingEndAt(start);
    boundaryRe.lastIndex = end;
    let boundary: RegExpExecArray | null;
    while ((boundary = boundaryRe.exec(scan)) !== null) {
      const at = boundary.index;
      if (at >= clauseEnd) break;
      if (scopes.depthAt(at) !== depth) continue;
      if (boundary[0] !== ";" && !isBareSqlKeyword(scan, at, at + boundary[0].length)) continue;
      const token = boundary[0].toLowerCase();
      // `;` and the next statement end the clause. That statement has already changed scope, so it
      // would not match the same-scope test below.
      if (token === ";" || SQL_STATEMENT_BOUNDARY.has(token) || scopes.at(at) === scope) {
        clauseEnd = at;
        break;
      }
    }
    sources.push({ kind, start, end, clauseEnd, depth });
  }
  return sources;
}
