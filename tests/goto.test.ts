import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
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

  describe("TypeScript", () => {
    it("resolves class method calls with high-confidence receivers", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ts-method-goto-"));
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
            "",
          ].join("\n"),
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
        expect(result.definition.range.start.line).toBe(13);
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

    it("should find definition of fully-qualified Composer-mapped type references", async () => {
      const index = await createTestIndex("php");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "php");
      const consumerFile = path.join(samplePath, "composer-type-qualified-consumer.php").replace(/\\/g, "/");
      const serviceFile = path.join(samplePath, "src", "Domain", "Service.php").replace(/\\/g, "/");

      await testGoToDefinition(index, consumerFile, 3, 37, serviceFile, 5);
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
  });
});
