import { describe, expect, it } from "vitest";
import { assertMcpSqliteQueryResourceBounded } from "../src/mcp/sqlite-guard.js";
import { maskSqlQuotedIdentifiers, maskSqlStringsAndComments } from "../src/sql/lex.js";

describe("SQL masking of square brackets", () => {
  it("reads every [ as a quoted identifier by default, as SQLite does", () => {
    // SQLite reads `t[a'b]` as column t with the alias `a'b`, so `hex(1)` after it is a real call.
    // Reading the `[` as a subscript would start a string at `'` and hide the call from the guard.
    const query = "SELECT t[a'b] FROM tbl WHERE x = hex(1)";

    expect(maskSqlStringsAndComments(query)).toBe(query);
    expect(() => assertMcpSqliteQueryResourceBounded(query)).toThrow(/hex/);
  });

  it.each([
    ["an identifier", "SELECT ARRAY['a(1)', f(2)]", "SELECT ARRAY[      , f(2)]"],
    ["a subscript", "SELECT arr['a(1)'] FROM t", "SELECT arr[      ] FROM t"],
    ["a closing parenthesis", "SELECT (x)['a(1)']", "SELECT (x)[      ]"],
    ["an earlier subscript", "SELECT m[1]['a(1)']", "SELECT m[1][      ]"],
    ["a quoted identifier", "SELECT \"col\"['a(1)']", 'SELECT "col"[      ]'],
    ["the word ARRAY and a space", "SELECT ARRAY ['a(1)', f(2)]", "SELECT ARRAY [      , f(2)]"],
  ])("reads a [ after %s as an array bracket when asked", (_label, statement, expected) => {
    expect(maskSqlStringsAndComments(statement, { arrayBrackets: true })).toBe(expected);
  });

  it.each([
    ["after a keyword", "SELECT [it's] FROM t"],
    ["after a comma", "SELECT a, [it's] FROM t"],
    ["after a dot", "SELECT t.[it's] FROM t"],
    ["after an opening parenthesis", "SELECT ([it's]) FROM t"],
  ])("still reads a [ %s as a quoted identifier when array brackets are asked for", (_label, statement) => {
    expect(maskSqlStringsAndComments(statement, { arrayBrackets: true })).toBe(statement);
  });

  it("blanks a quoted identifier for scanning but keeps the code in an array bracket", () => {
    const statement = 'SELECT [norm(1)], "norm(2)", `norm(3)`, ARRAY[norm(4)], arr[norm(5)]';
    const blank = "_".repeat("[norm(1)]".length);

    expect(maskSqlQuotedIdentifiers(maskSqlStringsAndComments(statement, { arrayBrackets: true }))).toBe(
      `SELECT ${blank}, ${blank}, ${blank}, ARRAY[norm(4)], arr[norm(5)]`,
    );
  });
});
