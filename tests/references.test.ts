import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import * as indexer from "../src/indexer.js";
import * as scopeModule from "../src/indexer/scope.js";
import {
  buildIndexedCandidateCoverage,
  describeReferenceStrategies,
  getCachedReferenceCandidateFiles,
  REFERENCE_COVERAGE_REASON_ORDER,
} from "../src/indexer/navigation-references.js";
import { findUsageReferences } from "../src/indexer/navigation.js";
import type { ProjectIndex } from "../src/index.js";
import { createReferenceLookupCache } from "../src/impact/reference-cache.js";
import { fileIdentityKey } from "../src/util/paths.js";
import {
  createTestIndex,
  createTestIndexFromFiles,
  testFindReferences,
  createTestIndexFromPath,
} from "./test-utils.js";

function expectReferenceAt(result: Awaited<ReturnType<typeof testFindReferences>>, file: string, line: number): void {
  if (result.status !== "ok") {
    return;
  }
  expect(result.references.some((reference) => reference.file === file && reference.range.start.line === line)).toBe(
    true,
  );
}

function tokenColumn(line: string, token: string, occurrence = 0): number {
  let fromIndex = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    const found = line.indexOf(token, fromIndex);
    if (found < 0) {
      throw new Error(`Expected token ${token} in ${line}`);
    }
    if (index === occurrence) return found + 1;
    fromIndex = found + token.length;
  }
  throw new Error(`Expected token ${token} in ${line}`);
}

function uniqueReferenceSiteCount(result: Awaited<ReturnType<typeof testFindReferences>>): number {
  if (result.status !== "ok") return 0;
  return new Set(
    result.references.map(
      (reference) =>
        `${reference.file}:${reference.range.start.line}:${reference.range.start.column}:${reference.range.start.index}:${reference.range.end.line}:${reference.range.end.column}:${reference.range.end.index}`,
    ),
  ).size;
}

function findReferenceSite(
  result: Awaited<ReturnType<typeof testFindReferences>>,
  file: string,
  line: number,
  column: number,
) {
  if (result.status !== "ok") return undefined;
  return result.references.find(
    (reference) =>
      reference.file === file && reference.range.start.line === line && reference.range.start.column === column,
  );
}

function markCandidateParserDegraded(index: indexer.ProjectIndex, file: string): void {
  const native = index.buildReport?.backend?.native ?? {
    available: false,
    enabled: false,
    supportedLanguageIds: [],
    filesUsed: 0,
    filesFellBack: 0,
    fallbackReasons: { unavailable: 0, unsupportedLanguage: 0, queryFailure: 0, sourceTooLarge: 0 },
    byLanguage: {},
    errors: [],
  };
  index.buildReport = {
    timings: index.buildReport?.timings ?? {},
    ...index.buildReport,
    backend: {
      native,
      parser: {
        total: 1,
        byLanguage: { typescript: 1 },
        files: [{ file, languageId: "typescript" }],
      },
    },
  };
}

describe("Find References", () => {
  it("narrows candidate files to importers that can resolve the definition", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-reference-candidates-"));
    try {
      const aFile = path.join(root, "a.ts").replace(/\\/g, "/");
      const bFile = path.join(root, "b.ts").replace(/\\/g, "/");
      const cFile = path.join(root, "c.ts").replace(/\\/g, "/");
      const dFile = path.join(root, "d.ts").replace(/\\/g, "/");
      const otherFile = path.join(root, "other.ts").replace(/\\/g, "/");

      await fsp.writeFile(aFile, "export function target() { return 1; }\n", "utf8");
      await fsp.writeFile(bFile, 'export { target } from "./a";\n', "utf8");
      await fsp.writeFile(cFile, 'import { target } from "./b";\ntarget();\n', "utf8");
      await fsp.writeFile(dFile, 'import { other } from "./other";\nother();\n', "utf8");
      await fsp.writeFile(otherFile, "export function other() { return 2; }\n", "utf8");

      const index = await createTestIndexFromFiles(root, [aFile, bFile, cFile, dFile, otherFile]);
      const def = index.byFile.get(fileIdentityKey(aFile))?.locals.find((local) => local.localName === "target");
      if (!def) throw new Error("Expected target definition");

      const candidates = getCachedReferenceCandidateFiles(index, def, ["target"], false);

      expect(candidates).toContain(cFile);
      expect(candidates).not.toContain(dFile);
      expect(candidates).not.toContain(otherFile);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("labels re-export declarations and preserves the label through the reference cache", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-reexport-reference-"));
    try {
      const sourceFile = path.join(root, "source.ts").replace(/\\/g, "/");
      const barrelFile = path.join(root, "barrel.ts").replace(/\\/g, "/");
      const consumerFile = path.join(root, "consumer.ts").replace(/\\/g, "/");
      await fsp.writeFile(sourceFile, "export const target = 1;\n", "utf8");
      await fsp.writeFile(barrelFile, 'export { target } from "./source";\n', "utf8");
      await fsp.writeFile(consumerFile, 'import { target } from "./barrel";\ntarget;\n', "utf8");

      const index = await createTestIndexFromFiles(root, [sourceFile, barrelFile, consumerFile]);
      const def = index.byFile.get(fileIdentityKey(sourceFile))?.locals.find((local) => local.localName === "target");
      if (!def) throw new Error("Expected target definition");

      const cache = createReferenceLookupCache();
      expect(getCachedReferenceCandidateFiles(index, def, ["target"], false)).toContain(barrelFile);
      const cold = await cache.get(index, def);
      const warm = await cache.get(index, def);

      expect(cold.status).toBe("ok");
      expect(warm.status).toBe("ok");
      if (cold.status !== "ok" || warm.status !== "ok") return;

      const expectedReexport = expect.objectContaining({
        file: barrelFile,
        range: expect.objectContaining({ start: expect.objectContaining({ line: 1 }) }),
        via: { reexport: true },
      });
      expect(cold.references).toContainEqual(expectedReexport);
      expect(warm.references).toContainEqual(expectedReexport);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("applies usage bounds after excluding re-export declarations", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-reexport-usage-bound-"));
    try {
      const sourceFile = path.join(root, "source.ts").replace(/\\/g, "/");
      const consumerFile = path.join(root, "consumer.ts").replace(/\\/g, "/");
      await fsp.writeFile(sourceFile, "export function target() { return 1; }\n", "utf8");
      await fsp.writeFile(
        consumerFile,
        [
          'export { target as first } from "./source";',
          'export { target as second } from "./source";',
          'import { target } from "./source";',
          "target();",
          "",
        ].join("\n"),
        "utf8",
      );
      const index = await createTestIndexFromFiles(root, [sourceFile, consumerFile]);
      const def = index.byFile.get(fileIdentityKey(sourceFile))?.locals.find((local) => local.localName === "target");
      if (!def) throw new Error("Expected target definition");

      const result = await findUsageReferences(index, { def }, { maxReferences: 1 });

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.references).toEqual([
        expect.objectContaining({
          file: consumerFile,
          range: expect.objectContaining({ start: expect.objectContaining({ line: 4 }) }),
        }),
      ]);
      expect(result.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
  it("labels path-alias re-export declarations", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-path-alias-reexport-reference-"));
    try {
      const sourceFile = path.join(root, "src", "mod.ts").replace(/\\/g, "/");
      const barrelFile = path.join(root, "barrel.ts").replace(/\\/g, "/");
      const consumerFile = path.join(root, "consumer.ts").replace(/\\/g, "/");
      await fsp.mkdir(path.dirname(sourceFile), { recursive: true });
      await fsp.writeFile(
        path.join(root, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@scope/*": ["src/*"] } } }),
        "utf8",
      );
      await fsp.writeFile(sourceFile, "export const target = 1;\n", "utf8");
      for (const name of ["unrelatedOne", "unrelatedTwo", "unrelatedThree"]) {
        await fsp.writeFile(path.join(root, "src", `${name}.ts`), `export const ${name} = 1;\n`, "utf8");
      }
      await fsp.writeFile(
        barrelFile,
        [
          'export { target } from "@scope/mod";',
          'export { unrelatedOne } from "@scope/unrelatedOne";',
          'export { unrelatedTwo } from "@scope/unrelatedTwo";',
          'export { unrelatedThree } from "@scope/unrelatedThree";',
        ].join("\n"),
        "utf8",
      );
      await fsp.writeFile(consumerFile, 'import { target } from "./barrel";\ntarget;\n', "utf8");

      const index = await createTestIndexFromPath(root);
      const def = index.byFile.get(fileIdentityKey(sourceFile))?.locals.find((local) => local.localName === "target");
      if (!def) throw new Error("Expected target definition");

      const result = await createReferenceLookupCache().get(index, def);

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.references).toContainEqual(
        expect.objectContaining({
          file: barrelFile,
          range: expect.objectContaining({ start: expect.objectContaining({ line: 1 }) }),
          via: { reexport: true },
        }),
      );
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  describe("SQL", () => {
    it("finds SQL object references across SQL files", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "sql", "graph");
      const schemaFile = path.join(samplePath, "001_create_users.sql").replace(/\\/g, "/");
      const alterFile = path.join(samplePath, "002_alter_users.sql").replace(/\\/g, "/");
      const reportFile = path.join(samplePath, "report.sql").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [schemaFile, alterFile, reportFile]);

      const result = await testFindReferences(index, schemaFile, 1, 16, [
        { file: schemaFile, line: 1, column: 14 },
        { file: alterFile, line: 1, column: 13 },
        { file: reportFile, line: 1, column: 23 },
      ]);

      expect(result.status).toBe("ok");
      expectReferenceAt(result, schemaFile, 1);
      expectReferenceAt(result, alterFile, 1);
      expectReferenceAt(result, reportFile, 1);
      if (result.status === "ok") {
        expect(result.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
      }
    });

    it("reuses SQL source and fact caches across repeated reference lookups", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "sql", "graph");
      const schemaFile = path.join(samplePath, "001_create_users.sql").replace(/\\/g, "/");
      const alterFile = path.join(samplePath, "002_alter_users.sql").replace(/\\/g, "/");
      const reportFile = path.join(samplePath, "report.sql").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [schemaFile, alterFile, reportFile]);
      delete index.parsed;

      await testFindReferences(index, schemaFile, 1, 16, 3);
      const cachedFacts = new Map(index.sqlNavigation?.factsByFile);
      const cachedSources = new Map(index.sqlNavigation?.sourceByFile);

      await testFindReferences(index, schemaFile, 1, 16, 3);

      expect(index.sqlNavigation?.factsByFile.size).toBe(3);
      expect(index.sqlNavigation?.sourceByFile.size).toBe(3);
      expect(index.sqlNavigation?.factsByFile.get(schemaFile)).toBe(cachedFacts.get(schemaFile));
      expect(index.sqlNavigation?.factsByFile.get(alterFile)).toBe(cachedFacts.get(alterFile));
      expect(index.sqlNavigation?.factsByFile.get(reportFile)).toBe(cachedFacts.get(reportFile));
      expect(index.sqlNavigation?.sourceByFile.get(schemaFile)).toBe(cachedSources.get(schemaFile));
      expect(index.sqlNavigation?.sourceByFile.get(alterFile)).toBe(cachedSources.get(alterFile));
      expect(index.sqlNavigation?.sourceByFile.get(reportFile)).toBe(cachedSources.get(reportFile));
    });

    it("finds schema-qualified SQL object references", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "sql", "graph");
      const schemaFile = path.join(samplePath, "qualified_schema.sql").replace(/\\/g, "/");
      const reportFile = path.join(samplePath, "qualified_report.sql").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [schemaFile, reportFile]);

      const result = await testFindReferences(index, schemaFile, 1, 22, [
        { file: schemaFile, line: 1, column: 14 },
        { file: reportFile, line: 1, column: 16 },
      ]);

      expect(result.status).toBe("ok");
      expectReferenceAt(result, schemaFile, 1);
      expectReferenceAt(result, reportFile, 1);
    });

    it("finds schema-qualified SQL references to unqualified definitions", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sql-qualified-to-unqualified-refs-"));
      try {
        const schemaFile = path.join(root, "schema.sql").replace(/\\/g, "/");
        const reportFile = path.join(root, "report.sql").replace(/\\/g, "/");
        await fsp.writeFile(schemaFile, "CREATE TABLE users (id integer);\n", "utf8");
        await fsp.writeFile(reportFile, "SELECT id FROM public.users;\n", "utf8");
        const index = await createTestIndexFromFiles(root, [schemaFile, reportFile]);

        const result = await testFindReferences(index, schemaFile, 1, 16, [
          { file: schemaFile, line: 1, column: 14 },
          { file: reportFile, line: 1, column: 16 },
        ]);

        expect(result.status).toBe("ok");
        expectReferenceAt(result, schemaFile, 1);
        expectReferenceAt(result, reportFile, 1);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("finds unqualified SQL references to schema-qualified definitions", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "sql", "graph");
      const schemaFile = path.join(samplePath, "qualified_schema.sql").replace(/\\/g, "/");
      const reportFile = path.join(samplePath, "report.sql").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [schemaFile, reportFile]);

      const result = await testFindReferences(index, schemaFile, 1, 22, 2);

      expect(result.status).toBe("ok");
      expectReferenceAt(result, schemaFile, 1);
      expectReferenceAt(result, reportFile, 1);
    });

    it("uses basename fallback only for unambiguous SQL definitions and returns token ranges", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sql-schema-reference-"));
      try {
        const schemaFile = path.join(root, "schema.sql").replace(/\\/g, "/");
        const reportFile = path.join(root, "report.sql").replace(/\\/g, "/");
        const schemaLines = [
          "CREATE TABLE schema1.users (id integer);",
          "CREATE TABLE schema2.users (id integer);",
          "CREATE TABLE schema3.audit_users (id integer);",
        ];
        const reportLines = [
          "SELECT id FROM schema1.users;",
          "SELECT id FROM schema2.users;",
          "SELECT id FROM users;",
          "  SELECT id FROM audit_users;",
        ];
        await fsp.writeFile(schemaFile, schemaLines.join("\n"), "utf8");
        await fsp.writeFile(reportFile, reportLines.join("\n"), "utf8");
        const index = await createTestIndexFromFiles(root, [schemaFile, reportFile]);

        const schema1Result = await testFindReferences(
          index,
          schemaFile,
          1,
          schemaLines[0]!.indexOf("schema1.users") + 1,
          2,
        );
        const auditUsersResult = await testFindReferences(
          index,
          schemaFile,
          3,
          schemaLines[2]!.indexOf("schema3.audit_users") + 1,
          2,
        );

        expect(schema1Result.status).toBe("ok");
        if (schema1Result.status === "ok") {
          const reportReferences = schema1Result.references.filter((reference) => reference.file === reportFile);
          expect(reportReferences).toEqual([
            expect.objectContaining({
              range: expect.objectContaining({
                start: expect.objectContaining({
                  line: 1,
                  column: reportLines[0]!.indexOf("schema1.users") + 1,
                }),
              }),
            }),
          ]);
        }

        expect(auditUsersResult.status).toBe("ok");
        if (auditUsersResult.status === "ok") {
          expect(auditUsersResult.references).toContainEqual(
            expect.objectContaining({
              file: reportFile,
              range: {
                start: { line: 4, column: reportLines[3]!.indexOf("audit_users") + 1 },
                end: { line: 4, column: reportLines[3]!.indexOf("audit_users") + "audit_users".length + 1 },
              },
            }),
          );
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("does not conflate quoted SQL identifiers with different case", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sql-quoted-reference-"));
      try {
        const schemaFile = path.join(root, "schema.sql").replace(/\\/g, "/");
        const reportFile = path.join(root, "report.sql").replace(/\\/g, "/");
        const schemaLines = ['CREATE TABLE "Users" (id integer);', 'CREATE TABLE "users" (id integer);'];
        const reportLines = ['SELECT id FROM "Users";', 'SELECT id FROM "users";'];
        await fsp.writeFile(schemaFile, schemaLines.join("\n"), "utf8");
        await fsp.writeFile(reportFile, reportLines.join("\n"), "utf8");
        const index = await createTestIndexFromFiles(root, [schemaFile, reportFile]);

        const upperCaseResult = await testFindReferences(
          index,
          schemaFile,
          1,
          schemaLines[0]!.indexOf('"Users"') + 1,
          2,
        );

        expect(upperCaseResult.status).toBe("ok");
        if (upperCaseResult.status === "ok") {
          expect(upperCaseResult.references).toContainEqual(
            expect.objectContaining({
              file: reportFile,
              range: expect.objectContaining({ start: expect.objectContaining({ line: 1 }) }),
            }),
          );
          expect(
            upperCaseResult.references.some(
              (reference) => reference.file === reportFile && reference.range.start.line === 2,
            ),
          ).toBe(false);
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("finds alias-qualified and table-qualified SQL object references", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sql-qualified-refs-"));
      try {
        const schemaFile = path.join(root, "schema.sql").replace(/\\/g, "/");
        const reportFile = path.join(root, "report.sql").replace(/\\/g, "/");
        await fsp.writeFile(
          schemaFile,
          [
            "CREATE TABLE schema1.table1 (id integer primary key);",
            "CREATE TABLE schema2.table2 (table1_id integer not null);",
          ].join("\n"),
          "utf8",
        );
        const queryLines = [
          "SELECT *",
          "FROM schema1.table1 t1",
          "JOIN schema2.table2 t2 ON t2.table1_id = t1.id;",
          "SELECT schema1.table1.id FROM schema1.table1;",
          "SELECT table1.id FROM schema1.table1;",
        ];
        await fsp.writeFile(reportFile, queryLines.join("\n"), "utf8");
        const index = await createTestIndexFromFiles(root, [schemaFile, reportFile]);

        const table1Result = await testFindReferences(index, schemaFile, 1, 22, 2);
        const table2Result = await testFindReferences(index, schemaFile, 2, 22, 2);
        const aliasResult = await testFindReferences(index, reportFile, 3, queryLines[2].indexOf("t1.id") + 1, 2);

        expect(table1Result.status).toBe("ok");
        expect(table2Result.status).toBe("ok");
        expectReferenceAt(table1Result, reportFile, 3);
        expectReferenceAt(table1Result, reportFile, 4);
        expectReferenceAt(table1Result, reportFile, 5);
        expectReferenceAt(table2Result, reportFile, 3);
        expectReferenceAt(aliasResult, schemaFile, 1);
        expectReferenceAt(aliasResult, reportFile, 3);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("reports SQL qualified-reference columns from indented statement starts", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sql-indented-ref-columns-"));
      try {
        const schemaFile = path.join(root, "schema.sql").replace(/\\/g, "/");
        const reportFile = path.join(root, "report.sql").replace(/\\/g, "/");
        await fsp.writeFile(schemaFile, "CREATE TABLE schema1.table1 (id integer primary key);\n", "utf8");
        const query = "  SELECT schema1.table1.id FROM schema1.table1;\n";
        await fsp.writeFile(reportFile, query, "utf8");
        const index = await createTestIndexFromFiles(root, [schemaFile, reportFile]);

        const result = await testFindReferences(index, schemaFile, 1, 22, 2);

        expect(result.status).toBe("ok");
        if (result.status === "ok") {
          expect(result.references).toContainEqual(
            expect.objectContaining({
              file: reportFile,
              range: expect.objectContaining({
                start: expect.objectContaining({
                  line: 1,
                  column: query.indexOf("schema1.table1.id") + 1,
                }),
              }),
            }),
          );
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("does not include ambiguous table-qualified basename references", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sql-ambiguous-basename-refs-"));
      try {
        const schemaFile = path.join(root, "schema.sql").replace(/\\/g, "/");
        const reportFile = path.join(root, "report.sql").replace(/\\/g, "/");
        await fsp.writeFile(
          schemaFile,
          ["CREATE TABLE schema1.table1 (id integer);", "CREATE TABLE schema2.table1 (id integer);"].join("\n"),
          "utf8",
        );
        await fsp.writeFile(reportFile, "SELECT table1.id;\n", "utf8");
        const index = await createTestIndexFromFiles(root, [schemaFile, reportFile]);

        const schema1Result = await testFindReferences(index, schemaFile, 1, 22, 1);
        const schema2Result = await testFindReferences(index, schemaFile, 2, 22, 1);

        expect(schema1Result.status).toBe("ok");
        expect(schema2Result.status).toBe("ok");
        if (schema1Result.status === "ok") {
          expect(schema1Result.references.some((reference) => reference.file === reportFile)).toBe(false);
        }
        if (schema2Result.status === "ok") {
          expect(schema2Result.references.some((reference) => reference.file === reportFile)).toBe(false);
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("does not include CTE-qualified column references as schema object references", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sql-cte-qualified-refs-"));
      try {
        const schemaFile = path.join(root, "schema.sql").replace(/\\/g, "/");
        const reportFile = path.join(root, "report.sql").replace(/\\/g, "/");
        await fsp.writeFile(
          schemaFile,
          ["CREATE TABLE schema1.table1 (id integer);", "CREATE TABLE recent_users (id integer);"].join("\n"),
          "utf8",
        );
        await fsp.writeFile(
          reportFile,
          ["WITH recent_users AS (SELECT id FROM schema1.table1)", "SELECT recent_users.id FROM recent_users;"].join(
            "\n",
          ),
          "utf8",
        );
        const index = await createTestIndexFromFiles(root, [schemaFile, reportFile]);

        const result = await testFindReferences(index, schemaFile, 2, 15, 1);

        expect(result.status).toBe("ok");
        if (result.status === "ok") {
          expect(result.references.some((reference) => reference.file === reportFile)).toBe(false);
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("does not include dotted SQL object text inside string literals as references", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sql-string-literal-refs-"));
      try {
        const schemaFile = path.join(root, "schema.sql").replace(/\\/g, "/");
        const reportFile = path.join(root, "report.sql").replace(/\\/g, "/");
        await fsp.writeFile(schemaFile, "CREATE TABLE schema1.table1 (id integer);\n", "utf8");
        await fsp.writeFile(reportFile, "SELECT 'schema1.table1.id';\n", "utf8");
        const index = await createTestIndexFromFiles(root, [schemaFile, reportFile]);

        const result = await testFindReferences(index, schemaFile, 1, 22, 1);

        expect(result.status).toBe("ok");
        if (result.status === "ok") {
          expect(result.references.some((reference) => reference.file === reportFile)).toBe(false);
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("keeps complete SQL coverage with the existing definition reference", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sql-unused-coverage-"));
      try {
        const schemaFile = path.join(root, "schema.sql").replace(/\\/g, "/");
        await fsp.writeFile(schemaFile, "CREATE TABLE unused_table (id integer);\n", "utf8");
        const index = await createTestIndexFromFiles(root, [schemaFile]);
        const result = await indexer.findReferences(index, { file: schemaFile, line: 1, column: 16 });
        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        expect(result.references).toHaveLength(1);
        expect(result.references[0]?.file).toBe(schemaFile);
        expect(result.references[0]?.range.start.line).toBe(1);
        expect(result.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });
    it("excludes SQL definitions and applies limits to usage-only reference scans", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sql-usage-bound-"));
      try {
        const schemaFile = path.join(root, "schema.sql").replace(/\\/g, "/");
        const reportFile = path.join(root, "report.sql").replace(/\\/g, "/");
        await fsp.writeFile(schemaFile, "CREATE TABLE users (id integer);\n", "utf8");
        await fsp.writeFile(reportFile, "SELECT id FROM users;\nSELECT count(*) FROM users;\n", "utf8");
        const index = await createTestIndexFromFiles(root, [schemaFile, reportFile]);

        const result = await findUsageReferences(
          index,
          { file: schemaFile, line: 1, column: 16 },
          { maxReferences: 1 },
        );

        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        expect(result.references).toHaveLength(1);
        expect(result.references[0]?.file).toBe(reportFile);
        expect(result.references.some((reference) => reference.file === schemaFile)).toBe(false);
        expect(result.referenceCoverage).toEqual({
          scope: "indexed_candidates",
          state: "partial",
          reasons: ["truncated"],
        });
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("marks a parser-degraded SQL candidate file as partial coverage", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sql-degraded-coverage-"));
      try {
        const schemaFile = path.join(root, "schema.sql").replace(/\\/g, "/");
        const reportFile = path.join(root, "report.sql").replace(/\\/g, "/");
        await fsp.writeFile(schemaFile, "CREATE TABLE users (id integer);\n", "utf8");
        await fsp.writeFile(reportFile, "SELECT id FROM users;\n", "utf8");
        const index = await createTestIndexFromFiles(root, [schemaFile, reportFile]);
        markCandidateParserDegraded(index, reportFile);
        const result = await indexer.findReferences(index, { file: schemaFile, line: 1, column: 16 });
        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        expectReferenceAt(result, schemaFile, 1);
        expect(result.referenceCoverage.state).toBe("partial");
        expect(result.referenceCoverage.reasons).toEqual(["parser_degraded"]);
        expect(result.referenceCoverage.affectedFiles).toEqual([reportFile]);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });
  });

  describe("TypeScript enum references", () => {
    it("finds references to exported enum declarations", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ts-enum-refs-"));
      try {
        const typesFile = path.join(root, "types.ts").replace(/\\/g, "/");
        const consumerFile = path.join(root, "consumer.ts").replace(/\\/g, "/");
        await fsp.writeFile(typesFile, "export enum Mode {\n  Light,\n  Dark,\n}\n", "utf8");
        await fsp.writeFile(
          consumerFile,
          ['import { Mode } from "./types";', "const selected = Mode.Light;", ""].join("\n"),
          "utf8",
        );
        const index = await createTestIndexFromFiles(root, [typesFile, consumerFile]);

        const importedColumn = tokenColumn('import { Mode } from "./types";', "Mode");
        const useColumn = tokenColumn("const selected = Mode.Light;", "Mode");
        const result = await testFindReferences(index, typesFile, 1, 13, [
          { file: typesFile, line: 1, column: 13 },
          { file: consumerFile, line: 1, column: importedColumn },
          { file: consumerFile, line: 2, column: useColumn },
        ]);

        expect(result.status).toBe("ok");
        expectReferenceAt(result, typesFile, 1);
        expectReferenceAt(result, consumerFile, 1);
        expectReferenceAt(result, consumerFile, 2);
        if (result.status === "ok") {
          const imported = result.references.find(
            (reference) => reference.file === consumerFile && reference.range.start.line === 1,
          );
          expect(imported?.via?.importBinding).toBe("imported");
          expect(imported?.via?.import).toBeDefined();
          expect(result.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });
    it("includes receiver-scan files in parser-degradation coverage", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ts-enum-member-coverage-"));
      try {
        const typesFile = path.join(root, "types.ts").replace(/\\/g, "/");
        const barrelFile = path.join(root, "barrel.ts").replace(/\\/g, "/");
        const consumerFile = path.join(root, "consumer.ts").replace(/\\/g, "/");
        await fsp.writeFile(typesFile, "export enum Mode {\n  Light,\n}\n", "utf8");
        await fsp.writeFile(barrelFile, 'export { Mode } from "./types";\n', "utf8");
        await fsp.writeFile(
          consumerFile,
          ['import { Mode } from "./barrel";', "const selected = Mode.Light;", ""].join("\n"),
          "utf8",
        );
        const index = await createTestIndexFromFiles(root, [typesFile, barrelFile, consumerFile]);
        const def = index.byFile.get(fileIdentityKey(typesFile))?.locals.find((local) => local.localName === "Light");
        if (!def) throw new Error("Expected enum member definition");
        expect(getCachedReferenceCandidateFiles(index, def, [], false)).not.toContain(consumerFile);
        markCandidateParserDegraded(index, consumerFile);

        const result = await indexer.findReferences(index, { def });

        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        expectReferenceAt(result, consumerFile, 2);
        expect(result.referenceCoverage.state).toBe("partial");
        expect(result.referenceCoverage.reasons).toEqual(["parser_degraded"]);
        expect(result.referenceCoverage.affectedFiles).toEqual([consumerFile]);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });
  });

  describe("import binding references and coverage", () => {
    it("counts a generic unused named import as an imported reference", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-import-only-refs-"));
      try {
        const sourceFile = path.join(root, "source.ts").replace(/\\/g, "/");
        const consumerFile = path.join(root, "consumer.ts").replace(/\\/g, "/");
        await fsp.writeFile(sourceFile, "export function target() { return 1; }\n", "utf8");
        const consumerSource = 'import { target } from "./source";\n';
        await fsp.writeFile(consumerFile, consumerSource, "utf8");
        const index = await createTestIndexFromFiles(root, [sourceFile, consumerFile]);
        const importedColumn = tokenColumn('import { target } from "./source";', "target");
        const result = await testFindReferences(index, sourceFile, 1, 17, [
          { file: sourceFile, line: 1, column: 17 },
          { file: consumerFile, line: 1, column: importedColumn },
        ]);
        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        const imported = result.references.find((reference) => reference.file === consumerFile);
        expect(imported?.via?.importBinding).toBe("imported");
        expect(imported?.via?.import).toBeDefined();
        expect(result.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("returns imported and local tokens for an aliased named import", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-import-alias-refs-"));
      try {
        const sourceFile = path.join(root, "source.ts").replace(/\\/g, "/");
        const consumerFile = path.join(root, "consumer.ts").replace(/\\/g, "/");
        await fsp.writeFile(sourceFile, "export function target() { return 1; }\n", "utf8");
        const importLine = 'import { target as localTarget } from "./source";';
        await fsp.writeFile(consumerFile, [importLine, "localTarget();", ""].join("\n"), "utf8");
        const index = await createTestIndexFromFiles(root, [sourceFile, consumerFile]);
        const importedColumn = tokenColumn(importLine, "target");
        const localColumn = tokenColumn(importLine, "localTarget");
        const useColumn = tokenColumn("localTarget();", "localTarget");
        const result = await testFindReferences(index, sourceFile, 1, 17, [
          { file: sourceFile, line: 1, column: 17 },
          { file: consumerFile, line: 1, column: importedColumn },
          { file: consumerFile, line: 1, column: localColumn },
          { file: consumerFile, line: 2, column: useColumn },
        ]);
        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        const imported = result.references.find(
          (reference) =>
            reference.file === consumerFile &&
            reference.range.start.line === 1 &&
            reference.range.start.column === importedColumn,
        );
        const local = result.references.find(
          (reference) =>
            reference.file === consumerFile &&
            reference.range.start.line === 1 &&
            reference.range.start.column === localColumn,
        );
        const use = result.references.find(
          (reference) => reference.file === consumerFile && reference.range.start.line === 2,
        );
        expect(imported?.via?.importBinding).toBe("imported");
        expect(local?.via?.importBinding).toBe("local");
        expect(use?.via?.import).toBeDefined();
        expect(use?.via?.importBinding).toBeUndefined();
        expect(uniqueReferenceSiteCount(result)).toBe(result.references.length);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("returns the imported token for a type-only import and its type uses", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-import-type-only-refs-"));
      try {
        const typesFile = path.join(root, "types.ts").replace(/\\/g, "/");
        const consumerFile = path.join(root, "consumer.ts").replace(/\\/g, "/");
        await fsp.writeFile(typesFile, 'export type Mode = "light" | "dark";\n', "utf8");
        const importLine = 'import type { Mode } from "./types";';
        const useLine = 'const value: Mode = "light";';
        await fsp.writeFile(consumerFile, [importLine, useLine, ""].join("\n"), "utf8");
        const index = await createTestIndexFromFiles(root, [typesFile, consumerFile]);
        const importedColumn = tokenColumn(importLine, "Mode");
        const useColumn = tokenColumn(useLine, "Mode");
        const result = await testFindReferences(index, typesFile, 1, 13, [
          { file: typesFile, line: 1, column: 13 },
          { file: consumerFile, line: 1, column: importedColumn },
          { file: consumerFile, line: 2, column: useColumn },
        ]);
        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        const imported = result.references.find(
          (reference) => reference.file === consumerFile && reference.range.start.line === 1,
        );
        expect(imported?.via?.importBinding).toBe("imported");
        expect(imported?.via?.import?.typeOnly).toBe(true);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("returns a default import local token after it resolves to the definition", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-import-default-refs-"));
      try {
        const sourceFile = path.join(root, "source.ts").replace(/\\/g, "/");
        const consumerFile = path.join(root, "consumer.ts").replace(/\\/g, "/");
        await fsp.writeFile(sourceFile, "export default function run() { return 1; }\n", "utf8");
        const importLine = 'import run from "./source";';
        await fsp.writeFile(consumerFile, [importLine, "run();", ""].join("\n"), "utf8");
        const index = await createTestIndexFromFiles(root, [sourceFile, consumerFile]);
        const localColumn = tokenColumn(importLine, "run");
        const useColumn = tokenColumn("run();", "run");
        const result = await testFindReferences(index, sourceFile, 1, 25, [
          { file: sourceFile, line: 1, column: 25 },
          { file: consumerFile, line: 1, column: localColumn },
          { file: consumerFile, line: 2, column: useColumn },
        ]);
        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        const local = result.references.find(
          (reference) => reference.file === consumerFile && reference.range.start.line === 1,
        );
        expect(local?.via?.importBinding).toBe("local");
        expect(local?.via?.import).toBeDefined();
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("unifies direct and barrel import tokens without duplicate ranges", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-import-barrel-refs-"));
      try {
        const sourceFile = path.join(root, "source.ts").replace(/\\/g, "/");
        const barrelFile = path.join(root, "barrel.ts").replace(/\\/g, "/");
        const consumerFile = path.join(root, "consumer.ts").replace(/\\/g, "/");
        await fsp.writeFile(sourceFile, "export function target() { return 1; }\n", "utf8");
        await fsp.writeFile(barrelFile, 'export { target } from "./source";\n', "utf8");
        const importLine = 'import { target } from "./barrel";';
        await fsp.writeFile(consumerFile, [importLine, "target();", ""].join("\n"), "utf8");
        const index = await createTestIndexFromFiles(root, [sourceFile, barrelFile, consumerFile]);
        const result = await indexer.findReferences(index, { file: sourceFile, line: 1, column: 17 });
        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        const imported = result.references.find(
          (reference) => reference.file === consumerFile && reference.range.start.line === 1,
        );
        const use = result.references.find(
          (reference) => reference.file === consumerFile && reference.range.start.line === 2,
        );
        const reexport = result.references.find((reference) => reference.file === barrelFile);
        expect(imported?.via?.importBinding).toBe("imported");
        expect(imported?.via?.import).toBeDefined();
        expect(use?.via?.import).toBeDefined();
        expect(use?.via?.importBinding).toBeUndefined();
        expect(reexport?.via?.reexport).toBe(true);
        expect(uniqueReferenceSiteCount(result)).toBe(result.references.length);
        const consumerImportSites = result.references.filter(
          (reference) => reference.file === consumerFile && reference.range.start.line === 1,
        );
        expect(consumerImportSites).toHaveLength(1);
        expect(result.referenceCoverage.state).toBe("complete");
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("does not count a namespace import declaration as a per-export reference", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-import-namespace-refs-"));
      try {
        const typesFile = path.join(root, "types.ts").replace(/\\/g, "/");
        const consumerFile = path.join(root, "consumer.ts").replace(/\\/g, "/");
        await fsp.writeFile(typesFile, "export enum Mode {\n  Light,\n}\n", "utf8");
        await fsp.writeFile(
          consumerFile,
          ['import * as shared from "./types";', "const selected = shared.Mode;", ""].join("\n"),
          "utf8",
        );
        const index = await createTestIndexFromFiles(root, [typesFile, consumerFile]);
        const result = await indexer.findReferences(index, { file: typesFile, line: 1, column: 13 });
        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        expect(
          result.references.some(
            (reference) => reference.file === consumerFile && reference.via?.importBinding !== undefined,
          ),
        ).toBe(false);
        const member = result.references.find(
          (reference) => reference.file === consumerFile && reference.via?.namespaceMember === "Mode",
        );
        expect(member).toBeDefined();
        expect(member?.range.start.line).toBe(2);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("does not attribute shadowed local uses to an imported binding", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-import-shadow-refs-"));
      try {
        const sourceFile = path.join(root, "source.ts").replace(/\\/g, "/");
        const consumerFile = path.join(root, "consumer.ts").replace(/\\/g, "/");
        await fsp.writeFile(sourceFile, "export function target() { return 1; }\n", "utf8");
        await fsp.writeFile(
          consumerFile,
          [
            'import { target } from "./source";',
            "function wrap() {",
            "  const target = 2;",
            "  return target;",
            "}",
            "export const used = target;",
            "",
          ].join("\n"),
          "utf8",
        );
        const index = await createTestIndexFromFiles(root, [sourceFile, consumerFile]);
        const result = await indexer.findReferences(index, { file: sourceFile, line: 1, column: 17 });
        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        expect(
          result.references.some((reference) => reference.file === consumerFile && reference.range.start.line === 3),
        ).toBe(false);
        expect(
          result.references.some((reference) => reference.file === consumerFile && reference.range.start.line === 4),
        ).toBe(false);
        expectReferenceAt(result, consumerFile, 1);
        expectReferenceAt(result, consumerFile, 6);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("marks parser-degraded candidate files as partial coverage", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-import-degraded-refs-"));
      try {
        const sourceFile = path.join(root, "source.ts").replace(/\\/g, "/");
        const consumerFile = path.join(root, "consumer.ts").replace(/\\/g, "/");
        await fsp.writeFile(sourceFile, "export function target() { return 1; }\n", "utf8");
        await fsp.writeFile(consumerFile, 'import { target } from "./source";\ntarget();\n', "utf8");
        const index = await createTestIndexFromFiles(root, [sourceFile, consumerFile]);
        markCandidateParserDegraded(index, consumerFile);
        const result = await indexer.findReferences(index, { file: sourceFile, line: 1, column: 17 });
        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        expect(result.referenceCoverage.state).toBe("partial");
        expect(result.referenceCoverage.reasons).toEqual(["parser_degraded"]);
        expect(result.referenceCoverage.affectedFiles).toEqual([consumerFile]);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("marks coverage partial when the degraded-file report omits a candidate after its cap", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-import-capped-degraded-refs-"));
      try {
        const sourceFile = path.join(root, "source.ts").replace(/\\/g, "/");
        const consumerFile = path.join(root, "consumer.ts").replace(/\\/g, "/");
        await fsp.writeFile(sourceFile, "export function target() { return 1; }\n", "utf8");
        await fsp.writeFile(consumerFile, 'import { target } from "./source";\ntarget();\n', "utf8");
        const index = await createTestIndexFromFiles(root, [sourceFile, consumerFile]);
        markCandidateParserDegraded(index, path.join(root, "listed.ts").replace(/\\/g, "/"));
        const parser = index.buildReport?.backend?.parser;
        if (!parser) throw new Error("Expected parser degradation report");
        parser.total = 21;
        parser.files = Array.from({ length: 20 }, (_, entryIndex) => ({
          file: path.join(root, `listed-${entryIndex}.ts`).replace(/\\/g, "/"),
          languageId: "typescript",
        }));

        const result = await indexer.findReferences(index, { file: sourceFile, line: 1, column: 17 });
        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        expect(result.referenceCoverage.state).toBe("partial");
        expect(result.referenceCoverage.reasons).toEqual(["parser_degraded"]);
        expect(result.referenceCoverage.affectedFiles).toBeUndefined();
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("does not lower coverage for an unrelated unresolved same-name import", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-import-unrelated-unresolved-refs-"));
      try {
        const sourceFile = path.join(root, "source.ts").replace(/\\/g, "/");
        const otherFile = path.join(root, "other.ts").replace(/\\/g, "/");
        await fsp.writeFile(sourceFile, "export function Mode() { return 1; }\n", "utf8");
        await fsp.writeFile(otherFile, 'import { Mode } from "not-a-real-package";\n', "utf8");
        const index = await createTestIndexFromFiles(root, [sourceFile, otherFile]);
        const result = await indexer.findReferences(index, { file: sourceFile, line: 1, column: 17 });
        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        expect(result.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
        expect(result.references.some((reference) => reference.file === otherFile)).toBe(false);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("reports unresolved_import only for a structurally linked unresolved name", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-import-linked-unresolved-refs-"));
      try {
        const sourceFile = path.join(root, "source.ts").replace(/\\/g, "/");
        const consumerFile = path.join(root, "consumer.ts").replace(/\\/g, "/");
        await fsp.writeFile(sourceFile, "export function target() { return 1; }\n", "utf8");
        await fsp.writeFile(consumerFile, 'import { target } from "./source";\n', "utf8");
        const index = await createTestIndexFromFiles(root, [sourceFile, consumerFile]);
        const sourceModule = index.byFile.get(fileIdentityKey(sourceFile));
        const def = sourceModule?.locals.find((local) => local.localName === "target");
        if (!sourceModule || !def) throw new Error("Expected source definition");
        sourceModule.exports = [];
        sourceModule.locals = sourceModule.locals.filter((local) => local.localName !== "target");
        index.exportCache.clear();
        const result = await indexer.findReferences(index, { def });
        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        expect(result.referenceCoverage.state).toBe("partial");
        expect(result.referenceCoverage.reasons).toEqual(["unresolved_import"]);
        expect(result.referenceCoverage.affectedFiles).toEqual([consumerFile]);
        expect(result.references.some((reference) => reference.file === consumerFile)).toBe(false);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });
    it("reports unresolved imports through an aliased re-export chain", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-import-aliased-reexport-unresolved-"));
      try {
        const sourceFile = path.join(root, "source.ts").replace(/\\/g, "/");
        const barrelFile = path.join(root, "barrel.ts").replace(/\\/g, "/");
        const consumerFile = path.join(root, "consumer.ts").replace(/\\/g, "/");
        await fsp.writeFile(sourceFile, "export function target() { return 1; }\n", "utf8");
        await fsp.writeFile(barrelFile, 'export { target as renamed } from "./source";\n', "utf8");
        await fsp.writeFile(consumerFile, 'import { renamed } from "./barrel";\n', "utf8");
        const index = await createTestIndexFromFiles(root, [sourceFile, barrelFile, consumerFile]);
        const sourceModule = index.byFile.get(fileIdentityKey(sourceFile));
        const def = sourceModule?.locals.find((local) => local.localName === "target");
        if (!sourceModule || !def) throw new Error("Expected source definition");
        sourceModule.exports = [];
        sourceModule.locals = sourceModule.locals.filter((local) => local.localName !== "target");
        index.exportCache.clear();

        const result = await indexer.findReferences(index, { def });

        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        expect(result.referenceCoverage.state).toBe("partial");
        expect(result.referenceCoverage.reasons).toContain("unresolved_import");
        expect(result.referenceCoverage.affectedFiles).toContain(consumerFile);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("does not lower coverage for an unrelated alias on a barrel that also reaches the definition", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-import-aliased-reexport-unrelated-"));
      try {
        const sourceFile = path.join(root, "source.ts").replace(/\\/g, "/");
        const otherFile = path.join(root, "other.ts").replace(/\\/g, "/");
        const barrelFile = path.join(root, "barrel.ts").replace(/\\/g, "/");
        const consumerFile = path.join(root, "consumer.ts").replace(/\\/g, "/");
        await fsp.writeFile(sourceFile, "export function target() { return 1; }\n", "utf8");
        await fsp.writeFile(otherFile, "export function other() { return 2; }\n", "utf8");
        await fsp.writeFile(
          barrelFile,
          ['export { target as renamed } from "./source";', 'export { other as target } from "./other";', ""].join(
            "\n",
          ),
          "utf8",
        );
        await fsp.writeFile(consumerFile, 'import { target } from "./barrel";\ntarget();\n', "utf8");
        const index = await createTestIndexFromFiles(root, [sourceFile, otherFile, barrelFile, consumerFile]);

        const result = await indexer.findReferences(index, { file: sourceFile, line: 1, column: 17 });

        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        expect(result.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
        expect(result.references.some((reference) => reference.file === consumerFile)).toBe(false);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("marks exact maxReferences truncation as partial coverage", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-import-truncation-refs-"));
      try {
        const sourceFile = path.join(root, "source.ts").replace(/\\/g, "/");
        const consumerFile = path.join(root, "consumer.ts").replace(/\\/g, "/");
        await fsp.writeFile(sourceFile, "export function target() { return 1; }\n", "utf8");
        await fsp.writeFile(consumerFile, 'import { target } from "./source";\ntarget();\n', "utf8");
        const index = await createTestIndexFromFiles(root, [sourceFile, consumerFile]);
        const result = await indexer.findReferences(
          index,
          { file: sourceFile, line: 1, column: 17 },
          { maxReferences: 1 },
        );
        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        expect(result.references).toHaveLength(1);
        expect(result.referenceCoverage.state).toBe("partial");
        expect(result.referenceCoverage.reasons).toEqual(["truncated"]);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("preserves coverage when the reference cache bounds a complete result", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-import-cache-bound-refs-"));
      try {
        const sourceFile = path.join(root, "source.ts").replace(/\\/g, "/");
        const consumerFile = path.join(root, "consumer.ts").replace(/\\/g, "/");
        await fsp.writeFile(sourceFile, "export function target() { return 1; }\n", "utf8");
        await fsp.writeFile(consumerFile, 'import { target } from "./source";\ntarget();\n', "utf8");
        const index = await createTestIndexFromFiles(root, [sourceFile, consumerFile]);
        const def = index.byFile.get(fileIdentityKey(sourceFile))?.locals.find((local) => local.localName === "target");
        if (!def) throw new Error("Expected target definition");
        const cache = createReferenceLookupCache();
        const unbounded = await cache.get(index, def);
        const bounded = await cache.get(index, def, { maxReferences: 1 });
        const unboundedAgain = await cache.get(index, def);
        expect(unbounded.status).toBe("ok");
        expect(bounded.status).toBe("ok");
        expect(unboundedAgain.status).toBe("ok");
        if (unbounded.status !== "ok" || bounded.status !== "ok" || unboundedAgain.status !== "ok") return;
        expect(unbounded.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
        expect(bounded.references).toHaveLength(1);
        expect(bounded.referenceCoverage.state).toBe("partial");
        expect(bounded.referenceCoverage.reasons).toEqual(["truncated"]);
        expect(unboundedAgain.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
        expect(unboundedAgain.references.length).toBeGreaterThan(1);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("keeps complete indexed-candidate coverage for an unused export", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-unused-export-coverage-"));
      try {
        const sourceFile = path.join(root, "source.ts").replace(/\\/g, "/");
        await fsp.writeFile(sourceFile, "export function unused() { return 1; }\n", "utf8");
        const index = await createTestIndexFromFiles(root, [sourceFile]);
        const result = await indexer.findReferences(index, { file: sourceFile, line: 1, column: 17 });
        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        expect(result.references).toHaveLength(1);
        expect(result.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("keeps complete coverage for an unused export when maxReferences is 1", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-unused-export-maxrefs-coverage-"));
      try {
        const sourceFile = path.join(root, "source.ts").replace(/\\/g, "/");
        await fsp.writeFile(sourceFile, "export function unused() { return 1; }\n", "utf8");
        const index = await createTestIndexFromFiles(root, [sourceFile]);
        const result = await indexer.findReferences(
          index,
          { file: sourceFile, line: 1, column: 17 },
          { maxReferences: 1 },
        );
        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        expect(result.references).toHaveLength(1);
        expect(result.references[0]?.file).toBe(sourceFile);
        expect(result.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("applies the import-binding contract to const enum owners", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-const-enum-import-refs-"));
      try {
        const typesFile = path.join(root, "types.ts").replace(/\\/g, "/");
        const consumerFile = path.join(root, "consumer.ts").replace(/\\/g, "/");
        await fsp.writeFile(typesFile, "export const enum Mode {\n  Light,\n}\n", "utf8");
        const importLine = 'import { Mode } from "./types";';
        const useLine = "const selected = Mode.Light;";
        await fsp.writeFile(consumerFile, [importLine, useLine, ""].join("\n"), "utf8");
        const index = await createTestIndexFromFiles(root, [typesFile, consumerFile]);
        const importedColumn = tokenColumn(importLine, "Mode");
        const useColumn = tokenColumn(useLine, "Mode");
        const result = await testFindReferences(index, typesFile, 1, 19, [
          { file: typesFile, line: 1, column: 19 },
          { file: consumerFile, line: 1, column: importedColumn },
          { file: consumerFile, line: 2, column: useColumn },
        ]);
        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        const imported = result.references.find(
          (reference) => reference.file === consumerFile && reference.range.start.line === 1,
        );
        expect(imported?.via?.importBinding).toBe("imported");
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });
  });

  describe("cross-language import binding references", () => {
    const cases: Array<{
      label: string;
      files: Record<string, string>;
      sourceFile: string;
      consumerFile: string;
      exportedName: string;
      importedName: string;
      importedOccurrence?: number;
      localName?: string;
      localOccurrence?: number;
      definitionLine: number;
      importLine: number;
      usageLine: number;
      usageName: string;
    }> = [
      {
        label: "Java unaliased import",
        files: {
          "pkg/Target.java": ["package pkg;", "public class Target {}", ""].join("\n"),
          "Consumer.java": ["import pkg.Target;", "class Consumer {", "  Target value;", "}", ""].join("\n"),
        },
        sourceFile: "pkg/Target.java",
        consumerFile: "Consumer.java",
        exportedName: "Target",
        importedName: "Target",
        definitionLine: 2,
        importLine: 1,
        usageLine: 3,
        usageName: "Target",
      },
      {
        label: "Kotlin explicit alias",
        files: {
          "pkg/Target.kt": ["package pkg", "class Target", ""].join("\n"),
          "Consumer.kt": ["import pkg.Target as LocalTarget", "fun use() {", "  LocalTarget()", "}", ""].join("\n"),
        },
        sourceFile: "pkg/Target.kt",
        consumerFile: "Consumer.kt",
        exportedName: "Target",
        importedName: "Target",
        localName: "LocalTarget",
        definitionLine: 2,
        importLine: 1,
        usageLine: 3,
        usageName: "LocalTarget",
      },
      {
        label: "Python explicit alias",
        files: {
          "source.py": ["def target():", "    return 1", ""].join("\n"),
          "consumer.py": ["from source import target as local_target", "local_target()", ""].join("\n"),
        },
        sourceFile: "source.py",
        consumerFile: "consumer.py",
        exportedName: "target",
        importedName: "target",
        localName: "local_target",
        definitionLine: 1,
        importLine: 1,
        usageLine: 2,
        usageName: "local_target",
      },
      {
        label: "PHP grouped alias",
        files: {
          "source.php": ["<?php", "namespace App;", "class Target", "{", "}", ""].join("\n"),
          "consumer.php": [
            "<?php",
            "use App\\{Target /* Target */ as LocalTarget /* LocalTarget */};",
            "$x = new LocalTarget();",
            "",
          ].join("\n"),
        },
        sourceFile: "source.php",
        consumerFile: "consumer.php",
        exportedName: "Target",
        importedName: "Target",
        localName: "LocalTarget",
        definitionLine: 3,
        importLine: 2,
        usageLine: 3,
        usageName: "LocalTarget",
      },
      {
        label: "Rust grouped alias",
        files: {
          "source.rs": ["pub fn target() {}", ""].join("\n"),
          "consumer.rs": [
            "mod source;",
            "use source::{target as local_target};",
            "fn run() {",
            "    local_target();",
            "}",
            "",
          ].join("\n"),
        },
        sourceFile: "source.rs",
        consumerFile: "consumer.rs",
        exportedName: "target",
        importedName: "target",
        localName: "local_target",
        definitionLine: 1,
        importLine: 2,
        usageLine: 4,
        usageName: "local_target",
      },
      {
        label: "C# alias using",
        files: {
          "Utils.cs": ["namespace Utils {", "  public class Target {}", "}", ""].join("\n"),
          "Consumer.cs": ["using AliasType = Utils.Target;", "class Consumer {", "  AliasType value;", "}", ""].join(
            "\n",
          ),
        },
        sourceFile: "Utils.cs",
        consumerFile: "Consumer.cs",
        exportedName: "Target",
        importedName: "Target",
        localName: "AliasType",
        definitionLine: 2,
        importLine: 1,
        usageLine: 3,
        usageName: "AliasType",
      },
      {
        label: "Swift dotted symbol import",
        files: {
          "Utils.swift": ["public struct Target {}", ""].join("\n"),
          "Consumer.swift": [
            "import struct Utils.Target /* outer /* inner */ Target */ // Target",
            "func use() {",
            "  Target()",
            "}",
            "",
          ].join("\n"),
        },
        sourceFile: "Utils.swift",
        consumerFile: "Consumer.swift",
        exportedName: "Target",
        importedName: "Target",
        definitionLine: 1,
        importLine: 1,
        usageLine: 3,
        usageName: "Target",
      },
      {
        label: "JavaScript destructured CommonJS require",
        files: {
          "source.js": "export function target() { return 1; }\n",
          "consumer.js": [
            'const { target: localTarget /* target: localTarget */ } = require("./source");',
            "localTarget();",
            "",
          ].join("\n"),
        },
        sourceFile: "source.js",
        consumerFile: "consumer.js",
        exportedName: "target",
        importedName: "target",
        localName: "localTarget",
        definitionLine: 1,
        importLine: 1,
        usageLine: 2,
        usageName: "localTarget",
      },
      {
        label: "TypeScript same-spelling alias",
        files: {
          "source.ts": "export class Target {}\n",
          "consumer.ts": ['import { Target as Target } from "./source";', "new Target();", ""].join("\n"),
        },
        sourceFile: "source.ts",
        consumerFile: "consumer.ts",
        exportedName: "Target",
        importedName: "Target",
        localName: "Target",
        localOccurrence: 1,
        definitionLine: 1,
        importLine: 1,
        usageLine: 2,
        usageName: "Target",
      },
      {
        label: "Python same-spelling alias",
        files: {
          "source.py": "class Target:\n    pass\n",
          "consumer.py": ["from source import Target as Target", "Target()", ""].join("\n"),
        },
        sourceFile: "source.py",
        consumerFile: "consumer.py",
        exportedName: "Target",
        importedName: "Target",
        localName: "Target",
        localOccurrence: 1,
        definitionLine: 1,
        importLine: 1,
        usageLine: 2,
        usageName: "Target",
      },
      {
        label: "PHP same-spelling alias",
        files: {
          "source.php": ["<?php", "namespace App;", "class Target {}", ""].join("\n"),
          "consumer.php": ["<?php", "use App\\Target as Target;", "new Target();", ""].join("\n"),
        },
        sourceFile: "source.php",
        consumerFile: "consumer.php",
        exportedName: "Target",
        importedName: "Target",
        localName: "Target",
        localOccurrence: 1,
        definitionLine: 3,
        importLine: 2,
        usageLine: 3,
        usageName: "Target",
      },
      {
        label: "Rust same-spelling alias",
        files: {
          "source.rs": "pub fn target() {}\n",
          "consumer.rs": ["mod source;", "use source::target as target;", "fn run() { target(); }", ""].join("\n"),
        },
        sourceFile: "source.rs",
        consumerFile: "consumer.rs",
        exportedName: "target",
        importedName: "target",
        localName: "target",
        localOccurrence: 1,
        definitionLine: 1,
        importLine: 2,
        usageLine: 3,
        usageName: "target",
      },
      {
        label: "Kotlin same-spelling alias",
        files: {
          "pkg/Target.kt": ["package pkg", "class Target", ""].join("\n"),
          "Consumer.kt": [
            "import pkg./* outer /* inner */ Target */Target as Target // Target",
            "fun use() { Target() }",
            "",
          ].join("\n"),
        },
        importedOccurrence: 1,
        sourceFile: "pkg/Target.kt",
        consumerFile: "Consumer.kt",
        exportedName: "Target",
        importedName: "Target",
        localName: "Target",
        localOccurrence: 2,
        definitionLine: 2,
        importLine: 1,
        usageLine: 2,
        usageName: "Target",
      },
      {
        label: "C# same-spelling alias",
        files: {
          "Utils.cs": ["namespace Utils {", "  public class Target {}", "}", ""].join("\n"),
          "Consumer.cs": ["using Target = Utils.Target;", "class Consumer { Target value; }", ""].join("\n"),
        },
        sourceFile: "Utils.cs",
        consumerFile: "Consumer.cs",
        exportedName: "Target",
        importedName: "Target",
        importedOccurrence: 1,
        localName: "Target",
        localOccurrence: 0,
        definitionLine: 2,
        importLine: 1,
        usageLine: 2,
        usageName: "Target",
      },
      {
        label: "CommonJS same-spelling alias",
        files: {
          "source.js": "export function target() { return 1; }\n",
          "consumer.js": ['const { target: target } = require("./source");', "target();", ""].join("\n"),
        },
        sourceFile: "source.js",
        consumerFile: "consumer.js",
        exportedName: "target",
        importedName: "target",
        localName: "target",
        localOccurrence: 1,
        definitionLine: 1,
        importLine: 1,
        usageLine: 2,
        usageName: "target",
      },
    ];

    for (const testCase of cases) {
      it(`returns import declaration tokens for ${testCase.label}`, async () => {
        const root = await fsp.mkdtemp(
          path.join(os.tmpdir(), `cg-xl-import-${testCase.label.toLowerCase().replace(/\s+/g, "-")}-`),
        );
        try {
          const written = new Map<string, string>();
          for (const [relativePath, contents] of Object.entries(testCase.files)) {
            const absolutePath = path.join(root, relativePath).replace(/\\/g, "/");
            await fsp.mkdir(path.dirname(absolutePath), { recursive: true });
            await fsp.writeFile(absolutePath, contents, "utf8");
            written.set(relativePath, absolutePath);
          }
          const sourceFile = written.get(testCase.sourceFile);
          const consumerFile = written.get(testCase.consumerFile);
          if (!sourceFile || !consumerFile) throw new Error(`Expected files for ${testCase.label}`);

          const sourceLine = (testCase.files[testCase.sourceFile] ?? "").split("\n")[testCase.definitionLine - 1] ?? "";
          const importSource = (testCase.files[testCase.consumerFile] ?? "").split("\n")[testCase.importLine - 1] ?? "";
          const usageSource = (testCase.files[testCase.consumerFile] ?? "").split("\n")[testCase.usageLine - 1] ?? "";
          const definitionColumn = tokenColumn(sourceLine, testCase.exportedName);
          const importedColumn = tokenColumn(importSource, testCase.importedName, testCase.importedOccurrence ?? 0);
          const localColumn = testCase.localName
            ? tokenColumn(importSource, testCase.localName, testCase.localOccurrence ?? 0)
            : undefined;
          const usageColumn = tokenColumn(usageSource, testCase.usageName);
          const expected = [
            { file: sourceFile, line: testCase.definitionLine, column: definitionColumn },
            { file: consumerFile, line: testCase.importLine, column: importedColumn },
            ...(localColumn === undefined
              ? []
              : [{ file: consumerFile, line: testCase.importLine, column: localColumn }]),
            { file: consumerFile, line: testCase.usageLine, column: usageColumn },
          ];

          const index = await createTestIndexFromFiles(root, [...written.values()]);
          const result = await testFindReferences(
            index,
            sourceFile,
            testCase.definitionLine,
            definitionColumn,
            expected,
          );

          expect(result.status).toBe("ok");
          if (result.status !== "ok") return;
          const imported = findReferenceSite(result, consumerFile, testCase.importLine, importedColumn);
          const usage = findReferenceSite(result, consumerFile, testCase.usageLine, usageColumn);
          expect(imported?.via?.importBinding).toBe("imported");
          expect(imported?.via?.import).toBeDefined();
          if (localColumn !== undefined) {
            const local = findReferenceSite(result, consumerFile, testCase.importLine, localColumn);
            expect(local?.via?.importBinding).toBe("local");
            expect(local?.via?.import).toBeDefined();
            expect(local?.range.start.column).not.toBe(imported?.range.start.column);
          } else {
            expect(
              result.references.some(
                (reference) =>
                  reference.file === consumerFile &&
                  reference.range.start.line === testCase.importLine &&
                  reference.via?.importBinding === "local",
              ),
            ).toBe(false);
          }
          expect(usage?.via?.import).toBeDefined();
          expect(usage?.via?.importBinding).toBeUndefined();
          expect(uniqueReferenceSiteCount(result)).toBe(result.references.length);
        } finally {
          await fsp.rm(root, { recursive: true, force: true });
        }
      });
    }

    it("keeps CommonJS default-value references out of the local binding declaration range", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-cjs-binding-default-"));
      try {
        const sourceFile = path.join(root, "source.js").replace(/\\/g, "/");
        const consumerFile = path.join(root, "consumer.js").replace(/\\/g, "/");
        const sourceLine = "export function target() { return 1; }";
        const importLine = 'const { target: localTarget = localTarget } = require("./source");';
        await fsp.writeFile(sourceFile, `${sourceLine}\n`, "utf8");
        await fsp.writeFile(consumerFile, `${importLine}\nlocalTarget();\n`, "utf8");

        const index = await createTestIndexFromFiles(root, [sourceFile, consumerFile]);
        const result = await indexer.findReferences(index, {
          file: sourceFile,
          line: 1,
          column: tokenColumn(sourceLine, "target"),
        });

        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        const importedColumn = tokenColumn(importLine, "target");
        const localBindingColumn = tokenColumn(importLine, "localTarget");
        const defaultReferenceColumn = tokenColumn(importLine, "localTarget", 1);
        expect(findReferenceSite(result, consumerFile, 1, importedColumn)?.via?.importBinding).toBe("imported");
        expect(findReferenceSite(result, consumerFile, 1, localBindingColumn)?.via?.importBinding).toBe("local");
        expect(
          result.references.some(
            (reference) =>
              reference.file === consumerFile &&
              reference.range.start.line === 1 &&
              reference.range.start.column === defaultReferenceColumn &&
              reference.via?.importBinding !== undefined,
          ),
        ).toBe(false);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("keeps grouped import aliases from claiming another binding's same-spelled token", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-xl-import-grouped-alias-collision-"));
      try {
        const sourceFile = path.join(root, "source.rs").replace(/\\/g, "/");
        const consumerFile = path.join(root, "consumer.rs").replace(/\\/g, "/");
        const source = ["pub fn Bar() {}", "pub fn Baz() {}", ""].join("\n");
        const importLine = "use source::{Bar /* Bar /* Bar */ Bar */ as X, Baz as Bar};";
        const consumer = ["mod source;", importLine, "fn run() {", "    X();", "    Bar();", "}", ""].join("\n");
        await fsp.writeFile(sourceFile, source, "utf8");
        await fsp.writeFile(consumerFile, consumer, "utf8");

        const barDefinitionColumn = tokenColumn("pub fn Bar() {}", "Bar");
        const bazDefinitionColumn = tokenColumn("pub fn Baz() {}", "Baz");
        const importedBarColumn = tokenColumn(importLine, "Bar");
        const localXColumn = tokenColumn(importLine, "X");
        const importedBazColumn = tokenColumn(importLine, "Baz");
        const commentBarColumn = tokenColumn(importLine, "Bar", 1);
        const localBarColumn = tokenColumn(importLine, "Bar", 4);
        const usageXColumn = tokenColumn("    X();", "X");
        const usageBarColumn = tokenColumn("    Bar();", "Bar");
        expect(importedBarColumn).not.toBe(localBarColumn);

        const index = await createTestIndexFromFiles(root, [sourceFile, consumerFile]);

        const barResult = await testFindReferences(index, sourceFile, 1, barDefinitionColumn, [
          { file: sourceFile, line: 1, column: barDefinitionColumn },
          { file: consumerFile, line: 2, column: importedBarColumn },
          { file: consumerFile, line: 2, column: localXColumn },
          { file: consumerFile, line: 4, column: usageXColumn },
        ]);
        expect(barResult.status).toBe("ok");
        if (barResult.status !== "ok") return;
        const barImported = findReferenceSite(barResult, consumerFile, 2, importedBarColumn);
        const barLocal = findReferenceSite(barResult, consumerFile, 2, localXColumn);
        const barUsage = findReferenceSite(barResult, consumerFile, 4, usageXColumn);
        expect(barImported?.via?.importBinding).toBe("imported");
        expect(barImported?.via?.import).toMatchObject({ imported: "Bar", local: "X" });
        expect(barLocal?.via?.importBinding).toBe("local");
        expect(barLocal?.via?.import).toMatchObject({ imported: "Bar", local: "X" });
        expect(barLocal?.range.start.column).not.toBe(barImported?.range.start.column);
        expect(barUsage?.via?.import).toBeDefined();
        expect(barUsage?.via?.importBinding).toBeUndefined();
        expect(findReferenceSite(barResult, consumerFile, 2, localBarColumn)).toBeUndefined();
        expect(findReferenceSite(barResult, consumerFile, 2, importedBazColumn)).toBeUndefined();
        expect(findReferenceSite(barResult, consumerFile, 2, commentBarColumn)).toBeUndefined();
        expect(uniqueReferenceSiteCount(barResult)).toBe(barResult.references.length);

        const bazResult = await testFindReferences(index, sourceFile, 2, bazDefinitionColumn, [
          { file: sourceFile, line: 2, column: bazDefinitionColumn },
          { file: consumerFile, line: 2, column: importedBazColumn },
          { file: consumerFile, line: 2, column: localBarColumn },
          { file: consumerFile, line: 5, column: usageBarColumn },
        ]);
        expect(bazResult.status).toBe("ok");
        if (bazResult.status !== "ok") return;
        const bazImported = findReferenceSite(bazResult, consumerFile, 2, importedBazColumn);
        const bazLocal = findReferenceSite(bazResult, consumerFile, 2, localBarColumn);
        const bazUsage = findReferenceSite(bazResult, consumerFile, 5, usageBarColumn);
        expect(bazImported?.via?.importBinding).toBe("imported");
        expect(bazImported?.via?.import).toMatchObject({ imported: "Baz", local: "Bar" });
        expect(bazLocal?.via?.importBinding).toBe("local");
        expect(bazLocal?.via?.import).toMatchObject({ imported: "Baz", local: "Bar" });
        expect(bazLocal?.range.start.column).not.toBe(bazImported?.range.start.column);
        expect(bazUsage?.via?.import).toBeDefined();
        expect(bazUsage?.via?.importBinding).toBeUndefined();
        expect(findReferenceSite(bazResult, consumerFile, 2, importedBarColumn)).toBeUndefined();
        expect(findReferenceSite(bazResult, consumerFile, 2, localXColumn)).toBeUndefined();
        expect(findReferenceSite(bazResult, consumerFile, 2, commentBarColumn)).toBeUndefined();
        expect(uniqueReferenceSiteCount(bazResult)).toBe(bazResult.references.length);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });
  });

  describe("TypeScript method references", () => {
    it("finds class method references only through verified receivers", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ts-method-refs-"));
      try {
        const serviceFile = path.join(root, "service.ts").replace(/\\/g, "/");
        const consumerFile = path.join(root, "consumer.ts").replace(/\\/g, "/");
        await fsp.writeFile(
          serviceFile,
          [
            "export class Service {",
            "  run(value: number) {",
            "    return value;",
            "  }",
            "}",
            "export class Other {",
            "  run(value: number) {",
            "    return value;",
            "  }",
            "}",
            "",
          ].join("\n"),
          "utf8",
        );
        await fsp.writeFile(
          consumerFile,
          [
            'import { Other, Service } from "./service";',
            "new Service().run(1);",
            "const service = new Service();",
            "service.run(2);",
            "new Other().run(3);",
            "",
          ].join("\n"),
          "utf8",
        );
        const index = await createTestIndexFromFiles(root, [serviceFile, consumerFile]);

        const result = await testFindReferences(index, serviceFile, 2, 3, [
          { file: serviceFile, line: 2, column: 3 },
          { file: consumerFile, line: 2, column: 15 },
          { file: consumerFile, line: 4, column: 9 },
        ]);

        expect(result.status).toBe("ok");
        expectReferenceAt(result, serviceFile, 2);
        expectReferenceAt(result, consumerFile, 2);
        expectReferenceAt(result, consumerFile, 4);
        if (result.status === "ok") {
          expect(
            result.references.some((reference) => reference.file === consumerFile && reference.range.start.line === 5),
          ).toBe(false);
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("does not treat class methods as module namespace exports", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ts-method-refs-namespace-export-"));
      try {
        const serviceFile = path.join(root, "service.ts").replace(/\\/g, "/");
        const consumerFile = path.join(root, "consumer.ts").replace(/\\/g, "/");
        await fsp.writeFile(serviceFile, "export class Service {\n  run(): void {}\n}\n", "utf8");
        await fsp.writeFile(
          consumerFile,
          'import * as api from "./service";\napi.run();\nconst service = new api.Service();\nservice.run();\n',
          "utf8",
        );

        const index = await createTestIndexFromFiles(root, [serviceFile, consumerFile]);
        const result = await indexer.findReferences(index, { file: serviceFile, line: 2, column: 3 });

        expect(result.status).toBe("ok");
        if (result.status === "ok") {
          expect(result.references).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                file: serviceFile,
                range: expect.objectContaining({
                  start: expect.objectContaining({ line: 2 }),
                }),
              }),
            ]),
          );
          expect(
            result.references.some((reference) => reference.file === consumerFile && reference.range.start.line === 2),
          ).toBe(false);
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });
  });

  describe("cross-language method references", () => {
    const cases: Array<{
      label: string;
      fileName: string;
      source: string;
      definition: { line: number; column: number };
      expectedLines: number[];
      rejectedLines: number[];
    }> = [
      {
        label: "Java",
        fileName: "Service.java",
        source: [
          "class Service {",
          "  int run(int value) { return value; }",
          "}",
          "class Other {",
          "  int run(int value) { return value; }",
          "}",
          "class Consumer {",
          "  int test() {",
          "    Service service = new Service();",
          "    return service.run(1) + new Other().run(2);",
          "  }",
          "}",
          "",
        ].join("\n"),
        definition: { line: 2, column: 7 },
        expectedLines: [2, 10],
        rejectedLines: [5],
      },
      {
        label: "C#",
        fileName: "Service.cs",
        source: [
          "class Service {",
          "  int Run(int value) { return value; }",
          "}",
          "class Other {",
          "  int Run(int value) { return value; }",
          "}",
          "class Consumer {",
          "  int Test() {",
          "    Service service = new Service();",
          "    return service.Run(1) + new Other().Run(2);",
          "  }",
          "}",
          "",
        ].join("\n"),
        definition: { line: 2, column: 7 },
        expectedLines: [2, 10],
        rejectedLines: [5],
      },
      {
        label: "Rust",
        fileName: "service.rs",
        source: [
          "struct Service;",
          "impl Service {",
          "  fn run(&self, value: i32) -> i32 { value }",
          "}",
          "struct Other;",
          "impl Other {",
          "  fn run(&self, value: i32) -> i32 { value }",
          "}",
          "fn test() -> i32 {",
          "  let service = Service;",
          "  service.run(1) + Other.run(2)",
          "}",
          "",
        ].join("\n"),
        definition: { line: 3, column: 6 },
        expectedLines: [3, 11],
        rejectedLines: [7],
      },
    ];

    for (const testCase of cases) {
      it(`finds ${testCase.label} method references only through verified receivers`, async () => {
        const root = await fsp.mkdtemp(path.join(os.tmpdir(), `cg-${testCase.label.toLowerCase()}-method-refs-`));
        try {
          const file = path.join(root, testCase.fileName).replace(/\\/g, "/");
          await fsp.writeFile(file, testCase.source, "utf8");
          const index = await createTestIndexFromFiles(root, [file]);

          const sourceLines = testCase.source.split("\n");
          const definitionLine = sourceLines[testCase.definition.line - 1] ?? "";
          const methodName = definitionLine.match(/\b([A-Za-z_]\w*)\s*\(/)?.[1];
          if (!methodName) {
            throw new Error(`Expected a method name in ${testCase.label} definition`);
          }
          const expectedReferences = testCase.expectedLines.map((line) => {
            const column = (sourceLines[line - 1] ?? "").indexOf(methodName) + 1;
            if (column < 1) {
              throw new Error(`Expected ${methodName} on line ${line} for ${testCase.label}`);
            }
            return { file, line, column };
          });
          const result = await testFindReferences(
            index,
            file,
            testCase.definition.line,
            testCase.definition.column,
            expectedReferences,
          );

          expect(result.status).toBe("ok");
          for (const line of testCase.expectedLines) {
            expectReferenceAt(result, file, line);
          }
          if (result.status === "ok") {
            for (const line of testCase.rejectedLines) {
              expect(
                result.references.some((reference) => reference.file === file && reference.range.start.line === line),
              ).toBe(false);
            }
          }
        } finally {
          await fsp.rm(root, { recursive: true, force: true });
        }
      });
    }
  });

  describe("unqualified same-name method resolution across files", () => {
    const cases: Array<{
      label: string;
      fileName: string;
      source: string;
      ownDefinition: { line: number; column: number };
      callsiteLine: number;
      expectsOwnMethodReference: boolean;
      otherDefinition: { line: number; column: number };
    }> = [
      {
        label: "Java",
        fileName: "Main.java",
        source: [
          "class Main {",
          "  void helper() { }",
          "  void run() {",
          "    helper();",
          "  }",
          "}",
          "class Other {",
          "  void helper() { }",
          "}",
          "",
        ].join("\n"),
        ownDefinition: { line: 2, column: 8 },
        callsiteLine: 4,
        expectsOwnMethodReference: true,
        otherDefinition: { line: 8, column: 8 },
      },
      {
        label: "C#",
        fileName: "Main.cs",
        source: [
          "class Main {",
          "  void Helper() { }",
          "  void Run() {",
          "    Helper();",
          "  }",
          "}",
          "class Other {",
          "  void Helper() { }",
          "}",
          "",
        ].join("\n"),
        ownDefinition: { line: 2, column: 8 },
        callsiteLine: 4,
        expectsOwnMethodReference: true,
        otherDefinition: { line: 8, column: 8 },
      },
      {
        label: "JavaScript",
        fileName: "main.js",
        source: [
          "class Main {",
          "  helper() { }",
          "  run() {",
          "    helper();",
          "  }",
          "}",
          "class Other {",
          "  helper() { }",
          "}",
          "",
        ].join("\n"),
        ownDefinition: { line: 2, column: 3 },
        callsiteLine: 4,
        expectsOwnMethodReference: false,
        otherDefinition: { line: 8, column: 3 },
      },
      {
        label: "TypeScript",
        fileName: "main.ts",
        source: [
          "class Main {",
          "  helper() { }",
          "  run() {",
          "    helper();",
          "  }",
          "}",
          "class Other {",
          "  helper() { }",
          "}",
          "",
        ].join("\n"),
        ownDefinition: { line: 2, column: 3 },
        callsiteLine: 4,
        expectsOwnMethodReference: false,
        otherDefinition: { line: 8, column: 3 },
      },
    ];
    for (const testCase of cases) {
      it(`resolves each ${testCase.label} bare call according to its receiver semantics`, async () => {
        const root = await fsp.mkdtemp(path.join(os.tmpdir(), `cg-${testCase.label.toLowerCase()}-unqualified-`));
        try {
          const file = path.join(root, testCase.fileName).replace(/\\/g, "/");
          await fsp.writeFile(file, testCase.source, "utf8");
          const index = await createTestIndexFromFiles(root, [file]);

          const ownResult = await testFindReferences(
            index,
            file,
            testCase.ownDefinition.line,
            testCase.ownDefinition.column,
            testCase.expectsOwnMethodReference ? 2 : 1,
          );
          expect(ownResult.status).toBe("ok");
          if (ownResult.status === "ok") {
            expect(
              ownResult.references.some(
                (reference) => reference.file === file && reference.range.start.line === testCase.callsiteLine,
              ),
            ).toBe(testCase.expectsOwnMethodReference);
          }

          const otherResult = await testFindReferences(
            index,
            file,
            testCase.otherDefinition.line,
            testCase.otherDefinition.column,
            1,
          );
          expect(otherResult.status).toBe("ok");
          if (otherResult.status === "ok") {
            expect(
              otherResult.references.some(
                (reference) => reference.file === file && reference.range.start.line === testCase.callsiteLine,
              ),
            ).toBe(false);
            expect(
              otherResult.references.some(
                (reference) => reference.file === file && reference.range.start.line === testCase.ownDefinition.line,
              ),
            ).toBe(false);
          }
        } finally {
          await fsp.rm(root, { recursive: true, force: true });
        }
      });
    }
  });

  describe("JavaScript and TypeScript explicit receiver methods", () => {
    const cases = [
      {
        label: "JavaScript",
        extension: "js",
        helperSource: "export function helper() { return 42; }\n",
        mainSource: [
          'import { helper } from "./helper.js";',
          "class Widget {",
          "  helper() { return 1; }",
          "  run() {",
          "    helper();",
          "    this.helper();",
          "  }",
          "}",
          "",
        ].join("\n"),
      },
      {
        label: "TypeScript",
        extension: "ts",
        helperSource: "export function helper(): number { return 42; }\n",
        mainSource: [
          'import { helper } from "./helper.js";',
          "class Widget {",
          "  helper(): number { return 1; }",
          "  run(): number {",
          "    helper();",
          "    return this.helper();",
          "  }",
          "}",
          "",
        ].join("\n"),
      },
    ];

    for (const testCase of cases) {
      it(`keeps ${testCase.label} bare calls bound to imports and receiver calls bound to methods`, async () => {
        const root = await fsp.mkdtemp(path.join(os.tmpdir(), `cg-${testCase.extension}-explicit-receiver-`));
        try {
          const helperFile = path.join(root, `helper.${testCase.extension}`).replace(/\\/g, "/");
          const mainFile = path.join(root, `main.${testCase.extension}`).replace(/\\/g, "/");
          await fsp.writeFile(helperFile, testCase.helperSource, "utf8");
          await fsp.writeFile(mainFile, testCase.mainSource, "utf8");
          const index = await createTestIndexFromFiles(root, [helperFile, mainFile]);

          const importedHelper = await testFindReferences(index, helperFile, 1, 17, 2);
          expect(importedHelper.status).toBe("ok");
          expectReferenceAt(importedHelper, mainFile, 5);
          if (importedHelper.status === "ok") {
            expect(
              importedHelper.references.some(
                (reference) => reference.file === mainFile && reference.range.start.line === 6,
              ),
            ).toBe(false);
          }

          const methodHelper = await testFindReferences(index, mainFile, 3, 3, 1);
          expect(methodHelper.status).toBe("ok");
          expectReferenceAt(methodHelper, mainFile, 6);
          if (methodHelper.status === "ok") {
            expect(
              methodHelper.references.some(
                (reference) => reference.file === mainFile && reference.range.start.line === 5,
              ),
            ).toBe(false);
          }
        } finally {
          await fsp.rm(root, { recursive: true, force: true });
        }
      });
    }
  });

  describe("Python match bindings and stubs", () => {
    it("finds exact references for pattern bindings and stub exports", async () => {
      const fixturePath = path.resolve(process.cwd(), "tests", "samples", "language-regressions", "python");
      const matchFile = path.join(fixturePath, "match_bindings.py").replace(/\\/g, "/");
      const stubFile = path.join(fixturePath, "stubs.pyi").replace(/\\/g, "/");
      const consumerFile = path.join(fixturePath, "stub_consumer.py").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(fixturePath, [matchFile, stubFile, consumerFile]);

      const tupleReferences = await testFindReferences(index, matchFile, 3, 15, 2);
      expect(tupleReferences.status).toBe("ok");
      expectReferenceAt(tupleReferences, matchFile, 3);
      expectReferenceAt(tupleReferences, matchFile, 4);

      const stubReferences = await testFindReferences(index, stubFile, 5, 5, 2);
      expect(stubReferences.status).toBe("ok");
      expectReferenceAt(stubReferences, stubFile, 5);
      expectReferenceAt(stubReferences, consumerFile, 4);
    });
  });

  describe("TypeScript", () => {
    it("should find all references to exported function", async () => {
      const index = await createTestIndex("typescript");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "typescript");
      const utilsFile = path.join(samplePath, "utils.ts").replace(/\\/g, "/");

      // Test find-references on helperFunction definition on line 1
      const result = await testFindReferences(index, utilsFile, 1, 16, 3);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.references.length).toBeGreaterThanOrEqual(1);
        expect(result.provenance?.resolution).toBe("exact");
        expect(result.provenance?.confidence).toBe("high");

        // Should include the definition itself
        const definitionRef = result.references.find((ref) => ref.file === utilsFile && ref.range.start.line === 1);
        expect(definitionRef).toBeDefined();
      }
    });

    it("should find all references to exported class", async () => {
      const index = await createTestIndex("typescript");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "typescript");
      const utilsFile = path.join(samplePath, "utils.ts").replace(/\\/g, "/");

      // Test find-references on UtilityClass definition on line 5
      const result = await testFindReferences(index, utilsFile, 5, 14, 2);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.references.length).toBeGreaterThanOrEqual(1);

        // Should include the definition itself
        const definitionRef = result.references.find((ref) => ref.file === utilsFile && ref.range.start.line === 5);
        expect(definitionRef).toBeDefined();
      }
    });

    it("should find references to namespace member", async () => {
      const index = await createTestIndex("typescript");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "typescript");
      const utilsFile = path.join(samplePath, "utils.ts").replace(/\\/g, "/");

      // Test find-references on helperFunction definition
      const result = await testFindReferences(index, utilsFile, 1, 16, 3);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        // Should find both direct usage and namespace usage
        const namespaceUsage = result.references.find(
          (ref) => ref.file.includes("main.ts") && ref.via?.namespaceMember,
        );
        expect(namespaceUsage?.range).toEqual({
          start: { line: 7, column: 27, index: 266 },
          end: { line: 7, column: 41, index: 280 },
        });
      }
    });
  });

  describe("TSX", () => {
    it("should keep block context scoped to the enclosing component", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-tsx-block-context-"));
      try {
        const buttonFile = path.join(root, "Button.tsx");
        const appFile = path.join(root, "App.tsx");
        await fsp.writeFile(
          buttonFile,
          [
            "export function Button(props: { label: string }) {",
            "  return <button>{props.label}</button>;",
            "}",
            "",
          ].join("\n"),
          "utf8",
        );
        await fsp.writeFile(
          appFile,
          [
            "import { Button } from './Button';",
            "",
            "function unrelated() {",
            "  return 'nope';",
            "}",
            "",
            "export function App() {",
            '  return <Button label="hi" />;',
            "}",
            "",
            "function trailing() {",
            "  return 'tail';",
            "}",
            "",
          ].join("\n"),
          "utf8",
        );

        const index = await createTestIndexFromPath(root);
        const result = await indexer.findReferences(
          index,
          { file: buttonFile.replace(/\\/g, "/"), line: 1, column: 17 },
          { context: "block", blockMaxLines: 50, maxReferences: 5 },
        );

        expect(result.status).toBe("ok");
        if (result.status === "ok") {
          const appReference = result.references.find(
            (reference) => reference.file === appFile.replace(/\\/g, "/") && reference.range.start.line === 8,
          );
          expect(appReference?.context).toContain("function App()");
          expect(appReference?.context).toContain('<Button label="hi" />');
          expect(appReference?.context).not.toContain("function unrelated()");
          expect(appReference?.context).not.toContain("function trailing()");
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("should find references for JSX imports authored with .jsx extensions", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "tsx");
      const appFile = path.join(samplePath, "JsxImportApp.tsx").replace(/\\/g, "/");
      const buttonFile = path.join(samplePath, "components", "Button.tsx").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [appFile, buttonFile]);

      const result = await testFindReferences(index, buttonFile, 5, 17, 2);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expectReferenceAt(result, buttonFile, 5);
        expectReferenceAt(result, appFile, 4);
      }
    });
  });

  describe("Python", () => {
    it("should find all references to exported function", async () => {
      const index = await createTestIndex("python");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "python");
      const utilsFile = path.join(samplePath, "utils.py").replace(/\\/g, "/");

      // Test find-references on helper_function definition on line 1
      const result = await testFindReferences(index, utilsFile, 1, 16, 3);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.references.length).toBeGreaterThanOrEqual(1);

        // Should include the definition itself
        const definitionRef = result.references.find((ref) => ref.file === utilsFile && ref.range.start.line === 1);
        expect(definitionRef).toBeDefined();
      }
    });

    it("should find all references to exported class", async () => {
      const index = await createTestIndex("python");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "python");
      const utilsFile = path.join(samplePath, "utils.py").replace(/\\/g, "/");

      // Test find-references on UtilityClass definition on line 5
      const result = await testFindReferences(index, utilsFile, 5, 7, 2);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.references.length).toBeGreaterThanOrEqual(1);

        // Should include the definition itself
        const definitionRef = result.references.find((ref) => ref.file === utilsFile && ref.range.start.line === 5);
        expect(definitionRef).toBeDefined();
      }
    });

    it("should find references to namespace member", async () => {
      const index = await createTestIndex("python");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "python");
      const utilsFile = path.join(samplePath, "utils.py").replace(/\\/g, "/");

      // Test find-references on helper_function definition
      const result = await testFindReferences(index, utilsFile, 1, 16, 3);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        // Should find usages in main.py
        const mainPyRefs = result.references.filter((ref) => ref.file.includes("main.py"));
        expect(mainPyRefs.length).toBeGreaterThan(0);
      }
    });

    it("should ignore shadowed names for wildcard imports while keeping real references", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-py-star-refs-"));
      try {
        const utilFile = path.join(root, "util.py");
        const mainFile = path.join(root, "main.py");
        await fsp.writeFile(utilFile, ["foo = 1", "bar = 2", ""].join("\n"), "utf8");
        await fsp.writeFile(
          mainFile,
          ["from util import *", "foo = 2", "print(foo)", "print(bar)", ""].join("\n"),
          "utf8",
        );

        const index = await createTestIndexFromPath(root);
        const normalizedUtil = utilFile.replace(/\\/g, "/");
        const normalizedMain = mainFile.replace(/\\/g, "/");

        const fooRefs = await testFindReferences(index, normalizedUtil, 1, 1, 1);
        expect(fooRefs.status).toBe("ok");
        if (fooRefs.status === "ok") {
          expect(fooRefs.references.some((reference) => reference.file === normalizedMain)).toBe(false);
        }

        const barRefs = await testFindReferences(index, normalizedUtil, 2, 1, 2);
        expect(barRefs.status).toBe("ok");
        if (barRefs.status === "ok") {
          expectReferenceAt(barRefs, normalizedMain, 4);
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("should avoid semantic fallback work for expanded wildcard imports", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-py-star-expanded-"));
      try {
        const utilFile = path.join(root, "util.py");
        const mainFile = path.join(root, "main.py");
        await fsp.writeFile(utilFile, ["foo = 1", ""].join("\n"), "utf8");
        await fsp.writeFile(mainFile, ["from util import *", "print(foo)", ""].join("\n"), "utf8");

        const index = await createTestIndexFromPath(root);
        const normalizedUtil = utilFile.replace(/\\/g, "/");
        const utilModule = index.byFile.get(fileIdentityKey(normalizedUtil));
        const fooDef = utilModule?.locals.find((local) => local.localName === "foo");

        expect(fooDef).toBeDefined();
        if (!fooDef) {
          throw new Error("Expected foo definition to exist");
        }

        const goToDefinitionSpy = vi.spyOn(indexer, "goToDefinition");
        try {
          const result = await indexer.findReferences(index, { def: fooDef }, { maxReferences: 2 });

          expect(result.status).toBe("ok");
          if (result.status === "ok") {
            expect(result.references).toHaveLength(2);
            expectReferenceAt(result, mainFile.replace(/\\/g, "/"), 2);
          }
          expect(goToDefinitionSpy).not.toHaveBeenCalled();
        } finally {
          goToDefinitionSpy.mockRestore();
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });
  });

  describe("PHP", () => {
    it("should find all references to imported function", async () => {
      const index = await createTestIndex("php");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "php");
      const utilsFile = path.join(samplePath, "utils.php").replace(/\\/g, "/");

      const result = await testFindReferences(index, utilsFile, 19, 11, 2);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expectReferenceAt(result, utilsFile, 19);
        expectReferenceAt(result, path.join(samplePath, "main.php").replace(/\\/g, "/"), 9);
      }
    });

    it("should find all references to imported class", async () => {
      const index = await createTestIndex("php");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "php");
      const utilsFile = path.join(samplePath, "utils.php").replace(/\\/g, "/");

      const result = await testFindReferences(index, utilsFile, 5, 7, 2);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expectReferenceAt(result, utilsFile, 5);
        expectReferenceAt(result, path.join(samplePath, "main.php").replace(/\\/g, "/"), 10);
      }
    });
    it("finds references for typed, untyped, and static properties", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "php");
      const propertiesFile = path.join(samplePath, "properties.php").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [propertiesFile]);

      for (const [column, line] of [
        [16, 5],
        [12, 6],
        [19, 7],
      ]) {
        const result = await testFindReferences(index, propertiesFile, line, column, 2);
        expectReferenceAt(result, propertiesFile, line);
        expectReferenceAt(result, propertiesFile, 11);
      }
    });

    it("should find references through grouped use aliases", async () => {
      const index = await createTestIndex("php");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "php");
      const toolboxFile = path.join(samplePath, "src", "Support", "Toolbox.php").replace(/\\/g, "/");
      const helperFile = path.join(samplePath, "src", "Support", "support_helper.php").replace(/\\/g, "/");
      const groupedFile = path.join(samplePath, "grouped-consumer.php").replace(/\\/g, "/");

      const toolboxResult = await testFindReferences(index, toolboxFile, 5, 7, 2);
      expect(toolboxResult.status).toBe("ok");
      if (toolboxResult.status === "ok") {
        expectReferenceAt(toolboxResult, toolboxFile, 5);
        expectReferenceAt(toolboxResult, groupedFile, 8);
      }

      const helperResult = await testFindReferences(index, helperFile, 5, 10, 2);
      expect(helperResult.status).toBe("ok");
      if (helperResult.status === "ok") {
        expectReferenceAt(helperResult, helperFile, 5);
        expectReferenceAt(helperResult, groupedFile, 9);
      }
    });

    it("should find references for fully-qualified Composer-mapped classes", async () => {
      const index = await createTestIndex("php");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "php");
      const serviceFile = path.join(samplePath, "src", "Domain", "Service.php").replace(/\\/g, "/");
      const qualifiedConsumerFile = path.join(samplePath, "composer-qualified-consumer.php").replace(/\\/g, "/");
      const staticConsumerFile = path.join(samplePath, "composer-static-qualified-consumer.php").replace(/\\/g, "/");
      const staticConstantConsumerFile = path
        .join(samplePath, "composer-static-constant-consumer.php")
        .replace(/\\/g, "/");
      const staticPropertyConsumerFile = path
        .join(samplePath, "composer-static-property-consumer.php")
        .replace(/\\/g, "/");
      const typedConsumerFile = path.join(samplePath, "composer-type-qualified-consumer.php").replace(/\\/g, "/");

      const result = await testFindReferences(index, serviceFile, 5, 7, 7);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expectReferenceAt(result, serviceFile, 5);
        expectReferenceAt(result, path.join(samplePath, "composer-consumer.php").replace(/\\/g, "/"), 5);
        expectReferenceAt(result, qualifiedConsumerFile, 3);
        expectReferenceAt(result, staticConsumerFile, 3);
        expectReferenceAt(result, staticConstantConsumerFile, 3);
        expectReferenceAt(result, staticPropertyConsumerFile, 3);
        expectReferenceAt(result, typedConsumerFile, 3);
        const uniqueRanges = new Set(
          result.references.map((reference) =>
            [reference.file, reference.range.start.index ?? -1, reference.range.end.index ?? -1].join(":"),
          ),
        );
        expect(uniqueRanges.size).toBe(result.references.length);
      }
    });

    it("should find references for Composer PSR-0, autoload-dev, classmap, and files entries", async () => {
      const index = await createTestIndex("php");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "php");
      const cases = [
        {
          definitionFile: path.join(samplePath, "legacy", "Tools", "Box.php").replace(/\\/g, "/"),
          definitionLine: 5,
          definitionColumn: 7,
          referenceFile: path.join(samplePath, "composer-psr0-consumer.php").replace(/\\/g, "/"),
          referenceLine: 5,
        },
        {
          definitionFile: path.join(samplePath, "dev-src", "Tool.php").replace(/\\/g, "/"),
          definitionLine: 5,
          definitionColumn: 7,
          referenceFile: path.join(samplePath, "composer-dev-psr4-consumer.php").replace(/\\/g, "/"),
          referenceLine: 5,
        },
        {
          definitionFile: path.join(samplePath, "dev-legacy", "Tools", "Box.php").replace(/\\/g, "/"),
          definitionLine: 5,
          definitionColumn: 7,
          referenceFile: path.join(samplePath, "composer-dev-psr0-consumer.php").replace(/\\/g, "/"),
          referenceLine: 5,
        },
        {
          definitionFile: path.join(samplePath, "classmap", "Specific.php").replace(/\\/g, "/"),
          definitionLine: 5,
          definitionColumn: 7,
          referenceFile: path.join(samplePath, "composer-classmap-consumer.php").replace(/\\/g, "/"),
          referenceLine: 5,
        },
        {
          definitionFile: path.join(samplePath, "dev-classmap", "DevSpecific.php").replace(/\\/g, "/"),
          definitionLine: 5,
          definitionColumn: 7,
          referenceFile: path.join(samplePath, "composer-dev-classmap-consumer.php").replace(/\\/g, "/"),
          referenceLine: 5,
        },
        {
          definitionFile: path.join(samplePath, "classmap", "Excluded", "PsrMapped.php").replace(/\\/g, "/"),
          definitionLine: 5,
          definitionColumn: 7,
          referenceFile: path.join(samplePath, "composer-excluded-psr4-consumer.php").replace(/\\/g, "/"),
          referenceLine: 6,
        },
        {
          definitionFile: path.join(samplePath, "classmap", "Excluded", "psr_helper.php").replace(/\\/g, "/"),
          definitionLine: 5,
          definitionColumn: 10,
          referenceFile: path.join(samplePath, "composer-excluded-psr4-consumer.php").replace(/\\/g, "/"),
          referenceLine: 7,
        },
        {
          definitionFile: path.join(samplePath, "autoload", "global_helper.php").replace(/\\/g, "/"),
          definitionLine: 3,
          definitionColumn: 10,
          referenceFile: path.join(samplePath, "composer-files-consumer.php").replace(/\\/g, "/"),
          referenceLine: 3,
        },
        {
          definitionFile: path.join(samplePath, "classmap", "Excluded", "excluded_helper.php").replace(/\\/g, "/"),
          definitionLine: 3,
          definitionColumn: 10,
          referenceFile: path.join(samplePath, "composer-excluded-files-consumer.php").replace(/\\/g, "/"),
          referenceLine: 3,
        },
      ];

      for (const testCase of cases) {
        const result = await testFindReferences(
          index,
          testCase.definitionFile,
          testCase.definitionLine,
          testCase.definitionColumn,
          2,
        );
        expect(result.status).toBe("ok");
        if (result.status === "ok") {
          expectReferenceAt(result, testCase.definitionFile, testCase.definitionLine);
          expectReferenceAt(result, testCase.referenceFile, testCase.referenceLine);
        }
      }
    });

    it("should find references for function imports when class names collide", async () => {
      const index = await createTestIndex("php");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "php");
      const functionFile = path.join(samplePath, "src", "Collision", "ThingFunction.php").replace(/\\/g, "/");
      const consumerFile = path.join(samplePath, "function-import-consumer.php").replace(/\\/g, "/");

      const result = await testFindReferences(index, functionFile, 5, 10, 2);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expectReferenceAt(result, functionFile, 5);
        expectReferenceAt(result, consumerFile, 5);
      }
    });

    it("should find references for classes declared in PHP bracketed namespace blocks", async () => {
      const index = await createTestIndex("php");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "php");
      const libraryFile = path.join(samplePath, "multi-namespace", "Library.php").replace(/\\/g, "/");
      const consumerFile = path.join(samplePath, "bracketed-consumer.php").replace(/\\/g, "/");
      const qualifiedConsumerFile = path.join(samplePath, "bracketed-qualified-consumer.php").replace(/\\/g, "/");

      const result = await testFindReferences(index, libraryFile, 8, 11, 3);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expectReferenceAt(result, libraryFile, 8);
        expectReferenceAt(result, consumerFile, 5);
        expectReferenceAt(result, qualifiedConsumerFile, 3);
      }
    });

    it("should find fully-qualified references for classes declared in later PHP namespace blocks", async () => {
      const root = path.resolve(process.cwd(), "tests", "samples", "php");
      const files = [
        path.join(root, "multi-namespace", "Library.php"),
        path.join(root, "bracketed-qualified-consumer.php"),
      ];
      const index = await createTestIndexFromFiles(root, files);
      const libraryFile = path.join(root, "multi-namespace", "Library.php").replace(/\\/g, "/");
      const qualifiedConsumerFile = path.join(root, "bracketed-qualified-consumer.php").replace(/\\/g, "/");

      const result = await testFindReferences(index, libraryFile, 8, 11, 2);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expectReferenceAt(result, libraryFile, 8);
        expectReferenceAt(result, qualifiedConsumerFile, 3);
      }
    });
  });

  describe("JavaScript", () => {
    it("should find all references to exported function", async () => {
      const index = await createTestIndex("javascript");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "javascript");
      const utilsFile = path.join(samplePath, "utils.js").replace(/\\/g, "/");

      // Test find-references on helperFunction definition on line 1
      const result = await testFindReferences(index, utilsFile, 1, 16, 3);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.references.length).toBeGreaterThanOrEqual(1);

        // Should include the definition itself
        const definitionRef = result.references.find((ref) => ref.file === utilsFile && ref.range.start.line === 1);
        expect(definitionRef).toBeDefined();
      }
    });

    it("should find all references to exported class", async () => {
      const index = await createTestIndex("javascript");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "javascript");
      const utilsFile = path.join(samplePath, "utils.js").replace(/\\/g, "/");

      // Test find-references on UtilityClass definition on line 5
      const result = await testFindReferences(index, utilsFile, 5, 14, 2);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.references.length).toBeGreaterThanOrEqual(1);

        // Should include the definition itself
        const definitionRef = result.references.find((ref) => ref.file === utilsFile && ref.range.start.line === 5);
        expect(definitionRef).toBeDefined();
      }
    });

    it("should find references to namespace member", async () => {
      const index = await createTestIndex("javascript");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "javascript");
      const utilsFile = path.join(samplePath, "utils.js").replace(/\\/g, "/");

      // Test find-references on helperFunction definition
      const result = await testFindReferences(index, utilsFile, 1, 16, 3);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        // Should find both direct usage and namespace usage
        const namespaceUsage = result.references.find(
          (ref) => ref.file.includes("main.js") && ref.via?.namespaceMember,
        );
        expect(namespaceUsage).toBeDefined();
      }
    });

    it("should find references to CommonJS exports", async () => {
      const index = await createTestIndex("javascript");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "javascript");
      const legacyFile = path.join(samplePath, "legacy.js").replace(/\\/g, "/");

      // Test find-references on legacyFunction definition on line 2
      const result = await testFindReferences(index, legacyFile, 2, 16, 3);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.references.length).toBeGreaterThanOrEqual(1);

        // Should include the definition itself
        const definitionRef = result.references.find((ref) => ref.file === legacyFile && ref.range.start.line === 2);
        expect(definitionRef).toBeDefined();
      }
    });

    it("should find references in mixed module systems", async () => {
      const index = await createTestIndex("javascript");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "javascript");
      const mixedFile = path.join(samplePath, "mixed.js").replace(/\\/g, "/");

      // Test find-references on mixedFunction definition on line 5
      const result = await testFindReferences(index, mixedFile, 5, 16, 1);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.references.length).toBeGreaterThanOrEqual(1);

        // Should include the definition itself
        const definitionRef = result.references.find((ref) => ref.file === mixedFile && ref.range.start.line === 5);
        expect(definitionRef).toBeDefined();
      }
    });
  });

  describe("Go", () => {
    it("should find all references to exported function", async () => {
      const index = await createTestIndex("go");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "go");
      const utilsFile = path.join(samplePath, "utils.go").replace(/\\/g, "/");

      const result = await testFindReferences(index, utilsFile, 5, 6, 1);
      if (result.status === "ok") {
        expect(
          result.references.some((reference) => reference.file === utilsFile && reference.range.start.line === 5),
        ).toBe(true);
      }
    });

    it("should find all references to exported struct type", async () => {
      const index = await createTestIndex("go");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "go");
      const utilsFile = path.join(samplePath, "utils.go").replace(/\\/g, "/");
      const mainFile = path.join(samplePath, "main.go").replace(/\\/g, "/");

      const result = await testFindReferences(index, utilsFile, 9, 6, 3);
      expectReferenceAt(result, utilsFile, 9);
      expectReferenceAt(result, mainFile, 12);
    });

    it("should find aliased and interface references to exported struct type", async () => {
      const index = await createTestIndex("go");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "go");
      const utilsFile = path.join(samplePath, "utils.go").replace(/\\/g, "/");
      const aliasedFile = path.join(samplePath, "aliased-types.go").replace(/\\/g, "/");
      const interfacesFile = path.join(samplePath, "interfaces.go").replace(/\\/g, "/");

      const result = await testFindReferences(index, utilsFile, 9, 6, 4);
      expectReferenceAt(result, aliasedFile, 9);
      expectReferenceAt(result, interfacesFile, 9);
    });

    it("should find embedded struct fields at direct and promoted uses", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "go");
      const embeddingFile = path.join(samplePath, "embedding.go").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [embeddingFile]);

      const result = await testFindReferences(index, embeddingFile, 4, 2, 4);
      expectReferenceAt(result, embeddingFile, 4);
      expectReferenceAt(result, embeddingFile, 8);
      expectReferenceAt(result, embeddingFile, 21);
      expectReferenceAt(result, embeddingFile, 22);
    });
    it("finds references for range index and value variables without indexing blanks", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "go");
      const rangeFile = path.join(samplePath, "range-variables.go").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [rangeFile]);

      const indexResult = await testFindReferences(index, rangeFile, 5, 6, 2);
      expectReferenceAt(indexResult, rangeFile, 5);
      expectReferenceAt(indexResult, rangeFile, 6);

      const valueResult = await testFindReferences(index, rangeFile, 5, 9, 2);
      expectReferenceAt(valueResult, rangeFile, 5);
      expectReferenceAt(valueResult, rangeFile, 6);
    });

    it("finds references to a generic type parameter within its own declaration, not a same-named type parameter on a sibling type", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-go-generic-references-"));
      try {
        const file = path.join(root, "main.go").replace(/\\/g, "/");
        await fsp.writeFile(
          file,
          [
            "package main",
            "",
            "type Box[T any] struct {",
            "\tValue T",
            "}",
            "",
            "type Pair[T any] struct {",
            "\tA T",
            "\tB T",
            "}",
            "",
          ].join("\n"),
          "utf8",
        );
        const index = await createTestIndexFromFiles(root, [file]);
        // Box's own T (line 3 col 10): only its own field use at line 4 should match, not Pair's T uses.
        const result = await testFindReferences(index, file, 3, 10, 1);
        expectReferenceAt(result, file, 4);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });
  });

  describe("C", () => {
    it("should find all references to shared function declaration", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "c");
      const utilsFile = path.join(samplePath, "utils.h").replace(/\\/g, "/");
      const mainFile = path.join(samplePath, "main.c").replace(/\\/g, "/");
      const helpersFile = path.join(samplePath, "helpers.h").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [mainFile, utilsFile, helpersFile]);

      const result = await testFindReferences(index, utilsFile, 8, 5, 2);
      expectReferenceAt(result, utilsFile, 8);
      expectReferenceAt(result, mainFile, 5);
    });

    it("should retain the typedef struct definition in references", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "c");
      const utilsFile = path.join(samplePath, "utils.h").replace(/\\/g, "/");
      const mainFile = path.join(samplePath, "main.c").replace(/\\/g, "/");
      const helpersFile = path.join(samplePath, "helpers.h").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [mainFile, utilsFile, helpersFile]);

      // The struct tag on line 4 and the typedef alias on line 6 are separate symbols now that C
      // uses query-driven locals like C++. References for the tag keep its own declaration plus the
      // cross-file use; the alias occurrence belongs to the alias symbol.
      const result = await testFindReferences(index, utilsFile, 4, 16, 2);
      expectReferenceAt(result, utilsFile, 4);
      expectReferenceAt(result, mainFile, 6);
    });

    it("should find references to function-pointer typedef use sites", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "c");
      const advancedUseFile = path.join(samplePath, "advanced-use.c").replace(/\\/g, "/");
      const functionPointersFile = path.join(samplePath, "function-pointers.h").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [advancedUseFile, functionPointersFile]);

      const result = await testFindReferences(index, functionPointersFile, 3, 15, 2);
      expectReferenceAt(result, functionPointersFile, 3);
      expectReferenceAt(result, advancedUseFile, 4);
    });

    it("does not recover macro-expanded typedef use sites", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "c");
      const advancedUseFile = path.join(samplePath, "advanced-use.c").replace(/\\/g, "/");
      const functionPointersFile = path.join(samplePath, "function-pointers.h").replace(/\\/g, "/");
      const macroHeaderFile = path.join(samplePath, "macro-typedef.h").replace(/\\/g, "/");
      const macroUseFile = path.join(samplePath, "macro-typedef-use.c").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [
        advancedUseFile,
        functionPointersFile,
        macroHeaderFile,
        macroUseFile,
      ]);

      const result = await testFindReferences(index, functionPointersFile, 3, 15, 2);
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expectReferenceAt(result, functionPointersFile, 3);
        expectReferenceAt(result, advancedUseFile, 4);
        const macroInvocationRecovered = result.references.some(
          (reference) => reference.file === macroUseFile && reference.range.start.line === 4,
        );
        expect(macroInvocationRecovered).toBe(false);
      }
    });
  });

  describe("C++", () => {
    it("should find all references to shared function declaration", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "cpp");
      const utilsFile = path.join(samplePath, "utils.hpp").replace(/\\/g, "/");
      const mainFile = path.join(samplePath, "main.cpp").replace(/\\/g, "/");
      const helpersFile = path.join(samplePath, "helpers.hpp").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [mainFile, utilsFile, helpersFile]);

      const result = await testFindReferences(index, utilsFile, 7, 5, 2);
      expectReferenceAt(result, utilsFile, 7);
      expectReferenceAt(result, mainFile, 5);
    });

    it("should find all references to shared struct type", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "cpp");
      const utilsFile = path.join(samplePath, "utils.hpp").replace(/\\/g, "/");
      const mainFile = path.join(samplePath, "main.cpp").replace(/\\/g, "/");
      const helpersFile = path.join(samplePath, "helpers.hpp").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [mainFile, utilsFile, helpersFile]);

      const result = await testFindReferences(index, utilsFile, 3, 8, 2);
      expectReferenceAt(result, utilsFile, 3);
      expectReferenceAt(result, mainFile, 6);
    });

    it("should find references to namespace-qualified alias targets", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "cpp");
      const usageFile = path.join(samplePath, "namespace-usage.cpp").replace(/\\/g, "/");
      const namespaceFile = path.join(samplePath, "namespaces.hpp").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [usageFile, namespaceFile]);

      const result = await testFindReferences(index, namespaceFile, 4, 7, 2);
      expectReferenceAt(result, namespaceFile, 4);
      expectReferenceAt(result, usageFile, 4);
    });
  });

  describe("Kotlin", () => {
    it("should find all references to imported function", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "kotlin");
      const utilsFile = path.join(samplePath, "utils", "helperFunction.kt").replace(/\\/g, "/");
      const mainFile = path.join(samplePath, "main.kt").replace(/\\/g, "/");
      const helpersFile = path.join(samplePath, "helpers", "helperFromHelpers.kt").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [mainFile, utilsFile, helpersFile]);

      const result = await testFindReferences(index, utilsFile, 3, 5, 2);
      expectReferenceAt(result, utilsFile, 3);
      expectReferenceAt(result, mainFile, 6);
    });

    it("should retain the imported class definition in references", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "kotlin");
      const utilsFile = path.join(samplePath, "utils", "helperFunction.kt").replace(/\\/g, "/");
      const mainFile = path.join(samplePath, "main.kt").replace(/\\/g, "/");
      const helpersFile = path.join(samplePath, "helpers", "helperFromHelpers.kt").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [mainFile, utilsFile, helpersFile]);

      const result = await testFindReferences(index, utilsFile, 7, 7, 2);
      expectReferenceAt(result, utilsFile, 7);
      expectReferenceAt(result, mainFile, 7);
    });

    it("should find wildcard-imported references to type aliases", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "kotlin");
      const consumerFile = path.join(samplePath, "TypeConsumers.kt").replace(/\\/g, "/");
      const moreTypesFile = path.join(samplePath, "utils", "MoreTypes.kt").replace(/\\/g, "/");
      const helperFile = path.join(samplePath, "utils", "helperFunction.kt").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [consumerFile, moreTypesFile, helperFile]);

      const result = await testFindReferences(index, moreTypesFile, 3, 11, 2);
      expectReferenceAt(result, moreTypesFile, 3);
      expectReferenceAt(result, consumerFile, 3);
    });

    it("should find wildcard-imported references to helper functions", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "kotlin");
      const consumerFile = path.join(samplePath, "TypeConsumers.kt").replace(/\\/g, "/");
      const moreTypesFile = path.join(samplePath, "utils", "MoreTypes.kt").replace(/\\/g, "/");
      const helperFile = path.join(samplePath, "utils", "helperFunction.kt").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [consumerFile, moreTypesFile, helperFile]);

      const result = await testFindReferences(index, helperFile, 3, 5, 2);
      expectReferenceAt(result, helperFile, 3);
      expectReferenceAt(result, consumerFile, 12);
    });

    it("finds property and method navigation without same-named decoy or local uses", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-member-refs-"));
      try {
        const file = path.join(root, "box.kt").replace(/\\/g, "/");
        const source = [
          "class Box {",
          "  val payload = 1",
          "  fun ping(): Int = payload",
          "}",
          "class Decoy {",
          "  val payload = 2",
          "  fun ping(): Int = payload",
          "}",
          "fun use(box: Box) {",
          "  val payload = 99",
          "  val ping = 99",
          "  val x = box.payload",
          "  box.ping()",
          "}",
          "fun other(decoy: Decoy) {",
          "  decoy.payload",
          "  decoy.ping()",
          "}",
          "",
        ].join("\n");
        await fsp.writeFile(file, source, "utf8");
        const index = await createTestIndexFromFiles(root, [file]);
        const columnOf = (line: number, token: string): number => {
          const text = source.split("\n")[line - 1];
          if (!text) throw new Error(`missing line ${line}`);
          const indexOf = text.indexOf(token);
          if (indexOf < 0) throw new Error(`token not found on line ${line}: ${token}`);
          return indexOf + 1;
        };

        const payloadRefs = await testFindReferences(index, file, 2, columnOf(2, "payload"), 3);
        expectReferenceAt(payloadRefs, file, 2);
        expectReferenceAt(payloadRefs, file, 3);
        expectReferenceAt(payloadRefs, file, 12);
        if (payloadRefs.status === "ok") {
          const payloadLines = payloadRefs.references.map((reference) => reference.range.start.line);
          expect(payloadLines).not.toContain(6);
          expect(payloadLines).not.toContain(10);
          expect(payloadLines).not.toContain(16);
        }

        const pingRefs = await testFindReferences(index, file, 3, columnOf(3, "ping"), 2);
        expectReferenceAt(pingRefs, file, 3);
        expectReferenceAt(pingRefs, file, 13);
        if (pingRefs.status === "ok") {
          const pingLines = pingRefs.references.map((reference) => reference.range.start.line);
          expect(pingLines).not.toContain(7);
          expect(pingLines).not.toContain(11);
          expect(pingLines).not.toContain(17);
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });
  });

  describe("Swift", () => {
    it("should find all references to imported function", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "swift");
      const utilsFile = path.join(samplePath, "Utils.swift").replace(/\\/g, "/");
      const mainFile = path.join(samplePath, "main.swift").replace(/\\/g, "/");
      const helpersFile = path.join(samplePath, "Helpers.swift").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [mainFile, utilsFile, helpersFile]);

      const result = await testFindReferences(index, utilsFile, 1, 13, 2);
      expectReferenceAt(result, utilsFile, 1);
      expectReferenceAt(result, mainFile, 5);
    });

    it("should find all references to imported struct", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "swift");
      const utilsFile = path.join(samplePath, "Utils.swift").replace(/\\/g, "/");
      const mainFile = path.join(samplePath, "main.swift").replace(/\\/g, "/");
      const helpersFile = path.join(samplePath, "Helpers.swift").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [mainFile, utilsFile, helpersFile]);

      const result = await testFindReferences(index, utilsFile, 5, 15, 2);
      expectReferenceAt(result, utilsFile, 5);
      expectReferenceAt(result, mainFile, 6);
    });

    it("should find references to imported static factory types", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "swift");
      const usageFile = path.join(samplePath, "AdvancedUsage.swift").replace(/\\/g, "/");
      const staticMembersFile = path.join(samplePath, "StaticMembers.swift").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "Utils.swift").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [usageFile, staticMembersFile, utilsFile]);

      const result = await testFindReferences(index, staticMembersFile, 6, 8, 2);
      expectReferenceAt(result, staticMembersFile, 6);
      expectReferenceAt(result, usageFile, 4);
    });
  });

  describe("Zig", () => {
    it("should find references to imported function members", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "zig");
      const mainFile = path.join(samplePath, "main.zig").replace(/\\/g, "/");
      const helpersFile = path.join(samplePath, "helpers.zig").replace(/\\/g, "/");
      const mathFile = path.join(samplePath, "math.zig").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [mainFile, helpersFile, mathFile]);

      const result = await testFindReferences(index, helpersFile, 1, 8, 2);
      expectReferenceAt(result, helpersFile, 1);
      expectReferenceAt(result, mainFile, 5);
    });

    it("should find references to imported type members", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "zig");
      const mainFile = path.join(samplePath, "main.zig").replace(/\\/g, "/");
      const helpersFile = path.join(samplePath, "helpers.zig").replace(/\\/g, "/");
      const mathFile = path.join(samplePath, "math.zig").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [mainFile, helpersFile, mathFile]);

      const result = await testFindReferences(index, mathFile, 1, 11, 2);
      expectReferenceAt(result, mathFile, 1);
      expectReferenceAt(result, mainFile, 5);
    });
  });

  describe("C#", () => {
    it("should find all references to static method", async () => {
      const index = await createTestIndex("csharp");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "csharp");
      const utilsFile = path.join(samplePath, "Utils.cs").replace(/\\/g, "/");
      // helperFunction definition line 3 col ~24
      await testFindReferences(index, utilsFile, 3, 24, 3);
    });

    it("should find all references to nested class", async () => {
      const index = await createTestIndex("csharp");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "csharp");
      const utilsFile = path.join(samplePath, "Utils.cs").replace(/\\/g, "/");
      // UtilityClass definition line 4 col ~20
      await testFindReferences(index, utilsFile, 4, 20, 2);
    });

    it("should find references to namespace member", async () => {
      const index = await createTestIndex("csharp");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "csharp");
      const utilsFile = path.join(samplePath, "Utils.cs").replace(/\\/g, "/");
      // UtilsClass definition line 2 col ~20
      await testFindReferences(index, utilsFile, 2, 20, 3);
    });

    it("should find references to aliased member", async () => {
      const index = await createTestIndex("csharp");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "csharp");
      const utilsFile = path.join(samplePath, "Utils.cs").replace(/\\/g, "/");
      await testFindReferences(index, utilsFile, 2, 20, 3);
    });

    it("keeps a local function's references scoped to its own method, not a same-named local function in another method", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-csharp-localfn-references-"));
      try {
        const mainFile = path.join(root, "Main.cs").replace(/\\/g, "/");
        await fsp.writeFile(
          mainFile,
          [
            "class Program {",
            "  void RunA() {",
            "    void Local() { }",
            "    Local();",
            "  }",
            "  void RunB() {",
            "    void Local() { }",
            "    Local();",
            "  }",
            "}",
            "",
          ].join("\n"),
          "utf8",
        );
        const index = await createTestIndexFromFiles(root, [mainFile]);
        // RunA's Local() declaration, line 3 col 10: only its own call at line 4 should match.
        const result = await testFindReferences(index, mainFile, 3, 10, 1);
        expectReferenceAt(result, mainFile, 4);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });
  });

  describe("Java", () => {
    it("should find references to imported annotation types", async () => {
      const index = await createTestIndex("java");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "java");
      const annotationFile = path.join(samplePath, "AnnotationTypes.java").replace(/\\/g, "/");
      const consumerFile = path.join(samplePath, "AnnotationConsumer.java").replace(/\\/g, "/");

      const result = await testFindReferences(index, annotationFile, 3, 19, 3);
      expectReferenceAt(result, annotationFile, 3);
      expectReferenceAt(result, consumerFile, 3);
      expectReferenceAt(result, consumerFile, 5);
    });

    it("should find references to wildcard-imported interfaces", async () => {
      const index = await createTestIndex("java");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "java");
      const packageFile = path.join(samplePath, "pkg", "PackageTypes.java").replace(/\\/g, "/");
      const wildcardFile = path.join(samplePath, "WildcardImports.java").replace(/\\/g, "/");

      const result = await testFindReferences(index, packageFile, 7, 11, 2);
      expectReferenceAt(result, packageFile, 7);
      expectReferenceAt(result, wildcardFile, 7);
    });

    it("should find references to wildcard-imported package interfaces across files", async () => {
      const index = await createTestIndex("java");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "java");
      const packageFile = path.join(samplePath, "pkg", "PackageService.java").replace(/\\/g, "/");
      const wildcardFile = path.join(samplePath, "WildcardImports.java").replace(/\\/g, "/");

      const result = await testFindReferences(index, packageFile, 3, 18, 2);
      expectReferenceAt(result, packageFile, 3);
      expectReferenceAt(result, wildcardFile, 8);
    });

    it("should find references to static wildcard-imported methods", async () => {
      const index = await createTestIndex("java");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "java");
      const utilsFile = path.join(samplePath, "utils", "Utils.java").replace(/\\/g, "/");
      const wildcardFile = path.join(samplePath, "StaticWildcardImports.java").replace(/\\/g, "/");

      const result = await testFindReferences(index, utilsFile, 4, 22, 2);
      expectReferenceAt(result, utilsFile, 4);
      expectReferenceAt(result, wildcardFile, 7);
    });
  });
  describe("Ruby", () => {
    it("should find all references to module function", async () => {
      const index = await createTestIndex("ruby");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "ruby");
      const utilsFile = path.join(samplePath, "utils.rb").replace(/\\/g, "/");
      // helper_function definition line 2 col 12
      await testFindReferences(index, utilsFile, 2, 12, 2);
    });
    it("should find all references to class", async () => {
      const index = await createTestIndex("ruby");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "ruby");
      const utilsFile = path.join(samplePath, "utils.rb").replace(/\\/g, "/");
      // UtilityClass definition line 4 col 10
      await testFindReferences(index, utilsFile, 4, 10, 2);
    });

    it("should find references to namespaced classes", async () => {
      const index = await createTestIndex("ruby");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "ruby");
      const namespacedFile = path.join(samplePath, "namespaced.rb").replace(/\\/g, "/");
      const consumerFile = path.join(samplePath, "consumer.rb").replace(/\\/g, "/");

      const result = await testFindReferences(index, namespacedFile, 5, 11, 2);
      expectReferenceAt(result, namespacedFile, 5);
      expectReferenceAt(result, consumerFile, 3);
    });
  });

  describe("Rust", () => {
    it("should find all references to helper_function", async () => {
      const index = await createTestIndex("rust");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "rust");
      const utilsFile = path.join(samplePath, "utils.rs").replace(/\\/g, "/");
      // helper_function definition line 1 col 8
      await testFindReferences(index, utilsFile, 1, 8, 2);
    });
    it("should find all references to helper_from_helpers", async () => {
      const index = await createTestIndex("rust");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "rust");
      const helpersFile = path.join(samplePath, "helpers.rs").replace(/\\/g, "/");
      // helper_from_helpers definition line 1 col 8
      await testFindReferences(index, helpersFile, 1, 8, 2);
    });

    it("should find references to nested module types", async () => {
      const index = await createTestIndex("rust");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "rust");
      const nestedFile = path.join(samplePath, "nested.rs").replace(/\\/g, "/");
      const nestedServiceFile = path.join(samplePath, "nested_service.rs").replace(/\\/g, "/");

      const result = await testFindReferences(index, nestedServiceFile, 1, 12, 2);
      expectReferenceAt(result, nestedServiceFile, 1);
      expectReferenceAt(result, nestedFile, 6);
    });

    it("should find references through aliased Rust imports", async () => {
      const index = await createTestIndex("rust");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "rust");
      const utilsFile = path.join(samplePath, "utils.rs").replace(/\\/g, "/");
      const aliasFile = path.join(samplePath, "aliased-use.rs").replace(/\\/g, "/");

      const result = await testFindReferences(index, utilsFile, 1, 8, 3);
      expectReferenceAt(result, aliasFile, 9);
    });

    it("finds references through crate #[path] modules and ignores conventional decoys", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-rust-path-attr-refs-"));
      try {
        const src = path.join(root, "src");
        await fsp.mkdir(src, { recursive: true });
        await fsp.writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "path-attr-refs"\nversion = "0.1.0"\n');
        await fsp.writeFile(path.join(src, "lib.rs"), '#[path = "custom.rs"]\nmod external;\npub mod consumer;\n');
        const customFile = path.join(src, "custom.rs").replace(/\\/g, "/");
        const decoyFile = path.join(src, "external.rs").replace(/\\/g, "/");
        const consumerFile = path.join(src, "consumer.rs").replace(/\\/g, "/");
        await fsp.writeFile(customFile, "pub struct Thing;\n");
        await fsp.writeFile(decoyFile, "pub struct Decoy;\n");
        await fsp.writeFile(
          consumerFile,
          [
            "use crate::external::Thing;",
            '#[path = "decoy.rs"]',
            "mod external;",
            "pub fn consume() {",
            "    let _t = Thing;",
            "}",
            "",
          ].join("\n"),
        );
        await fsp.writeFile(path.join(src, "decoy.rs"), "pub struct Thing;\n");
        const index = await createTestIndexFromFiles(root, [
          path.join(src, "lib.rs"),
          customFile,
          decoyFile,
          consumerFile,
          path.join(src, "decoy.rs"),
        ]);
        const result = await testFindReferences(index, customFile, 1, 12, 2);
        expect(result.status).toBe("ok");
        expectReferenceAt(result, customFile, 1);
        expectReferenceAt(result, consumerFile, 5);
        if (result.status === "ok") {
          expect(result.references.some((reference) => path.basename(reference.file) === "external.rs")).toBe(false);
          expect(result.references.some((reference) => path.basename(reference.file) === "decoy.rs")).toBe(false);
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("finds references to the reachable #[path] module owner and never the undeclared decoy", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-rust-path-owner-refs-"));
      try {
        const src = path.join(root, "src");
        await fsp.mkdir(src, { recursive: true });
        await fsp.writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "path-owner"\nversion = "0.1.0"\n');
        const realFile = path.join(src, "real.rs").replace(/\\/g, "/");
        const orphanFile = path.join(src, "aaa_orphan.rs").replace(/\\/g, "/");
        const sharedFile = path.join(src, "shared.rs").replace(/\\/g, "/");
        await fsp.writeFile(path.join(src, "lib.rs"), "mod real;\npub struct RootThing;\n");
        await fsp.writeFile(realFile, '#[path = "shared.rs"]\nmod shared;\npub struct RealThing;\n');
        await fsp.writeFile(orphanFile, '#[path = "shared.rs"]\nmod shared;\npub struct OrphanThing;\n');
        await fsp.writeFile(
          sharedFile,
          ["use super::RealThing;", "pub fn take() -> RealThing {", "    RealThing", "}", ""].join("\n"),
        );
        const index = await createTestIndexFromFiles(root, [
          path.join(src, "lib.rs"),
          realFile,
          orphanFile,
          sharedFile,
        ]);
        const declLine = "pub struct RealThing;";
        const result = await testFindReferences(index, realFile, 3, declLine.indexOf("RealThing") + 1, 3);
        expectReferenceAt(result, realFile, 3);
        expectReferenceAt(result, sharedFile, 1);
        expectReferenceAt(result, sharedFile, 3);
        if (result.status === "ok") {
          expect(result.references.some((reference) => path.basename(reference.file) === "aaa_orphan.rs")).toBe(false);
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("finds references through a custom library path and never a stray src/lib.rs", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-rust-path-owner-custom-lib-refs-"));
      try {
        const src = path.join(root, "src");
        const customDir = path.join(root, "custom");
        await fsp.mkdir(src, { recursive: true });
        await fsp.mkdir(customDir, { recursive: true });
        await fsp.writeFile(
          path.join(root, "Cargo.toml"),
          '[package]\nname = "path-owner-custom-lib"\nversion = "0.1.0"\n\n[lib]\npath = "custom/root.rs"\n',
        );
        const customFile = path.join(customDir, "root.rs").replace(/\\/g, "/");
        const strayLib = path.join(src, "lib.rs").replace(/\\/g, "/");
        const sharedFile = path.join(src, "shared.rs").replace(/\\/g, "/");
        await fsp.writeFile(customFile, '#[path = "../src/shared.rs"]\nmod shared;\npub struct CustomThing;\n');
        await fsp.writeFile(strayLib, '#[path = "shared.rs"]\nmod shared;\npub struct StrayThing;\n');
        await fsp.writeFile(
          sharedFile,
          ["use super::CustomThing;", "pub fn take() -> CustomThing {", "    CustomThing", "}", ""].join("\n"),
        );
        const index = await createTestIndexFromFiles(root, [customFile, strayLib, sharedFile]);
        const declLine = "pub struct CustomThing;";
        const result = await testFindReferences(index, customFile, 3, declLine.indexOf("CustomThing") + 1, 3);
        expectReferenceAt(result, customFile, 3);
        expectReferenceAt(result, sharedFile, 1);
        expectReferenceAt(result, sharedFile, 3);
        if (result.status === "ok") {
          expect(result.references.some((reference) => path.basename(reference.file) === "lib.rs")).toBe(false);
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("finds references without treating src/main.rs as a crate root when autobins is false", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-rust-path-owner-autobins-refs-"));
      try {
        const src = path.join(root, "src");
        await fsp.mkdir(src, { recursive: true });
        await fsp.writeFile(
          path.join(root, "Cargo.toml"),
          '[package]\nname = "path-owner-autobins"\nversion = "0.1.0"\nautobins = false\n',
        );
        const realFile = path.join(src, "real.rs").replace(/\\/g, "/");
        const mainFile = path.join(src, "main.rs").replace(/\\/g, "/");
        const sharedFile = path.join(src, "shared.rs").replace(/\\/g, "/");
        await fsp.writeFile(path.join(src, "lib.rs"), "mod real;\n");
        await fsp.writeFile(realFile, '#[path = "shared.rs"]\nmod shared;\npub struct RealThing;\n');
        await fsp.writeFile(mainFile, '#[path = "shared.rs"]\nmod shared;\nfn main() {}\n');
        await fsp.writeFile(
          sharedFile,
          ["use super::RealThing;", "pub fn take() -> RealThing {", "    RealThing", "}", ""].join("\n"),
        );
        const index = await createTestIndexFromFiles(root, [path.join(src, "lib.rs"), realFile, mainFile, sharedFile]);
        const declLine = "pub struct RealThing;";
        const result = await testFindReferences(index, realFile, 3, declLine.indexOf("RealThing") + 1, 3);
        expectReferenceAt(result, realFile, 3);
        expectReferenceAt(result, sharedFile, 1);
        expectReferenceAt(result, sharedFile, 3);
        if (result.status === "ok") {
          expect(result.references.some((reference) => path.basename(reference.file) === "main.rs")).toBe(false);
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("finds references through an explicit named bin without path when autobins is false", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-rust-path-owner-named-bin-refs-"));
      try {
        const src = path.join(root, "src");
        const binDir = path.join(src, "bin");
        await fsp.mkdir(binDir, { recursive: true });
        await fsp.writeFile(
          path.join(root, "Cargo.toml"),
          '[package]\nname = "named-bin"\nversion = "0.1.0"\nautobins = false\nautolib = false\n\n[[bin]]\nname = "tool"\n',
        );
        const ownerFile = path.join(binDir, "tool.rs").replace(/\\/g, "/");
        const decoyFile = path.join(src, "aaa_decoy.rs").replace(/\\/g, "/");
        const sharedFile = path.join(src, "shared.rs").replace(/\\/g, "/");
        await fsp.writeFile(ownerFile, '#[path = "../shared.rs"]\nmod shared;\npub struct NamedThing;\n');
        await fsp.writeFile(decoyFile, '#[path = "shared.rs"]\nmod shared;\npub struct DecoyThing;\n');
        await fsp.writeFile(
          sharedFile,
          ["use super::NamedThing;", "pub fn take() -> NamedThing {", "    NamedThing", "}", ""].join("\n"),
        );
        const index = await createTestIndexFromFiles(root, [ownerFile, decoyFile, sharedFile]);
        const declLine = "pub struct NamedThing;";
        const result = await testFindReferences(index, ownerFile, 3, declLine.indexOf("NamedThing") + 1, 3);
        expectReferenceAt(result, ownerFile, 3);
        expectReferenceAt(result, sharedFile, 1);
        expectReferenceAt(result, sharedFile, 3);
        if (result.status === "ok") {
          expect(result.references.some((reference) => path.basename(reference.file) === "aaa_decoy.rs")).toBe(false);
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("finds references through an explicit [lib] table when autolib is false", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-rust-path-owner-explicit-lib-refs-"));
      try {
        const src = path.join(root, "src");
        await fsp.mkdir(src, { recursive: true });
        await fsp.writeFile(
          path.join(root, "Cargo.toml"),
          '[package]\nname = "explicit-lib"\nversion = "0.1.0"\nautolib = false\n\n[lib]\n',
        );
        const libFile = path.join(src, "lib.rs").replace(/\\/g, "/");
        const decoyFile = path.join(src, "aaa_decoy.rs").replace(/\\/g, "/");
        const sharedFile = path.join(src, "shared.rs").replace(/\\/g, "/");
        await fsp.writeFile(libFile, '#[path = "shared.rs"]\nmod shared;\npub struct LibThing;\n');
        await fsp.writeFile(decoyFile, '#[path = "shared.rs"]\nmod shared;\npub struct DecoyThing;\n');
        await fsp.writeFile(
          sharedFile,
          ["use super::LibThing;", "pub fn take() -> LibThing {", "    LibThing", "}", ""].join("\n"),
        );
        const index = await createTestIndexFromFiles(root, [libFile, decoyFile, sharedFile]);
        const declLine = "pub struct LibThing;";
        const result = await testFindReferences(index, libFile, 3, declLine.indexOf("LibThing") + 1, 3);
        expectReferenceAt(result, libFile, 3);
        expectReferenceAt(result, sharedFile, 1);
        expectReferenceAt(result, sharedFile, 3);
        if (result.status === "ok") {
          expect(result.references.some((reference) => path.basename(reference.file) === "aaa_decoy.rs")).toBe(false);
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("finds references without treating a virtual workspace root as a package", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-rust-path-owner-virtual-ws-refs-"));
      try {
        const src = path.join(root, "src");
        const pkgSrc = path.join(root, "pkg", "src");
        await fsp.mkdir(src, { recursive: true });
        await fsp.mkdir(pkgSrc, { recursive: true });
        await fsp.writeFile(path.join(root, "Cargo.toml"), '[workspace]\nmembers = ["pkg"]\n');
        await fsp.writeFile(path.join(root, "pkg", "Cargo.toml"), '[package]\nname = "pkg"\nversion = "0.1.0"\n');
        await fsp.writeFile(path.join(pkgSrc, "lib.rs"), "");
        const strayBuild = path.join(root, "build.rs").replace(/\\/g, "/");
        const ownerFile = path.join(src, "aaa_owner.rs").replace(/\\/g, "/");
        const sharedFile = path.join(src, "shared.rs").replace(/\\/g, "/");
        await fsp.writeFile(strayBuild, '#[path = "src/shared.rs"]\nmod shared;\npub struct WorkspaceThing;\n');
        await fsp.writeFile(ownerFile, '#[path = "shared.rs"]\nmod shared;\npub struct OwnerThing;\n');
        await fsp.writeFile(
          sharedFile,
          ["use super::OwnerThing;", "pub fn take() -> OwnerThing {", "    OwnerThing", "}", ""].join("\n"),
        );
        const index = await createTestIndexFromFiles(root, [strayBuild, ownerFile, sharedFile]);
        const declLine = "pub struct OwnerThing;";
        const result = await testFindReferences(index, ownerFile, 3, declLine.indexOf("OwnerThing") + 1, 3);
        expectReferenceAt(result, ownerFile, 3);
        expectReferenceAt(result, sharedFile, 1);
        expectReferenceAt(result, sharedFile, 3);
        if (result.status === "ok") {
          expect(result.references.some((reference) => path.basename(reference.file) === "build.rs")).toBe(false);
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("finds references when a reachable #[path] uses a differently cased spelling of the target", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-rust-path-owner-case-fold-refs-"));
      try {
        const src = path.join(root, "src");
        await fsp.mkdir(src, { recursive: true });
        await fsp.writeFile(
          path.join(root, "Cargo.toml"),
          '[package]\nname = "path-owner-case-fold"\nversion = "0.1.0"\n',
        );
        const libFile = path.join(src, "lib.rs").replace(/\\/g, "/");
        const decoyFile = path.join(src, "aaa_decoy.rs").replace(/\\/g, "/");
        const sharedFile = path.join(src, "shared.rs").replace(/\\/g, "/");
        await fsp.writeFile(libFile, '#[path = "SHARED.rs"]\nmod shared;\npub struct CaseThing;\n');
        await fsp.writeFile(decoyFile, '#[path = "shared.rs"]\nmod shared;\npub struct DecoyThing;\n');
        await fsp.writeFile(
          sharedFile,
          ["use super::CaseThing;", "pub fn take() -> CaseThing {", "    CaseThing", "}", ""].join("\n"),
        );
        try {
          await fsp.stat(path.join(src, "SHARED.rs"));
        } catch {
          return;
        }
        const index = await createTestIndexFromFiles(root, [libFile, decoyFile, sharedFile]);
        const declLine = "pub struct CaseThing;";
        const result = await testFindReferences(index, libFile, 3, declLine.indexOf("CaseThing") + 1, 3);
        expectReferenceAt(result, libFile, 3);
        expectReferenceAt(result, sharedFile, 1);
        expectReferenceAt(result, sharedFile, 3);
        if (result.status === "ok") {
          expect(result.references.some((reference) => path.basename(reference.file) === "aaa_decoy.rs")).toBe(false);
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("finds references through a conventional child of a custom crate-root filename", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-rust-path-owner-custom-child-refs-"));
      try {
        const src = path.join(root, "src");
        const customDir = path.join(root, "custom");
        await fsp.mkdir(src, { recursive: true });
        await fsp.mkdir(path.join(customDir, "root"), { recursive: true });
        await fsp.writeFile(
          path.join(root, "Cargo.toml"),
          '[package]\nname = "custom-child"\nversion = "0.1.0"\n\n[lib]\npath = "custom/root.rs"\n',
        );
        const customRoot = path.join(customDir, "root.rs").replace(/\\/g, "/");
        const ownerFile = path.join(customDir, "owner.rs").replace(/\\/g, "/");
        const nestedDecoy = path.join(customDir, "root", "owner.rs").replace(/\\/g, "/");
        const sharedFile = path.join(src, "shared.rs").replace(/\\/g, "/");
        await fsp.writeFile(customRoot, "mod owner;\n");
        await fsp.writeFile(ownerFile, '#[path = "../src/shared.rs"]\nmod shared;\npub struct OwnerThing;\n');
        await fsp.writeFile(nestedDecoy, '#[path = "../../src/shared.rs"]\nmod shared;\npub struct NestedThing;\n');
        await fsp.writeFile(
          sharedFile,
          ["use super::OwnerThing;", "pub fn take() -> OwnerThing {", "    OwnerThing", "}", ""].join("\n"),
        );
        const index = await createTestIndexFromFiles(root, [customRoot, ownerFile, nestedDecoy, sharedFile]);
        const declLine = "pub struct OwnerThing;";
        const result = await testFindReferences(index, ownerFile, 3, declLine.indexOf("OwnerThing") + 1, 3);
        expectReferenceAt(result, ownerFile, 3);
        expectReferenceAt(result, sharedFile, 1);
        expectReferenceAt(result, sharedFile, 3);
        if (result.status === "ok") {
          expect(
            result.references.some(
              (reference) =>
                path.basename(reference.file) === "owner.rs" && path.basename(path.dirname(reference.file)) === "root",
            ),
          ).toBe(false);
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("finds references through a raw-identifier conventional module", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-rust-path-owner-raw-ident-refs-"));
      try {
        const src = path.join(root, "src");
        await fsp.mkdir(src, { recursive: true });
        await fsp.writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "raw-ident"\nversion = "0.1.0"\n');
        const libFile = path.join(src, "lib.rs").replace(/\\/g, "/");
        const typeFile = path.join(src, "type.rs").replace(/\\/g, "/");
        const decoyFile = path.join(src, "aaa_decoy.rs").replace(/\\/g, "/");
        const sharedFile = path.join(src, "shared.rs").replace(/\\/g, "/");
        await fsp.writeFile(libFile, "mod r#type;\n");
        await fsp.writeFile(typeFile, '#[path = "shared.rs"]\nmod shared;\npub struct TypeThing;\n');
        await fsp.writeFile(decoyFile, '#[path = "shared.rs"]\nmod shared;\npub struct DecoyThing;\n');
        await fsp.writeFile(
          sharedFile,
          ["use super::TypeThing;", "pub fn take() -> TypeThing {", "    TypeThing", "}", ""].join("\n"),
        );
        const index = await createTestIndexFromFiles(root, [libFile, typeFile, decoyFile, sharedFile]);
        const declLine = "pub struct TypeThing;";
        const result = await testFindReferences(index, typeFile, 3, declLine.indexOf("TypeThing") + 1, 3);
        expectReferenceAt(result, typeFile, 3);
        expectReferenceAt(result, sharedFile, 1);
        expectReferenceAt(result, sharedFile, 3);
        if (result.status === "ok") {
          expect(result.references.some((reference) => path.basename(reference.file) === "aaa_decoy.rs")).toBe(false);
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("finds macro_rules definitions and invocations", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "rust");
      const macroFile = path.join(samplePath, ".regressions", "macros.rs").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [macroFile]);
      const result = await testFindReferences(index, macroFile, 1, 14, 2);

      expect(result.status).toBe("ok");
      expectReferenceAt(result, macroFile, 1);
      expectReferenceAt(result, macroFile, 6);
    });
  });
  describe("JavaScript and TypeScript export-from references", () => {
    const sampleCases = [
      {
        label: "TypeScript",
        language: "typescript" as const,
        extension: "ts",
        utilsFile: "utils.ts",
        mainFile: "main.ts",
        localLines: [1, 7, 11, 16],
      },
      {
        label: "JavaScript",
        language: "javascript" as const,
        helperFile: "helpers.js",
        utilsFile: "utils.js",
        mainFile: "main.js",
        localLines: [1, 7, 11, 16, 31],
      },
    ];

    for (const testCase of sampleCases) {
      it(`excludes ${testCase.label} export-from clauses from local references`, async () => {
        const index = await createTestIndex(testCase.language);
        const samplePath = path.resolve(process.cwd(), "tests", "samples", testCase.language);
        const utilsFile = path.join(samplePath, testCase.utilsFile).replace(/\\/g, "/");
        const mainFile = path.join(samplePath, testCase.mainFile).replace(/\\/g, "/");

        const localResult = await testFindReferences(index, utilsFile, 1, 16, testCase.localLines.length);
        expect(localResult.status).toBe("ok");
        if (localResult.status === "ok") {
          const expectedLocalSites = [
            [mainFile, 1],
            [mainFile, 3],
            [mainFile, 3],
            ...testCase.localLines
              .slice(1)
              .filter((line) => line !== 31)
              .map((line) => [mainFile, line]),
            [utilsFile, testCase.localLines[0]],
            ...(testCase.localLines.at(-1) === 31 ? [[utilsFile, 31]] : []),
          ];
          expect(localResult.references.map((reference) => [reference.file, reference.range.start.line])).toEqual(
            expectedLocalSites,
          );
          const reexportLine = testCase.extension === "ts" ? 29 : 22;
          expect(
            localResult.references.some(
              (reference) => reference.file === utilsFile && reference.range.start.line === reexportLine,
            ),
          ).toBe(false);
        }
      });
    }

    for (const testCase of [
      { label: "TypeScript", extension: "ts", sourceImport: "./source" },
      { label: "JavaScript", extension: "js", sourceImport: "./source.js" },
    ]) {
      it(`keeps plain local exports distinct from ${testCase.label} export-from clauses`, async () => {
        const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-export-from-"));
        try {
          const sourceFile = path.join(root, `source.${testCase.extension}`).replace(/\\/g, "/");
          const entryFile = path.join(root, `entry.${testCase.extension}`).replace(/\\/g, "/");
          const consumerFile = path.join(root, `consumer.${testCase.extension}`).replace(/\\/g, "/");
          const functionSuffix = testCase.extension === "ts" ? "(): string" : "()";
          await fsp.writeFile(
            sourceFile,
            [`export function helper${functionSuffix} { return "source"; }`].join("\n"),
            "utf8",
          );
          await fsp.writeFile(
            entryFile,
            [
              `export function localHelper${functionSuffix} { return "entry"; }`,
              "export { localHelper };",
              `export { helper as forwarded } from "${testCase.sourceImport}";`,
              `export { helper } from "${testCase.sourceImport}";`,
              `export * from "${testCase.sourceImport}";`,
              `export * as ns from "${testCase.sourceImport}";`,
            ].join("\n"),
            "utf8",
          );
          await fsp.writeFile(
            consumerFile,
            [`import { localHelper } from "./entry.${testCase.extension}";`, "localHelper();"].join("\n"),
            "utf8",
          );

          const index = await createTestIndexFromFiles(root, [sourceFile, entryFile, consumerFile]);
          const scopeBuildSpy = vi.spyOn(scopeModule, "buildScopeIndexFromSource");
          try {
            const localResult = await testFindReferences(index, entryFile, 1, 16, 3);
            expect(localResult.status).toBe("ok");
            if (localResult.status === "ok") {
              const firstReferences = localResult.references.map((reference) => [
                reference.file,
                reference.range.start.line,
              ]);
              expect(firstReferences).toEqual([
                [consumerFile, 1],
                [consumerFile, 2],
                [entryFile, 1],
                [entryFile, 2],
              ]);
              expect(index.scopeCache.has(fileIdentityKey(entryFile))).toBe(true);

              const buildCountAfterFirst = scopeBuildSpy.mock.calls.length;
              const warmResult = await testFindReferences(index, entryFile, 1, 16, 3);
              expect(scopeBuildSpy.mock.calls.length).toBe(buildCountAfterFirst);
              expect(warmResult.status).toBe("ok");
              if (warmResult.status === "ok") {
                expect(warmResult.references.map((reference) => [reference.file, reference.range.start.line])).toEqual(
                  firstReferences,
                );
              }
            }
          } finally {
            scopeBuildSpy.mockRestore();
          }
        } finally {
          await fsp.rm(root, { recursive: true, force: true });
        }
      });
    }

    it("excludes type and namespace re-export clauses from same-name local references", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-export-from-forms-"));
      try {
        const sourceFile = path.join(root, "source.ts").replace(/\\/g, "/");
        const entryFile = path.join(root, "entry.ts").replace(/\\/g, "/");
        await fsp.writeFile(sourceFile, "export type Foo = string;\nexport const value = 1;\n", "utf8");
        await fsp.writeFile(
          entryFile,
          ['const ns = "local";', 'export type { Foo } from "./source";', 'export * as ns from "./source";'].join("\n"),
          "utf8",
        );

        const index = await createTestIndexFromFiles(root, [sourceFile, entryFile]);
        const typeResult = await testFindReferences(index, sourceFile, 1, 13, 1);
        expect(typeResult.status).toBe("ok");
        if (typeResult.status === "ok") {
          expect(typeResult.references.map((reference) => [reference.file, reference.range.start.line])).toEqual([
            [entryFile, 2],
            [sourceFile, 1],
          ]);
          expect(typeResult.references).toContainEqual(
            expect.objectContaining({ file: entryFile, via: { reexport: true } }),
          );
        }

        const localNamespace = await testFindReferences(index, entryFile, 1, 7, 1);
        expect(localNamespace.status).toBe("ok");
        if (localNamespace.status === "ok") {
          expect(localNamespace.references.map((reference) => [reference.file, reference.range.start.line])).toEqual([
            [entryFile, 1],
          ]);
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });
  });
});

describe("Find References: Unicode identifiers (C11)", () => {
  it("finds every cross-file reference to a Unicode-named function, matching an ASCII control", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-references-unicode-"));
    try {
      // Mirrors the audit's V1 repro: a definition file whose source begins with non-ASCII
      // text (byte offset drift), consumed twice each by six files. An ASCII control with the
      // identical structure proves the counts are byte-offset-driven, not incidental.
      const uDefFile = path.join(root, "u1.py").replace(/\\/g, "/");
      await fsp.writeFile(uDefFile, 'x = "ééé"\ndef créer():\n    return 1\n', "utf8");
      const uConsumerFiles: string[] = [];
      for (let i = 1; i <= 6; i += 1) {
        const file = path.join(root, `cu${i}.py`).replace(/\\/g, "/");
        await fsp.writeFile(file, `from u1 import créer\n\ndef use${i}():\n    créer()\n    créer()\n`, "utf8");
        uConsumerFiles.push(file);
      }

      const aDefFile = path.join(root, "a1.py").replace(/\\/g, "/");
      await fsp.writeFile(aDefFile, 'x = "eee"\ndef creer():\n    return 1\n', "utf8");
      const aConsumerFiles: string[] = [];
      for (let i = 1; i <= 6; i += 1) {
        const file = path.join(root, `ca${i}.py`).replace(/\\/g, "/");
        await fsp.writeFile(file, `from a1 import creer\n\ndef use${i}():\n    creer()\n    creer()\n`, "utf8");
        aConsumerFiles.push(file);
      }

      const index = await createTestIndexFromFiles(root, [uDefFile, aDefFile, ...uConsumerFiles, ...aConsumerFiles]);

      const uResult = await testFindReferences(index, uDefFile, 2, "def créer".indexOf("créer") + 1, 19);
      expect(uResult.status).toBe("ok");
      if (uResult.status === "ok") expect(uResult.references).toHaveLength(19);

      const aResult = await testFindReferences(index, aDefFile, 2, "def creer".indexOf("creer") + 1, 19);
      expect(aResult.status).toBe("ok");
      if (aResult.status === "ok") expect(aResult.references).toHaveLength(19);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Find References: Unicode cross-file fixtures", () => {
  it("finds references to a Java combining-mark class imported across files", async () => {
    const samplePath = path.resolve(process.cwd(), "tests", "samples", "java");
    const consumerFile = path.join(samplePath, ".regressions", "unicode_consumer.java").replace(/\\/g, "/");
    const definitionFile = path.join(samplePath, ".regressions", "unicode_def.java").replace(/\\/g, "/");
    const index = await createTestIndexFromFiles(samplePath, [consumerFile, definitionFile]);
    const result = await testFindReferences(index, definitionFile, 3, 7, 2);

    expect(result.status).toBe("ok");
    expectReferenceAt(result, definitionFile, 3);
    expectReferenceAt(result, consumerFile, 7);
  });

  it("finds references to a Kotlin Unicode import alias across files", async () => {
    const samplePath = path.resolve(process.cwd(), "tests", "samples", "kotlin");
    const consumerFile = path.join(samplePath, ".regressions", "unicode_consumer.kt").replace(/\\/g, "/");
    const definitionFile = path.join(samplePath, ".regressions", "unicode_def.kt").replace(/\\/g, "/");
    const index = await createTestIndexFromFiles(samplePath, [consumerFile, definitionFile]);
    const result = await testFindReferences(index, definitionFile, 3, 5, 2);

    expect(result.status).toBe("ok");
    expectReferenceAt(result, definitionFile, 3);
    expectReferenceAt(result, consumerFile, 6);
  });

  it("finds references to a Go Unicode-named function through a Unicode-letter alias", async () => {
    const samplePath = path.resolve(process.cwd(), "tests", "samples", "go");
    const consumerFile = path.join(samplePath, ".regressions", "unicode_consumer.go").replace(/\\/g, "/");
    const definitionFile = path.join(samplePath, ".regressions", "unicodepkg.go").replace(/\\/g, "/");
    const index = await createTestIndexFromFiles(samplePath, [consumerFile, definitionFile]);
    const result = await testFindReferences(index, definitionFile, 3, 6, 2);

    expect(result.status).toBe("ok");
    expectReferenceAt(result, definitionFile, 3);
    expectReferenceAt(result, consumerFile, 6);
  });

  it("finds references to a PHP non-letter use alias across files", async () => {
    const samplePath = path.resolve(process.cwd(), "tests", "samples", "php");
    const consumerFile = path.join(samplePath, "src", "Collision", "unicode_consumer.php").replace(/\\/g, "/");
    const definitionFile = path.join(samplePath, "src", "Collision", "unicode_def.php").replace(/\\/g, "/");
    const index = await createTestIndexFromFiles(samplePath, [consumerFile, definitionFile]);
    const result = await testFindReferences(index, definitionFile, 5, 10, 2);

    expect(result.status).toBe("ok");
    expectReferenceAt(result, definitionFile, 5);
    expectReferenceAt(result, consumerFile, 7);
  });
  it("finds references to a Rust Unicode-named function through an XID-continuation alias", async () => {
    const samplePath = path.resolve(process.cwd(), "tests", "samples", "rust");
    const consumerFile = path.join(samplePath, ".regressions", "unicode_consumer.rs").replace(/\\/g, "/");
    const definitionFile = path.join(samplePath, ".regressions", "unicode_def.rs").replace(/\\/g, "/");
    const index = await createTestIndexFromFiles(samplePath, [consumerFile, definitionFile]);
    const result = await testFindReferences(index, definitionFile, 1, 8, 2);

    expect(result.status).toBe("ok");
    expectReferenceAt(result, definitionFile, 1);
    expectReferenceAt(result, consumerFile, 6);
  });
});

describe("Find References: canonical Unicode identifier equality", () => {
  for (const testCase of [
    {
      language: "python",
      definition: "unicode_nfc_def.py",
      consumer: "unicode_nfc_consumer.py",
      definitionColumn: 5,
      consumerLine: 3,
    },
    {
      language: "python",
      definition: "unicode_nfd_def.py",
      consumer: "unicode_nfd_consumer.py",
      definitionColumn: 5,
      consumerLine: 3,
    },
    {
      language: "rust",
      definition: "unicode_nfc_def.rs",
      consumer: "unicode_nfc_consumer.rs",
      definitionColumn: 8,
      consumerLine: 6,
    },
    {
      language: "rust",
      definition: "unicode_nfd_def.rs",
      consumer: "unicode_nfd_consumer.rs",
      definitionColumn: 8,
      consumerLine: 6,
    },
  ]) {
    it(`includes the consumer for ${testCase.language} canonical equality`, async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", testCase.language, ".regressions");
      const definitionFile = path.join(samplePath, testCase.definition).replace(/\\/g, "/");
      const consumerFile = path.join(samplePath, testCase.consumer).replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [definitionFile, consumerFile]);
      const result = await testFindReferences(index, definitionFile, 1, testCase.definitionColumn, 2);

      expectReferenceAt(result, consumerFile, testCase.consumerLine);
    });
  }

  for (const testCase of [
    {
      language: "java",
      definition: "Foo.java",
      consumer: "unicode_ignorable_consumer.java",
      definitionLine: 3,
      definitionColumn: 7,
      consumerLine: 7,
    },
    {
      language: "csharp",
      definition: "unicode_verbatim.cs",
      consumer: "unicode_verbatim.cs",
      definitionLine: 3,
      definitionColumn: 11,
      consumerLine: 9,
    },
  ]) {
    it(`includes the consumer for ${testCase.language} canonical equality`, async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", testCase.language, ".regressions");
      const definitionFile = path.join(samplePath, testCase.definition).replace(/\\/g, "/");
      const consumerFile = path.join(samplePath, testCase.consumer).replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [definitionFile, consumerFile]);
      const result = await testFindReferences(
        index,
        definitionFile,
        testCase.definitionLine,
        testCase.definitionColumn,
        2,
      );

      expectReferenceAt(result, consumerFile, testCase.consumerLine);
    });
  }

  for (const testCase of [
    { language: "kotlin", definition: "unicode_nfc_def.kt", consumer: "unicode_nfd_consumer.kt", column: 7 },
    { language: "go", definition: "unicode_negative_pkg/def.go", consumer: "unicode_nfd_consumer.go", column: 6 },
    { language: "typescript", definition: "unicode_nfc_def.ts", consumer: "unicode_nfd_consumer.ts", column: 17 },
  ]) {
    it(`excludes distinct ${testCase.language} spellings`, async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", testCase.language, ".regressions");
      const definitionFile = path.join(samplePath, testCase.definition).replace(/\\/g, "/");
      const consumerFile = path.join(samplePath, testCase.consumer).replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [definitionFile, consumerFile]);
      const module = index.byFile.get(fileIdentityKey(definitionFile));
      const def = module?.locals[0];
      if (!def) throw new Error("Expected Unicode definition");

      const result = await indexer.findReferences(index, { def });
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.references.some((reference) => reference.file === consumerFile)).toBe(false);
      }
    });
  }

  it("excludes distinct PHP spellings", async () => {
    const samplePath = path.resolve(process.cwd(), "tests", "samples", "php");
    const definitionFile = path.join(samplePath, "src", "Collision", "unicode_nfc_def.php").replace(/\\/g, "/");
    const consumerFile = path.join(samplePath, "src", "Collision", "unicode_nfd_consumer.php").replace(/\\/g, "/");
    const index = await createTestIndexFromFiles(samplePath, [definitionFile, consumerFile]);
    const def = index.byFile.get(fileIdentityKey(definitionFile))?.locals[0];
    if (!def) throw new Error("Expected Unicode PHP definition");

    const result = await indexer.findReferences(index, { def });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.references.some((reference) => reference.file === consumerFile)).toBe(false);
    }
  });
});

describe("Find References: Python receiver member resolution", () => {
  const source = [
    "class Service:",
    "    def __init__(self, name):",
    "        self.name = name",
    "",
    "    def run(self):",
    "        return self.name",
    "",
    "    def call_self(self):",
    "        return self.run()",
    "",
    "class Base:",
    "    def base_method(self):",
    "        return 1",
    "",
    "class Derived(Base):",
    "    def use_inherited(self):",
    "        return self.base_method()",
    "",
    "def run():",
    "    return 0",
    "",
    "def bare_call():",
    "    return run()",
    "",
    "def make_service():",
    '    return Service("x")',
    "",
    "def via_constructor():",
    "    svc = Service()",
    "    return svc.run()",
    "",
    "def via_factory():",
    "    svc = make_service()",
    "    return svc.run()",
    "",
    "def via_param(svc):",
    "    return svc.run()",
    "",
    "class KindHolder:",
    '    kind = "svc"',
    "",
    "    @classmethod",
    "    def from_kind(cls):",
    "        return cls.kind",
    "",
    "class Left:",
    "    def shared(self):",
    '        return "L"',
    "",
    "class Right:",
    "    def shared(self):",
    '        return "R"',
    "",
    "class Ambiguous(Left, Right):",
    "    def use_shared(self):",
    "        return self.shared()",
    "",
    "class Other:",
    "    def run(self):",
    "        return 2",
    "",
    "class Shadow:",
    "    def run(self):",
    "        return 1",
    "",
    "    def call(self):",
    "        run = 0",
    "        return self.run()",
    "",
    "def via_annotated():",
    "    svc: Service = Service()",
    "    return svc.run()",
    "",
    "def via_other():",
    "    other = Other()",
    "    return other.run()",
    "",
  ].join("\n");
  const lines = source.split("\n");

  function columnOf(line: number, token: string): number {
    const index = lines[line - 1]!.indexOf(token);
    if (index < 0) throw new Error(`Expected token ${token} on fixture line ${line}`);
    return index + 1;
  }

  async function buildReceiverFixture(): Promise<{ root: string; file: string; index: ProjectIndex }> {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-python-receiver-refs-"));
    const file = path.join(root, "models.py").replace(/\\/g, "/");
    await fsp.writeFile(file, source, "utf8");
    return { root, file, index: await createTestIndexFromFiles(root, [file]) };
  }

  it("resolves references from a Python self member call or attribute", async () => {
    const { root, file, index } = await buildReceiverFixture();
    try {
      const methodRefs = await testFindReferences(index, file, 5, columnOf(5, "run"), 3);
      if (methodRefs.status === "ok") {
        expectReferenceAt(methodRefs, file, 5);
        expectReferenceAt(methodRefs, file, 9);
        expectReferenceAt(methodRefs, file, 30);
        expect(methodRefs.references.some((reference) => reference.range.start.line === 23)).toBe(false);
        expect(methodRefs.references.some((reference) => reference.range.start.line === 34)).toBe(false);
        expect(methodRefs.references.some((reference) => reference.range.start.line === 37)).toBe(false);
        expect(methodRefs.references.some((reference) => reference.range.start.line === 59)).toBe(false);
      }

      const nameRefs = await testFindReferences(index, file, 6, columnOf(6, "name"), 2);
      if (nameRefs.status === "ok") {
        expectReferenceAt(nameRefs, file, 3);
        expectReferenceAt(nameRefs, file, 6);
      }

      const inheritedRefs = await testFindReferences(index, file, 17, columnOf(17, "base_method"), 2);
      if (inheritedRefs.status === "ok") {
        expectReferenceAt(inheritedRefs, file, 12);
        expectReferenceAt(inheritedRefs, file, 17);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a Python module-level function separate from a same-named method", async () => {
    const { root, file, index } = await buildReceiverFixture();
    try {
      // The module-level `def run` on line 19 owns the bare `run()` call on line 23 but not
      // the method declaration on line 5 or the `self.run()` receiver on line 9.
      const moduleRefs = await testFindReferences(index, file, 19, columnOf(19, "run"), 2);
      if (moduleRefs.status === "ok") {
        expectReferenceAt(moduleRefs, file, 19);
        expectReferenceAt(moduleRefs, file, 23);
        expect(moduleRefs.references.some((reference) => reference.range.start.line === 5)).toBe(false);
        expect(moduleRefs.references.some((reference) => reference.range.start.line === 9)).toBe(false);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves references through a Python constructor-assigned receiver", async () => {
    const { root, file, index } = await buildReceiverFixture();
    try {
      const refs = await testFindReferences(index, file, 30, columnOf(30, "run"), 2);
      if (refs.status === "ok") {
        expectReferenceAt(refs, file, 5);
        expectReferenceAt(refs, file, 30);
        expect(refs.references.some((reference) => reference.range.start.line === 23)).toBe(false);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not resolve references through an unproven Python receiver", async () => {
    const { root, file, index } = await buildReceiverFixture();
    try {
      // `svc.run()` on line 34 (receiver from a factory call) and on line 37 (unannotated
      // parameter) have no proven receiver type.
      await testFindReferences(index, file, 34, columnOf(34, "run"), 0, "not_found");
      await testFindReferences(index, file, 37, columnOf(37, "run"), 0, "not_found");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves references from a Python cls class-level member", async () => {
    const { root, file, index } = await buildReceiverFixture();
    try {
      const refs = await testFindReferences(index, file, 44, columnOf(44, "kind"), 2);
      if (refs.status === "ok") {
        expectReferenceAt(refs, file, 40);
        expectReferenceAt(refs, file, 44);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not resolve references for an ambiguous Python inherited member", async () => {
    const { root, file, index } = await buildReceiverFixture();
    try {
      await testFindReferences(index, file, 56, columnOf(56, "shared"), 0, "not_found");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Find References: PHP unproven receiver is not a bare-name hit", () => {
  it("does not treat $unknown->helper() as a reference to an imported helper", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-php-misattr-refs-"));
    try {
      const libFile = path.join(root, "lib.php").replace(/\\/g, "/");
      const hostFile = path.join(root, "host.php").replace(/\\/g, "/");
      await fsp.writeFile(libFile, ["<?php", "namespace Imported;", "function helper() {}", ""].join("\n"), "utf8");
      const host = [
        "<?php",
        "use function Imported\\helper;",
        "class Box { function helper() {} }",
        "function run() { $unknown->helper(); }",
        "",
      ].join("\n");
      await fsp.writeFile(hostFile, host, "utf8");
      const index = await createTestIndexFromFiles(root, [libFile, hostFile]);
      const helperColumn = host.split("\n")[3]!.indexOf("helper();") + 1;
      await testFindReferences(index, hostFile, 4, helperColumn, 0, "not_found");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Find References: PHP global-namespace symbols", () => {
  it("finds a no-use consumer reference for a global-namespace class", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-php-global-class-refs-"));
    try {
      const sourceFile = path.join(root, "source.php").replace(/\\/g, "/");
      const consumerFile = path.join(root, "consumer.php").replace(/\\/g, "/");
      const sourceLine = "<?php class GlobalService { function run() { return 1; } }";
      await fsp.writeFile(sourceFile, `${sourceLine}\n`, "utf8");
      await fsp.writeFile(consumerFile, "<?php $svc = new GlobalService(); $svc->run();\n", "utf8");
      const index = await createTestIndexFromFiles(root, [sourceFile, consumerFile]);

      const result = await testFindReferences(index, sourceFile, 1, tokenColumn(sourceLine, "GlobalService"), 2);

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expectReferenceAt(result, sourceFile, 1);
      expectReferenceAt(result, consumerFile, 1);
      expect(result.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("finds a no-use consumer reference for a global-namespace function", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-php-global-function-refs-"));
    try {
      const sourceFile = path.join(root, "source.php").replace(/\\/g, "/");
      const consumerFile = path.join(root, "consumer.php").replace(/\\/g, "/");
      const sourceLine = "<?php function globalHelper() { return 1; }";
      await fsp.writeFile(sourceFile, `${sourceLine}\n`, "utf8");
      await fsp.writeFile(consumerFile, "<?php $x = globalHelper();\n", "utf8");
      const index = await createTestIndexFromFiles(root, [sourceFile, consumerFile]);

      const result = await testFindReferences(index, sourceFile, 1, tokenColumn(sourceLine, "globalHelper"), 2);

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expectReferenceAt(result, sourceFile, 1);
      expectReferenceAt(result, consumerFile, 1);
      expect(result.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("finds a case-variant reference to a namespaced class", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-php-case-class-refs-"));
    try {
      const serviceFile = path.join(root, "service.php").replace(/\\/g, "/");
      const useFile = path.join(root, "use.php").replace(/\\/g, "/");
      const serviceLine = "<?php namespace App; class Service { function run() { return 1; } }";
      await fsp.writeFile(serviceFile, `${serviceLine}\n`, "utf8");
      await fsp.writeFile(useFile, "<?php $svc = new \\app\\service();\n", "utf8");
      const index = await createTestIndexFromFiles(root, [serviceFile, useFile]);

      const result = await testFindReferences(index, serviceFile, 1, tokenColumn(serviceLine, "Service"), 2);

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expectReferenceAt(result, serviceFile, 1);
      expectReferenceAt(result, useFile, 1);
      expect(result.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("finds a case-variant reference to a namespaced function", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-php-case-function-refs-"));
    try {
      const serviceFile = path.join(root, "service.php").replace(/\\/g, "/");
      const useFile = path.join(root, "use.php").replace(/\\/g, "/");
      const serviceLine = "<?php namespace App; function Helper() { return 1; }";
      await fsp.writeFile(serviceFile, `${serviceLine}\n`, "utf8");
      await fsp.writeFile(useFile, "<?php $x = \\app\\helper();\n", "utf8");
      const index = await createTestIndexFromFiles(root, [serviceFile, useFile]);

      const result = await testFindReferences(index, serviceFile, 1, tokenColumn(serviceLine, "Helper"), 2);

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expectReferenceAt(result, serviceFile, 1);
      expectReferenceAt(result, useFile, 1);
      expect(result.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps PHP variables and properties case-sensitive", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-php-case-variable-refs-"));
    try {
      const file = path.join(root, "props.php").replace(/\\/g, "/");
      const lines = [
        "<?php",
        "class Box {",
        "  public $value = 1;",
        "  public $Value = 2;",
        "  function read() { return $this->value + $this->Value; }",
        "}",
        "",
      ];
      await fsp.writeFile(file, lines.join("\n"), "utf8");
      const index = await createTestIndexFromFiles(root, [file]);
      const readLine = lines[4]!;

      const lower = await indexer.findReferences(index, { file, line: 3, column: tokenColumn(lines[2]!, "value") });
      expect(lower.status).toBe("ok");
      if (lower.status === "ok") {
        expect(
          lower.references.some(
            (reference) =>
              reference.range.start.line === 5 && reference.range.start.column === tokenColumn(readLine, "value"),
          ),
        ).toBe(true);
        expect(
          lower.references.some(
            (reference) =>
              reference.range.start.line === 5 && reference.range.start.column === tokenColumn(readLine, "Value"),
          ),
        ).toBe(false);
      }

      const upper = await indexer.findReferences(index, { file, line: 4, column: tokenColumn(lines[3]!, "Value") });
      expect(upper.status).toBe("ok");
      if (upper.status === "ok") {
        expect(
          upper.references.some(
            (reference) =>
              reference.range.start.line === 5 && reference.range.start.column === tokenColumn(readLine, "Value"),
          ),
        ).toBe(true);
        expect(
          upper.references.some(
            (reference) =>
              reference.range.start.line === 5 && reference.range.start.column === tokenColumn(readLine, "value"),
          ),
        ).toBe(false);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Find References: reference coverage honesty", () => {
  it("reports partial coverage when an applicable strategy never ran", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-coverage-strategy-"));
    try {
      const sourceFile = path.join(root, "source.ts").replace(/\\/g, "/");
      await fsp.writeFile(sourceFile, "export function target() { return 1; }\n", "utf8");
      const index = await createTestIndexFromFiles(root, [sourceFile]);
      const def = index.byFile.get(fileIdentityKey(sourceFile))?.locals.find((local) => local.localName === "target");
      if (!def) throw new Error("Expected a definition for target");

      const strategies = describeReferenceStrategies({
        languageId: "cpp",
        phpQualifiedNames: [],
        sameFileOccurrence: { applicable: true, executed: false },
      });
      expect(strategies.applicable).toEqual(["same_file_occurrence"]);
      expect(strategies.executed).toEqual([]);

      // The PHP qualified-name scan is required for every PHP definition; an empty probe set
      // means the scan never ran, which must not be reported as complete.
      expect(describeReferenceStrategies({ languageId: "php", phpQualifiedNames: [] })).toEqual({
        applicable: ["php_qualified_name"],
        executed: [],
      });
      expect(describeReferenceStrategies({ languageId: "php", phpQualifiedNames: ["App\\Service"] })).toEqual({
        applicable: ["php_qualified_name"],
        executed: ["php_qualified_name"],
      });
      expect(describeReferenceStrategies({ languageId: "ts", phpQualifiedNames: [] })).toEqual({
        applicable: [],
        executed: [],
      });

      expect(
        buildIndexedCandidateCoverage({
          index,
          def,
          exportedNames: [],
          candidateFiles: [],
          scannedFiles: [sourceFile],
          truncated: false,
          strategies,
        }),
      ).toEqual({ scope: "indexed_candidates", state: "partial", reasons: ["strategy_unavailable"] });

      // The strategy report is optional: without it the historical file-count behavior stands.
      expect(
        buildIndexedCandidateCoverage({
          index,
          def,
          exportedNames: [],
          candidateFiles: [],
          scannedFiles: [sourceFile],
          truncated: false,
        }),
      ).toEqual({ scope: "indexed_candidates", state: "complete" });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("reports name_equivalence_unavailable for a bare case-variant PHP reference", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-coverage-name-equivalence-"));
    try {
      const serviceFile = path.join(root, "service.php").replace(/\\/g, "/");
      const useFile = path.join(root, "use.php").replace(/\\/g, "/");
      const serviceLine = "<?php namespace App; class Service { function run() { return 1; } }";
      await fsp.writeFile(serviceFile, `${serviceLine}\n`, "utf8");
      await fsp.writeFile(useFile, "<?php namespace App; $svc = new service();\n", "utf8");
      const index = await createTestIndexFromFiles(root, [serviceFile, useFile]);

      const result = await indexer.findReferences(index, {
        file: serviceFile,
        line: 1,
        column: tokenColumn(serviceLine, "Service"),
      });

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      // The bare `service` spelling is a legal case-variant reference, but a bare name could
      // also be a same-named constant, so the equivalence is unproven and coverage says so.
      expectReferenceAt(result, useFile, 1);
      expect(result.referenceCoverage).toEqual({
        scope: "indexed_candidates",
        state: "partial",
        reasons: ["name_equivalence_unavailable"],
      });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("orders direct and bounded-cache coverage reasons through one table", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-coverage-order-"));
    try {
      const sourceFile = path.join(root, "source.ts").replace(/\\/g, "/");
      const consumerFile = path.join(root, "consumer.ts").replace(/\\/g, "/");
      await fsp.writeFile(sourceFile, "export function target() { return 1; }\n", "utf8");
      await fsp.writeFile(
        consumerFile,
        ['import { target } from "./source";', "const a = target();", "const b = target();", ""].join("\n"),
        "utf8",
      );
      const index = await createTestIndexFromFiles(root, [sourceFile, consumerFile]);
      markCandidateParserDegraded(index, consumerFile);

      const direct = await indexer.findReferences(index, { file: sourceFile, line: 1, column: 17 });
      expect(direct.status).toBe("ok");
      if (direct.status !== "ok") return;
      expect(direct.referenceCoverage.state).toBe("partial");
      expect(direct.referenceCoverage.reasons).toEqual(
        REFERENCE_COVERAGE_REASON_ORDER.filter((reason) => direct.referenceCoverage.reasons?.includes(reason)),
      );

      const bounded = await createReferenceLookupCache().get(index, direct.definition, { maxReferences: 1 });
      expect(bounded.status).toBe("ok");
      if (bounded.status !== "ok") return;
      expect(bounded.referenceCoverage.reasons).toEqual(
        REFERENCE_COVERAGE_REASON_ORDER.filter((reason) => bounded.referenceCoverage.reasons?.includes(reason)),
      );
      expect(bounded.referenceCoverage.reasons).toEqual(["parser_degraded", "truncated"]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
