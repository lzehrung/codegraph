import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { goToDefinition } from "../src/index.js";
import { JAVA_SUPPORT } from "../src/languages.js";
import { resolveNamedDefinition } from "../src/indexer/navigation-local.js";
import { fileIdentityKey } from "../src/util/paths.js";
import { createTestIndex, createTestIndexFromFiles, testGoToDefinition } from "./test-utils.js";

describe("Go to Definition", () => {
  describe("SQL", () => {
    it("resolves SQL object references to SQL definitions", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "sql", "graph");
      const schemaFile = path.join(samplePath, "001_create_users.sql").replace(/\\/g, "/");
      const reportFile = path.join(samplePath, "report.sql").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [schemaFile, reportFile]);

      const result = await testGoToDefinition(index, reportFile, 1, 25, schemaFile, 1);

      expect(result.status).toBe("ok");
    });

    it("resolves schema-qualified SQL object references", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "sql", "graph");
      const schemaFile = path.join(samplePath, "qualified_schema.sql").replace(/\\/g, "/");
      const reportFile = path.join(samplePath, "qualified_report.sql").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [schemaFile, reportFile]);

      const result = await testGoToDefinition(index, reportFile, 1, 25, schemaFile, 1);

      expect(result.status).toBe("ok");
    });

    it("resolves schema-qualified SQL references to unqualified definitions", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sql-qualified-to-unqualified-goto-"));
      try {
        const schemaFile = path.join(root, "schema.sql").replace(/\\/g, "/");
        const reportFile = path.join(root, "report.sql").replace(/\\/g, "/");
        await fsp.writeFile(schemaFile, "CREATE TABLE users (id integer);\n", "utf8");
        const query = "SELECT id FROM public.users;\n";
        await fsp.writeFile(reportFile, query, "utf8");
        const index = await createTestIndexFromFiles(root, [schemaFile, reportFile]);

        const result = await testGoToDefinition(index, reportFile, 1, query.indexOf("public.users") + 1, schemaFile, 1);

        expect(result.status).toBe("ok");
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("resolves quoted SQL identifiers with their exact case", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sql-quoted-goto-"));
      try {
        const schemaFile = path.join(root, "schema.sql").replace(/\\/g, "/");
        const reportFile = path.join(root, "report.sql").replace(/\\/g, "/");
        const schemaLines = ['CREATE TABLE "Users" (id integer);', 'CREATE TABLE "users" (id integer);'];
        const reportLines = ['SELECT id FROM "Users";', 'SELECT id FROM "users";'];
        await fsp.writeFile(schemaFile, schemaLines.join("\n"), "utf8");
        await fsp.writeFile(reportFile, reportLines.join("\n"), "utf8");
        const index = await createTestIndexFromFiles(root, [schemaFile, reportFile]);

        await testGoToDefinition(index, reportFile, 1, reportLines[0]!.indexOf('"Users"') + 1, schemaFile, 1);
        await testGoToDefinition(index, reportFile, 2, reportLines[1]!.indexOf('"users"') + 1, schemaFile, 2);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("resolves alias-qualified and table-qualified SQL object references", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sql-qualified-goto-"));
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

        const t2Column = queryLines[2].indexOf("t2.table1_id") + 1;
        const t1Column = queryLines[2].indexOf("t1.id") + 1;
        const qualifiedColumn = queryLines[3].indexOf("schema1.table1.id") + 1;
        const basenameColumn = queryLines[4].indexOf("table1.id") + 1;

        await testGoToDefinition(index, reportFile, 3, t2Column, schemaFile, 2);
        await testGoToDefinition(index, reportFile, 3, t1Column, schemaFile, 1);
        await testGoToDefinition(index, reportFile, 4, qualifiedColumn, schemaFile, 1);
        await testGoToDefinition(index, reportFile, 5, basenameColumn, schemaFile, 1);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("does not guess SQL definitions for unresolved statement aliases", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sql-unresolved-alias-goto-"));
      try {
        const schemaFile = path.join(root, "schema.sql").replace(/\\/g, "/");
        const reportFile = path.join(root, "report.sql").replace(/\\/g, "/");
        await fsp.writeFile(schemaFile, "CREATE TABLE schema1.table1 (id integer primary key);\n", "utf8");
        const query = "SELECT missing_alias.id FROM schema1.table1 t1;";
        await fsp.writeFile(reportFile, query, "utf8");
        const index = await createTestIndexFromFiles(root, [schemaFile, reportFile]);

        const result = await testGoToDefinition(
          index,
          reportFile,
          1,
          query.indexOf("missing_alias.id") + 1,
          undefined,
          undefined,
          "not_found",
        );

        expect(result.status).toBe("not_found");
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("does not guess SQL definitions for ambiguous table-qualified basenames", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sql-ambiguous-basename-goto-"));
      try {
        const schemaFile = path.join(root, "schema.sql").replace(/\\/g, "/");
        const reportFile = path.join(root, "report.sql").replace(/\\/g, "/");
        await fsp.writeFile(
          schemaFile,
          ["CREATE TABLE schema1.table1 (id integer);", "CREATE TABLE schema2.table1 (id integer);"].join("\n"),
          "utf8",
        );
        const query = "SELECT table1.id FROM schema1.table1;";
        await fsp.writeFile(reportFile, query, "utf8");
        const index = await createTestIndexFromFiles(root, [schemaFile, reportFile]);

        const result = await testGoToDefinition(
          index,
          reportFile,
          1,
          query.indexOf("table1.id") + 1,
          undefined,
          undefined,
          "not_found",
        );

        expect(result.status).toBe("not_found");
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("does not resolve CTE aliases as schema object definitions", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sql-cte-alias-goto-"));
      try {
        const schemaFile = path.join(root, "schema.sql").replace(/\\/g, "/");
        const reportFile = path.join(root, "report.sql").replace(/\\/g, "/");
        await fsp.writeFile(
          schemaFile,
          ["CREATE TABLE schema1.table1 (id integer);", "CREATE TABLE recent_users (id integer);"].join("\n"),
          "utf8",
        );
        const queryLines = [
          "WITH recent_users AS (SELECT id FROM schema1.table1)",
          "SELECT ru.id FROM recent_users ru;",
        ];
        await fsp.writeFile(reportFile, queryLines.join("\n"), "utf8");
        const index = await createTestIndexFromFiles(root, [schemaFile, reportFile]);

        const result = await testGoToDefinition(
          index,
          reportFile,
          2,
          queryLines[1].indexOf("ru.id") + 1,
          undefined,
          undefined,
          "not_found",
        );

        expect(result.status).toBe("not_found");
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("does not resolve CTE-qualified columns as schema object definitions", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sql-cte-name-goto-"));
      try {
        const schemaFile = path.join(root, "schema.sql").replace(/\\/g, "/");
        const reportFile = path.join(root, "report.sql").replace(/\\/g, "/");
        await fsp.writeFile(
          schemaFile,
          ["CREATE TABLE schema1.table1 (id integer);", "CREATE TABLE recent_users (id integer);"].join("\n"),
          "utf8",
        );
        const queryLines = [
          "WITH recent_users AS (SELECT id FROM schema1.table1)",
          "SELECT recent_users.id FROM recent_users;",
        ];
        await fsp.writeFile(reportFile, queryLines.join("\n"), "utf8");
        const index = await createTestIndexFromFiles(root, [schemaFile, reportFile]);

        const result = await testGoToDefinition(
          index,
          reportFile,
          2,
          queryLines[1].indexOf("recent_users.id") + 1,
          undefined,
          undefined,
          "not_found",
        );

        expect(result.status).toBe("not_found");
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("does not resolve dotted SQL object text inside string literals", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sql-string-literal-goto-"));
      try {
        const schemaFile = path.join(root, "schema.sql").replace(/\\/g, "/");
        const reportFile = path.join(root, "report.sql").replace(/\\/g, "/");
        await fsp.writeFile(schemaFile, "CREATE TABLE schema1.table1 (id integer);\n", "utf8");
        const query = "SELECT 'schema1.table1.id' FROM schema1.table1;";
        await fsp.writeFile(reportFile, query, "utf8");
        const index = await createTestIndexFromFiles(root, [schemaFile, reportFile]);

        const result = await testGoToDefinition(
          index,
          reportFile,
          1,
          query.indexOf("schema1.table1.id") + 1,
          undefined,
          undefined,
          "not_found",
        );

        expect(result.status).toBe("not_found");
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("does not resolve SQL objects when the cursor is immediately after the token", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sql-token-boundary-goto-"));
      try {
        const schemaFile = path.join(root, "schema.sql").replace(/\\/g, "/");
        const reportFile = path.join(root, "report.sql").replace(/\\/g, "/");
        await fsp.writeFile(schemaFile, "CREATE TABLE users (id integer);\n", "utf8");
        const query = "SELECT id FROM users;";
        await fsp.writeFile(reportFile, query, "utf8");
        const index = await createTestIndexFromFiles(root, [schemaFile, reportFile]);

        const semicolonColumn = query.indexOf(";") + 1;
        const result = await testGoToDefinition(
          index,
          reportFile,
          1,
          semicolonColumn,
          undefined,
          undefined,
          "not_found",
        );

        expect(result.status).toBe("not_found");
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("does not guess SQL definitions for duplicate exact qualified prefixes", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sql-ambiguous-exact-prefix-goto-"));
      try {
        const schemaAFile = path.join(root, "schema_a.sql").replace(/\\/g, "/");
        const schemaBFile = path.join(root, "schema_b.sql").replace(/\\/g, "/");
        const reportFile = path.join(root, "report.sql").replace(/\\/g, "/");
        await fsp.writeFile(schemaAFile, "CREATE TABLE schema1.table1 (id integer);\n", "utf8");
        await fsp.writeFile(schemaBFile, "CREATE TABLE schema1.table1 (id integer);\n", "utf8");
        const query = "SELECT schema1.table1.id FROM schema1.table1;";
        await fsp.writeFile(reportFile, query, "utf8");
        const index = await createTestIndexFromFiles(root, [schemaAFile, schemaBFile, reportFile]);

        const result = await testGoToDefinition(
          index,
          reportFile,
          1,
          query.indexOf("schema1.table1.id") + 1,
          undefined,
          undefined,
          "not_found",
        );

        expect(result.status).toBe("not_found");
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("does not guess SQL definitions for duplicate exact object names", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-sql-ambiguous-exact-goto-"));
      try {
        const schemaAFile = path.join(root, "schema_a.sql").replace(/\\/g, "/");
        const schemaBFile = path.join(root, "schema_b.sql").replace(/\\/g, "/");
        const reportFile = path.join(root, "report.sql").replace(/\\/g, "/");
        await fsp.writeFile(schemaAFile, "CREATE TABLE schema1.table1 (id integer);\n", "utf8");
        await fsp.writeFile(schemaBFile, "CREATE TABLE schema1.table1 (id integer);\n", "utf8");
        const query = "SELECT id FROM schema1.table1;";
        await fsp.writeFile(reportFile, query, "utf8");
        const index = await createTestIndexFromFiles(root, [schemaAFile, schemaBFile, reportFile]);

        const result = await testGoToDefinition(
          index,
          reportFile,
          1,
          query.indexOf("schema1.table1") + 1,
          undefined,
          undefined,
          "not_found",
        );

        expect(result.status).toBe("not_found");
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });
  });

  describe("Go", () => {
    it("resolves promoted struct fields through embedding", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "go");
      const embeddingFile = path.join(samplePath, "embedding.go").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [embeddingFile]);

      await testGoToDefinition(index, embeddingFile, 22, 8, embeddingFile, 4);
    });
    it("resolves range variables to their declarations", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "go");
      const rangeFile = path.join(samplePath, "range-variables.go").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [rangeFile]);

      await testGoToDefinition(index, rangeFile, 6, 12, rangeFile, 5);
      await testGoToDefinition(index, rangeFile, 6, 16, rangeFile, 5);
    });
  });

  describe("TypeScript", () => {
    it("resolves TypeScript enum imports to enum declarations", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ts-enum-goto-"));
      try {
        const typesFile = path.join(root, "types.ts").replace(/\\/g, "/");
        const consumerFile = path.join(root, "consumer.ts").replace(/\\/g, "/");
        await fsp.writeFile(typesFile, "export enum Mode {\n  Light,\n  Dark,\n}\n", "utf8");
        const usageLine = "const selected = Mode.Light;";
        const consumer = ['import { Mode } from "./types";', usageLine, ""].join("\n");
        await fsp.writeFile(consumerFile, consumer, "utf8");
        const index = await createTestIndexFromFiles(root, [typesFile, consumerFile]);

        await testGoToDefinition(index, consumerFile, 2, usageLine.indexOf("Mode.Light") + 1, typesFile, 1);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("resolves default imports to anonymous default exports", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ts-anon-default-goto-"));
      try {
        const widgetFile = path.join(root, "widget.ts").replace(/\\/g, "/");
        const consumerFile = path.join(root, "consumer.ts").replace(/\\/g, "/");
        await fsp.writeFile(widgetFile, "export default function(value: string) {\n  return value;\n}\n", "utf8");
        const usageLine = 'render("ok");';
        const consumer = ['import render from "./widget";', usageLine, ""].join("\n");
        await fsp.writeFile(consumerFile, consumer, "utf8");
        const index = await createTestIndexFromFiles(root, [widgetFile, consumerFile]);

        await testGoToDefinition(index, consumerFile, 2, usageLine.indexOf("render(") + 1, widgetFile, 1);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("resolves named default exports without synthetic defaults", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ts-named-default-goto-"));
      try {
        const widgetFile = path.join(root, "widget.ts").replace(/\\/g, "/");
        const consumerFile = path.join(root, "consumer.ts").replace(/\\/g, "/");
        await fsp.writeFile(widgetFile, "export default abstract class Widget {\n  abstract run(): void;\n}\n", "utf8");
        const usageLine = "class Impl extends Widget { run() {} }";
        const consumer = ['import Widget from "./widget";', usageLine, ""].join("\n");
        await fsp.writeFile(consumerFile, consumer, "utf8");
        const index = await createTestIndexFromFiles(root, [widgetFile, consumerFile]);
        const widgetModule = index.byFile.get(fileIdentityKey(widgetFile));
        const defaultExport = widgetModule?.exports.find(
          (entry) => entry.type === "local" && entry.exportedAs === "default",
        );

        expect(widgetModule?.locals.some((local) => local.localName === "__default_export__")).toBe(false);
        expect(defaultExport?.type).toBe("local");
        if (defaultExport?.type === "local") {
          expect(defaultExport.target.localName).toBe("Widget");
        }
        await testGoToDefinition(index, consumerFile, 2, usageLine.indexOf("Widget") + 1, widgetFile, 1);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("resolves shorthand object properties through imports", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ts-shorthand-goto-"));
      try {
        const valuesFile = path.join(root, "values.ts").replace(/\\/g, "/");
        const consumerFile = path.join(root, "consumer.ts").replace(/\\/g, "/");
        await fsp.writeFile(valuesFile, "export const value = 1;\n", "utf8");
        const usageLine = "const packet = { value };";
        const consumer = ['import { value } from "./values";', usageLine, ""].join("\n");
        await fsp.writeFile(consumerFile, consumer, "utf8");
        const index = await createTestIndexFromFiles(root, [valuesFile, consumerFile]);

        await testGoToDefinition(index, consumerFile, 2, usageLine.indexOf("value };") + 1, valuesFile, 1);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("resolves class method calls with high-confidence receivers", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ts-method-goto-"));
      try {
        const serviceFile = path.join(root, "service.ts").replace(/\\/g, "/");
        const consumerFile = path.join(root, "consumer.ts").replace(/\\/g, "/");
        await fsp.writeFile(
          serviceFile,
          ["export class Service {", "  run(value: number) {", "    return value;", "  }", "}", ""].join("\n"),
          "utf8",
        );
        await fsp.writeFile(
          consumerFile,
          [
            'import { Service } from "./service";',
            "new Service().run(1);",
            "const service = new Service();",
            "service.run(2);",
            "",
          ].join("\n"),
          "utf8",
        );
        const index = await createTestIndexFromFiles(root, [serviceFile, consumerFile]);

        await testGoToDefinition(index, consumerFile, 2, 15, serviceFile, 2);
        await testGoToDefinition(index, consumerFile, 4, 9, serviceFile, 2);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("does not resolve ambiguous same-name methods without receiver proof", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ts-method-goto-ambiguous-"));
      try {
        const serviceFile = path.join(root, "service.ts").replace(/\\/g, "/");
        const consumerFile = path.join(root, "consumer.ts").replace(/\\/g, "/");
        await fsp.writeFile(
          serviceFile,
          [
            "export class First {",
            "  run() { return 1; }",
            "}",
            "export class Second {",
            "  run() { return 2; }",
            "}",
            "",
          ].join("\n"),
          "utf8",
        );
        await fsp.writeFile(
          consumerFile,
          [
            'import { First, Second } from "./service";',
            "declare const unknown: First | Second;",
            "unknown.run();",
            "",
          ].join("\n"),
          "utf8",
        );
        const index = await createTestIndexFromFiles(root, [serviceFile, consumerFile]);

        await testGoToDefinition(index, consumerFile, 3, 9, undefined, undefined, "not_found");
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("does not reuse constructor proof across a shadowed receiver binding", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ts-method-goto-shadowed-receiver-"));
      try {
        const serviceFile = path.join(root, "service.ts").replace(/\\/g, "/");
        const consumerFile = path.join(root, "consumer.ts").replace(/\\/g, "/");
        await fsp.writeFile(
          serviceFile,
          [
            "export class Service {",
            "  run() { return 1; }",
            "}",
            "export class Other {",
            "  run() { return 2; }",
            "}",
            "",
          ].join("\n"),
          "utf8",
        );
        await fsp.writeFile(
          consumerFile,
          [
            'import { Service, Other } from "./service";',
            "const service = new Service();",
            "function call(service: Other) {",
            "  service.run();",
            "}",
            "",
          ].join("\n"),
          "utf8",
        );
        const index = await createTestIndexFromFiles(root, [serviceFile, consumerFile]);

        const result = await goToDefinition(index, { file: consumerFile, line: 4, column: 11 });

        if (result.status === "ok") {
          expect(result.definition.file).not.toBe(serviceFile);
          expect(result.definition.range.start.line).not.toBe(2);
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("should find definition of imported function", async () => {
      const index = await createTestIndex("typescript");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "typescript");
      const mainFile = path.join(samplePath, "main.ts").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "utils.ts").replace(/\\/g, "/");

      // Test go-to-definition on helperFunction() call on line 7
      const result = await testGoToDefinition(index, mainFile, 7, 25);

      if (result.status === "ok") {
        expect(result.definition.file).toBe(utilsFile);
        expect(result.definition.range.start.line).toBe(1); // helperFunction definition
        expect(result.provenance?.resolution).toBe("namespace");
        expect(result.provenance?.confidence).toBe("medium");
      }
    });

    it("should find definition of imported class", async () => {
      const index = await createTestIndex("typescript");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "typescript");
      const mainFile = path.join(samplePath, "main.ts").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "utils.ts").replace(/\\/g, "/");

      // Test go-to-definition on UtilityClass() call on line 12
      const result = await testGoToDefinition(index, mainFile, 12, 18);

      if (result.status === "ok") {
        expect(result.definition.file).toBe(utilsFile);
        expect(result.definition.range.start.line).toBe(5); // UtilityClass definition
      }
    });

    it("should find definition of namespace member", async () => {
      const index = await createTestIndex("typescript");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "typescript");
      const mainFile = path.join(samplePath, "main.ts").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "utils.ts").replace(/\\/g, "/");

      // Test go-to-definition on utils.helperFunction() call on line 7
      const result = await testGoToDefinition(index, mainFile, 7, 25);

      if (result.status === "ok") {
        expect(result.definition.file).toBe(utilsFile);
        expect(result.definition.range.start.line).toBe(1); // helperFunction definition
      }
    });

    it("should find definition of alias import", async () => {
      const index = await createTestIndex("typescript");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "typescript");
      const mainFile = path.join(samplePath, "main.ts").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "utils.ts").replace(/\\/g, "/");

      // Test go-to-definition on helperAlias() call on line 16
      const result = await testGoToDefinition(index, mainFile, 16, 20);

      if (result.status === "ok") {
        expect(result.definition.file).toBe(utilsFile);
        expect(result.definition.range.start.line).toBe(1); // helperFunction definition
      }
    });

    it("resolves bare imported calls separately from explicit receiver method calls", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ts-method-goto-explicit-receiver-"));
      try {
        const helperFile = path.join(root, "helper.ts").replace(/\\/g, "/");
        const mainFile = path.join(root, "main.ts").replace(/\\/g, "/");
        await fsp.writeFile(helperFile, "export function helper(): number { return 42; }\n", "utf8");
        await fsp.writeFile(
          mainFile,
          [
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
          "utf8",
        );
        const index = await createTestIndexFromFiles(root, [helperFile, mainFile]);

        await testGoToDefinition(index, mainFile, 5, 5, helperFile, 1);
        await testGoToDefinition(index, mainFile, 6, 17, mainFile, 3);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });
  });

  describe("TSX", () => {
    it("should find definition of JSX imports authored with .jsx extensions", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "tsx");
      const appFile = path.join(samplePath, "JsxImportApp.tsx").replace(/\\/g, "/");
      const buttonFile = path.join(samplePath, "components", "Button.tsx").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [appFile, buttonFile]);

      const result = await testGoToDefinition(index, appFile, 4, 11);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.definition.file).toBe(buttonFile);
        expect(result.definition.range.start.line).toBe(5);
      }
    });
  });

  describe("Python", () => {
    it("should find definition of imported function", async () => {
      const index = await createTestIndex("python");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "python");
      const mainFile = path.join(samplePath, "main.py").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "utils.py").replace(/\\/g, "/");

      // Test go-to-definition on helper_function() call on line 11
      const result = await testGoToDefinition(index, mainFile, 11, 18);

      if (result.status === "ok") {
        expect(result.definition.file).toBe(utilsFile);
        expect(result.definition.range.start.line).toBe(1); // helper_function definition
      }
    });

    it("should find definition of imported class", async () => {
      const index = await createTestIndex("python");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "python");
      const mainFile = path.join(samplePath, "main.py").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "utils.py").replace(/\\/g, "/");

      // Test go-to-definition on UtilityClass() call on line 12
      const result = await testGoToDefinition(index, mainFile, 12, 18);

      if (result.status === "ok") {
        expect(result.definition.file).toBe(utilsFile);
        expect(result.definition.range.start.line).toBe(5); // UtilityClass definition
      }
    });

    it("should find definition of namespace member", async () => {
      const index = await createTestIndex("python");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "python");
      const mainFile = path.join(samplePath, "main.py").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "utils.py").replace(/\\/g, "/");

      // Test go-to-definition on utils.helper_function() call on line 7
      const result = await testGoToDefinition(index, mainFile, 7, 25);

      if (result.status === "ok") {
        expect(result.definition.file).toBe(utilsFile);
        expect(result.definition.range.start.line).toBe(1); // helper_function definition
      }
    });

    it("should find definition of alias import", async () => {
      const index = await createTestIndex("python");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "python");
      const mainFile = path.join(samplePath, "main.py").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "utils.py").replace(/\\/g, "/");

      // Test go-to-definition on helper_alias() call on line 16
      const result = await testGoToDefinition(index, mainFile, 16, 18);

      if (result.status === "ok") {
        expect(result.definition.file).toBe(utilsFile);
        expect(result.definition.range.start.line).toBe(1); // helper_function definition
      }
    });

    it("does not fabricate a definition for a missing imported symbol", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-python-missing-import-goto-"));
      const moduleFile = path.join(root, "module.py").replace(/\\/g, "/");
      const mainFile = path.join(root, "main.py").replace(/\\/g, "/");
      try {
        await fsp.writeFile(moduleFile, "def existing():\n    return 1\n", "utf8");
        await fsp.writeFile(mainFile, "from module import missing\nmissing()\n", "utf8");

        const index = await createTestIndexFromFiles(root, [moduleFile, mainFile]);
        const result = await goToDefinition(index, { file: mainFile, line: 2, column: 2 });

        expect(result.status).toBe("not_found");
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("keeps a real Python submodule as a namespace import", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-python-submodule-import-"));
      const packageDir = path.join(root, "package");
      const packageFile = path.join(packageDir, "__init__.py").replace(/\\/g, "/");
      const childFile = path.join(packageDir, "child.py").replace(/\\/g, "/");
      const mainFile = path.join(root, "main.py").replace(/\\/g, "/");
      try {
        await fsp.mkdir(packageDir);
        await fsp.writeFile(packageFile, "", "utf8");
        await fsp.writeFile(childFile, "value = 1\n", "utf8");
        await fsp.writeFile(mainFile, "from package import child\n", "utf8");

        const index = await createTestIndexFromFiles(root, [packageFile, childFile, mainFile]);
        const mainModule = index.byFile.get(fileIdentityKey(mainFile));
        const binding = mainModule?.imports.find((candidate) => candidate.kind === "namespace");

        expect(binding?.kind).toBe("namespace");
        if (!binding || binding.kind !== "namespace") return;
        expect(binding.resolved).toBe(childFile);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("resolves Python match bindings and Python stub imports", async () => {
      const fixturePath = path.resolve(process.cwd(), "tests", "samples", "language-regressions", "python");
      const matchFile = path.join(fixturePath, "match_bindings.py").replace(/\\/g, "/");
      const stubFile = path.join(fixturePath, "stubs.pyi").replace(/\\/g, "/");
      const consumerFile = path.join(fixturePath, "stub_consumer.py").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(fixturePath, [matchFile, stubFile, consumerFile]);

      await testGoToDefinition(index, matchFile, 4, 20, matchFile, 3);
      await testGoToDefinition(index, matchFile, 6, 20, matchFile, 5);
      await testGoToDefinition(index, consumerFile, 4, 10, stubFile, 5);
    });
  });

  describe("PHP", () => {
    it("should find definition of imported function", async () => {
      const index = await createTestIndex("php");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "php");
      const mainFile = path.join(samplePath, "main.php").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "utils.php").replace(/\\/g, "/");

      const result = await testGoToDefinition(index, mainFile, 9, 11);

      if (result.status === "ok") {
        expect(result.definition.file).toBe(utilsFile);
        expect(result.definition.range.start.line).toBe(19);
      }
    });

    it("should find definition of imported class", async () => {
      const index = await createTestIndex("php");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "php");
      const mainFile = path.join(samplePath, "main.php").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "utils.php").replace(/\\/g, "/");

      const result = await testGoToDefinition(index, mainFile, 10, 12);

      if (result.status === "ok") {
        expect(result.definition.file).toBe(utilsFile);
        expect(result.definition.range.start.line).toBe(5);
      }
    });
    it("resolves typed, untyped, and static properties to their declarations", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "php");
      const propertiesFile = path.join(samplePath, "properties.php").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [propertiesFile]);

      await testGoToDefinition(index, propertiesFile, 11, 23, propertiesFile, 5);
      await testGoToDefinition(index, propertiesFile, 11, 38, propertiesFile, 6);
      await testGoToDefinition(index, propertiesFile, 11, 53, propertiesFile, 7);
    });

    it("should find definition of grouped use aliases", async () => {
      const index = await createTestIndex("php");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "php");
      const groupedFile = path.join(samplePath, "grouped-consumer.php").replace(/\\/g, "/");
      const toolboxFile = path.join(samplePath, "src", "Support", "Toolbox.php").replace(/\\/g, "/");
      const helperFile = path.join(samplePath, "src", "Support", "support_helper.php").replace(/\\/g, "/");

      await testGoToDefinition(index, groupedFile, 8, 10, toolboxFile, 5);
      await testGoToDefinition(index, groupedFile, 9, 12, helperFile, 5);
    });

    it("should find definition of Composer-mapped classes", async () => {
      const index = await createTestIndex("php");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "php");
      const mainFile = path.join(samplePath, "composer-consumer.php").replace(/\\/g, "/");
      const serviceFile = path.join(samplePath, "src", "Domain", "Service.php").replace(/\\/g, "/");

      const result = await testGoToDefinition(index, mainFile, 5, 16);

      if (result.status === "ok") {
        expect(result.definition.file).toBe(serviceFile);
        expect(result.definition.range.start.line).toBe(5);
      }
    });

    it("should find definition through PHP __DIR__ includes", async () => {
      const index = await createTestIndex("php");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "php");
      const consumerFile = path.join(samplePath, "dir-include-consumer.php").replace(/\\/g, "/");
      const helpersFile = path.join(samplePath, "helpers.php").replace(/\\/g, "/");

      await testGoToDefinition(index, consumerFile, 5, 6, helpersFile, 3);
    });

    it("should find definition of fully-qualified Composer-mapped classes", async () => {
      const index = await createTestIndex("php");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "php");
      const consumerFile = path.join(samplePath, "composer-qualified-consumer.php").replace(/\\/g, "/");
      const serviceFile = path.join(samplePath, "src", "Domain", "Service.php").replace(/\\/g, "/");

      await testGoToDefinition(index, consumerFile, 3, 27, serviceFile, 5);
    });

    it("should find definition of fully-qualified Composer-mapped static class references", async () => {
      const index = await createTestIndex("php");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "php");
      const consumerFile = path.join(samplePath, "composer-static-qualified-consumer.php").replace(/\\/g, "/");
      const serviceFile = path.join(samplePath, "src", "Domain", "Service.php").replace(/\\/g, "/");

      await testGoToDefinition(index, consumerFile, 3, 23, serviceFile, 5);
    });

    it("should find definition of fully-qualified Composer-mapped static constant references", async () => {
      const index = await createTestIndex("php");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "php");
      const consumerFile = path.join(samplePath, "composer-static-constant-consumer.php").replace(/\\/g, "/");
      const serviceFile = path.join(samplePath, "src", "Domain", "Service.php").replace(/\\/g, "/");

      await testGoToDefinition(index, consumerFile, 3, 23, serviceFile, 5);
    });

    it("should find definition of fully-qualified Composer-mapped static property references", async () => {
      const index = await createTestIndex("php");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "php");
      const consumerFile = path.join(samplePath, "composer-static-property-consumer.php").replace(/\\/g, "/");
      const serviceFile = path.join(samplePath, "src", "Domain", "Service.php").replace(/\\/g, "/");

      await testGoToDefinition(index, consumerFile, 3, 25, serviceFile, 5);
    });

    it("should not treat fully-qualified PHP type names as receiver members", async () => {
      const index = await createTestIndex("php");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "php");
      const consumerFile = path.join(samplePath, "composer-type-qualified-consumer.php").replace(/\\/g, "/");
      const serviceFile = path.join(samplePath, "src", "Domain", "Service.php").replace(/\\/g, "/");

      const result = await testGoToDefinition(index, consumerFile, 3, 37, serviceFile, 5);
      if (result.status === "ok") {
        expect(result.provenance).toEqual({
          resolution: "php-qualified",
          confidence: "high",
        });
      }
    });

    it("should find definitions through Composer PSR-0, autoload-dev, classmap, and files entries", async () => {
      const index = await createTestIndex("php");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "php");

      await testGoToDefinition(
        index,
        path.join(samplePath, "composer-psr0-consumer.php").replace(/\\/g, "/"),
        5,
        6,
        path.join(samplePath, "legacy", "Tools", "Box.php").replace(/\\/g, "/"),
        5,
      );
      await testGoToDefinition(
        index,
        path.join(samplePath, "composer-dev-psr4-consumer.php").replace(/\\/g, "/"),
        5,
        6,
        path.join(samplePath, "dev-src", "Tool.php").replace(/\\/g, "/"),
        5,
      );
      await testGoToDefinition(
        index,
        path.join(samplePath, "composer-dev-psr0-consumer.php").replace(/\\/g, "/"),
        5,
        6,
        path.join(samplePath, "dev-legacy", "Tools", "Box.php").replace(/\\/g, "/"),
        5,
      );
      await testGoToDefinition(
        index,
        path.join(samplePath, "composer-classmap-consumer.php").replace(/\\/g, "/"),
        5,
        6,
        path.join(samplePath, "classmap", "Specific.php").replace(/\\/g, "/"),
        5,
      );
      await testGoToDefinition(
        index,
        path.join(samplePath, "composer-dev-classmap-consumer.php").replace(/\\/g, "/"),
        5,
        6,
        path.join(samplePath, "dev-classmap", "DevSpecific.php").replace(/\\/g, "/"),
        5,
      );
      await testGoToDefinition(
        index,
        path.join(samplePath, "composer-excluded-psr4-consumer.php").replace(/\\/g, "/"),
        6,
        6,
        path.join(samplePath, "classmap", "Excluded", "PsrMapped.php").replace(/\\/g, "/"),
        5,
      );
      await testGoToDefinition(
        index,
        path.join(samplePath, "composer-excluded-psr4-consumer.php").replace(/\\/g, "/"),
        7,
        3,
        path.join(samplePath, "classmap", "Excluded", "psr_helper.php").replace(/\\/g, "/"),
        5,
      );
      await testGoToDefinition(
        index,
        path.join(samplePath, "composer-files-consumer.php").replace(/\\/g, "/"),
        3,
        3,
        path.join(samplePath, "autoload", "global_helper.php").replace(/\\/g, "/"),
        3,
      );
      await testGoToDefinition(
        index,
        path.join(samplePath, "composer-excluded-files-consumer.php").replace(/\\/g, "/"),
        3,
        3,
        path.join(samplePath, "classmap", "Excluded", "excluded_helper.php").replace(/\\/g, "/"),
        3,
      );
    });

    it("should not resolve Composer classes excluded from classmap", async () => {
      const index = await createTestIndex("php");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "php");
      const consumerFile = path.join(samplePath, "composer-excluded-classmap-consumer.php").replace(/\\/g, "/");

      const result = await testGoToDefinition(index, consumerFile, 5, 6, undefined, undefined, "not_found");

      expect(result.status).toBe("not_found");
    });

    it("should respect PHP function import kinds when class names collide", async () => {
      const index = await createTestIndex("php");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "php");
      const consumerFile = path.join(samplePath, "function-import-consumer.php").replace(/\\/g, "/");
      const functionFile = path.join(samplePath, "src", "Collision", "ThingFunction.php").replace(/\\/g, "/");

      await testGoToDefinition(index, consumerFile, 5, 10, functionFile, 5);
    });

    it("should find definitions from PHP bracketed namespace blocks", async () => {
      const index = await createTestIndex("php");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "php");
      const consumerFile = path.join(samplePath, "bracketed-consumer.php").replace(/\\/g, "/");
      const libraryFile = path.join(samplePath, "multi-namespace", "Library.php").replace(/\\/g, "/");

      await testGoToDefinition(index, consumerFile, 5, 17, libraryFile, 8);
    });

    it("should find fully-qualified definitions from later PHP namespace blocks", async () => {
      const index = await createTestIndex("php");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "php");
      const consumerFile = path.join(samplePath, "bracketed-qualified-consumer.php").replace(/\\/g, "/");
      const libraryFile = path.join(samplePath, "multi-namespace", "Library.php").replace(/\\/g, "/");

      await testGoToDefinition(index, consumerFile, 3, 29, libraryFile, 8);
    });
  });

  describe("JavaScript", () => {
    it("should find definition of imported function", async () => {
      const index = await createTestIndex("javascript");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "javascript");
      const mainFile = path.join(samplePath, "main.js").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "utils.js").replace(/\\/g, "/");

      // Test go-to-definition on helperFunction() call on line 7
      const result = await testGoToDefinition(index, mainFile, 7, 25);

      if (result.status === "ok") {
        expect(result.definition.file).toBe(utilsFile);
        expect(result.definition.range.start.line).toBe(1); // helperFunction definition
      }
    });

    it("should find definition of imported class", async () => {
      const index = await createTestIndex("javascript");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "javascript");
      const mainFile = path.join(samplePath, "main.js").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "utils.js").replace(/\\/g, "/");

      // Test go-to-definition on UtilityClass() call on line 12
      const result = await testGoToDefinition(index, mainFile, 12, 18);

      if (result.status === "ok") {
        expect(result.definition.file).toBe(utilsFile);
        expect(result.definition.range.start.line).toBe(5); // UtilityClass definition
      }
    });

    it("should find definition of namespace member", async () => {
      const index = await createTestIndex("javascript");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "javascript");
      const mainFile = path.join(samplePath, "main.js").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "utils.js").replace(/\\/g, "/");

      // Test go-to-definition on utils.helperFunction() call on line 7
      const result = await testGoToDefinition(index, mainFile, 7, 25);

      if (result.status === "ok") {
        expect(result.definition.file).toBe(utilsFile);
        expect(result.definition.range.start.line).toBe(1); // helperFunction definition
      }
    });

    it("should find definition of alias import", async () => {
      const index = await createTestIndex("javascript");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "javascript");
      const mainFile = path.join(samplePath, "main.js").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "utils.js").replace(/\\/g, "/");

      // Test go-to-definition on helperAlias() call on line 16
      const result = await testGoToDefinition(index, mainFile, 16, 20);

      if (result.status === "ok") {
        expect(result.definition.file).toBe(utilsFile);
        expect(result.definition.range.start.line).toBe(1); // helperFunction definition
      }
    });

    it("should find definition of CommonJS require", async () => {
      const index = await createTestIndex("javascript");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "javascript");
      const mainFile = path.join(samplePath, "main.js").replace(/\\/g, "/");
      const helpersFile = path.join(samplePath, "helpers.js").replace(/\\/g, "/");

      // Test go-to-definition on requireHelper() call on line 33
      const result = await testGoToDefinition(index, mainFile, 33, 18);

      if (result.status === "ok") {
        expect(result.definition.file).toBe(helpersFile);
        expect(result.definition.range.start.line).toBe(1); // helperFunction definition
      }
    });

    it("resolves bare imported calls separately from explicit receiver method calls", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-js-method-goto-explicit-receiver-"));
      try {
        const helperFile = path.join(root, "helper.js").replace(/\\/g, "/");
        const mainFile = path.join(root, "main.js").replace(/\\/g, "/");
        await fsp.writeFile(helperFile, "export function helper() { return 42; }\n", "utf8");
        await fsp.writeFile(
          mainFile,
          [
            'import { helper } from "./helper.js";',
            "class Widget {",
            "  helper() { return 1; }",
            "  run() {",
            "    helper();",
            "    return this.helper();",
            "  }",
            "}",
            "",
          ].join("\n"),
          "utf8",
        );
        const index = await createTestIndexFromFiles(root, [helperFile, mainFile]);

        await testGoToDefinition(index, mainFile, 5, 5, helperFile, 1);
        await testGoToDefinition(index, mainFile, 6, 17, mainFile, 3);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });
  });

  describe("Go", () => {
    it("should find definition of imported function", async () => {
      const index = await createTestIndex("go");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "go");
      const mainFile = path.join(samplePath, "main.go").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "utils.go").replace(/\\/g, "/");

      await testGoToDefinition(index, mainFile, 9, 9, utilsFile, 5);
    });

    it("should find definition of imported struct type", async () => {
      const index = await createTestIndex("go");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "go");
      const mainFile = path.join(samplePath, "main.go").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "utils.go").replace(/\\/g, "/");

      await testGoToDefinition(index, mainFile, 12, 20, utilsFile, 9);
    });

    it("should find definition of aliased imported struct type", async () => {
      const index = await createTestIndex("go");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "go");
      const aliasFile = path.join(samplePath, "aliased-types.go").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "utils.go").replace(/\\/g, "/");

      await testGoToDefinition(index, aliasFile, 9, 24, utilsFile, 9);
    });

    it("should find definition of dot-imported constructor", async () => {
      const index = await createTestIndex("go");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "go");
      const dotImportFile = path.join(samplePath, "dot-imports.go").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "utils.go").replace(/\\/g, "/");

      await testGoToDefinition(index, dotImportFile, 9, 15, utilsFile, 13);
    });
  });

  describe("C", () => {
    it("should find definition of included function declaration", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "c");
      const mainFile = path.join(samplePath, "main.c").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "utils.h").replace(/\\/g, "/");
      const helpersFile = path.join(samplePath, "helpers.h").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [mainFile, utilsFile, helpersFile]);

      await testGoToDefinition(index, mainFile, 5, 15, utilsFile, 8);
    });

    it("should find definition of included typedef struct", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "c");
      const mainFile = path.join(samplePath, "main.c").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "utils.h").replace(/\\/g, "/");
      const helpersFile = path.join(samplePath, "helpers.h").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [mainFile, utilsFile, helpersFile]);

      await testGoToDefinition(index, mainFile, 6, 3, utilsFile, 6);
    });

    it("should find definition of function-pointer typedef", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "c");
      const advancedUseFile = path.join(samplePath, "advanced-use.c").replace(/\\/g, "/");
      const functionPointersFile = path.join(samplePath, "function-pointers.h").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [advancedUseFile, functionPointersFile]);

      await testGoToDefinition(index, advancedUseFile, 4, 3, functionPointersFile, 3);
    });
  });

  describe("C++", () => {
    it("should find definition of included function declaration", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "cpp");
      const mainFile = path.join(samplePath, "main.cpp").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "utils.hpp").replace(/\\/g, "/");
      const helpersFile = path.join(samplePath, "helpers.hpp").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [mainFile, utilsFile, helpersFile]);

      await testGoToDefinition(index, mainFile, 5, 15, utilsFile, 7);
    });

    it("should find definition of included struct type", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "cpp");
      const mainFile = path.join(samplePath, "main.cpp").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "utils.hpp").replace(/\\/g, "/");
      const helpersFile = path.join(samplePath, "helpers.hpp").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [mainFile, utilsFile, helpersFile]);

      await testGoToDefinition(index, mainFile, 6, 3, utilsFile, 3);
    });

    it("should find definition of namespace-qualified alias target", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "cpp");
      const usageFile = path.join(samplePath, "namespace-usage.cpp").replace(/\\/g, "/");
      const namespaceFile = path.join(samplePath, "namespaces.hpp").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [usageFile, namespaceFile]);

      await testGoToDefinition(index, usageFile, 4, 12, namespaceFile, 4);
    });
  });

  describe("Kotlin", () => {
    it("should find definition of imported function", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "kotlin");
      const mainFile = path.join(samplePath, "main.kt").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "utils", "helperFunction.kt").replace(/\\/g, "/");
      const helpersFile = path.join(samplePath, "helpers", "helperFromHelpers.kt").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [mainFile, utilsFile, helpersFile]);

      await testGoToDefinition(index, mainFile, 6, 15, utilsFile, 3);
    });

    it("should find definition of imported class", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "kotlin");
      const mainFile = path.join(samplePath, "main.kt").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "utils", "helperFunction.kt").replace(/\\/g, "/");
      const helpersFile = path.join(samplePath, "helpers", "helperFromHelpers.kt").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [mainFile, utilsFile, helpersFile]);

      await testGoToDefinition(index, mainFile, 7, 17, utilsFile, 7);
    });

    it("should find definition of aliased imported class", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "kotlin");
      const aliasFile = path.join(samplePath, "Aliases.kt").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "utils", "helperFunction.kt").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [aliasFile, utilsFile]);

      await testGoToDefinition(index, aliasFile, 3, 24, utilsFile, 7);
    });

    it("should find definition of wildcard-imported type alias", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "kotlin");
      const consumerFile = path.join(samplePath, "TypeConsumers.kt").replace(/\\/g, "/");
      const moreTypesFile = path.join(samplePath, "utils", "MoreTypes.kt").replace(/\\/g, "/");
      const helperFile = path.join(samplePath, "utils", "helperFunction.kt").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [consumerFile, moreTypesFile, helperFile]);

      await testGoToDefinition(index, consumerFile, 3, 21, moreTypesFile, 3);
    });

    it("should find definition of wildcard-imported helper functions", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "kotlin");
      const consumerFile = path.join(samplePath, "TypeConsumers.kt").replace(/\\/g, "/");
      const moreTypesFile = path.join(samplePath, "utils", "MoreTypes.kt").replace(/\\/g, "/");
      const helperFile = path.join(samplePath, "utils", "helperFunction.kt").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [consumerFile, moreTypesFile, helperFile]);

      await testGoToDefinition(index, consumerFile, 12, 10, helperFile, 3);
    });
  });

  describe("Swift", () => {
    it("should find definition of imported function", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "swift");
      const mainFile = path.join(samplePath, "main.swift").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "Utils.swift").replace(/\\/g, "/");
      const helpersFile = path.join(samplePath, "Helpers.swift").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [mainFile, utilsFile, helpersFile]);

      await testGoToDefinition(index, mainFile, 5, 21, utilsFile, 1);
    });

    it("should find definition of imported struct", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "swift");
      const mainFile = path.join(samplePath, "main.swift").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "Utils.swift").replace(/\\/g, "/");
      const helpersFile = path.join(samplePath, "Helpers.swift").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [mainFile, utilsFile, helpersFile]);

      await testGoToDefinition(index, mainFile, 6, 23, utilsFile, 5);
    });

    it("should find definition of imported static factory type", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "swift");
      const usageFile = path.join(samplePath, "AdvancedUsage.swift").replace(/\\/g, "/");
      const staticMembersFile = path.join(samplePath, "StaticMembers.swift").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "Utils.swift").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [usageFile, staticMembersFile, utilsFile]);

      await testGoToDefinition(index, usageFile, 4, 10, staticMembersFile, 6);
    });
  });

  describe("Zig", () => {
    it("should find definition of imported function member", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "zig");
      const mainFile = path.join(samplePath, "main.zig").replace(/\\/g, "/");
      const helpersFile = path.join(samplePath, "helpers.zig").replace(/\\/g, "/");
      const mathFile = path.join(samplePath, "math.zig").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [mainFile, helpersFile, mathFile]);

      await testGoToDefinition(index, mainFile, 5, 43, helpersFile, 1);
    });

    it("should find definition of imported type member", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "zig");
      const mainFile = path.join(samplePath, "main.zig").replace(/\\/g, "/");
      const helpersFile = path.join(samplePath, "helpers.zig").replace(/\\/g, "/");
      const mathFile = path.join(samplePath, "math.zig").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [mainFile, helpersFile, mathFile]);

      await testGoToDefinition(index, mainFile, 5, 23, mathFile, 1);
    });
  });

  describe("Java", () => {
    it("should find definition of imported annotation types", async () => {
      const index = await createTestIndex("java");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "java");
      const consumerFile = path.join(samplePath, "AnnotationConsumer.java").replace(/\\/g, "/");
      const annotationFile = path.join(samplePath, "AnnotationTypes.java").replace(/\\/g, "/");

      await testGoToDefinition(index, consumerFile, 5, 2, annotationFile, 3);
    });

    it("should find definition of imported static method", async () => {
      const index = await createTestIndex("java");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "java");
      const mainFile = path.join(samplePath, "main.java").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "utils", "Utils.java").replace(/\\/g, "/");
      // Test go-to-definition on Utils.helperFunction() call line 8 col 11
      await testGoToDefinition(index, mainFile, 8, 11, utilsFile, 4);
    });

    it("should find definition of static nested class", async () => {
      const index = await createTestIndex("java");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "java");
      const mainFile = path.join(samplePath, "main.java").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "utils", "Utils.java").replace(/\\/g, "/");
      // Test go-to-definition on new Utils.UtilityClass() UtilityClass line 9 col 15
      await testGoToDefinition(index, mainFile, 9, 15, utilsFile, 5);
    });

    it("should find definition of wildcard-imported nested type", async () => {
      const index = await createTestIndex("java");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "java");
      const wildcardFile = path.join(samplePath, "WildcardImports.java").replace(/\\/g, "/");
      const packageFile = path.join(samplePath, "pkg", "PackageTypes.java").replace(/\\/g, "/");

      await testGoToDefinition(index, wildcardFile, 6, 16, packageFile, 4);
    });

    it("should find definition of wildcard-imported package interfaces across files", async () => {
      const index = await createTestIndex("java");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "java");
      const wildcardFile = path.join(samplePath, "WildcardImports.java").replace(/\\/g, "/");
      const packageFile = path.join(samplePath, "pkg", "PackageService.java").replace(/\\/g, "/");

      await testGoToDefinition(index, wildcardFile, 8, 3, packageFile, 3);
    });

    it("should find definition of static wildcard-imported methods", async () => {
      const index = await createTestIndex("java");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "java");
      const wildcardFile = path.join(samplePath, "StaticWildcardImports.java").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "utils", "Utils.java").replace(/\\/g, "/");

      await testGoToDefinition(index, wildcardFile, 7, 5, utilsFile, 4);
    });

    it("resolves receiver method calls through typed locals", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-java-method-goto-receiver-"));
      try {
        const serviceFile = path.join(root, "Service.java").replace(/\\/g, "/");
        await fsp.writeFile(
          serviceFile,
          [
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
          "utf8",
        );
        const index = await createTestIndexFromFiles(root, [serviceFile]);
        const callLine = "    return service.run(1) + new Other().run(2);";

        await testGoToDefinition(
          index,
          serviceFile,
          10,
          callLine.indexOf("service.run") + "service.".length + 1,
          serviceFile,
          2,
        );
        await testGoToDefinition(
          index,
          serviceFile,
          10,
          callLine.indexOf("Other().run") + "Other().".length + 1,
          serviceFile,
          5,
        );
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("resolves a static import alias that differs only by an ignorable character", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-java-unicode-import-goto-"));
      try {
        const utilFile = path.join(root, "demo", "Util.java").replace(/\\/g, "/");
        const consumerFile = path.join(root, "demo", "Consumer.java").replace(/\\/g, "/");
        await fsp.mkdir(path.dirname(utilFile), { recursive: true });
        await fsp.writeFile(
          utilFile,
          ["package demo;", "class Util\u200c {", "  static void helper() {}", "}", ""].join("\n"),
          "utf8",
        );
        await fsp.writeFile(
          consumerFile,
          [
            "package demo;",
            "import static demo.Util.helper;",
            "class Consumer {",
            "  void run() {",
            "    helper();",
            "  }",
            "}",
            "",
          ].join("\n"),
          "utf8",
        );
        const index = await createTestIndexFromFiles(root, [utilFile, consumerFile]);
        const module = index.byFile.get(fileIdentityKey(consumerFile));
        const imported = module?.imports.find((imp) => imp.kind === "named");

        expect(imported).toBeDefined();
        if (!module || !imported || imported.kind !== "named") return;
        imported.local = "help\u200cer";
        const result = resolveNamedDefinition(index, module, consumerFile, JAVA_SUPPORT, "helper");

        expect(result?.status).toBe("ok");
        if (result?.status === "ok") {
          expect(fileIdentityKey(result.definition.file)).toBe(fileIdentityKey(utilFile));
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("resolves an unqualified call to the same-file method, not a same-named method in another class", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-java-method-goto-unqualified-"));
      try {
        const mainFile = path.join(root, "Main.java").replace(/\\/g, "/");
        await fsp.writeFile(
          mainFile,
          [
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
          "utf8",
        );
        const index = await createTestIndexFromFiles(root, [mainFile]);
        await testGoToDefinition(index, mainFile, 4, 5, mainFile, 2);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });
  });

  describe("C#", () => {
    it("should find definition of static method", async () => {
      const index = await createTestIndex("csharp");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "csharp");
      const mainFile = path.join(samplePath, "Main.cs").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "Utils.cs").replace(/\\/g, "/");
      // UtilsClass.HelperFunction() on 'H' line 7 col 16
      await testGoToDefinition(index, mainFile, 7, 16, utilsFile, 3);
    });

    it("should find definition of nested class", async () => {
      const index = await createTestIndex("csharp");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "csharp");
      const mainFile = path.join(samplePath, "Main.cs").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "Utils.cs").replace(/\\/g, "/");
      // new UtilsClass.UtilityClass() on 'U' UtilityClass line 8 col 20
      await testGoToDefinition(index, mainFile, 8, 20, utilsFile, 4);
    });

    it("should find definition of namespace member", async () => {
      const index = await createTestIndex("csharp");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "csharp");
      const mainFile = path.join(samplePath, "Main.cs").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "Utils.cs").replace(/\\/g, "/");
      // UtilsClass.HelperFunction() on 'U' UtilsClass line 7 col 5
      await testGoToDefinition(index, mainFile, 7, 5, utilsFile, 2);
    });

    it("should find definition of alias", async () => {
      const index = await createTestIndex("csharp");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "csharp");
      const mainFile = path.join(samplePath, "Main.cs").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "Utils.cs").replace(/\\/g, "/");
      // UUtils.HelperFunction() on 'U' UUtils line 10 col 5
      await testGoToDefinition(index, mainFile, 10, 5, utilsFile, 2);
    });

    it("resolves receiver method calls through typed locals", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-csharp-method-goto-receiver-"));
      try {
        const serviceFile = path.join(root, "Service.cs").replace(/\\/g, "/");
        await fsp.writeFile(
          serviceFile,
          [
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
          "utf8",
        );
        const index = await createTestIndexFromFiles(root, [serviceFile]);
        const callLine = "    return service.Run(1) + new Other().Run(2);";

        await testGoToDefinition(
          index,
          serviceFile,
          10,
          callLine.indexOf("service.Run") + "service.".length + 1,
          serviceFile,
          2,
        );
        await testGoToDefinition(
          index,
          serviceFile,
          10,
          callLine.indexOf("Other().Run") + "Other().".length + 1,
          serviceFile,
          5,
        );
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("resolves an unqualified call to the same-file method, not a same-named method in another class", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-csharp-method-goto-unqualified-"));
      try {
        const mainFile = path.join(root, "Main.cs").replace(/\\/g, "/");
        await fsp.writeFile(
          mainFile,
          [
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
          "utf8",
        );
        const index = await createTestIndexFromFiles(root, [mainFile]);
        await testGoToDefinition(index, mainFile, 4, 5, mainFile, 2);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });
  });

  describe("Ruby", () => {
    it("should find definition of module function", async () => {
      const index = await createTestIndex("ruby");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "ruby");
      const mainFile = path.join(samplePath, "main.rb").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "utils.rb").replace(/\\/g, "/");
      // Test go-to-definition on Utils.helper_function call line 4 col 7
      await testGoToDefinition(index, mainFile, 4, 7, utilsFile, 2);
    });
    it("should find definition of class", async () => {
      const index = await createTestIndex("ruby");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "ruby");
      const mainFile = path.join(samplePath, "main.rb").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "utils.rb").replace(/\\/g, "/");
      // Test go-to-definition on Utils::UtilityClass line 6 col 13
      await testGoToDefinition(index, mainFile, 6, 13, utilsFile, 4);
    });

    it("should find definition of namespaced class", async () => {
      const index = await createTestIndex("ruby");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "ruby");
      const consumerFile = path.join(samplePath, "consumer.rb").replace(/\\/g, "/");
      const namespacedFile = path.join(samplePath, "namespaced.rb").replace(/\\/g, "/");

      await testGoToDefinition(index, consumerFile, 3, 22, namespacedFile, 5);
    });
  });

  describe("Rust", () => {
    it("should find definition of helper_function", async () => {
      const index = await createTestIndex("rust");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "rust");
      const mainFile = path.join(samplePath, "main.rs").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "utils.rs").replace(/\\/g, "/");
      // helper_function() on line 8 col 5
      await testGoToDefinition(index, mainFile, 8, 5, utilsFile, 1);
    });
    it("should find definition of helper_from_helpers", async () => {
      const index = await createTestIndex("rust");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "rust");
      const mainFile = path.join(samplePath, "main.rs").replace(/\\/g, "/");
      const helpersFile = path.join(samplePath, "helpers.rs").replace(/\\/g, "/");
      // helper_from_helpers() on line 9 col 5
      await testGoToDefinition(index, mainFile, 9, 5, helpersFile, 1);
    });

    it("should find definition of nested module type", async () => {
      const index = await createTestIndex("rust");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "rust");
      const nestedFile = path.join(samplePath, "nested.rs").replace(/\\/g, "/");
      const nestedServiceFile = path.join(samplePath, "nested_service.rs").replace(/\\/g, "/");

      await testGoToDefinition(index, nestedFile, 6, 18, nestedServiceFile, 1);
    });

    it("should find definition of aliased Rust imports", async () => {
      const index = await createTestIndex("rust");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "rust");
      const aliasFile = path.join(samplePath, "aliased-use.rs").replace(/\\/g, "/");
      const utilsFile = path.join(samplePath, "utils.rs").replace(/\\/g, "/");

      await testGoToDefinition(index, aliasFile, 9, 5, utilsFile, 1);
    });

    it("resolves receiver method calls through impl-backed locals", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-rust-method-goto-receiver-"));
      try {
        const serviceFile = path.join(root, "service.rs").replace(/\\/g, "/");
        await fsp.writeFile(
          serviceFile,
          [
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
          "utf8",
        );
        const index = await createTestIndexFromFiles(root, [serviceFile]);
        const callLine = "  service.run(1) + Other.run(2)";

        await testGoToDefinition(
          index,
          serviceFile,
          11,
          callLine.indexOf("service.run") + "service.".length + 1,
          serviceFile,
          3,
        );
        await testGoToDefinition(
          index,
          serviceFile,
          11,
          callLine.indexOf("Other.run") + "Other.".length + 1,
          serviceFile,
          7,
        );
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("resolves a receiver member with an NFC declaration and NFD call", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-rust-unicode-member-goto-"));
      try {
        const serviceFile = path.join(root, "service.rs").replace(/\\/g, "/");
        const methodName = "caf\u00e9";
        const calledMethodName = "cafe\u0301";
        const source = [
          "struct Service;",
          "impl Service {",
          `  fn ${methodName}(&self) {}`,
          "}",
          "fn test() {",
          "  let service = Service;",
          `  service.${calledMethodName}();`,
          "}",
          "",
        ].join("\n");
        await fsp.writeFile(serviceFile, source, "utf8");
        const index = await createTestIndexFromFiles(root, [serviceFile]);

        await testGoToDefinition(
          index,
          serviceFile,
          7,
          source.split("\n")[6]!.indexOf(calledMethodName) + 1,
          serviceFile,
          3,
        );
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("resolves macro invocations to macro_rules definitions", async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "rust");
      const macroFile = path.join(samplePath, ".regressions", "macros.rs").replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [macroFile]);

      await testGoToDefinition(index, macroFile, 6, 5, macroFile, 1);
    });
  });
});

describe("Go to Definition: Unicode identifiers (C11)", () => {
  it("resolves a call to a Unicode-named function to its exact identifier position", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-goto-unicode-"));
    try {
      const defFile = path.join(root, "u1.py").replace(/\\/g, "/");
      const useFile = path.join(root, "consumer.py").replace(/\\/g, "/");
      const defSource = 'x = "ééé"\ndef créer():\n    return 1\n';
      const useSource = "from u1 import créer\n\ncréer()\n";
      await fsp.writeFile(defFile, defSource, "utf8");
      await fsp.writeFile(useFile, useSource, "utf8");
      const index = await createTestIndexFromFiles(root, [defFile, useFile]);

      const callColumn = useSource.split("\n")[2]!.indexOf("créer") + 1;
      const result = await goToDefinition(index, { file: useFile, line: 3, column: callColumn });

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(fileIdentityKey(result.definition.file)).toBe(fileIdentityKey(defFile));
      // The definition range must land exactly on "créer" in def source, not offset by the
      // byte length of the preceding non-ASCII string literal.
      expect(result.definition.range.start.index).toBe(defSource.indexOf("créer"));
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Go to Definition: Unicode cross-file fixtures", () => {
  it("resolves a Java combining-mark class imported across files", async () => {
    const samplePath = path.resolve(process.cwd(), "tests", "samples", "java");
    const consumerFile = path.join(samplePath, ".regressions", "unicode_consumer.java").replace(/\\/g, "/");
    const definitionFile = path.join(samplePath, ".regressions", "unicode_def.java").replace(/\\/g, "/");
    const index = await createTestIndexFromFiles(samplePath, [consumerFile, definitionFile]);

    await testGoToDefinition(index, consumerFile, 7, 12, definitionFile, 3);
  });

  it("resolves a Kotlin Unicode import alias across files", async () => {
    const samplePath = path.resolve(process.cwd(), "tests", "samples", "kotlin");
    const consumerFile = path.join(samplePath, ".regressions", "unicode_consumer.kt").replace(/\\/g, "/");
    const definitionFile = path.join(samplePath, ".regressions", "unicode_def.kt").replace(/\\/g, "/");
    const index = await createTestIndexFromFiles(samplePath, [consumerFile, definitionFile]);

    await testGoToDefinition(index, consumerFile, 6, 10, definitionFile, 3);
  });

  it("resolves a Go Unicode-letter import alias across files", async () => {
    const samplePath = path.resolve(process.cwd(), "tests", "samples", "go");
    const consumerFile = path.join(samplePath, ".regressions", "unicode_consumer.go").replace(/\\/g, "/");
    const definitionFile = path.join(samplePath, ".regressions", "unicodepkg.go").replace(/\\/g, "/");
    const index = await createTestIndexFromFiles(samplePath, [consumerFile, definitionFile]);

    await testGoToDefinition(index, consumerFile, 6, 5, definitionFile, 3);
  });

  it("resolves a PHP non-letter use alias across files", async () => {
    const samplePath = path.resolve(process.cwd(), "tests", "samples", "php");
    const consumerFile = path.join(samplePath, "src", "Collision", "unicode_consumer.php").replace(/\\/g, "/");
    const definitionFile = path.join(samplePath, "src", "Collision", "unicode_def.php").replace(/\\/g, "/");
    const index = await createTestIndexFromFiles(samplePath, [consumerFile, definitionFile]);

    await testGoToDefinition(index, consumerFile, 7, 1, definitionFile, 5);
  });
  it("resolves a Rust XID-continuation alias across files", async () => {
    const samplePath = path.resolve(process.cwd(), "tests", "samples", "rust");
    const consumerFile = path.join(samplePath, ".regressions", "unicode_consumer.rs").replace(/\\/g, "/");
    const definitionFile = path.join(samplePath, ".regressions", "unicode_def.rs").replace(/\\/g, "/");
    const index = await createTestIndexFromFiles(samplePath, [consumerFile, definitionFile]);

    await testGoToDefinition(index, consumerFile, 6, 5, definitionFile, 1);
  });
});

describe("Go to Definition: canonical Unicode identifier equality", () => {
  for (const testCase of [
    {
      label: "Python NFC declaration and NFD consumer",
      language: "python",
      definition: "unicode_nfc_def.py",
      consumer: "unicode_nfc_consumer.py",
      consumerLine: 3,
      consumerColumn: 1,
    },
    {
      label: "Python NFD declaration and NFC consumer",
      language: "python",
      definition: "unicode_nfd_def.py",
      consumer: "unicode_nfd_consumer.py",
      consumerLine: 3,
      consumerColumn: 1,
    },
    {
      label: "Rust NFC declaration and NFD consumer",
      language: "rust",
      definition: "unicode_nfc_def.rs",
      consumer: "unicode_nfc_consumer.rs",
      consumerLine: 6,
      consumerColumn: 5,
    },
    {
      label: "Rust NFD declaration and NFC consumer",
      language: "rust",
      definition: "unicode_nfd_def.rs",
      consumer: "unicode_nfd_consumer.rs",
      consumerLine: 6,
      consumerColumn: 5,
    },
  ]) {
    it(`resolves ${testCase.label}`, async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", testCase.language, ".regressions");
      const definitionFile = path.join(samplePath, testCase.definition).replace(/\\/g, "/");
      const consumerFile = path.join(samplePath, testCase.consumer).replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [definitionFile, consumerFile]);

      await testGoToDefinition(index, consumerFile, testCase.consumerLine, testCase.consumerColumn, definitionFile, 1);
    });
  }

  it("resolves a Java identifier that differs only by an ignorable character", async () => {
    const samplePath = path.resolve(process.cwd(), "tests", "samples", "java", ".regressions");
    const definitionFile = path.join(samplePath, "Foo.java").replace(/\\/g, "/");
    const consumerFile = path.join(samplePath, "unicode_ignorable_consumer.java").replace(/\\/g, "/");
    const index = await createTestIndexFromFiles(samplePath, [definitionFile, consumerFile]);

    await testGoToDefinition(index, consumerFile, 7, 12, definitionFile, 3);
  });

  it("resolves a C# verbatim identifier in the declaring file", async () => {
    const samplePath = path.resolve(process.cwd(), "tests", "samples", "csharp", ".regressions");
    const file = path.join(samplePath, "unicode_verbatim.cs").replace(/\\/g, "/");
    const index = await createTestIndexFromFiles(samplePath, [file]);

    await testGoToDefinition(index, file, 9, 9, file, 3);
  });

  for (const testCase of [
    { language: "kotlin", definition: "unicode_nfc_def.kt", consumer: "unicode_nfd_consumer.kt", line: 6, column: 17 },
    {
      language: "go",
      definition: "unicode_negative_pkg/def.go",
      consumer: "unicode_nfd_consumer.go",
      line: 6,
      column: 16,
    },
    {
      language: "typescript",
      definition: "unicode_nfc_def.ts",
      consumer: "unicode_nfd_consumer.ts",
      line: 3,
      column: 1,
    },
  ]) {
    it(`does not normalize distinct ${testCase.language} identifiers`, async () => {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", testCase.language, ".regressions");
      const definitionFile = path.join(samplePath, testCase.definition).replace(/\\/g, "/");
      const consumerFile = path.join(samplePath, testCase.consumer).replace(/\\/g, "/");
      const index = await createTestIndexFromFiles(samplePath, [definitionFile, consumerFile]);

      const result = await goToDefinition(index, {
        file: consumerFile,
        line: testCase.line,
        column: testCase.column,
      });
      expect(result.status).not.toBe("ok");
    });
  }

  it("does not normalize distinct PHP identifiers", async () => {
    const samplePath = path.resolve(process.cwd(), "tests", "samples", "php");
    const definitionFile = path.join(samplePath, "src", "Collision", "unicode_nfc_def.php").replace(/\\/g, "/");
    const consumerFile = path.join(samplePath, "src", "Collision", "unicode_nfd_consumer.php").replace(/\\/g, "/");
    const index = await createTestIndexFromFiles(samplePath, [definitionFile, consumerFile]);

    const result = await goToDefinition(index, { file: consumerFile, line: 7, column: 1 });
    expect(result.status).not.toBe("ok");
  });
});
