import { describe, expect, it } from "vitest";
import {
  findSqlRoutineMentions,
  findSqlRoutineSources,
  sqlRoutineDefinitionNamespace,
  sqlStatementDropsRoutine,
} from "../src/sql/routine-mentions.js";

/** `kind:namespace:text` for each mention, with the text as written in the statement. */
function describeMentions(statement: string): string[] {
  return findSqlRoutineMentions(statement).map(
    (mention) => `${mention.kind}:${mention.namespace}:${statement.slice(mention.start, mention.end)}`,
  );
}

function mentionTexts(statement: string): string[] {
  return findSqlRoutineMentions(statement).map((mention) => statement.slice(mention.start, mention.end));
}

/** The call mentions of a statement, with their text as written. */
function callMentions(statement: string): Array<{ text: string; speculative: boolean }> {
  return findSqlRoutineMentions(statement)
    .filter((mention) => mention.kind === "call")
    .map((mention) => ({ text: statement.slice(mention.start, mention.end), speculative: mention.speculative }));
}

describe("SQL routine mentions", () => {
  it.each([
    ["a SELECT list", "SELECT normalize_email(email) FROM users", "normalize_email"],
    ["an INSERT value", "INSERT INTO users (id, email) VALUES (1, normalize_email('a@b'))", "normalize_email"],
    ["a column default", "CREATE TABLE t (e text DEFAULT normalize_email('x'))", "normalize_email"],
    ["a CHECK constraint", "CREATE TABLE t (e text, CHECK (normalize_email(e) = e))", "normalize_email"],
    ["an index expression", "CREATE INDEX i ON users (normalize_email(email))", "normalize_email"],
    ["a FROM source", "SELECT * FROM public.get_users(1) AS u", "public.get_users"],
    ["quoted identifiers", 'SELECT "App"."Norm"(1)', '"App"."Norm"'],
    ["whitespace around the dot", "SELECT app . norm (1)", "app . norm"],
    ["a PL/pgSQL assignment", "DO $$ BEGIN v := normalize_email(x); END $$", "normalize_email"],
    ["a join predicate", "SELECT * FROM a JOIN b ON norm(a.id) = b.id", "norm"],
    ["a CTE body", "WITH c AS (SELECT norm(1)) SELECT 1", "norm"],
    ["a MATERIALIZED CTE body", "WITH c AS MATERIALIZED (SELECT norm(1)) SELECT 1", "norm"],
    ["an array constructor", "SELECT ARRAY[f(1), g(2)]", "f"],
    ["an array constructor after a space", "SELECT ARRAY [norm(1)]", "norm"],
  ])("finds a call in %s", (_label, statement, text) => {
    expect(describeMentions(statement)).toContain(`call:callable:${text}`);
  });

  it("marks a keyword call as certain and a bare name( as speculative", () => {
    expect(findSqlRoutineMentions("CALL audit_user(1)")).toMatchObject([{ kind: "call", speculative: false }]);
    expect(findSqlRoutineMentions("SELECT audit_user(1)")).toMatchObject([{ kind: "call", speculative: true }]);
  });

  it.each([
    ["CALL", "CALL audit_user(1)", ["call:callable:audit_user"]],
    ["CALL without parentheses", "CALL audit_user", ["call:callable:audit_user"]],
    ["T-SQL EXEC", "EXEC dbo.refresh_totals 1", ["call:callable:dbo.refresh_totals"]],
    ["T-SQL EXECUTE", "EXECUTE dbo.refresh_totals @account_id = 7", ["call:callable:dbo.refresh_totals"]],
    ["T-SQL EXEC with a return code", "EXEC @status = dbo.refresh_totals 9", ["call:callable:dbo.refresh_totals"]],
    ["a comment between CALL and the name", "CALL /* note */ norm(1)", ["call:callable:norm"]],
    ["a comment between EXEC and the name", "EXEC /* note */ dbo.norm 1", ["call:callable:dbo.norm"]],
    ["a line comment between CALL and the name", "CALL -- note\n norm(1)", ["call:callable:norm"]],
    [
      "a trigger EXECUTE FUNCTION",
      "CREATE TRIGGER t BEFORE UPDATE ON u FOR EACH ROW EXECUTE FUNCTION touch()",
      ["definition:trigger:t", "call:callable:touch"],
    ],
    [
      "a trigger EXECUTE PROCEDURE",
      "CREATE TRIGGER t AFTER INSERT ON u FOR EACH ROW EXECUTE PROCEDURE audit()",
      ["definition:trigger:t", "call:callable:audit"],
    ],
  ])("reads %s", (_label, statement, expected) => {
    expect(describeMentions(statement)).toEqual(expected);
  });

  it.each([
    ["DROP FUNCTION", "DROP FUNCTION IF EXISTS app.f(integer)", ["drop:callable:app.f"]],
    ["DROP TRIGGER", "DROP TRIGGER set_updated_at ON users", ["drop:trigger:set_updated_at"]],
    ["ALTER PROCEDURE", "ALTER PROCEDURE p(integer) OWNER TO app", ["reference:callable:p"]],
    ["COMMENT ON FUNCTION", "COMMENT ON FUNCTION f(text) IS 'x'", ["reference:callable:f"]],
    ["GRANT ON FUNCTION", "GRANT EXECUTE ON FUNCTION f(text) TO app", ["reference:callable:f"]],
    ["ENABLE TRIGGER", "ALTER TABLE users ENABLE TRIGGER set_updated_at", ["reference:trigger:set_updated_at"]],
    [
      "CREATE PROCEDURE",
      "CREATE OR REPLACE PROCEDURE app.p(a integer) LANGUAGE sql AS $$ SELECT 1 $$",
      ["definition:callable:app.p"],
    ],
    [
      "a function that returns trigger",
      "CREATE FUNCTION f() RETURNS trigger AS $$ SELECT 1 $$ LANGUAGE sql",
      ["definition:callable:f"],
    ],
  ])("reads %s as a statement about a routine", (_label, statement, expected) => {
    expect(describeMentions(statement)).toEqual(expected);
  });

  it.each([
    ["an INSERT target", "INSERT INTO users (id) VALUES (1)", "users"],
    ["a CREATE TABLE name", "CREATE TABLE IF NOT EXISTS users (id integer)", "users"],
    ["a foreign key target", "ALTER TABLE orders ADD FOREIGN KEY (user_id) REFERENCES users (id)", "users"],
    ["a CAST type", "SELECT CAST(x AS numeric(10, 2))", "numeric"],
    ["a column alias list", "SELECT * FROM generate_series(1, 3) AS g(i)", "g"],
    ["an EXECUTE AS clause", "EXECUTE AS USER = 'app'", "AS"],
  ])("does not read %s as a routine", (_label, statement, text) => {
    expect(mentionTexts(statement)).not.toContain(text);
  });

  it.each([
    "SELECT y::varchar(20)",
    "SELECT @total(1)",
    "SELECT call FROM t",
    "EXEC ('SELECT 1')",
    "GRANT EXECUTE TO app",
    "SELECT * FROM users (NOLOCK)",
    "SELECT * FROM users WITH (NOLOCK)",
    "SELECT * FROM users u WITH (NOLOCK), orders o WITH (NOLOCK, INDEX (ix_orders))",
  ])("finds no routine in %s", (statement) => {
    expect(describeMentions(statement)).toEqual([]);
  });

  it.each([
    "SELECT 'normalize_email(x)' FROM t",
    "SELECT 1 -- normalize_email(x)",
    "SELECT /* normalize_email(x) */ 1",
    "SELECT $$normalize_email(x)$$",
    "SELECT $tag$ normalize_email(x) $tag$",
    "SELECT 'it''s', 'normalize_email(x)'",
    "COMMENT ON TABLE t IS 'CALL normalize_email(x)'",
  ])("ignores a name inside a string or comment: %s", (statement) => {
    expect(mentionTexts(statement)).not.toContain("normalize_email");
  });

  it.each([
    ["SQL", "CREATE FUNCTION w() RETURNS int AS $$ SELECT f(1) $$ LANGUAGE sql"],
    ["PL/pgSQL", "CREATE FUNCTION w() RETURNS int AS $$ BEGIN RETURN f(1); END $$ LANGUAGE plpgsql"],
    ["a quoted language", "CREATE FUNCTION w() RETURNS int AS $$ SELECT f(1) $$ LANGUAGE 'sql'"],
    [
      "a LANGUAGE clause before AS",
      "CREATE FUNCTION w() RETURNS int LANGUAGE plpgsql AS $b$ BEGIN RETURN f(1); END $b$",
    ],
    ["a function without a LANGUAGE clause", "CREATE FUNCTION w() RETURNS int AS $$ SELECT f(1) $$"],
    ["a DO block", "DO $$ BEGIN PERFORM f(1); END $$"],
    ["a procedure", "CREATE PROCEDURE w() LANGUAGE plpgsql AS $$ BEGIN CALL f(1); END $$"],
    ["a double-quoted language", 'CREATE FUNCTION w() RETURNS int AS $$ SELECT f(1) $$ LANGUAGE "plpgsql"'],
    [
      "a language after a block comment",
      "CREATE FUNCTION w() RETURNS int AS $$ SELECT f(1) $$ LANGUAGE /* note */ plpgsql",
    ],
    ["a language after a line comment", "CREATE FUNCTION w() RETURNS int AS $$ SELECT f(1) $$ LANGUAGE -- note\n sql"],
    ["a parameter named language", "CREATE FUNCTION w(language text) RETURNS int AS $$ SELECT f(1) $$ LANGUAGE sql"],
    ["a DO block with a language before the body", "DO LANGUAGE plpgsql $$ BEGIN PERFORM f(1); END $$"],
    ["a DO block with a language after the body", "DO $$ BEGIN PERFORM f(1); END $$ LANGUAGE plpgsql"],
  ])("reads the $$ body of %s as code", (_label, statement) => {
    expect(describeMentions(statement)).toContain("call:callable:f");
  });

  it.each([
    ["a Python body", "CREATE FUNCTION w() RETURNS int AS $$ return f(1) $$ LANGUAGE plpython3u"],
    ["a string in the body", "CREATE FUNCTION w() RETURNS int AS $$ BEGIN PERFORM 'f(1)'; END $$ LANGUAGE plpgsql"],
    [
      "a comment in the body",
      "CREATE FUNCTION w() RETURNS int AS $$ BEGIN -- f(1)\n RETURN 1; END $$ LANGUAGE plpgsql",
    ],
    [
      "a nested dollar-quoted string",
      "CREATE FUNCTION w() RETURNS int AS $$ BEGIN EXECUTE $q$ SELECT f(1) $q$; END $$ LANGUAGE plpgsql",
    ],
    ["a double-quoted language", 'CREATE FUNCTION w() RETURNS int AS $$ return f(1) $$ LANGUAGE "plpython3u"'],
    [
      "a language after a block comment",
      "CREATE FUNCTION w() RETURNS int AS $$ return f(1) $$ LANGUAGE /* note */ plpython3u",
    ],
    [
      "a language after a line comment",
      "CREATE FUNCTION w() RETURNS int AS $$ return f(1) $$ LANGUAGE -- note\n plpython3u",
    ],
    [
      "a double-quoted language before AS",
      'CREATE FUNCTION w() RETURNS int LANGUAGE "plpython3u" AS $$ return f(1) $$',
    ],
    ["a DO block in another language", 'DO $$ return f(1) $$ LANGUAGE "plpython3u"'],
    [
      "a language clause that cannot be read",
      "CREATE FUNCTION w() RETURNS int AS $$ return f(1) $$ LANGUAGE $q$plpython3u$q$",
    ],
  ])("does not read %s as a call", (_label, statement) => {
    expect(describeMentions(statement)).not.toContain("call:callable:f");
  });

  it.each([
    [
      "a parameter default",
      "CREATE FUNCTION w(x text DEFAULT $$normalize_email(x)$$) RETURNS int AS $$ SELECT f(1) $$ LANGUAGE sql",
    ],
    [
      "a SET value",
      "CREATE FUNCTION w() RETURNS int AS $$ SELECT f(1) $$ LANGUAGE sql SET search_path = $$normalize_email(x)$$",
    ],
    [
      "a procedure parameter default",
      "CREATE PROCEDURE w(x text DEFAULT $$normalize_email(x)$$) LANGUAGE sql AS $$ CALL f(1) $$",
    ],
  ])("reads only the routine body as code, not %s", (_label, statement) => {
    expect(mentionTexts(statement)).toContain("f");
    expect(mentionTexts(statement)).not.toContain("normalize_email");
  });

  it.each([
    ["a call-shaped alias", 'SELECT 1 AS "normalize_email(email)"'],
    ["a CALL keyword in an alias", 'SELECT 1 AS "call normalize_email"'],
    ["a DROP FUNCTION in an alias", 'SELECT 1 AS "drop function normalize_email"'],
    ["an escaped quote in an alias", 'SELECT 1 AS "a"" normalize_email(x)"'],
    ["a backtick alias", "SELECT 1 AS `normalize_email(email)`"],
    ["a bracketed alias", "SELECT 1 AS [normalize_email(email)]"],
    ["a bracketed alias without AS", "SELECT 1 [normalize_email(email)]"],
    ["a CALL keyword in a bracketed alias", "SELECT 1 AS [call normalize_email]"],
    ["a DROP FUNCTION in a bracketed alias", "SELECT 1 AS [drop function normalize_email]"],
    ["a bracketed alias that holds a quote", "SELECT 1 AS [it's normalize_email(x)]"],
  ])("does not read the inside of a quoted identifier as a routine: %s", (_label, statement) => {
    expect(describeMentions(statement)).toEqual([]);
  });

  it.each([
    ["a quoted call", 'SELECT "normalize_email"(email)', '"normalize_email"'],
    ["a quoted call after a quoted alias", 'SELECT 1 AS "a(b)", "normalize_email"(email)', '"normalize_email"'],
    ["a quoted schema and name", 'SELECT "App"."Norm"(1)', '"App"."Norm"'],
    ["a quoted CALL target", 'CALL "App"."Norm"(1)', '"App"."Norm"'],
    ["a bracketed call", "SELECT [normalize_email](email)", "[normalize_email]"],
    ["a bracketed call after a bracketed alias", "SELECT 1 AS [a(b)], [normalize_email](email)", "[normalize_email]"],
    ["a bracketed schema and name", "SELECT [App].[Norm](1)", "[App].[Norm]"],
    ["a bracketed EXEC target", "EXEC [dbo].[refresh_totals] 1", "[dbo].[refresh_totals]"],
  ])("keeps %s as a routine call", (_label, statement, text) => {
    expect(mentionTexts(statement)).toEqual([text]);
  });

  it.each([
    ["a string in an array constructor", "SELECT ARRAY['normalize_email(x)', normalize_email(y)]"],
    ["a block comment in an array constructor", "SELECT ARRAY[/* normalize_email(x) */ normalize_email(y)]"],
    ["a line comment in an array constructor", "SELECT ARRAY[1, -- normalize_email(x)\n normalize_email(y)]"],
    ["a string in an array constructor after a space", "SELECT ARRAY ['normalize_email(x)', normalize_email(y)]"],
    ["a string in a subscript", "SELECT arr['normalize_email(x)'], normalize_email(y) FROM t"],
    ["a nested array constructor", "SELECT ARRAY[ARRAY['normalize_email(x)'], ARRAY[normalize_email(y)]]"],
    ["a quoted identifier in an array constructor", 'SELECT ARRAY["a(b)", normalize_email(y)]'],
  ])("reads only the code in %s", (_label, statement) => {
    expect(findSqlRoutineMentions(statement).map((mention) => mention.start)).toEqual([
      statement.lastIndexOf("normalize_email"),
    ]);
  });

  it.each([
    ["a keyword", "SELECT[normalize_email(x)] FROM t"],
    ["a number", "SELECT 1[normalize_email(x)]"],
    ["AS", "SELECT 1 AS[normalize_email(x)]"],
    ["a clause keyword", "SELECT 1 WHERE[normalize_email(x)] = 1"],
  ])("does not read a bracketed identifier right after %s as a routine call", (_label, statement) => {
    expect(describeMentions(statement)).toEqual([]);
  });

  it.each([
    ["a column", "SELECT arr[normalize_email(1)] FROM t"],
    ["an identifier that ends in a digit", "SELECT x1[normalize_email(1)]"],
    ["a qualified column", "SELECT t.col[normalize_email(1)] FROM t"],
    ["ARRAY", "SELECT ARRAY[normalize_email(1)]"],
    ["a closing parenthesis", "SELECT (a)[normalize_email(1)]"],
  ])("keeps a call inside a subscript after %s", (_label, statement) => {
    expect(mentionTexts(statement)).toContain("normalize_email");
  });

  it.each([
    ["a nested block comment", "SELECT 1 /* a /* b */ normalize_email(x) */"],
    ["two levels of block comments", "SELECT /* a /* b /* c */ */ normalize_email(x) */ 1"],
    ["a block comment that is never closed", "SELECT /* a /* b */ normalize_email(x)"],
  ])("ignores a name inside %s", (_label, statement) => {
    expect(describeMentions(statement)).toEqual([]);
  });

  it.each([
    ["a call after a nested comment", "SELECT /* a /* b */ */ normalize_email(x)"],
    ["a CALL target after a nested comment", "CALL /* a /* b */ */ normalize_email(x)"],
  ])("keeps %s", (_label, statement) => {
    expect(callMentions(statement).map((call) => call.text)).toEqual(["normalize_email"]);
  });

  it.each([
    ["an escaped quote", "SELECT E'can\\'t normalize_email(x)'"],
    ["a lowercase prefix", "SELECT e'can\\'t normalize_email(x)'"],
    ["a doubled quote and an escaped quote", "SELECT E'it''s \\' normalize_email(x)', 1"],
  ])("ignores a name inside an E string with %s", (_label, statement) => {
    expect(describeMentions(statement)).toEqual([]);
  });

  it.each([
    ["an escaped backslash before the closing quote", "SELECT E'a\\\\', normalize_email(x)"],
    ["a word that ends in e, which is no E string", "SELECT date'a\\' normalize_email(x)'"],
  ])("keeps the call after %s", (_label, statement) => {
    expect(callMentions(statement).map((call) => call.text)).toEqual(["normalize_email"]);
  });

  it.each([
    ["a string after CALL", "CALL 'note' norm(1)"],
    ["a string after EXEC", "EXEC 'x' dbo.norm 1"],
    ["a comment-shaped string", "CALL '/* note */' norm(1)"],
  ])("does not treat an intervening string as whitespace: %s", (_label, statement) => {
    expect(mentionTexts(statement)).not.toContain("norm");
    expect(mentionTexts(statement)).not.toContain("dbo.norm");
  });

  it.each([
    ["an index target", "CREATE INDEX ix ON norm (id)", "norm"],
    ["a qualified index target", "CREATE INDEX ix ON ONLY dbo.norm (id)", "dbo.norm"],
    ["a CTE declaration", "WITH norm(x) AS (SELECT 1) SELECT x FROM norm", "norm"],
    ["a later CTE declaration", "WITH a(x) AS (SELECT 1), norm(y) AS (SELECT 2) SELECT y FROM norm", "norm"],
    ["a MATERIALIZED CTE declaration", "WITH norm(x) AS MATERIALIZED (SELECT 1) SELECT x FROM norm", "norm"],
    ["a NOT MATERIALIZED CTE declaration", "WITH norm(x) AS NOT MATERIALIZED (SELECT 1) SELECT x FROM norm", "norm"],
    [
      "a later MATERIALIZED CTE declaration",
      "WITH a(x) AS (SELECT 1), norm(y) AS MATERIALIZED (SELECT 2) SELECT y FROM norm",
      "norm",
    ],
    [
      "a lowercase tight NOT MATERIALIZED declaration",
      "with norm(x) as not materialized(select 1) select x from norm",
      "norm",
    ],
  ])("does not read %s as a routine", (_label, statement, name) => {
    expect(mentionTexts(statement)).not.toContain(name);
  });

  it.each([
    ["a function source with AS", "SELECT * FROM generate_series(1, 3) AS norm(i)"],
    ["a function source without AS", "SELECT * FROM generate_series(1, 3) norm(i)"],
    ["a table without AS", "SELECT * FROM users norm(i)"],
    ["a subquery without AS", "SELECT * FROM (SELECT 1) norm(i)"],
    ["a VALUES list without AS", "SELECT * FROM (VALUES (1, 2)) norm(a, b)"],
    ["a LATERAL join without AS", "SELECT * FROM a JOIN LATERAL f(a.id) norm(i) ON true"],
    ["WITH ORDINALITY", "SELECT * FROM unnest(arr) WITH ORDINALITY norm(x, n)"],
    ["a later source", "SELECT * FROM a, generate_series(1, 3) norm(i), b"],
    ["a MERGE source", "MERGE INTO t USING (VALUES (1)) norm(a) ON t.a = norm.a WHEN MATCHED THEN DELETE"],
    ["a quoted alias", 'SELECT * FROM generate_series(1, 3) "Norm"(i)'],
  ])("does not read the alias column list of %s as a routine", (_label, statement) => {
    expect(mentionTexts(statement).map((text) => text.toLowerCase())).not.toContain("norm");
    expect(mentionTexts(statement)).not.toContain('"Norm"');
  });

  it.each([
    ["a function source", "SELECT * FROM norm(1)", ["norm"]],
    ["a function source with an alias column list", "SELECT * FROM norm(1) g(i)", ["norm"]],
    ["a LATERAL function source", "SELECT * FROM a, LATERAL norm(a.id) AS t(x)", ["norm"]],
    ["a function source after a comma", "SELECT * FROM a, norm(1)", ["norm"]],
    [
      "a call in the arguments of a source",
      "SELECT * FROM generate_series(1, norm(3)) g(i)",
      ["generate_series", "norm"],
    ],
    ["a call after the FROM list", "SELECT * FROM users u WHERE norm(u.id) > 0", ["norm"]],
    ["a call after IS DISTINCT FROM", "SELECT 1 WHERE a IS DISTINCT FROM norm(x)", ["norm"]],
  ])("keeps the calls of %s", (_label, statement, expected) => {
    expect(mentionTexts(statement)).toEqual(expected);
  });

  it.each([
    ["a hint in parentheses", "SELECT * FROM users (NOLOCK)", "users"],
    ["several hints in parentheses", "SELECT * FROM users (NOLOCK, READPAST)", "users"],
    ["a hint after WITH", "SELECT * FROM users WITH (NOLOCK)", "users"],
    ["a hint after an alias and WITH", "SELECT * FROM users u WITH (NOLOCK)", "users"],
    ["a hint after AS and an alias", "SELECT * FROM users AS u (NOLOCK)", "users"],
    ["a hint on a qualified table", "SELECT * FROM dbo.users (NOLOCK)", "dbo.users"],
    ["a hint on a joined table", "SELECT * FROM a JOIN dbo.orders (NOLOCK) ON a.id = orders.id", "dbo.orders"],
    ["an INDEX hint", "SELECT * FROM dbo.users (INDEX (ix_users))", "dbo.users"],
  ])("does not read %s as a routine call", (_label, statement, name) => {
    expect(mentionTexts(statement)).not.toContain(name);
  });

  it("keeps a call whose arguments are not table hints, even in a FROM list", () => {
    expect(mentionTexts("SELECT * FROM get_users(id)")).toEqual(["get_users"]);
    expect(mentionTexts("SELECT * FROM get_users()")).toEqual(["get_users"]);
  });

  it.each([
    ["a DO block", "DO $$ BEGIN EXECUTE cmd; END $$"],
    [
      "a function",
      "CREATE FUNCTION w() RETURNS int AS $$ DECLARE cmd text; r int; BEGIN EXECUTE cmd INTO r; RETURN r; END $$ LANGUAGE plpgsql",
    ],
    ["a USING clause", "DO $$ BEGIN EXECUTE cmd USING 1, 2; END $$"],
    ["a qualified variable", "DO $$ BEGIN EXECUTE state.cmd; END $$"],
  ])("does not read the command variable of a PL/pgSQL EXECUTE in %s as a routine", (_label, statement) => {
    expect(callMentions(statement)).toEqual([]);
  });

  it.each([
    [
      "a function in the command",
      "DO $$ BEGIN EXECUTE format('SELECT %s', normalize_email(x)); END $$",
      ["format", "normalize_email"],
    ],
    ["a function that builds the command", "DO $$ BEGIN EXECUTE build_command(x); END $$", ["build_command"]],
    [
      "a CALL after an EXECUTE",
      "CREATE PROCEDURE p() LANGUAGE plpgsql AS $$ BEGIN EXECUTE cmd; CALL q(1); END $$",
      ["q"],
    ],
  ])("keeps the calls in %s", (_label, statement, expected) => {
    expect(callMentions(statement).map((call) => call.text)).toEqual(expected);
  });

  it.each([
    ["EXEC in a T-SQL procedure body", "CREATE PROCEDURE dbo.p AS BEGIN EXEC dbo.q 1; END"],
    ["EXECUTE in a T-SQL procedure body", "CREATE PROCEDURE dbo.p AS BEGIN EXECUTE dbo.q @a = 1; END"],
    ["a top-level EXECUTE", "EXECUTE dbo.q @a = 1"],
  ])("keeps the target of %s as a certain call", (_label, statement) => {
    expect(callMentions(statement)).toEqual([{ text: "dbo.q", speculative: false }]);
  });

  it.each([
    ["a T-SQL INSERT without INTO", "INSERT dbo.norm (id) VALUES (1)", "dbo.norm"],
    ["a MySQL INSERT without INTO", "INSERT norm (id) VALUES (1)", "norm"],
    ["a COPY with a column list", "COPY public.norm (id, email) FROM stdin", "public.norm"],
    ["a MySQL INSERT IGNORE", "INSERT IGNORE norm (id) VALUES (1)", "norm"],
    ["a MySQL INSERT with two modifiers", "INSERT LOW_PRIORITY IGNORE dbo.norm (id) VALUES (1)", "dbo.norm"],
    ["a MySQL INSERT DELAYED", "INSERT DELAYED norm (id) VALUES (1)", "norm"],
    ["a T-SQL INSERT TOP", "INSERT TOP (1) dbo.norm (id) VALUES (1)", "dbo.norm"],
    ["a T-SQL INSERT TOP PERCENT", "INSERT TOP (10) PERCENT dbo.norm (id) VALUES (1)", "dbo.norm"],
    ["a T-SQL INSERT TOP with a call in its limit", "INSERT TOP (ABS(1)) dbo.norm (id) VALUES (1)", "dbo.norm"],
    ["a T-SQL INSERT TOP and INTO", "INSERT TOP (1) INTO dbo.norm (id) VALUES (1)", "dbo.norm"],
    ["a MySQL REPLACE", "REPLACE norm (id) VALUES (1)", "norm"],
    ["a MySQL REPLACE with a modifier", "REPLACE LOW_PRIORITY norm (id) VALUES (1)", "norm"],
    ["an INSERT IGNORE in a procedure", "CREATE PROCEDURE p() BEGIN INSERT IGNORE norm (id) VALUES (1); END", "norm"],
  ])("does not read the target of %s as a routine call", (_label, statement, name) => {
    expect(mentionTexts(statement)).not.toContain(name);
  });

  it.each([
    ["INSERT dbo.norm (id) SELECT norm(1)"],
    ["INSERT IGNORE norm (id) SELECT norm(1)"],
    ["INSERT TOP (1) dbo.norm (id) VALUES (norm(1))"],
    ["INSERT LOW_PRIORITY norm (id) VALUES (1), (norm(2))"],
    ["REPLACE norm (id) SELECT norm(1)"],
  ])("keeps the call in the query of %s", (statement) => {
    const starts = findSqlRoutineMentions(statement)
      .filter((mention) => statement.slice(mention.start, mention.end).endsWith("norm"))
      .map((mention) => mention.start);

    // The table before the column list is no call. The one call is the last `norm`.
    expect(starts).toEqual([statement.lastIndexOf("norm")]);
  });

  it.each([
    ["REPLACE as a string function", "SELECT REPLACE(a, 'x', 'y')", "REPLACE"],
    ["INSERT as a string function", "SELECT INSERT('Quadratic', 3, 4, 'What')", "INSERT"],
  ])("keeps %s as a call shape, not a table target", (_label, statement, name) => {
    expect(mentionTexts(statement)).toContain(name);
  });

  it.each([
    ["names without signatures", "DROP FUNCTION f, g", ["drop:callable:f", "drop:callable:g"]],
    ["names with signatures", "DROP FUNCTION f(integer), g(text)", ["drop:callable:f", "drop:callable:g"]],
    [
      "signatures with several arguments",
      "DROP FUNCTION IF EXISTS f(integer, text), g",
      ["drop:callable:f", "drop:callable:g"],
    ],
    ["three names", "DROP ROUTINE a(int), b(int), c", ["drop:callable:a", "drop:callable:b", "drop:callable:c"]],
    [
      "qualified, quoted, and bracketed names",
      'DROP FUNCTION app.f(int), "A b", [dbo].[c]',
      ["drop:callable:app.f", 'drop:callable:"A b"', "drop:callable:[dbo].[c]"],
    ],
    ["a clause after the list", "DROP FUNCTION f(integer), g(text) CASCADE", ["drop:callable:f", "drop:callable:g"]],
    ["T-SQL procedures", "DROP PROCEDURE dbo.p1, dbo.p2", ["drop:callable:dbo.p1", "drop:callable:dbo.p2"]],
    ["T-SQL triggers", "DROP TRIGGER t1, t2", ["drop:trigger:t1", "drop:trigger:t2"]],
    ["a comment inside the list", "DROP FUNCTION f(integer) /* a, b */, g", ["drop:callable:f", "drop:callable:g"]],
    ["GRANT", "GRANT EXECUTE ON FUNCTION f(text), g(text) TO app", ["reference:callable:f", "reference:callable:g"]],
    ["REVOKE", "REVOKE EXECUTE ON FUNCTION f, g FROM app", ["reference:callable:f", "reference:callable:g"]],
  ])("reads every routine in the target list of %s as the same kind of mention", (_label, statement, expected) => {
    expect(describeMentions(statement)).toEqual(expected);
  });

  it.each([
    ["a clause after the only target", "DROP FUNCTION f(integer) CASCADE", ["drop:callable:f"]],
    ["the roles of a GRANT", "GRANT EXECUTE ON FUNCTION f(text) TO a, b", ["reference:callable:f"]],
    ["a comma in a comment string", "COMMENT ON FUNCTION f(text) IS 'a, b'", ["reference:callable:f"]],
    ["the table of a trigger drop", "DROP TRIGGER t ON users", ["drop:trigger:t"]],
    ["ALTER FUNCTION", "ALTER FUNCTION f(int) OWNER TO a", ["reference:callable:f"]],
    [
      "the actions of one ALTER TABLE",
      "ALTER TABLE u DISABLE TRIGGER a, ENABLE TRIGGER b",
      ["reference:trigger:a", "reference:trigger:b"],
    ],
    [
      "another action after ENABLE TRIGGER",
      "ALTER TABLE u ENABLE TRIGGER a, ADD COLUMN x int",
      ["reference:trigger:a"],
    ],
    ["a list of tables", "DROP TABLE a, b", []],
  ])("does not read a name the statement does not list as a routine: %s", (_label, statement, expected) => {
    expect(describeMentions(statement)).toEqual(expected);
  });

  it.each([
    ["right after SELECT", "SELECT call audit_user FROM contacts"],
    ["after a comma", "SELECT id, call audit_user FROM contacts"],
    ["after DISTINCT", "SELECT DISTINCT exec audit_user FROM contacts"],
    ["named EXECUTE", "SELECT execute audit_user FROM contacts"],
    ["in parentheses", "SELECT (call audit_user) FROM contacts"],
    ["in an INSERT query", "INSERT INTO t SELECT call audit_user FROM c"],
    ["after UNION", "SELECT 1 UNION SELECT call audit_user FROM c"],
    ["after SELECT and a block comment", "SELECT /* note */ call audit_user FROM contacts"],
    ["after SELECT and a line comment", "SELECT -- note\n call audit_user FROM contacts"],
    ["after SELECT and two comments", "SELECT /* a */ /* b */ call audit_user FROM contacts"],
    ["after SELECT and a nested comment", "SELECT /* a /* b */ c */ call audit_user FROM contacts"],
    ["after a comma and a block comment", "SELECT id, /* note */ call audit_user FROM contacts"],
    ["after a comma and a line comment", "SELECT id, -- note\n call audit_user FROM contacts"],
    ["after DISTINCT and a comment", "SELECT DISTINCT /* note */ exec audit_user FROM contacts"],
    ["in parentheses after a comment", "SELECT (/* note */ call audit_user) FROM contacts"],
  ])("does not read a column named like CALL as a call: %s", (_label, statement) => {
    expect(callMentions(statement).map((call) => call.text)).not.toContain("audit_user");
  });

  it.each([
    ["a statement start", "CALL audit_user(1)"],
    ["T-SQL EXEC", "EXEC audit_user 1"],
    ["a begin block", "CREATE PROCEDURE w() BEGIN CALL audit_user(); END"],
    ["a THEN branch", "CREATE PROCEDURE w() BEGIN IF x THEN CALL audit_user(); END IF; END"],
    ["a T-SQL batch after a SELECT without a semicolon", "SELECT 1\nEXEC audit_user 1"],
    ["a T-SQL batch after a string", "SELECT 'done'\nEXEC audit_user 1"],
    ["a T-SQL batch after two strings", "SELECT 'a', 'b'\nEXEC audit_user 1"],
    ["a T-SQL IF", "IF @x > 0 EXEC audit_user @x"],
    ["INSERT ... EXEC", "INSERT INTO t EXEC audit_user 1"],
    ["INSERT ... EXEC after a column list", "INSERT INTO t (a) EXEC audit_user 1"],
    ["a MySQL trigger", "CREATE TRIGGER t AFTER INSERT ON u FOR EACH ROW CALL audit_user()"],
    ["a procedure whose body is one statement", "CREATE PROCEDURE dbo.p AS EXEC audit_user"],
    ["a leading comment", "/* note */ CALL audit_user(1)"],
    ["a begin block after a comment", "CREATE PROCEDURE w() BEGIN /* note */ CALL audit_user(); END"],
    ["a T-SQL batch after a string and a comment", "SELECT 'done' /* note */\nEXEC audit_user 1"],
    ["a T-SQL batch after a comment that holds a comma", "SELECT a /* , */\nEXEC audit_user 1"],
    ["a T-SQL batch after a comment that holds SELECT", "SELECT a /* select */\nEXEC audit_user 1"],
    ["a T-SQL batch after a line comment", "SELECT a, b -- note\nEXEC audit_user 1"],
  ])("keeps a CALL or EXEC in %s as a certain call", (_label, statement) => {
    expect(callMentions(statement)).toEqual([{ text: "audit_user", speculative: false }]);
  });

  it.each([
    ["DROP FUNCTION f(text)", true],
    ["DROP /* note */ FUNCTION f(text)", true],
    ["DROP -- note\n PROCEDURE f(text)", true],
    ["DROP /* note */ /* more */ TRIGGER t ON u", true],
    ["DROP /* note */ TABLE f", false],
    ["DROP TABLE f", false],
    ["SELECT 'DROP FUNCTION f'", false],
    ["-- DROP FUNCTION f\nSELECT 1", false],
  ])("tells whether %s drops a routine", (statement, drops) => {
    expect(sqlStatementDropsRoutine(statement)).toBe(drops);
  });

  it("keeps a call in an index expression and does not treat the indexed table as a call", () => {
    expect(mentionTexts("CREATE INDEX ix ON users (normalize_email(email))")).toEqual(["normalize_email"]);
  });

  it.each([
    ["CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql", "callable"],
    ["CREATE OR REPLACE PROCEDURE p() LANGUAGE sql AS $$ SELECT 1 $$", "callable"],
    ["CREATE TRIGGER t BEFORE UPDATE ON u FOR EACH ROW EXECUTE FUNCTION f()", "trigger"],
  ])("puts the routine defined by %s in the %s name space", (statement, namespace) => {
    expect(sqlRoutineDefinitionNamespace(statement)).toBe(namespace);
  });
});

describe("SQL routine sources", () => {
  /** `[name, alias]` for each routine the statement calls as a source, with the name as written. */
  function describeSources(statement: string): Array<[string, string | null]> {
    return findSqlRoutineSources(statement).map(({ mention, alias }) => [
      statement.slice(mention.start, mention.end),
      alias,
    ]);
  }

  it.each([
    ["a function", "SELECT * FROM get_users()", [["get_users", null]]],
    ["a function with an alias", "SELECT * FROM get_users() AS u", [["get_users", "u"]]],
    ["a function with an alias and no AS", "SELECT * FROM get_users() u", [["get_users", "u"]]],
    ["an alias with a column list", "SELECT * FROM get_users() u(id, name)", [["get_users", "u"]]],
    ["WITH ORDINALITY", "SELECT * FROM unnest(a) WITH ORDINALITY AS t(x, n)", [["unnest", "t"]]],
    ["a schema-qualified function", "SELECT * FROM public.get_users(1)", [["public.get_users", null]]],
    ["a JOIN", "SELECT * FROM a JOIN get_users() ON true", [["get_users", null]]],
    ["a LATERAL source", "SELECT * FROM a, LATERAL get_users(a.id) AS l", [["get_users", "l"]]],
    ["a T-SQL APPLY", "SELECT * FROM a CROSS APPLY dbo.fn(a.id) AS f", [["dbo.fn", "f"]]],
    ["a source in a subquery", "SELECT * FROM (SELECT * FROM get_users()) s", [["get_users", null]]],
    [
      "every source of a list",
      "SELECT * FROM a(), b() y, c",
      [
        ["a", null],
        ["b", "y"],
      ],
    ],
    ["a quoted name", 'SELECT * FROM "App"."Get"() AS u', [['"App"."Get"', "u"]]],
  ])("finds the routine of %s", (_label, statement, expected) => {
    expect(describeSources(statement)).toEqual(expected);
  });

  it.each([
    ["a table", "SELECT * FROM users"],
    ["a table with an alias", "SELECT * FROM users u"],
    ["a table with an alias column list", "SELECT * FROM users u(id, name)"],
    ["a table with hints", "SELECT * FROM users (NOLOCK)"],
    ["a table with a WITH hint", "SELECT * FROM users u WITH (NOLOCK)"],
    ["a call in the select list", "SELECT get_users() FROM users"],
    ["a call in a join condition", "SELECT * FROM a JOIN b ON get_users(a.id) = b.id"],
    ["a name in a string", "SELECT 'FROM get_users()'"],
    ["a name in a comment", "SELECT 1 /* FROM get_users() */"],
  ])("finds no routine source in %s", (_label, statement) => {
    expect(describeSources(statement)).toEqual([]);
  });
});
