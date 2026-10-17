import { describe, expect, it } from "vitest";
import { findSqlRoutineMentions, sqlRoutineDefinitionNamespace } from "../src/sql/routine-mentions.js";

/** `kind:namespace:text` for each mention, with the text as written in the statement. */
function describeMentions(statement: string): string[] {
  return findSqlRoutineMentions(statement).map(
    (mention) => `${mention.kind}:${mention.namespace}:${statement.slice(mention.start, mention.end)}`,
  );
}

function mentionTexts(statement: string): string[] {
  return findSqlRoutineMentions(statement).map((mention) => statement.slice(mention.start, mention.end));
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
  ])("does not read %s as a call", (_label, statement) => {
    expect(describeMentions(statement)).not.toContain("call:callable:f");
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
  ])("does not read %s as a routine", (_label, statement, name) => {
    expect(mentionTexts(statement)).not.toContain(name);
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
