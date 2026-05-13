# SQL Artifact Graph Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add useful SQL language support and PR review context without letting stale migrations, historical SQL, or arbitrary application-code strings create false application dependencies.

**Architecture:** Treat SQL as a normal discovered repository language with SQL-specific semantics. Extract file-local statement facts and object mentions, index SQL object symbols, create SQL-to-SQL graph edges, keep every fact tied to source provenance, and bridge SQL to application code only through explicit high-confidence evidence or PR-triggered review context.

**Tech Stack:** TypeScript, native Tree-sitter SQL through `tree-sitter-sequel`, optional JS fallback grammar support, text-based SQL statement facts for native-only/package installs, Vitest, existing Codegraph graph/index/review APIs.

---

## Context

SQL support has a different truth model from normal source languages. A repository may contain one current schema snapshot, a long migration history, obsolete migrations, fixtures, seed data, vendor dumps, ad hoc analytics queries, generated SQL, or all of those at once. A naive extractor is still valuable, but only if its facts are not promoted into the same dependency graph as current application code.

The v1 goal is therefore deliberately narrower than "current schema reconstruction":

- Extract true statement-level facts from every discovered `.sql` file.
- Keep SQL symbols in a SQL namespace while exposing them through normal symbol, go-to-definition, and find-references APIs.
- Include SQL-to-SQL object edges in the normal graph while keeping application-code string literals out of global SQL dependency resolution by default.
- Use SQL facts in PR review only when the changed files or explicit code evidence make them relevant.
- Defer current-schema reconstruction until we can identify trusted schema snapshots or ordered migration streams.

Follow [docs/adding-language-support.md](../../adding-language-support.md), [docs/language-parity.md](../../language-parity.md), and [docs/scenario-catalog.md](../../scenario-catalog.md) for language-support documentation and test coverage.

## Revised Support Surface

Add SQL as a supported repository language with graph-first statement facts.

Initial claims:

- File discovery: `.sql`.
- Parser: Tree-sitter SQL where available.
- Chunking: statement-level chunks plus larger DDL/routine blocks.
- SQL facts: `CREATE TABLE`, `CREATE VIEW`, `CREATE INDEX`, `ALTER TABLE`, `DROP`, `INSERT`, `UPDATE`, `DELETE`, `SELECT`, `JOIN`, routines, triggers, constraints, and foreign keys where syntax is recognized.
- SQL graph: SQL object nodes and edges with source file, line range, statement kind, and extraction confidence.
- Current schema: no default claim.
- Go-to definition: no initial support.
- References: no initial support through existing source-reference APIs.
- PR impact: SQL facts are review context when SQL files changed, SQL literals changed, or an explicit mapping connects code to SQL.

Do add table names from `.sql` files to SQL symbol/navigation support and SQL-to-SQL graph edges. Do not treat every historical SQL object mention as a current schema assertion or application-code dependency.

## Follow-On Practical SQL Navigation Support

Add practical semantic navigation for alias-qualified and table-qualified SQL object references without claiming full column-level schema reconstruction.

Scope:

- Resolve table aliases declared in a statement's `FROM`, `JOIN`, and `USING` clauses.
- When the cursor is on `alias.column`, resolve the alias back to its source SQL object and navigate to that object's table/view definition.
- When the cursor is on `schema.table.column`, resolve the longest known object prefix, such as `schema.table`, and navigate to that object definition.
- When the cursor is on `table.column`, resolve `table` by exact object name first and basename second, using the existing SQL object lookup behavior.
- Include alias-qualified and table-qualified object references in SQL reference results at the statement level.

Non-goals:

- Do not infer a current database schema from migrations, seeds, fixtures, dumps, or unordered SQL history.
- Do not claim that `alias.column` resolves to a specific column declaration.
- Do not model CTE output columns, view output columns, generated columns, or dialect-specific type details in this phase.
- Do not create application-code dependencies from SQL-looking strings.

Example target behavior:

```sql
SELECT *
FROM schema1.table1 t1
JOIN schema2.table2 t2 ON t2.table1_id = t1.id;
```

- Go-to-definition on `t1.id` resolves to the definition of `schema1.table1`.
- Go-to-definition on `t2.table1_id` resolves to the definition of `schema2.table2`.
- Go-to-definition on `schema1.table1.id` resolves to the definition of `schema1.table1`.
- Find-references for `schema1.table1` includes statements that refer to it through `schema1.table1`, `table1`, or an in-statement alias such as `t1`.

## Namespace And Truth Model

Use three SQL truth tiers.

1. `sql_statement_fact`

This is the v1 default. The fact is true because it was extracted from a specific statement in a specific file.

Examples:

- `db/migrate/20190101_create_users.sql` contains a statement that creates `users`.
- `reports/monthly.sql` reads from `orders`.
- `fixtures/legacy.sql` inserts into `archived_users`.

2. `sql_schema_candidate`

This is a grouped candidate derived from one or more statement facts, but it is not asserted as current. It can be used for search and review hints.

Examples:

- Multiple SQL files mention table `users`.
- One migration creates `users`, another alters `users`.
- A query reads from `users` and `organizations`.

3. `sql_current_schema`

Do not create this tier in v1. It is reserved for a later phase with trusted evidence, such as a recognized `schema.sql` snapshot or a verified ordered migration replay.

## File Responsibilities

Create:

- `src/languages/definitions/sql.ts`: Tree-sitter SQL language definition, chunk boundaries, statement capture queries.
- `src/sql/types.ts`: SQL fact, object, edge, namespace, and review trigger types.
- `src/sql/extractFacts.ts`: AST-to-fact extraction from one SQL file.
- `src/sql/classifySqlFile.ts`: lightweight file role tagging for review filtering, not schema truth.
- `src/sql/graph.ts`: SQL fact/candidate graph projection.
- `src/sql/review.ts`: PR review bridge rules.
- `src/sql/index.ts`: internal SQL exports.
- `tests/languages/sql.test.ts`: SQL parser/chunk behavior.
- `tests/sql-fact-extraction.test.ts`: statement fact extraction.
- `tests/sql-artifact-graph.test.ts`: SQL namespace and graph projection.
- `tests/sql-review-context.test.ts`: PR review bridge guardrails.
- `tests/samples/sql/*`: fixture SQL files.

Modify:

- `src/languages/all.ts`: register SQL definition.
- `src/languages.ts`: expose SQL support metadata.
- `src/util/projectFiles.ts`: include `.sql` in default discovery.
- `src/graphs.ts`: include SQL-to-SQL graph edges in normal graph output and detailed SQL fact output when requested.
- `src/index.ts`: export SQL artifact types only if they are part of public API.
- `src/cli.ts`: expose SQL graph output if needed through existing graph/report commands.
- `packages/codegraph-js-fallback/package.json`: add `tree-sitter-sql`.
- `packages/codegraph-native/Cargo.toml`: add native SQL only after compatibility check.
- `packages/codegraph-native/src/languages.rs`: register native SQL only after compatibility check.
- `tests/project-file-discovery.test.ts`: `.sql` discovery.
- `tests/goto.test.ts`: negative SQL source-navigation tests.
- `tests/references.test.ts`: negative SQL source-navigation tests.
- `tests/native-tree-sitter.test.ts`: native SQL smoke only if native SQL is wired.
- `tests/native-parser-ownership.test.ts`: native SQL ownership only if native SQL is wired.
- `docs/language-parity.md`: SQL language support with SQL-specific graph semantics.
- `docs/scenario-catalog.md`: SQL language and PR review scenarios.
- `README.md`: supported file/language summary.
- `docs/cli.md`: CLI output contract if commands change.
- `docs/library-api.md`: public API if SQL facts are exported.
- `codegraph-skill/codegraph/SKILL.md`: agent-facing support surface if CLI or capabilities change.

Use npm package [`tree-sitter-sql`](https://www.npmjs.com/package/tree-sitter-sql). The crates.io package [`tree-sitter-sql`](https://crates.io/crates/tree-sitter-sql) exists but is older, so native support is an implementation-time compatibility check, not a plan assumption.

## Core Types

Implement these as lower-camel schema values if runtime validation is added, matching repo preference.

```ts
export type SqlFileRole =
  | "schema_snapshot"
  | "migration"
  | "seed"
  | "query"
  | "routine"
  | "fixture"
  | "dump"
  | "unknown";

export type SqlFactKind =
  | "defines_table"
  | "defines_view"
  | "defines_index"
  | "defines_constraint"
  | "alters_table"
  | "drops_object"
  | "renames_object"
  | "reads_from"
  | "writes_to"
  | "joins"
  | "references_object"
  | "defines_routine"
  | "unknown_statement";

export type SqlTruthTier =
  | "sql_statement_fact"
  | "sql_schema_candidate";

export type SqlBridgeReason =
  | "changed_sql_file"
  | "changed_sql_literal"
  | "explicit_orm_mapping"
  | "same_pr_object_name";

export interface SqlStatementFact {
  readonly id: string;
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly role: SqlFileRole;
  readonly kind: SqlFactKind;
  readonly objectName: string | null;
  readonly relatedObjectName: string | null;
  readonly statementText: string;
  readonly truthTier: SqlTruthTier;
}
```

## SQL File Role Tags

Role tags are review filters, not schema truth.

Migration indicators:

- Path segments: `migration`, `migrations`, `db/migrate`, `schema/migrations`, `database/migrations`, `alembic/versions`.
- Ordered file names: `001_*.sql`, `0001_*.sql`, `V001__*.sql`, timestamp prefixes such as `20240510120000_*.sql`.
- Migration verbs: `ALTER TABLE`, `CREATE INDEX`, `DROP TABLE`, `DROP COLUMN`, `RENAME`.

Snapshot indicators:

- File names: `schema.sql`, `structure.sql`, `init.sql`, `database.sql`.
- Many `CREATE TABLE` statements.

Seed, fixture, and dump indicators:

- Paths containing `seed`, `seeds`, `fixtures`, `testdata`, `samples`, `dump`, `backup`.
- Mostly `INSERT`, `COPY`, `LOAD DATA`, or vendor dump scaffolding.

Query indicators:

- Mostly `SELECT`, `WITH`, `UPDATE`, `DELETE`, or `INSERT ... SELECT` without schema DDL.
- Paths such as `queries`, `reports`, `analytics`.

Unknown:

- Mixed or unsupported content with no reliable signal.

## Graph Model

Add SQL graph node kinds:

- `sql_file`
- `sql_statement`
- `sql_object_candidate`
- `sql_table_candidate`
- `sql_view_candidate`
- `sql_index_candidate`
- `sql_constraint_candidate`
- `sql_routine_candidate`

Add SQL graph edge kinds:

- `sql_contains_statement`
- `sql_statement_defines`
- `sql_statement_alters`
- `sql_statement_drops`
- `sql_statement_reads`
- `sql_statement_writes`
- `sql_statement_joins`
- `sql_statement_references`
- `sql_candidate_mentions`

All SQL fact/candidate graph nodes must carry SQL namespace metadata. Normal graph builders should include SQL-to-SQL object edges but must not create application-code edges from arbitrary SQL-looking strings.

## Cross-Language Bridge Rules

No global string matching from code to SQL in v1.

Allowed bridge cases:

- A changed application file contains a changed SQL literal that names an SQL object candidate.
- A changed SQL file names an object that also appears in a changed code SQL literal in the same PR.
- A language-specific extractor has an explicit ORM/table mapping, such as a decorator, annotation, or config that is already tested.
- A user or CLI command explicitly requests SQL artifact context.

Blocked bridge cases:

- Linking every table-like identifier in code to every SQL object candidate.
- Treating a historical migration table node as current application dependency.
- Using seed, fixture, dump, or test SQL as review impact evidence unless the PR changed that SQL or explicitly requests it.

## Implementation Steps

### Task 1: Document SQL As Isolated Artifact Support

Files:

- `docs/language-parity.md`
- `docs/scenario-catalog.md`
- `README.md`
- `codegraph-skill/codegraph/SKILL.md`

Changes:

- [ ] Add SQL as a graph-first repository language.
- [ ] State that v1 extracts statement facts, not a current schema.
- [ ] State that SQL symbols participate in SQL navigation while application-code string literals do not become SQL dependencies by default.
- [ ] Add scenarios for changed migration review context, stale migration isolation, seed/fixture filtering, query file extraction, and SQL literal bridge rules.

Verification:

```bash
npx markdownlint-cli2 README.md docs/language-parity.md docs/scenario-catalog.md codegraph-skill/codegraph/SKILL.md
```

If this repo does not have markdownlint installed, inspect the rendered markdown manually and continue.

Commit:

```bash
git add docs/language-parity.md docs/scenario-catalog.md README.md codegraph-skill/codegraph/SKILL.md
git commit -m "docs: define isolated SQL artifact support"
```

### Task 2: Wire SQL Parser And Discovery

Files:

- `src/languages/definitions/sql.ts`
- `src/languages/all.ts`
- `src/languages.ts`
- `src/util/projectFiles.ts`
- `packages/codegraph-js-fallback/package.json`
- `packages/codegraph-native/Cargo.toml`
- `packages/codegraph-native/src/languages.rs`
- `tests/languages/sql.test.ts`
- `tests/project-file-discovery.test.ts`
- `tests/native-tree-sitter.test.ts`
- `tests/native-parser-ownership.test.ts`

Changes:

- [ ] Add `.sql` discovery.
- [ ] Add Tree-sitter SQL fallback dependency.
- [ ] Add SQL language definition with statement chunk boundaries.
- [ ] Add native SQL only if a parser-load test proves the Rust crate works with the native runtime.
- [ ] Document native SQL support and native-only coverage in parity docs.

Tests:

- `supportForFile("schema.sql")` returns SQL support.
- `chunkFile()` or the existing chunk API returns statement-level SQL chunks.
- Native SQL parser test runs only when native SQL is actually wired.

Commands:

```bash
npm install
npx vitest run tests/languages/sql.test.ts tests/project-file-discovery.test.ts
npm run build
```

If native SQL is wired:

```bash
npm run test:native
```

Commit:

```bash
git add src/languages/definitions/sql.ts src/languages/all.ts src/languages.ts src/util/projectFiles.ts packages/codegraph-js-fallback/package.json packages/codegraph-native/Cargo.toml packages/codegraph-native/src/languages.rs tests/languages/sql.test.ts tests/project-file-discovery.test.ts tests/native-tree-sitter.test.ts tests/native-parser-ownership.test.ts package-lock.json
git commit -m "feat: wire SQL artifact parsing"
```

### Task 3: Extract SQL Statement Facts

Files:

- `src/sql/types.ts`
- `src/sql/classifySqlFile.ts`
- `src/sql/extractFacts.ts`
- `src/sql/index.ts`
- `tests/sql-fact-extraction.test.ts`
- `tests/samples/sql/facts/*`

Changes:

- [ ] Extract file role tags.
- [ ] Extract statement facts from one SQL file at a time.
- [ ] Preserve file path, line range, statement text, role, kind, object name, and related object name.
- [ ] Emit `unknown_statement` facts for parsed statements that are unsupported but still useful as review context.
- [ ] Do not infer current schema.

Tests:

- A snapshot-like file emits `defines_table`, `defines_view`, and `defines_index` facts.
- A migration-like file emits `alters_table` and `drops_object` facts without creating current schema nodes.
- A seed file emits `writes_to` facts and role `seed`.
- A query file emits `reads_from` and `joins` facts.
- A dump/fixture file is tagged as `dump` or `fixture` and still preserves statement facts.

Command:

```bash
npx vitest run tests/sql-fact-extraction.test.ts
```

Commit:

```bash
git add src/sql tests/sql-fact-extraction.test.ts tests/samples/sql/facts
git commit -m "feat: extract SQL statement facts"
```

### Task 4: Project SQL Facts Into An Isolated Artifact Graph

Files:

- `src/sql/graph.ts`
- `src/graphs.ts`
- `src/index.ts`
- `tests/sql-artifact-graph.test.ts`
- `tests/samples/sql/graph/*`

Changes:

- [ ] Add SQL graph nodes and edges in a SQL namespace.
- [ ] Group repeated object mentions into `sql_*_candidate` nodes, not current schema nodes.
- [ ] Ensure graph functions include SQL-to-SQL object edges without traversing SQL candidate edges as application-code dependencies.
- [ ] Include provenance on every SQL edge.

Tests:

- A `users` table mentioned in two old migrations becomes a SQL candidate, not a source dependency.
- Query and migration facts are visible in SQL artifact graph output.
- Existing application-code dependency output is unchanged for a fixture repo that also contains stale SQL.

Command:

```bash
npx vitest run tests/sql-artifact-graph.test.ts
```

Commit:

```bash
git add src/sql/graph.ts src/graphs.ts src/index.ts tests/sql-artifact-graph.test.ts tests/samples/sql/graph
git commit -m "feat: add isolated SQL artifact graph"
```

### Task 5: Add PR Review SQL Context Guardrails

Files:

- `src/sql/review.ts`
- `src/review.ts`
- `tests/sql-review-context.test.ts`
- `tests/samples/sql/review/*`
- `docs/scenario-catalog.md`

Changes:

- [ ] Add a review helper that accepts changed file paths and changed line ranges.
- [ ] Include SQL facts when changed files include `.sql`.
- [ ] Include SQL facts when changed code lines contain SQL literals that match SQL object candidates.
- [ ] Include explicit ORM/table mapping bridges only when the language extractor provides tested metadata.
- [ ] Exclude seed, fixture, dump, and historical migration SQL from review impact unless touched by the PR or matched by an allowed bridge.

Tests:

- Changing `src/userRepo.ts` with a modified SQL literal for `users` surfaces SQL candidates for `users`.
- Changing an old unrelated migration does not mark application files as impacted.
- Changing a seed file shows SQL context but does not create source dependency impact.
- A repo containing stale `legacy_users` SQL does not affect a code-only PR unless the PR mentions `legacy_users`.

Command:

```bash
npx vitest run tests/sql-review-context.test.ts
```

Commit:

```bash
git add src/sql/review.ts src/review.ts tests/sql-review-context.test.ts tests/samples/sql/review docs/scenario-catalog.md
git commit -m "feat: add SQL review context guardrails"
```

### Task 6: Add CLI/API Visibility Without Overclaiming

Files:

- `src/cli.ts`
- `docs/cli.md`
- `docs/library-api.md`
- `codegraph-skill/codegraph/SKILL.md`
- `tests/cli.test.ts`

Changes:

- [ ] Surface SQL artifact graph output through existing graph/report commands or a focused SQL artifact flag.
- [ ] Name output fields as SQL facts/candidates, not current schema.
- [ ] Keep `goto`, `refs`, and source dependency commands honest about SQL unsupported behavior.

Tests:

- CLI graph output includes SQL artifact nodes for a SQL fixture.
- CLI review output includes SQL context only for changed SQL or allowed bridge cases.
- Non-SQL CLI output remains stable.

Command:

```bash
npx vitest run tests/cli.test.ts
```

Commit:

```bash
git add src/cli.ts docs/cli.md docs/library-api.md codegraph-skill/codegraph/SKILL.md tests/cli.test.ts
git commit -m "feat: expose SQL artifact graph output"
```

### Task 7: Add Navigation Boundary Tests

Files:

- `tests/goto.test.ts`
- `tests/references.test.ts`
- `tests/native-semantic-parity.test.ts`
- `docs/language-parity.md`
- `docs/scenario-catalog.md`

Changes:

- [ ] Add tests proving SQL objects are normal SQL go-to targets.
- [ ] Add tests proving stale SQL does not create application-code references.
- [ ] Document SQL navigation as part of normal source navigation with SQL-specific limits.

Command:

```bash
npx vitest run tests/goto.test.ts tests/references.test.ts tests/native-semantic-parity.test.ts
```

Commit:

```bash
git add tests/goto.test.ts tests/references.test.ts tests/native-semantic-parity.test.ts docs/language-parity.md docs/scenario-catalog.md
git commit -m "test: lock SQL navigation boundaries"
```

### Task 8: Full Verification

Commands:

```bash
npm run build
npm run test:ci
```

If native SQL is wired:

```bash
npm run test:native
```

Commit final documentation corrections:

```bash
git add README.md docs/language-parity.md docs/scenario-catalog.md docs/cli.md docs/library-api.md codegraph-skill/codegraph/SKILL.md
git commit -m "docs: finalize SQL artifact support"
```

### Task 9: Add Practical SQL Qualified Navigation

Files:

- `src/sql/extractFacts.ts`
- `src/sql/navigation.ts`
- `src/sql/types.ts`
- `tests/sql-fact-extraction.test.ts`
- `tests/goto.test.ts`
- `tests/references.test.ts`
- `docs/language-parity.md`
- `docs/scenario-catalog.md`
- `README.md`
- `codegraph-skill/codegraph/SKILL.md`

Changes:

- [ ] Add an internal statement alias model that records source object aliases from `FROM`, `JOIN`, and `USING` clauses.
- [ ] Teach SQL go-to-definition to resolve `alias.column` through the statement alias map to the aliased table/view object.
- [ ] Teach SQL go-to-definition to resolve `schema.table.column` and `table.column` by longest known SQL object prefix.
- [ ] Teach SQL references to include statements that mention a target object through an alias-qualified use inside the same statement.
- [ ] Keep reference ranges statement-level unless a narrower range is already available from the existing SQL navigation helpers.
- [ ] Document this as object-level practical SQL navigation, not column-definition navigation.

Tests:

- `schema1.table1 t1 JOIN schema2.table2 t2` resolves go-to-definition on `t1.id` to `schema1.table1`.
- The same query resolves go-to-definition on `t2.table1_id` to `schema2.table2`.
- `schema1.table1.id` resolves by longest known prefix to `schema1.table1`.
- `table1.id` resolves by basename only when that matches the existing SQL object lookup behavior.
- Find-references for `schema1.table1` includes statements that refer to it through `schema1.table1`, `table1`, and in-statement alias `t1`.
- Ambiguous aliases and unresolved table prefixes return `not_found` instead of guessing.
- CTE aliases continue to resolve as statement-local query aliases, not schema object definitions.

Commands:

```bash
npx vitest run tests/sql-fact-extraction.test.ts tests/goto.test.ts tests/references.test.ts
npm run lint
npm run build
npm run test:ci
```

Commit:

```bash
git add src/sql tests/sql-fact-extraction.test.ts tests/goto.test.ts tests/references.test.ts docs/language-parity.md docs/scenario-catalog.md README.md codegraph-skill/codegraph/SKILL.md
git commit -m "feat: add practical SQL qualified navigation"
```

## Deferred Phase: Current Schema Reconstruction

Do not include this in v1 implementation.

Add `sql_current_schema` only after a separate plan proves:

- Trusted schema snapshots can be recognized and tested.
- Ordered migration streams can be replayed with stable ordering.
- Dropped and renamed objects can be tombstoned rather than erased.
- Ambiguous or incomplete migration history does not produce current-schema claims.
- PR review can distinguish historical migration facts from current schema.

## Acceptance Criteria

- `.sql` files are discovered by default.
- SQL facts preserve source file provenance, statement line ranges, file role, object names, and fact kind.
- SQL nodes live in a SQL namespace, participate in SQL-to-SQL graph resolution, and do not create application-code dependencies by default.
- Stale migrations and fixture SQL do not create application impact in a code-only PR.
- SQL review context appears when SQL files are touched or explicit bridge evidence exists.
- Docs describe SQL as artifact/fact support, not current-schema support.
- Tests cover stale migration isolation, seed/fixture filtering, changed SQL files, changed SQL literals, and navigation boundaries.
- Practical SQL qualified navigation resolves alias-qualified and table-qualified object references to table/view definitions without claiming column-definition semantics.

## Risks

- SQL dialect differences may exceed generic Tree-sitter extraction. Mitigation: extract common DDL/DML first and preserve unsupported statements as `unknown_statement` facts.
- Native Rust grammar compatibility may lag npm support. Mitigation: make native SQL a tested capability, not an assumption.
- SQL object candidates may look like current schema. Mitigation: naming, docs, and tests must use "candidate" and "statement fact" language.
- Review context can become noisy. Mitigation: bridge SQL into review only when changed files or explicit mappings justify it.
- Alias-qualified SQL navigation can over-resolve if aliases are parsed outside their statement scope. Mitigation: build aliases per statement, prefer exact object names, and return `not_found` for ambiguous or unresolved prefixes.

## References

- [Language support checklist](../../adding-language-support.md)
- [Language parity matrix](../../language-parity.md)
- [Scenario catalog](../../scenario-catalog.md)
- [`tree-sitter-sql` on npm](https://www.npmjs.com/package/tree-sitter-sql)
- [`tree-sitter-sql` on crates.io](https://crates.io/crates/tree-sitter-sql)
