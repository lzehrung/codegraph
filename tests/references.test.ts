import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import * as indexer from "../src/indexer.js";
import * as scopeModule from "../src/indexer/scope.js";
import { getCachedReferenceCandidateFiles } from "../src/indexer/navigation-references.js";
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

  describe("SQL", () => {
    it("finds SQL object references across SQL files", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "sql", "graph");
      const schemaFile = path.join(samplePath, "001_create_users.sql").replace(/\\/g, "/");
      const alterFile = path.join(samplePath, "002_alter_users.sql").replace(/\\/g, "/");
      const reportFile = path.join(samplePath, "report.sql").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [schemaFile, alterFile, reportFile]);

      const result = await testFindReferences(index, schemaFile, 1, 16, 3);

      expect(result.status).toBe("ok");
      expectReferenceAt(result, schemaFile, 1);
      expectReferenceAt(result, alterFile, 1);
      expectReferenceAt(result, reportFile, 1);
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

      const result = await testFindReferences(index, schemaFile, 1, 22, 2);

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

        const result = await testFindReferences(index, schemaFile, 1, 16, 2);

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

        const result = await testFindReferences(index, typesFile, 1, 13, 2);

        expect(result.status).toBe("ok");
        expectReferenceAt(result, typesFile, 1);
        expectReferenceAt(result, consumerFile, 2);
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

        const result = await testFindReferences(index, serviceFile, 2, 3, 3);

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

          const result = await testFindReferences(
            index,
            file,
            testCase.definition.line,
            testCase.definition.column,
            testCase.expectedLines.length,
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
          { context: "block", blockMaxLines: 50, maxReferences: 2 },
        );

        expect(result.status).toBe("ok");
        if (result.status === "ok") {
          const appReference = result.references.find((reference) => reference.file === appFile.replace(/\\/g, "/"));
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

      const result = await testFindReferences(index, utilsFile, 4, 16, 2);
      expectReferenceAt(result, utilsFile, 6);
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
  });

  describe("Java", () => {
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
            [sourceFile, 1],
          ]);
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
