import { describe, expect, it } from "vitest";
import { assertMcpSqliteQueryResourceBounded } from "../src/mcp/sqlite-guard.js";
import {
  maskSqlQuotedIdentifiers,
  maskSqlStringsAndComments,
  sqlQueryScopes,
  sqlSourceClauses,
} from "../src/sql/lex.js";

/** The text with runs of blanks and line breaks folded to one space, so a test names what stays and what goes. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

describe("SQL masking of square brackets", () => {
  it("reads every [ as a quoted identifier by default, as SQLite does", () => {
    // SQLite reads `t[a'b]` as column t with the alias `a'b`, so `hex(1)` after it is a real call.
    // Reading the `[` as a subscript would start a string at `'` and hide the call from the guard.
    const query = "SELECT t[a'b] FROM tbl WHERE x = hex(1)";

    expect(maskSqlStringsAndComments(query)).toBe(query);
    expect(() => assertMcpSqliteQueryResourceBounded(query)).toThrow(/hex/);
  });

  it.each([
    ["an identifier", "SELECT ARRAY['a(1)', f(2)]", "SELECT ARRAY , f(2)"],
    ["a column", "SELECT arr['a(1)'] FROM t", "SELECT arr FROM t"],
    ["an identifier that ends in a digit", "SELECT x1['a(1)'], f(2)", "SELECT x1 , f(2)"],
    ["a closing parenthesis", "SELECT (x)['a(1)']", "SELECT (x)"],
    ["an earlier subscript", "SELECT m[1]['a(1)']", "SELECT m 1"],
    ["a quoted identifier", "SELECT \"col\"['a(1)']", 'SELECT "col"'],
    ["the word ARRAY and a space", "SELECT ARRAY ['a(1)', f(2)]", "SELECT ARRAY , f(2)"],
  ])("reads a [ after %s as an array bracket when asked, and blanks it", (_label, statement, expected) => {
    const masked = maskSqlStringsAndComments(statement, { arrayBrackets: true });

    expect(masked).toHaveLength(statement.length);
    expect(collapse(masked)).toBe(expected);
  });

  it.each([
    ["a keyword", "SELECT[it's] FROM t"],
    ["a number", "SELECT 1[it's]"],
    ["a clause keyword", "SELECT 1 WHERE[it's] = 1"],
    ["AS", "SELECT 1 AS[it's]"],
    ["a space", "SELECT [it's] FROM t"],
    ["a comma", "SELECT a, [it's] FROM t"],
    ["a dot", "SELECT t.[it's] FROM t"],
    ["an opening parenthesis", "SELECT ([it's]) FROM t"],
  ])("reads a [ after %s as a quoted identifier even when array brackets are asked for", (_label, statement) => {
    expect(maskSqlStringsAndComments(statement, { arrayBrackets: true })).toBe(statement);
  });

  it("blanks a quoted identifier for scanning but keeps the code in an array bracket", () => {
    const statement = 'SELECT [norm(1)], "norm(2)", `norm(3)`, ARRAY[norm(4)], arr[norm(5)]';
    const blank = "_".repeat("[norm(1)]".length);
    const scan = maskSqlQuotedIdentifiers(maskSqlStringsAndComments(statement, { arrayBrackets: true }));

    expect(collapse(scan)).toBe(`SELECT ${blank}, ${blank}, ${blank}, ARRAY norm(4) , arr norm(5)`);
  });
});

describe("SQL masking of nested block comments", () => {
  const statement = "SELECT /* a /* b */ hex(1) */ 2";

  it("ends a block comment at its first closing delimiter by default, as SQLite does", () => {
    expect(maskSqlStringsAndComments(statement)).toContain("hex(1)");
    // SQLite reads the first `*/` as the end of the comment, so `hex(...)` runs and a `--` hides the rest.
    expect(() => assertMcpSqliteQueryResourceBounded("SELECT /* a /* b */ hex(randomblob(10)) -- */\n 1")).toThrow(
      /hex/,
    );
  });

  it.each([
    ["a nested comment", statement, "SELECT 2"],
    ["two levels", "SELECT /* a /* b /* c */ */ hex(1) */ 2", "SELECT 2"],
    ["a call after the comment", "SELECT /* a /* b */ */ hex(1)", "SELECT hex(1)"],
    ["a comment that is never closed", "SELECT /* a /* b */ hex(1)", "SELECT"],
    ["a line comment in a comment", "SELECT /* a -- b */ hex(1)", "SELECT hex(1)"],
  ])("lets a block comment hold block comments when asked: %s", (_label, text, expected) => {
    const masked = maskSqlStringsAndComments(text, { nestedBlockComments: true });

    expect(masked).toHaveLength(text.length);
    expect(collapse(masked)).toBe(expected);
  });
});

describe("SQL masking of escape strings", () => {
  it("ends a string at its first closing quote by default, as SQLite does", () => {
    expect(collapse(maskSqlStringsAndComments("SELECT E'can\\'t hex(1)'"))).toContain("hex(1)");
    // SQLite has no escape string: `E` is a name, `'a\'` a string, and `hex(...)` a call between two strings.
    expect(() => assertMcpSqliteQueryResourceBounded("SELECT E'a\\' , hex(randomblob(10)), 'b'")).toThrow(/hex/);
  });

  it.each([
    ["an escaped quote", "SELECT E'can\\'t hex(1)'", "SELECT E"],
    ["a lowercase prefix", "SELECT e'can\\'t hex(1)'", "SELECT e"],
    ["an escaped backslash before the closing quote", "SELECT E'a\\\\', hex(1)", "SELECT E , hex(1)"],
    ["a doubled quote and an escaped quote", "SELECT E'it''s \\' hex(1)', hex(2)", "SELECT E , hex(2)"],
    ["an escaped line break", "SELECT E'a\\\nb hex(1)', hex(2)", "SELECT E , hex(2)"],
  ])("reads a backslash in an E string as an escape when asked: %s", (_label, text, expected) => {
    const masked = maskSqlStringsAndComments(text, { escapeStrings: true });

    expect(masked).toHaveLength(text.length);
    expect(collapse(masked)).toBe(expected);
  });

  it.each([
    ["a word that ends in e", "SELECT date'a\\' hex(1)'"],
    ["no prefix", "SELECT 'a\\' hex(1)'"],
    ["a prefix inside a longer word", "SELECT type'a\\' hex(1)'"],
  ])("keeps the end of a string at its first closing quote when it is no E string: %s", (_label, text) => {
    expect(maskSqlStringsAndComments(text, { escapeStrings: true })).toContain("hex(1)");
  });
});

describe("SQL source clause bounds", () => {
  function sourceTexts(sql: string): string[] {
    const scan = maskSqlQuotedIdentifiers(
      maskSqlStringsAndComments(sql, { arrayBrackets: true, nestedBlockComments: true, escapeStrings: true }),
    );
    return sqlSourceClauses(scan).map((source) => scan.slice(source.end, source.clauseEnd).replace(/\s+/g, " ").trim());
  }

  it("ends a source clause at a semicolon and at the next query inside a procedure", () => {
    const body = "CREATE PROCEDURE p AS BEGIN SELECT u.id FROM users u; SELECT g.id FROM get_users() g; END";
    const noSemicolon = "CREATE PROCEDURE p AS BEGIN SELECT u.id FROM users u SELECT g.id FROM get_users() g END";

    expect(sourceTexts(body)).toEqual(["users u", "get_users() g"]);
    const unbound = sourceTexts(noSemicolon);
    expect(unbound[0]).toBe("users u");
    expect(unbound[1]?.startsWith("get_users() g")).toBe(true);
    expect(unbound[0]).not.toContain("get_users");
  });

  it("does not end an outer source at a semicolon inside a parenthesized query", () => {
    expect(sourceTexts("SELECT * FROM (SELECT id FROM users u;) x")).toEqual([
      "(SELECT id FROM users u;) x",
      "users u",
    ]);
  });

  it.each([
    ["a long block comment", `SELECT 1 WHERE value IS /* ${"c".repeat(80)} */ DISTINCT FROM norm(1)`],
    ["a long line comment", `SELECT 1 WHERE value IS -- ${"c".repeat(80)}\n DISTINCT FROM norm(1)`],
    ["whitespace and newlines", `SELECT 1 WHERE value IS${" \n".repeat(30)}DISTINCT${" \n".repeat(30)}FROM norm(1)`],
    ["IS NOT and a long comment", `SELECT 1 WHERE value IS NOT /* ${"c".repeat(80)} */ DISTINCT FROM norm(1)`],
  ])("does not read %s between IS and FROM as a source clause", (_label, sql) => {
    expect(sourceTexts(sql)).toEqual([]);
    // The same words with the comment still present, not only after it has been blanked.
    expect(sqlSourceClauses(sql)).toEqual([]);
  });

  it("still reads the table beside IS DISTINCT FROM when a long comment separates the words", () => {
    const sql = `SELECT norm.id FROM norm WHERE value IS /* ${"c".repeat(80)} */ DISTINCT FROM norm(1)`;
    expect(sourceTexts(sql)).toEqual(["norm"]);
  });
  it("keeps variable and qualified keyword-shaped identifiers inside the query and source clause", () => {
    const sql = "SELECT u.id, @update, :select, $insert, u.select FROM users u JOIN orgs o ON u.where = o.id";
    const scopes = sqlQueryScopes(sql);
    const query = scopes.at(sql.indexOf("SELECT"));
    for (const token of ["u.id", "@update", ":select", "$insert", "u.select", "FROM users", "u.where"]) {
      expect(scopes.at(sql.indexOf(token))).toBe(query);
    }
    expect(sourceTexts(sql)).toEqual(["users u", "orgs o"]);
    expect(sourceTexts("SELECT * FROM users u WHERE u.where = 1")).toEqual(["users u"]);
    expect(sourceTexts("SELECT * FROM users u, u.where x WHERE x.id = 1")).toEqual(["users u, u.where x"]);
    const quoted = 'SELECT u.id, select.b, "update", [delete], `merge` FROM users u';
    const masked = maskSqlQuotedIdentifiers(maskSqlStringsAndComments(quoted));
    const quotedScopes = sqlQueryScopes(masked);
    expect(quotedScopes.at(quoted.indexOf("select.b"))).toBe(quotedScopes.at(0));
    expect(quotedScopes.at(quoted.indexOf("FROM users"))).toBe(quotedScopes.at(0));
    expect(sqlSourceClauses(masked).map((source) => masked.slice(source.end, source.clauseEnd).trim())).toEqual([
      "users u",
    ]);
  });
});
