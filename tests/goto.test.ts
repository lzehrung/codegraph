import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { goToDefinition, type ProjectIndex } from "../src/index.js";
import { JAVA_SUPPORT } from "../src/languages.js";
import { resolveNamedDefinition } from "../src/indexer/navigation-local.js";
import { fileIdentityKey } from "../src/util/paths.js";
import { clearTsconfigCache } from "../src/util/resolution/tsconfig.js";
import {
  createTestIndex,
  createTestIndexFromFiles,
  createTestIndexFromPath,
  testGoToDefinition,
} from "./test-utils.js";

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

    it("resolves relative re-export declarations", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ts-relative-reexport-goto-"));
      try {
        const sourceFile = path.join(root, "x.ts").replace(/\\/g, "/");
        const barrelFile = path.join(root, "barrel.ts").replace(/\\/g, "/");
        const barrelSource = 'export { X } from "./x";\n';
        await fsp.writeFile(sourceFile, "export const X = 1;\n", "utf8");
        await fsp.writeFile(barrelFile, barrelSource, "utf8");
        const index = await createTestIndexFromFiles(root, [sourceFile, barrelFile]);

        await testGoToDefinition(index, barrelFile, 1, barrelSource.indexOf("X") + 1, sourceFile, 1);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("does not read tsconfig for a relative re-export goto", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ts-reexport-goto-no-tsconfig-"));
      try {
        const sourceFile = path.join(root, "x.ts").replace(/\\/g, "/");
        const barrelFile = path.join(root, "barrel.ts").replace(/\\/g, "/");
        const barrelSource = 'export { X } from "./x";\n';
        // A real tsconfig must exist, otherwise the nearest-tsconfig walk reads nothing and
        // the assertion below would hold whether or not the load is deferred.
        await fsp.writeFile(
          path.join(root, "tsconfig.json"),
          JSON.stringify({ compilerOptions: { baseUrl: "." } }),
          "utf8",
        );
        await fsp.writeFile(sourceFile, "export const X = 1;\n", "utf8");
        await fsp.writeFile(barrelFile, barrelSource, "utf8");
        const index = await createTestIndexFromPath(root);

        // Index construction already normalized "./x" into an in-root file, so goto takes the
        // fast path and never needs matchPath. Clear the cache first, or a load during index
        // construction would mask a load during goto.
        clearTsconfigCache();
        const readSpy = vi.spyOn(fsp, "readFile");
        try {
          await testGoToDefinition(index, barrelFile, 1, barrelSource.indexOf("X") + 1, sourceFile, 1);
          const tsconfigReads = readSpy.mock.calls.filter(([file]) => String(file).endsWith("tsconfig.json")).length;
          expect(tsconfigReads).toBe(0);
        } finally {
          readSpy.mockRestore();
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("resolves tsconfig path-alias re-export declarations", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-ts-path-alias-reexport-goto-"));
      try {
        const sourceFile = path.join(root, "src", "x.ts").replace(/\\/g, "/");
        const barrelFile = path.join(root, "barrel.ts").replace(/\\/g, "/");
        const barrelSource = 'export { X } from "@scope/x";\n';
        await fsp.mkdir(path.dirname(sourceFile), { recursive: true });
        await fsp.writeFile(
          path.join(root, "tsconfig.json"),
          JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@scope/*": ["src/*"] } } }),
          "utf8",
        );
        await fsp.writeFile(sourceFile, "export const X = 1;\n", "utf8");
        await fsp.writeFile(barrelFile, barrelSource, "utf8");
        const index = await createTestIndexFromPath(root);

        await testGoToDefinition(index, barrelFile, 1, barrelSource.indexOf("X") + 1, sourceFile, 1);
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
    it("folds PHP method names but keeps property and constant names exact", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-php-member-case-goto-"));
      try {
        const file = path.join(root, "probe.php").replace(/\\/g, "/");
        const lines = [
          "<?php",
          "class Box {",
          "  public $field;",
          "  public const Limit = 1;",
          "  public function run() {}",
          "  public function relay() { $this->RUN(); return $this->FIELD; }",
          "  public static function read() { return self::limit; }",
          "}",
          "$svc = new Box();",
          "$svc->RUN();",
          "$svc->field;",
          "$svc->FIELD;",
          "Box::Limit;",
          "Box::limit;",
        ];
        await fsp.writeFile(file, lines.join("\n"), "utf8");
        const index = await createTestIndexFromFiles(root, [file]);
        for (const [line, name, targetLine] of [
          [6, "RUN", 5],
          [6, "FIELD", undefined],
          [7, "limit", undefined],
          [10, "RUN", 5],
          [11, "field", 3],
          [12, "FIELD", undefined],
          [13, "Limit", 4],
          [14, "limit", undefined],
        ] as const) {
          const result = await goToDefinition(index, { file, line, column: lines[line - 1]!.lastIndexOf(name) + 1 });
          if (targetLine === undefined) {
            expect(result.status, `${line}:${name}`).toBe("not_found");
          } else {
            expect(result.status, `${line}:${name}`).toBe("ok");
            if (result.status !== "ok") throw new Error("Expected a PHP member definition");
            expect(result.definition.range.start.line).toBe(targetLine);
          }
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

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
    it("keeps PHP class, function, and constant aliases in separate symbol namespaces", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-php-alias-role-goto-"));
      try {
        const sourceFile = path.join(root, "source.php").replace(/\\/g, "/");
        const consumerFile = path.join(root, "consumer.php").replace(/\\/g, "/");
        const sourceLines = [
          "<?php",
          "namespace App;",
          "class Service {}",
          "function helper() { return 1; }",
          "const TOKEN = 1;",
          "",
        ];
        const consumerLines = [
          "<?php",
          "namespace Client;",
          "use App\\Service as Alias;",
          "use function App\\HELPER as Alias;",
          "use const App\\TOKEN as Alias;",
          "$service = new ALIAS();",
          "$value = ALIAS();",
          "$constant = Alias;",
          "$wrong = ALIAS;",
          "",
        ];
        await fsp.writeFile(sourceFile, sourceLines.join("\n"), "utf8");
        await fsp.writeFile(consumerFile, consumerLines.join("\n"), "utf8");
        const index = await createTestIndexFromFiles(root, [sourceFile, consumerFile]);
        const aliasColumn = (line: number): number => consumerLines[line - 1]!.lastIndexOf("Alias") + 1;

        await testGoToDefinition(index, consumerFile, 6, consumerLines[5]!.indexOf("ALIAS") + 1, sourceFile, 3);
        await testGoToDefinition(index, consumerFile, 7, consumerLines[6]!.indexOf("ALIAS") + 1, sourceFile, 4);
        await testGoToDefinition(index, consumerFile, 8, aliasColumn(8), sourceFile, 5);
        await testGoToDefinition(
          index,
          consumerFile,
          9,
          consumerLines[8]!.indexOf("ALIAS") + 1,
          undefined,
          undefined,
          "not_found",
        );
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("resolves PHP members through a case-variant imported receiver type", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-php-member-alias-case-goto-"));
      try {
        const sourceFile = path.join(root, "source.php").replace(/\\/g, "/");
        const consumerFile = path.join(root, "consumer.php").replace(/\\/g, "/");
        const sourceLines = [
          "<?php",
          "namespace App;",
          "class Service {",
          "  public static function Run() {}",
          "  public function Go() {}",
          "}",
        ];
        const consumerLines = [
          "<?php",
          "use App\\Service as Foo;",
          "fOo::run();",
          "function invoke(FOO $service) { $service->go(); }",
        ];
        await fsp.writeFile(sourceFile, sourceLines.join("\n"), "utf8");
        await fsp.writeFile(consumerFile, consumerLines.join("\n"), "utf8");
        const index = await createTestIndexFromFiles(root, [sourceFile, consumerFile]);

        await testGoToDefinition(index, consumerFile, 3, consumerLines[2]!.indexOf("run") + 1, sourceFile, 4);
        await testGoToDefinition(index, consumerFile, 4, consumerLines[3]!.indexOf("go") + 1, sourceFile, 5);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("resolves same-spelled aliases as classes in PHP type contexts", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-php-alias-type-contexts-"));
      try {
        const sourceFile = path.join(root, "source.php").replace(/\\/g, "/");
        const consumerFile = path.join(root, "consumer.php").replace(/\\/g, "/");
        const sourceLines = [
          "<?php",
          "namespace App;",
          "class BaseType { public $field; }",
          "interface ContractType {}",
          "#[\\Attribute] class RouteType {}",
          "class ProblemType extends \\Exception {}",
          "function baseFunction() {}",
          "function contractFunction() {}",
          "function routeFunction() {}",
          "function problemFunction() {}",
          "const TOKEN = 1;",
          "",
        ];
        const consumerLines = [
          "<?php",
          "namespace Client;",
          "use App\\BaseType as BaseAlias;",
          "use function App\\baseFunction as BaseAlias;",
          "use App\\ContractType as ContractAlias;",
          "use function App\\contractFunction as ContractAlias;",
          "use App\\RouteType as RouteAlias;",
          "use function App\\routeFunction as RouteAlias;",
          "use App\\ProblemType as ProblemAlias;",
          "use function App\\problemFunction as ProblemAlias;",
          "function accepts(BASEALIAS $value): basealias { return $value; }",
          "class Child extends BASEALIAS implements contractalias {}",
          "#[routealias]",
          "class Marked {}",
          "try {} catch (PROBLEMALIAS $error) {}",
          "use const App\\TOKEN as BaseAlias;",
          "$value = new BaseAlias(BaseAlias);",
          "$is = $value instanceof BaseAlias;",
          "$function = BaseAlias();",
          "$value->field;",
          "$value->FIELD;",
          "",
        ];
        await fsp.writeFile(sourceFile, sourceLines.join("\n"), "utf8");
        await fsp.writeFile(consumerFile, consumerLines.join("\n"), "utf8");
        const index = await createTestIndexFromFiles(root, [sourceFile, consumerFile]);

        for (const [line, token, fromEnd, expectedLine] of [
          [11, "BASEALIAS", false, 3],
          [11, "basealias", true, 3],
          [12, "BASEALIAS", false, 3],
          [12, "contractalias", false, 4],
          [13, "routealias", false, 5],
          [15, "PROBLEMALIAS", false, 6],
          [17, "BaseAlias", false, 3],
          [17, "BaseAlias", true, 11],
          [18, "BaseAlias", false, 3],
          [19, "BaseAlias", false, 7],
        ] as const) {
          const sourceLine = consumerLines[line - 1]!;
          const tokenIndex = fromEnd ? sourceLine.lastIndexOf(token) : sourceLine.indexOf(token);
          await testGoToDefinition(index, consumerFile, line, tokenIndex + 1, sourceFile, expectedLine);
        }
        await testGoToDefinition(index, consumerFile, 20, consumerLines[19]!.indexOf("field") + 1, sourceFile, 3);
        expect(
          (
            await goToDefinition(index, {
              file: consumerFile,
              line: 21,
              column: consumerLines[20]!.indexOf("FIELD") + 1,
            })
          ).status,
        ).toBe("not_found");
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("resolves imported and fully qualified PHP interfaces and enums through the class namespace", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-php-qualified-class-namespace-"));
      try {
        const sourceFile = path.join(root, "source.php").replace(/\\/g, "/");
        const consumerFile = path.join(root, "consumer.php").replace(/\\/g, "/");
        const sourceLines = ["<?php", "namespace App\\Domain;", "interface Contract {}", "enum State { case Ready; }"];
        const consumerLines = [
          "<?php",
          "use aPp\\dOmAiN\\cOnTrAcT as ContractAlias;",
          "use APP\\DOMAIN\\sTaTe as StateAlias;",
          "class QualifiedChild implements \\App\\domain\\CONTRACT {}",
          "class ImportedChild implements ContractAlias {}",
          "function accepts(\\app\\Domain\\state $state): StateAlias { return $state; }",
        ];
        await fsp.writeFile(sourceFile, sourceLines.join("\n"), "utf8");
        await fsp.writeFile(consumerFile, consumerLines.join("\n"), "utf8");
        const index = await createTestIndexFromFiles(root, [sourceFile, consumerFile]);

        for (const [line, token, fromEnd, expectedLine] of [
          [4, "CONTRACT", false, 3],
          [5, "ContractAlias", false, 3],
          [6, "state", false, 4],
          [6, "StateAlias", true, 4],
        ] as const) {
          const sourceLine = consumerLines[line - 1]!;
          const tokenIndex = fromEnd ? sourceLine.lastIndexOf(token) : sourceLine.indexOf(token);
          await testGoToDefinition(index, consumerFile, line, tokenIndex + 1, sourceFile, expectedLine);
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
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

    it("resolves a generic type parameter used inside its own declaration, not a same-named type parameter on a sibling type", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-go-generic-goto-"));
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
            "func F[T any](v T) T {",
            "\treturn v",
            "}",
            "",
          ].join("\n"),
          "utf8",
        );
        const index = await createTestIndexFromFiles(root, [file]);
        // Box's field type T (line 4) resolves to Box's own T (line 3), not Pair's.
        await testGoToDefinition(index, file, 4, 8, file, 3);
        // Pair's field type T (line 8) resolves to Pair's own T (line 7), not Box's.
        await testGoToDefinition(index, file, 8, 4, file, 7);
        // func F's parameter type T and return type T both resolve to F's own T (line 12).
        await testGoToDefinition(index, file, 12, 17, file, 12);
        await testGoToDefinition(index, file, 12, 20, file, 12);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
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

      // `typedef struct Utility { ... } Utility;` declares two symbols: the struct tag on line 4 and
      // the typedef alias on line 6. C now uses query-driven locals like C++, so both exist and the
      // tag owns the exported name.
      await testGoToDefinition(index, mainFile, 6, 3, utilsFile, 4);
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

    it("selects same-scope C++ overloads by call argument count", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-cpp-local-overload-goto-"));
      try {
        const file = path.join(root, "probe.cpp").replace(/\\/g, "/");
        const lines = [
          "int pick(void);",
          "int pick(int value);",
          "int zero() { return pick(); }",
          "int one() { return pick(1); }",
          "int choose(int value);",
          "int choose(double value);",
          "int unresolved() { return choose(1); }",
          "",
        ];
        await fsp.writeFile(file, lines.join("\n"), "utf8");
        const index = await createTestIndexFromFiles(root, [file]);

        await testGoToDefinition(index, file, 3, lines[2]!.indexOf("pick") + 1, file, 1);
        await testGoToDefinition(index, file, 4, lines[3]!.indexOf("pick") + 1, file, 2);
        const ambiguous = await goToDefinition(index, {
          file,
          line: 7,
          column: lines[6]!.indexOf("choose") + 1,
        });
        expect(ambiguous).toEqual({ status: "not_found", reason: "Ambiguous C++ overload" });
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("groups C++ redeclarations and accepts default and variadic arguments", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-cpp-callable-shape-goto-"));
      try {
        const file = path.join(root, "probe.cpp").replace(/\\/g, "/");
        const lines = [
          "int add(int left, int right);",
          "int add(double value);",
          "int add(int left, int right) { return left + right; }",
          "int call_add() { return add(1, 2); }",
          "int defaults(int left, int right = 0);",
          "int defaults(int first, int second, int third);",
          "int call_default() { return defaults(1); }",
          "int spread(int first, ...);",
          "int spread();",
          "int call_spread() { return spread(1, 2, 3); }",
          "int log(const char* format, ...);",
          "int log(int code);",
          "int call_log() { return log(1); }",
          "",
        ];
        await fsp.writeFile(file, lines.join("\n"), "utf8");
        const index = await createTestIndexFromFiles(root, [file]);

        await testGoToDefinition(index, file, 4, lines[3]!.lastIndexOf("add") + 1, file, 3);
        await testGoToDefinition(index, file, 7, lines[6]!.lastIndexOf("defaults") + 1, file, 5);
        await testGoToDefinition(index, file, 10, lines[9]!.lastIndexOf("spread") + 1, file, 8);
        const overlappingLog = await goToDefinition(index, {
          file,
          line: 13,
          column: lines[12]!.lastIndexOf("log") + 1,
        });
        expect(overlappingLog.status).toBe("not_found");
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("does not rank overlapping C++ default-argument overloads", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-cpp-default-overlap-goto-"));
      try {
        const file = path.join(root, "probe.cpp").replace(/\\/g, "/");
        const lines = [
          "int f();",
          "int f(int value = 0);",
          "int zero() { return f(); }",
          "int one() { return f(1); }",
          "",
        ];
        await fsp.writeFile(file, lines.join("\n"), "utf8");
        const index = await createTestIndexFromFiles(root, [file]);

        const ambiguous = await goToDefinition(index, {
          file,
          line: 3,
          column: lines[2]!.lastIndexOf("f()") + 1,
        });
        expect(ambiguous.status).toBe("not_found");
        await testGoToDefinition(index, file, 4, lines[3]!.lastIndexOf("f(") + 1, file, 2);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it.each([
      {
        name: "unnamed pointer parameters",
        declarations: ["int pick(int*);", "int pick(int* value) { return 1; }"],
        call: "pick(nullptr)",
        targetLine: 2,
      },
      {
        name: "renamed reference parameters",
        declarations: ["int pick(int&);", "int pick(int& value) { return value; }"],
        call: "pick(value)",
        targetLine: 2,
      },
      {
        name: "nested callback parameter names",
        declarations: ["int pick(void (*)(int));", "int pick(void (*callback)(int value)) { return 1; }"],
        call: "pick(nullptr)",
        targetLine: 2,
      },
      {
        name: "distinct reference operators",
        declarations: ["int pick(int& value);", "int pick(int&& value);"],
        call: "pick(value)",
        targetLine: undefined,
      },
      {
        name: "distinct array-bound operators",
        declarations: ["int pick(int (*value)[2+3]) { return 1; }", "int pick(int (*value)[2*3]) { return 2; }"],
        call: "pick(nullptr)",
        targetLine: undefined,
      },
    ])("preserves C++ callable identity for $name", async ({ declarations, call, targetLine }) => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-cpp-signature-goto-"));
      try {
        const file = path.join(root, "probe.cpp").replace(/\\/g, "/");
        const lines = [...declarations, `int use(int& value) { return ${call}; }`];
        await fsp.writeFile(file, lines.join("\n"), "utf8");
        const index = await createTestIndexFromFiles(root, [file]);
        const result = await goToDefinition(index, {
          file,
          line: 3,
          column: lines[2]!.indexOf("pick") + 1,
        });
        if (targetLine === undefined) {
          expect(result.status).toBe("not_found");
        } else {
          expect(result.status).toBe("ok");
          if (result.status !== "ok") throw new Error("Expected one C++ callable entity");
          expect(result.definition.range.start.line).toBe(targetLine);
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("links namespace-qualified free definitions to bare and qualified calls", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-cpp-namespace-definition-goto-"));
      try {
        const file = path.join(root, "probe.cpp").replace(/\\/g, "/");
        const lines = [
          "namespace tools { int run(); int call() { return run(); } }",
          "int tools::run() { return 1; }",
          "int outside() { return tools::run(); }",
          "",
        ];
        await fsp.writeFile(file, lines.join("\n"), "utf8");
        const index = await createTestIndexFromFiles(root, [file]);

        await testGoToDefinition(index, file, 1, lines[0]!.lastIndexOf("run();") + 1, file, 2);
        await testGoToDefinition(index, file, 3, lines[2]!.lastIndexOf("run();") + 1, file, 2);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("models named, unnamed, inline, and nested C++ namespaces", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-cpp-namespace-scope-goto-"));
      try {
        const file = path.join(root, "probe.cpp").replace(/\\/g, "/");
        const lines = [
          "namespace named { int isolated() { return 1; } }",
          "namespace { int hidden() { return 2; } }",
          "inline namespace v1 { int versioned() { return 3; } }",
          "namespace outer::inner { int nested() { return 4; } }",
          "int use_hidden() { return hidden(); }",
          "int use_versioned() { return versioned(); }",
          "int use_nested() { return outer::inner::nested(); }",
          "int invalid_bare() { return isolated(); }",
        ];
        await fsp.writeFile(file, lines.join("\n"), "utf8");
        const index = await createTestIndexFromFiles(root, [file]);

        await testGoToDefinition(index, file, 5, lines[4]!.lastIndexOf("hidden") + 1, file, 2);
        await testGoToDefinition(index, file, 6, lines[5]!.lastIndexOf("versioned") + 1, file, 3);
        await testGoToDefinition(index, file, 7, lines[6]!.lastIndexOf("nested") + 1, file, 4);
        await testGoToDefinition(index, file, 8, lines[7]!.indexOf("isolated") + 1, undefined, undefined, "not_found");
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("returns safely for an incomplete C++ base clause", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-cpp-incomplete-base-goto-"));
      try {
        const file = path.join(root, "probe.cpp").replace(/\\/g, "/");
        const source = "class Derived : public { int run() { return this->missing(); } };\n";
        await fsp.writeFile(file, source, "utf8");
        const index = await createTestIndexFromFiles(root, [file]);

        await testGoToDefinition(index, file, 1, source.indexOf("missing") + 1, undefined, undefined, "not_found");
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
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

    it("resolves property and method navigation on a typed receiver", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-member-goto-"));
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

        await testGoToDefinition(index, file, 12, columnOf(12, "payload"), file, 2);
        await testGoToDefinition(index, file, 13, columnOf(13, "ping"), file, 3);
        await testGoToDefinition(index, file, 16, columnOf(16, "payload"), file, 6);
        await testGoToDefinition(index, file, 10, columnOf(10, "payload"), file, 10);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
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

    it("resolves a call to a local function from a sibling statement in the same method, not a same-named local function in another method", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-csharp-localfn-goto-"));
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
        // "Local();" in RunA (line 4) resolves to RunA's own local function (line 3).
        await testGoToDefinition(index, mainFile, 4, 5, mainFile, 3);
        // "Local();" in RunB (line 8) resolves to RunB's own local function (line 7), not RunA's.
        await testGoToDefinition(index, mainFile, 8, 5, mainFile, 7);
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

    it("resolves crate #[path] modules to the attributed file instead of importer or conventional decoys", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-rust-path-attr-goto-"));
      try {
        const src = path.join(root, "src");
        await fsp.mkdir(src, { recursive: true });
        await fsp.writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "path-attr-goto"\nversion = "0.1.0"\n');
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
        const usage = "    let _t = Thing;";
        const result = await testGoToDefinition(index, consumerFile, 5, usage.indexOf("Thing") + 1, customFile, 1);
        expect(result.status).toBe("ok");
        if (result.status === "ok") {
          expect(path.basename(result.definition.file)).toBe("custom.rs");
          expect(path.basename(result.definition.file)).not.toBe("external.rs");
          expect(path.basename(result.definition.file)).not.toBe("decoy.rs");
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("resolves super to the crate module tree owner, not an undeclared decoy in the same directory", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-rust-path-owner-goto-"));
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
        const usage = "    RealThing";
        const result = await testGoToDefinition(index, sharedFile, 3, usage.indexOf("RealThing") + 1, realFile, 3);
        expect(result.status).toBe("ok");
        if (result.status === "ok") {
          expect(path.basename(result.definition.file)).toBe("real.rs");
          expect(path.basename(result.definition.file)).not.toBe("aaa_orphan.rs");
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("resolves super through a custom library path, not a stray src/lib.rs", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-rust-path-owner-custom-lib-goto-"));
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
        const usage = "    CustomThing";
        const result = await testGoToDefinition(index, sharedFile, 3, usage.indexOf("CustomThing") + 1, customFile, 3);
        expect(result.status).toBe("ok");
        if (result.status === "ok") {
          expect(path.basename(result.definition.file)).toBe("root.rs");
          expect(path.basename(result.definition.file)).not.toBe("lib.rs");
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("resolves super without treating src/main.rs as a crate root when autobins is false", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-rust-path-owner-autobins-goto-"));
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
        const usage = "    RealThing";
        const result = await testGoToDefinition(index, sharedFile, 3, usage.indexOf("RealThing") + 1, realFile, 3);
        expect(result.status).toBe("ok");
        if (result.status === "ok") {
          expect(path.basename(result.definition.file)).toBe("real.rs");
          expect(path.basename(result.definition.file)).not.toBe("main.rs");
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("resolves super through an explicit named bin without path when autobins is false", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-rust-path-owner-named-bin-goto-"));
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
        const usage = "    NamedThing";
        const result = await testGoToDefinition(index, sharedFile, 3, usage.indexOf("NamedThing") + 1, ownerFile, 3);
        expect(result.status).toBe("ok");
        if (result.status === "ok") {
          expect(path.basename(result.definition.file)).toBe("tool.rs");
          expect(path.basename(result.definition.file)).not.toBe("aaa_decoy.rs");
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("resolves super through an explicit [lib] table when autolib is false", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-rust-path-owner-explicit-lib-goto-"));
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
        const usage = "    LibThing";
        const result = await testGoToDefinition(index, sharedFile, 3, usage.indexOf("LibThing") + 1, libFile, 3);
        expect(result.status).toBe("ok");
        if (result.status === "ok") {
          expect(path.basename(result.definition.file)).toBe("lib.rs");
          expect(path.basename(result.definition.file)).not.toBe("aaa_decoy.rs");
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("does not treat a virtual workspace root as a package when resolving super", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-rust-path-owner-virtual-ws-goto-"));
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
        const usage = "    OwnerThing";
        const result = await testGoToDefinition(index, sharedFile, 3, usage.indexOf("OwnerThing") + 1, ownerFile, 3);
        expect(result.status).toBe("ok");
        if (result.status === "ok") {
          expect(path.basename(result.definition.file)).toBe("aaa_owner.rs");
          expect(path.basename(result.definition.file)).not.toBe("build.rs");
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("resolves super when a reachable #[path] uses a differently cased spelling of the target", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-rust-path-owner-case-fold-goto-"));
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
        const usage = "    CaseThing";
        const result = await testGoToDefinition(index, sharedFile, 3, usage.indexOf("CaseThing") + 1, libFile, 3);
        expect(result.status).toBe("ok");
        if (result.status === "ok") {
          expect(path.basename(result.definition.file)).toBe("lib.rs");
          expect(path.basename(result.definition.file)).not.toBe("aaa_decoy.rs");
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("resolves super through a conventional child of a custom crate-root filename", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-rust-path-owner-custom-child-goto-"));
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
        const usage = "    OwnerThing";
        const result = await testGoToDefinition(index, sharedFile, 3, usage.indexOf("OwnerThing") + 1, ownerFile, 3);
        expect(result.status).toBe("ok");
        if (result.status === "ok") {
          expect(path.basename(path.dirname(result.definition.file))).toBe("custom");
          expect(path.basename(result.definition.file)).toBe("owner.rs");
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("resolves super through a raw-identifier conventional module", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-rust-path-owner-raw-ident-goto-"));
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
        const usage = "    TypeThing";
        const result = await testGoToDefinition(index, sharedFile, 3, usage.indexOf("TypeThing") + 1, typeFile, 3);
        expect(result.status).toBe("ok");
        if (result.status === "ok") {
          expect(path.basename(result.definition.file)).toBe("type.rs");
          expect(path.basename(result.definition.file)).not.toBe("aaa_decoy.rs");
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
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

describe("Python receiver member resolution", () => {
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
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-python-receiver-goto-"));
    const file = path.join(root, "models.py").replace(/\\/g, "/");
    await fsp.writeFile(file, source, "utf8");
    return { root, file, index: await createTestIndexFromFiles(root, [file]) };
  }

  it("resolves a Python self member inside the declaring class", async () => {
    const { root, file, index } = await buildReceiverFixture();
    try {
      await testGoToDefinition(index, file, 9, columnOf(9, "run"), file, 5);
      await testGoToDefinition(index, file, 6, columnOf(6, "name"), file, 3);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a Python inherited member reached through self", async () => {
    const { root, file, index } = await buildReceiverFixture();
    try {
      await testGoToDefinition(index, file, 17, columnOf(17, "base_method"), file, 12);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a Python constructor-assigned local receiver", async () => {
    const { root, file, index } = await buildReceiverFixture();
    try {
      await testGoToDefinition(index, file, 30, columnOf(30, "run"), file, 5);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not resolve an unproven Python receiver", async () => {
    const { root, file, index } = await buildReceiverFixture();
    try {
      // `svc.run()` on line 34 after `svc = make_service()` on line 32: a factory call proves
      // no constructor.
      await testGoToDefinition(index, file, 34, columnOf(34, "run"), undefined, undefined, "not_found");
      // `svc.run()` on line 37: an unannotated parameter proves no receiver type.
      await testGoToDefinition(index, file, 37, columnOf(37, "run"), undefined, undefined, "not_found");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a Python module-level function separate from a same-named method", async () => {
    const { root, file, index } = await buildReceiverFixture();
    try {
      // The bare `run()` call on line 23 resolves to the module-level `def run` on line 19,
      // not to `Service.run` on line 5.
      await testGoToDefinition(index, file, 23, columnOf(23, "run"), file, 19);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a Python cls class-level member", async () => {
    const { root, file, index } = await buildReceiverFixture();
    try {
      await testGoToDefinition(index, file, 44, columnOf(44, "kind"), file, 40);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not resolve an ambiguous Python inherited member at the same level", async () => {
    const { root, file, index } = await buildReceiverFixture();
    try {
      await testGoToDefinition(index, file, 56, columnOf(56, "shared"), undefined, undefined, "not_found");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not attribute a Python method to a same-named member on an unrelated class", async () => {
    const { root, file, index } = await buildReceiverFixture();
    try {
      await testGoToDefinition(index, file, 30, columnOf(30, "run"), file, 5);
      await testGoToDefinition(index, file, 76, columnOf(76, "run"), file, 59);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not let a Python method-local variable shadow a class member", async () => {
    const { root, file, index } = await buildReceiverFixture();
    try {
      await testGoToDefinition(index, file, 68, columnOf(68, "run"), file, 63);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a Python annotated constructor-assigned local receiver", async () => {
    const { root, file, index } = await buildReceiverFixture();
    try {
      await testGoToDefinition(index, file, 72, columnOf(72, "run"), file, 5);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Receiver construction, reassignment, typed parameters, and static scope", () => {
  function columnOf(source: string, line: number, token: string): number {
    const lines = source.split("\n");
    const index = lines[line - 1]!.indexOf(token);
    if (index < 0) throw new Error(`Expected token ${token} on fixture line ${line}`);
    return index + 1;
  }

  async function buildFiles(
    prefix: string,
    files: Record<string, string>,
  ): Promise<{ root: string; paths: Record<string, string>; index: ProjectIndex }> {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
    const paths: Record<string, string> = {};
    for (const [name, source] of Object.entries(files)) {
      const file = path.join(root, name).replace(/\\/g, "/");
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, source, "utf8");
      paths[name] = file;
    }
    return { root, paths, index: await createTestIndexFromFiles(root, Object.values(paths)) };
  }

  it("resolves a PHP named receiver assigned from new", async () => {
    const source = [
      "<?php",
      "class Box { function helper() {} }",
      "function run() { $box = new Box(); $box->helper(); }",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-php-named-goto-", { "box.php": source });
    try {
      await testGoToDefinition(index, paths["box.php"]!, 3, columnOf(source, 3, "helper();"), paths["box.php"]!, 2);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not resolve an unproven PHP receiver to an imported function of the same name", async () => {
    const lib = ["<?php", "namespace Imported;", "function helper() {}", ""].join("\n");
    const host = [
      "<?php",
      "use function Imported\\helper;",
      "class Box { function helper() {} }",
      "function run() { $unknown->helper(); }",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-php-misattr-goto-", { "lib.php": lib, "host.php": host });
    try {
      await testGoToDefinition(
        index,
        paths["host.php"]!,
        4,
        columnOf(host, 4, "helper();"),
        undefined,
        undefined,
        "not_found",
      );
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a Zig struct-literal receiver", async () => {
    const source = [
      "const Box = struct {",
      "    fn helper(self: Box) void {}",
      "};",
      "fn run() void { var box = Box{}; box.helper(); }",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-zig-literal-goto-", { "box.zig": source });
    try {
      await testGoToDefinition(index, paths["box.zig"]!, 4, columnOf(source, 4, "helper();"), paths["box.zig"]!, 2);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a Ruby instance-variable receiver assigned from .new", async () => {
    const source = [
      "class Box",
      "  def helper",
      "  end",
      "end",
      "def run",
      "  @box = Box.new",
      "  @box.helper",
      "end",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-rb-ivar-goto-", { "box.rb": source });
    try {
      await testGoToDefinition(index, paths["box.rb"]!, 7, columnOf(source, 7, "helper"), paths["box.rb"]!, 2);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a JavaScript this-receiver method", async () => {
    const source = ["class JsBox {", "  helper() {}", "  run() { this.helper(); }", "}"].join("\n");
    const { root, paths, index } = await buildFiles("cg-js-this-goto-", { "box.js": source });
    try {
      await testGoToDefinition(index, paths["box.js"]!, 3, columnOf(source, 3, "helper();"), paths["box.js"]!, 2);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a Go constructor-assigned receiver", async () => {
    const source = [
      "package gox",
      "type GoBox struct{}",
      "func (b GoBox) GoHelper() {}",
      "func GoRun() { b := GoBox{}; b.GoHelper() }",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-go-ctor-goto-", { "gox.go": source });
    try {
      await testGoToDefinition(index, paths["gox.go"]!, 4, columnOf(source, 4, "GoHelper()"), paths["gox.go"]!, 3);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a Swift self-receiver method", async () => {
    const source = ["class SwBox {", "  func swHelper() {}", "  func swRun() { self.swHelper() }", "}"].join("\n");
    const { root, paths, index } = await buildFiles("cg-swift-self-goto-", { "swx.swift": source });
    try {
      await testGoToDefinition(
        index,
        paths["swx.swift"]!,
        3,
        columnOf(source, 3, "swHelper()"),
        paths["swx.swift"]!,
        2,
      );
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a TypeScript typed-parameter receiver", async () => {
    const source = [
      "export class Lib { target(): number { return 1; } }",
      "export function run(box: Lib): number { return box.target(); }",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-ts-typed-goto-", { "run.ts": source });
    try {
      await testGoToDefinition(index, paths["run.ts"]!, 2, columnOf(source, 2, "target();"), paths["run.ts"]!, 1);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("leaves a reassigned receiver unresolved in TypeScript, Java, and Go", async () => {
    const ts = [
      "export class Lib { target(): number { return 1; } }",
      "export function other(): Lib { return new Lib(); }",
      "export function run(): number { let l = new Lib(); l = other(); return l.target(); }",
      "",
    ].join("\n");
    const java = [
      "class Lib { void target() {} }",
      "class Host {",
      "  Lib other() { return new Lib(); }",
      "  void run() { Lib l = new Lib(); l = other(); l.target(); }",
      "}",
      "",
    ].join("\n");
    const go = [
      "package run",
      "type Lib struct{}",
      "func (l Lib) Target() {}",
      "func other() Lib { return Lib{} }",
      "func Run() { l := Lib{}; l = other(); l.Target() }",
      "",
    ].join("\n");
    const tsFix = await buildFiles("cg-ts-reassign-goto-", { "run.ts": ts });
    const javaFix = await buildFiles("cg-java-reassign-goto-", { "Run.java": java });
    const goFix = await buildFiles("cg-go-reassign-goto-", { "run.go": go });
    try {
      await testGoToDefinition(
        tsFix.index,
        tsFix.paths["run.ts"]!,
        3,
        columnOf(ts, 3, "target();"),
        undefined,
        undefined,
        "not_found",
      );
      await testGoToDefinition(
        javaFix.index,
        javaFix.paths["Run.java"]!,
        4,
        columnOf(java, 4, "target();"),
        undefined,
        undefined,
        "not_found",
      );
      await testGoToDefinition(
        goFix.index,
        goFix.paths["run.go"]!,
        5,
        columnOf(go, 5, "Target()"),
        undefined,
        undefined,
        "not_found",
      );
    } finally {
      await fsp.rm(tsFix.root, { recursive: true, force: true });
      await fsp.rm(javaFix.root, { recursive: true, force: true });
      await fsp.rm(goFix.root, { recursive: true, force: true });
    }
  });

  it("resolves TypeScript static members on the class and instance members only on a constructed receiver", async () => {
    const source = [
      "export class Box {",
      "  static staticValue = 1;",
      "  instanceValue = 2;",
      "}",
      "export function run(): number {",
      "  const fromClass = Box.staticValue;",
      "  const invalid = Box.instanceValue;",
      "  const fromNew = new Box().instanceValue;",
      "  return fromClass + invalid + fromNew;",
      "}",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-ts-static-instance-goto-", { "box.ts": source });
    try {
      await testGoToDefinition(index, paths["box.ts"]!, 6, columnOf(source, 6, "staticValue"), paths["box.ts"]!, 2);
      await testGoToDefinition(
        index,
        paths["box.ts"]!,
        7,
        columnOf(source, 7, "instanceValue"),
        undefined,
        undefined,
        "not_found",
      );
      await testGoToDefinition(index, paths["box.ts"]!, 8, columnOf(source, 8, "instanceValue"), paths["box.ts"]!, 3);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not cross-resolve static and instance members in C#, Java, and PHP", async () => {
    const cs = [
      "class Cfg {",
      "  public void InstanceMethod() {}",
      "  public static void StaticMethod() {}",
      "  public void Run() { var c = new Cfg(); c.StaticMethod(); }",
      "}",
      "",
    ].join("\n");
    const java = [
      "class Cfg {",
      "  void instanceMethod() {}",
      "  static void staticMethod() {}",
      "  void run() { Cfg c = new Cfg(); c.staticMethod(); }",
      "}",
      "",
    ].join("\n");
    const php = [
      "<?php",
      "class Cfg {",
      "    function instanceMethod() {}",
      "    static function staticMethod() {}",
      "    function run() { $c = new Cfg(); $c->staticMethod(); Cfg::instanceMethod(); }",
      "}",
      "",
    ].join("\n");
    const csFix = await buildFiles("cg-cs-static-goto-", { "Cfg.cs": cs });
    const javaFix = await buildFiles("cg-java-static-goto-", { "Cfg.java": java });
    const phpFix = await buildFiles("cg-php-static-goto-", { "cfg.php": php });
    try {
      await testGoToDefinition(
        csFix.index,
        csFix.paths["Cfg.cs"]!,
        4,
        columnOf(cs, 4, "StaticMethod();"),
        undefined,
        undefined,
        "not_found",
      );
      await testGoToDefinition(
        javaFix.index,
        javaFix.paths["Cfg.java"]!,
        4,
        columnOf(java, 4, "staticMethod();"),
        undefined,
        undefined,
        "not_found",
      );
      await testGoToDefinition(
        phpFix.index,
        phpFix.paths["cfg.php"]!,
        5,
        columnOf(php, 5, "staticMethod();"),
        undefined,
        undefined,
        "not_found",
      );
      await testGoToDefinition(
        phpFix.index,
        phpFix.paths["cfg.php"]!,
        5,
        columnOf(php, 5, "instanceMethod();"),
        undefined,
        undefined,
        "not_found",
      );
    } finally {
      await fsp.rm(csFix.root, { recursive: true, force: true });
      await fsp.rm(javaFix.root, { recursive: true, force: true });
      await fsp.rm(phpFix.root, { recursive: true, force: true });
    }
  });
});

describe("Keyword-receiver member navigation", () => {
  function columnOf(source: string, line: number, token: string): number {
    const lines = source.split("\n");
    const index = lines[line - 1]!.indexOf(token);
    if (index < 0) throw new Error(`Expected token ${token} on fixture line ${line}`);
    return index + 1;
  }

  async function buildFiles(
    prefix: string,
    files: Record<string, string>,
  ): Promise<{ root: string; paths: Record<string, string>; index: ProjectIndex }> {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
    const paths: Record<string, string> = {};
    for (const [name, source] of Object.entries(files)) {
      const file = path.join(root, name).replace(/\\/g, "/");
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, source, "utf8");
      paths[name] = file;
    }
    return { root, paths, index: await createTestIndexFromFiles(root, Object.values(paths)) };
  }

  async function expectMemberAccess(
    index: ProjectIndex,
    file: string,
    line: number,
    column: number,
    expectedLine: number,
  ): Promise<void> {
    const result = await goToDefinition(index, { file, line, column });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.definition.range.start.line).toBe(expectedLine);
    expect(result.provenance?.resolution).toBe("member-access");
  }

  it("resolves C++ this-> method and field through member-access", async () => {
    const source = [
      "class Box {",
      " public:",
      "  int field = 1;",
      "  int target() { return 1; }",
      "  int run() { return this->field + this->target(); }",
      "};",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-cpp-this-goto-", { "box.cpp": source });
    try {
      await expectMemberAccess(index, paths["box.cpp"]!, 5, columnOf(source, 5, "field"), 3);
      await expectMemberAccess(index, paths["box.cpp"]!, 5, columnOf(source, 5, "target()"), 4);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a C++ static call to its class declaration when its implementation is out of line", async () => {
    const header = ["class Box {", " public:", "  static int make(int value);", "  int run(int value);", "};", ""].join(
      "\n",
    );
    const implementation = [
      '#include "box.hpp"',
      "int Box::make(int value) { return value; }",
      "int Box::run(int value) { return make(value); }",
      "",
    ].join("\n");
    const consumer = ['#include "box.hpp"', "int use() { return Box::make(1); }", ""].join("\n");
    const { root, paths, index } = await buildFiles("cg-cpp-out-of-line-goto-", {
      "box.hpp": header,
      "box.cpp": implementation,
      "use.cpp": consumer,
    });
    try {
      const result = await goToDefinition(index, {
        file: paths["use.cpp"]!,
        line: 2,
        column: columnOf(consumer, 2, "make"),
      });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.definition.file).toBe(paths["box.hpp"]);
      expect(result.definition.range.start.line).toBe(3);
      expect(result.provenance?.resolution).toBe("member-access");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves C# this. method and field through member-access", async () => {
    const source = [
      "class Box {",
      "  public int field = 1;",
      "  public int Target() { return 1; }",
      "  public int Run() { return this.field + this.Target(); }",
      "}",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-cs-this-goto-", { "Box.cs": source });
    try {
      await expectMemberAccess(index, paths["Box.cs"]!, 4, columnOf(source, 4, "field"), 2);
      await expectMemberAccess(index, paths["Box.cs"]!, 4, columnOf(source, 4, "Target()"), 3);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves Java this. method and field through member-access", async () => {
    const source = [
      "class Box {",
      "  int field = 1;",
      "  int target() { return 1; }",
      "  int run() { return this.field + this.target(); }",
      "}",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-java-this-goto-", { "Box.java": source });
    try {
      await expectMemberAccess(index, paths["Box.java"]!, 4, columnOf(source, 4, "field"), 2);
      await expectMemberAccess(index, paths["Box.java"]!, 4, columnOf(source, 4, "target()"), 3);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves Java this members through interfaces but keeps super on the class chain", async () => {
    const source = [
      "class Base {}",
      "interface Face { default int target() { return 1; } }",
      "class Box extends Base implements Face {",
      "  int own() { return this.target(); }",
      "  int inherited() { return super.target(); }",
      "}",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-java-interface-goto-", { "Box.java": source });
    try {
      await expectMemberAccess(index, paths["Box.java"]!, 4, columnOf(source, 4, "target()"), 2);
      const result = await goToDefinition(index, {
        file: paths["Box.java"]!,
        line: 5,
        column: columnOf(source, 5, "target()"),
      });
      expect(result.status).toBe("not_found");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves Kotlin this. method and field through member-access", async () => {
    const source = [
      "class Box {",
      "  val field = 1",
      "  fun target(): Int = 1",
      "  fun run(): Int = this.field + this.target()",
      "}",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-kt-this-goto-", { "Box.kt": source });
    try {
      await expectMemberAccess(index, paths["Box.kt"]!, 4, columnOf(source, 4, "field"), 2);
      await expectMemberAccess(index, paths["Box.kt"]!, 4, columnOf(source, 4, "target()"), 3);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves Ruby self. method through member-access", async () => {
    const source = ["class Box", "  def target", "  end", "  def run", "    self.target", "  end", "end", ""].join(
      "\n",
    );
    const { root, paths, index } = await buildFiles("cg-rb-self-goto-", { "box.rb": source });
    try {
      await expectMemberAccess(index, paths["box.rb"]!, 5, columnOf(source, 5, "target"), 2);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves PHP $this members through used traits", async () => {
    const source = [
      "<?php",
      "trait Greeter { function target() {} }",
      "class Box {",
      "  use Greeter;",
      "  function run() { $this->target(); }",
      "}",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-php-trait-goto-", { "box.php": source });
    try {
      await expectMemberAccess(index, paths["box.php"]!, 5, columnOf(source, 5, "target()"), 2);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves Ruby self members through included mixins", async () => {
    const source = [
      "module Greeter",
      "  def target",
      "  end",
      "end",
      "class Box",
      "  include Greeter",
      "  def run",
      "    self.target",
      "  end",
      "end",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-ruby-mixin-goto-", { "box.rb": source });
    try {
      await expectMemberAccess(index, paths["box.rb"]!, 8, columnOf(source, 8, "target"), 2);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves Swift self. method through member-access", async () => {
    const source = [
      "class Box {",
      "  var field = 1",
      "  func target() -> Int { return 1 }",
      "  func run() -> Int { return self.target() }",
      "}",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-swift-self-goto-", { "Box.swift": source });
    try {
      await expectMemberAccess(index, paths["Box.swift"]!, 4, columnOf(source, 4, "target()"), 3);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
  it("resolves C# this members without selecting method-local or nested-class declarations", async () => {
    const source = [
      "class Box {",
      "  public void Run() { int helper = 0; this.helper(); }",
      "  class Nested { public void target() {} }",
      "  public void RunNested() { this.target(); }",
      "  public void helper() {}",
      "  public void target() {}",
      "}",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-cs-this-direct-goto-", { "Box.cs": source });
    try {
      await expectMemberAccess(index, paths["Box.cs"]!, 2, columnOf(source, 2, "helper()"), 5);
      await expectMemberAccess(index, paths["Box.cs"]!, 4, columnOf(source, 4, "target()"), 6);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves TypeScript this members through unique ancestors and rejects same-depth ambiguity", async () => {
    const source = [
      "class Base {",
      "  helper(): number { return 1; }",
      "}",
      "class Left {",
      "  helper(): number { return 2; }",
      "}",
      "class Right {",
      "  helper(): number { return 3; }",
      "}",
      "class Derived extends Base {",
      "  run(): number { return this.helper(); }",
      "}",
      "class Ambiguous extends Left, Right {",
      "  run(): number { return this.helper(); }",
      "}",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-ts-this-ancestor-goto-", { "Box.ts": source });
    try {
      await expectMemberAccess(index, paths["Box.ts"]!, 11, columnOf(source, 11, "helper()"), 2);
      const result = await goToDefinition(index, {
        file: paths["Box.ts"]!,
        line: 14,
        column: columnOf(source, 14, "helper()"),
      });
      expect(result.status).toBe("not_found");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not resolve this.member when shallow bases are ambiguous even with a shared grandparent", async () => {
    const source = [
      "class Grand {",
      "  helper(): number { return 0; }",
      "}",
      "class Left extends Grand {",
      "  helper(): number { return 1; }",
      "}",
      "class Right extends Grand {",
      "  helper(): number { return 2; }",
      "}",
      "class Ambiguous extends Left, Right {",
      "  run(): number { return this.helper(); }",
      "}",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-ts-this-grandparent-goto-", { "Box.ts": source });
    try {
      const result = await goToDefinition(index, {
        file: paths["Box.ts"]!,
        line: 11,
        column: columnOf(source, 11, "helper()"),
      });
      expect(result.status).toBe("not_found");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps instance and type receiver member scopes separate", async () => {
    const csharp = [
      "class Box {",
      "  public static void helper() {}",
      "  public void Run() { this.helper(); }",
      "}",
      "",
    ].join("\n");
    const php = [
      "<?php",
      "class Box {",
      "  public static function helper() {}",
      "  public function run() { static::helper(); }",
      "}",
      "",
    ].join("\n");
    const csharpFix = await buildFiles("cg-cs-this-static-goto-", { "Box.cs": csharp });
    const phpFix = await buildFiles("cg-php-static-goto-", { "Box.php": php });
    try {
      const csharpResult = await goToDefinition(csharpFix.index, {
        file: csharpFix.paths["Box.cs"]!,
        line: 3,
        column: columnOf(csharp, 3, "helper()"),
      });
      expect(csharpResult.status).toBe("not_found");
      await expectMemberAccess(phpFix.index, phpFix.paths["Box.php"]!, 4, columnOf(php, 4, "helper()"), 3);
    } finally {
      await fsp.rm(csharpFix.root, { recursive: true, force: true });
      await fsp.rm(phpFix.root, { recursive: true, force: true });
    }
  });

  it("resolves TypeScript static this to static members while instance contexts stay instance-only", async () => {
    const source = [
      "class Box {",
      "  static helper(): number { return 1; }",
      "  member(): number { return 2; }",
      "  static run(): number { return this.helper(); }",
      "  static run2(): number { return this.member(); }",
      "  run(): number { return this.member(); }",
      "}",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-ts-static-this-goto-", { "Box.ts": source });
    try {
      await expectMemberAccess(index, paths["Box.ts"]!, 4, columnOf(source, 4, "helper()"), 2);
      const instanceMemberFromStatic = await goToDefinition(index, {
        file: paths["Box.ts"]!,
        line: 5,
        column: columnOf(source, 5, "member()"),
      });
      expect(instanceMemberFromStatic.status).toBe("not_found");
      await expectMemberAccess(index, paths["Box.ts"]!, 6, columnOf(source, 6, "member()"), 3);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not resolve this.member across a nested ordinary function and keeps lexical this through arrows", async () => {
    const source = [
      "class Box {",
      "  helper(): number { return 1; }",
      "  static helperStatic(): number { return 2; }",
      "  run(): number {",
      "    function inner() { return this.helper(); }",
      "    const expr = function named() { return this.helper(); };",
      "    const object = { nested() { return this.helper(); } };",
      "    const arrow = () => this.helper();",
      "    const nested = () => { const innerArrow = () => this.helper(); return innerArrow(); };",
      "    return arrow() + nested();",
      "  }",
      "  static runStatic(): number {",
      "    function inner() { return this.helperStatic(); }",
      "    const arrow = () => this.helperStatic();",
      "    return arrow();",
      "  }",
      "}",
      "",
    ].join("\n");
    const js = source.replaceAll(": number", "");
    const tsx = [
      "class Box {",
      "  helper() { return 1; }",
      "  run() {",
      "    function inner() { return <span>{this.helper()}</span>; }",
      "    const object = { nested() { return <span>{this.helper()}</span>; } };",
      "    const arrow = () => <span>{this.helper()}</span>;",
      "    return arrow();",
      "  }",
      "}",
      "",
    ].join("\n");
    const tsFix = await buildFiles("cg-ts-this-nested-fn-goto-", { "Box.ts": source });
    const jsFix = await buildFiles("cg-js-this-nested-fn-goto-", { "box.js": js });
    const tsxFix = await buildFiles("cg-tsx-this-nested-fn-goto-", { "Box.tsx": tsx });
    try {
      for (const { index, file, helperLine } of [
        { index: tsFix.index, file: tsFix.paths["Box.ts"]!, helperLine: 2 },
        { index: jsFix.index, file: jsFix.paths["box.js"]!, helperLine: 2 },
      ]) {
        const inner = await goToDefinition(index, { file, line: 5, column: columnOf(source, 5, "helper()") });
        expect(inner.status).toBe("not_found");
        const named = await goToDefinition(index, { file, line: 6, column: columnOf(source, 6, "helper()") });
        expect(named.status).toBe("not_found");
        const objectMethod = await goToDefinition(index, {
          file,
          line: 7,
          column: columnOf(source, 7, "helper()"),
        });
        expect(objectMethod.status).toBe("not_found");
        await expectMemberAccess(index, file, 8, columnOf(source, 8, "helper()"), helperLine);
        await expectMemberAccess(index, file, 9, columnOf(source, 9, "helper()"), helperLine);
        const staticInner = await goToDefinition(index, {
          file,
          line: 13,
          column: columnOf(source, 13, "helperStatic()"),
        });
        expect(staticInner.status).toBe("not_found");
        await expectMemberAccess(index, file, 14, columnOf(source, 14, "helperStatic()"), 3);
      }
      const innerTsx = await goToDefinition(tsxFix.index, {
        file: tsxFix.paths["Box.tsx"]!,
        line: 4,
        column: columnOf(tsx, 4, "helper()"),
      });
      expect(innerTsx.status).toBe("not_found");
      const objectMethodTsx = await goToDefinition(tsxFix.index, {
        file: tsxFix.paths["Box.tsx"]!,
        line: 5,
        column: columnOf(tsx, 5, "helper()"),
      });
      expect(objectMethodTsx.status).toBe("not_found");
      await expectMemberAccess(tsxFix.index, tsxFix.paths["Box.tsx"]!, 6, columnOf(tsx, 6, "helper()"), 2);
    } finally {
      await fsp.rm(tsFix.root, { recursive: true, force: true });
      await fsp.rm(jsFix.root, { recursive: true, force: true });
      await fsp.rm(tsxFix.root, { recursive: true, force: true });
    }
  });

  it("resolves Swift static and class self to type members while instance self stays instance-only", async () => {
    const source = [
      "class Box {",
      "  static func a() -> Int { return 1 }",
      "  class func b() -> Int { return 2 }",
      "  func c() -> Int { return 3 }",
      "  static func runA() -> Int { return self.a() }",
      "  class func runB() -> Int { return self.b() }",
      "  func runC() -> Int { return self.c() }",
      "}",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-swift-static-self-goto-", { "Box.swift": source });
    try {
      await expectMemberAccess(index, paths["Box.swift"]!, 5, columnOf(source, 5, "a()"), 2);
      await expectMemberAccess(index, paths["Box.swift"]!, 6, columnOf(source, 6, "b()"), 3);
      await expectMemberAccess(index, paths["Box.swift"]!, 7, columnOf(source, 7, "c()"), 4);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("selects TypeScript this overloads by known call argument count", async () => {
    const source = [
      "class Box {",
      "  helper(): number { return 1; }",
      "  helper(x: number): number { return 2; }",
      "  run(): number { return this.helper(); }",
      "  run2(x: number): number { return this.helper(x); }",
      "}",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-ts-this-overload-goto-", { "Box.ts": source });
    try {
      await expectMemberAccess(index, paths["Box.ts"]!, 4, columnOf(source, 4, "helper()"), 2);
      await expectMemberAccess(index, paths["Box.ts"]!, 5, columnOf(source, 5, "helper(x)"), 3);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("stops ancestor lookup when shallow overloads reject a known argument count", async () => {
    const source = [
      "class Grand {",
      "  helper(): number { return 0; }",
      "}",
      "class Base extends Grand {",
      "  helper(x: number): number { return x; }",
      "  helper(x: number, y: number): number { return x + y; }",
      "}",
      "class Child extends Base {",
      "  run(): number { return this.helper(); }",
      "}",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-ts-this-overload-shadow-goto-", { "Box.ts": source });
    try {
      const result = await goToDefinition(index, {
        file: paths["Box.ts"]!,
        line: 9,
        column: columnOf(source, 9, "helper()"),
      });
      expect(result.status).toBe("not_found");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("stops ancestor lookup when one shallow member rejects a known argument count", async () => {
    const source = [
      "class Grand {",
      "  helper(): number { return 0; }",
      "}",
      "class Base extends Grand {",
      "  helper(x: number): number { return x; }",
      "}",
      "class Child extends Base {",
      "  run(): number { return this.helper(); }",
      "}",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-ts-this-single-shadow-goto-", { "Box.ts": source });
    try {
      const result = await goToDefinition(index, {
        file: paths["Box.ts"]!,
        line: 8,
        column: columnOf(source, 8, "helper()"),
      });
      expect(result.status).toBe("not_found");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps an unknown argument count ambiguous for this overloads", async () => {
    const source = [
      "class Box {",
      "  helper(): number { return 1; }",
      "  helper(x: number): number { return 2; }",
      "  run(): number { const fn = this.helper; return fn(); }",
      "}",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-ts-this-overload-unknown-goto-", { "Box.ts": source });
    try {
      const result = await goToDefinition(index, {
        file: paths["Box.ts"]!,
        line: 4,
        column: columnOf(source, 4, "helper;"),
      });
      expect(result.status).toBe("not_found");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("selects Java this overloads by known call argument count", async () => {
    const source = [
      "class Box {",
      "  void helper() {}",
      "  void helper(int a) {}",
      "  void run() { this.helper(); }",
      "  void run2(int a) { this.helper(a); }",
      "}",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-java-this-overload-goto-", { "Box.java": source });
    try {
      await expectMemberAccess(index, paths["Box.java"]!, 4, columnOf(source, 4, "helper()"), 2);
      await expectMemberAccess(index, paths["Box.java"]!, 5, columnOf(source, 5, "helper(a)"), 3);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("selects C# this overloads by known call argument count", async () => {
    const source = [
      "class Box {",
      "  public void Helper() {}",
      "  public void Helper(int a) {}",
      "  public void Run() { this.Helper(); }",
      "  public void Run2(int a) { this.Helper(a); }",
      "}",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-cs-this-overload-goto-", { "Box.cs": source });
    try {
      await expectMemberAccess(index, paths["Box.cs"]!, 4, columnOf(source, 4, "Helper()"), 2);
      await expectMemberAccess(index, paths["Box.cs"]!, 5, columnOf(source, 5, "Helper(a)"), 3);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves an inherited Kotlin interface member through this", async () => {
    const source = [
      "interface Face {",
      "  fun helper(): Int { return 3 }",
      "}",
      "class Derived : Face {",
      "  fun run(): Int { return this.helper() }",
      "}",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-kt-this-interface-goto-", { "box.kt": source });
    try {
      await expectMemberAccess(index, paths["box.kt"]!, 5, columnOf(source, 5, "helper()"), 2);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a member through an imported named type alias", async () => {
    const namedFace = ["export type NamedFace = {", "  fromAlias(): number", "}", ""].join("\n");
    const child = [
      'import { NamedFace } from "./named-face";',
      "class AliasChild implements NamedFace {",
      "  run(): number { return this.fromAlias() }",
      "}",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-ts-imported-type-alias-goto-", {
      "named-face.ts": namedFace,
      "child.ts": child,
    });
    try {
      await testGoToDefinition(
        index,
        paths["child.ts"]!,
        3,
        columnOf(child, 3, "fromAlias()"),
        paths["named-face.ts"]!,
        2,
      );
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a member through an imported Java interface", async () => {
    const face = ["package api;", "public interface Face {", "  default int helper() { return 1; }", "}", ""].join(
      "\n",
    );
    const child = [
      "package app;",
      "import api.Face;",
      "class Child implements Face {",
      "  int run() { return this.helper(); }",
      "}",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-java-imported-interface-goto-", {
      "api/Face.java": face,
      "app/Child.java": child,
    });
    try {
      await testGoToDefinition(
        index,
        paths["app/Child.java"]!,
        4,
        columnOf(child, 4, "helper()"),
        paths["api/Face.java"]!,
        3,
      );
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("selects C++ this-> overloads by known call argument count", async () => {
    const source = [
      "struct Box {",
      " public:",
      "  void helper() {}",
      "  void helper(int a) {}",
      "  void run() { this->helper(); }",
      "  void run2(int a) { this->helper(a); }",
      "};",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-cpp-this-overload-goto-", { "box.cpp": source });
    try {
      await expectMemberAccess(index, paths["box.cpp"]!, 5, columnOf(source, 5, "helper()"), 3);
      await expectMemberAccess(index, paths["box.cpp"]!, 6, columnOf(source, 6, "helper(a)"), 4);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Supertype keyword member navigation", () => {
  function columnOf(source: string, line: number, token: string): number {
    const lines = source.split("\n");
    const index = lines[line - 1]!.indexOf(token);
    if (index < 0) throw new Error(`Expected token ${token} on fixture line ${line}`);
    return index + 1;
  }

  async function buildFiles(
    prefix: string,
    files: Record<string, string>,
  ): Promise<{ root: string; paths: Record<string, string>; index: ProjectIndex }> {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
    const paths: Record<string, string> = {};
    for (const [name, source] of Object.entries(files)) {
      const file = path.join(root, name).replace(/\\/g, "/");
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, source, "utf8");
      paths[name] = file;
    }
    return { root, paths, index: await createTestIndexFromFiles(root, Object.values(paths)) };
  }

  async function expectMemberAccess(
    index: ProjectIndex,
    file: string,
    line: number,
    column: number,
    expectedLine: number,
  ): Promise<void> {
    const result = await goToDefinition(index, { file, line, column });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.definition.range.start.line).toBe(expectedLine);
    expect(result.provenance?.resolution).toBe("member-access");
  }

  it("resolves TypeScript super.helper() to the base declaration, not the derived override", async () => {
    const source = [
      "class Base {",
      "  helper(): number { return 1; }",
      "}",
      "class Derived extends Base {",
      "  helper(): number { return 2; }",
      "  run(): number { return super.helper(); }",
      "}",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-ts-super-goto-", { "box.ts": source });
    try {
      const result = await goToDefinition(index, {
        file: paths["box.ts"]!,
        line: 6,
        column: columnOf(source, 6, "helper()"),
      });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.definition.range.start.line).toBe(2);
      expect(result.definition.range.start.line).not.toBe(5);
      expect(result.provenance?.resolution).toBe("member-access");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps Swift super on the class ancestor and excludes protocols", async () => {
    const source = [
      "protocol Face { func helper() -> Int }",
      "class Base { func helper() -> Int { return 1 } }",
      "class Derived: Base, Face {",
      "  override func helper() -> Int { return 2 }",
      "  func run() -> Int { return super.helper() }",
      "}",
      "class ProtocolOnly: Face {",
      "  func helper() -> Int { return 3 }",
      "  func run() -> Int { return super.helper() }",
      "}",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-swift-super-goto-", { "box.swift": source });
    try {
      await expectMemberAccess(index, paths["box.swift"]!, 5, columnOf(source, 5, "helper()"), 2);
      const protocolOnly = await goToDefinition(index, {
        file: paths["box.swift"]!,
        line: 9,
        column: columnOf(source, 9, "helper()"),
      });
      expect(protocolOnly.status).toBe("not_found");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not infer a superclass from inside a computed TypeScript extends expression", async () => {
    const source = [
      "class Base {",
      "  helper(): number { return 1; }",
      "}",
      "function mixin<T>(base: T): T { return base; }",
      "class Derived extends mixin(Base) {",
      "  run(): number { return super.helper(); }",
      "}",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-ts-computed-super-goto-", { "box.ts": source });
    try {
      const result = await goToDefinition(index, {
        file: paths["box.ts"]!,
        line: 6,
        column: columnOf(source, 6, "helper()"),
      });
      expect(result.status).toBe("not_found");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not fall back to a same-named module-level function for super.missing()", async () => {
    const source = [
      "function missing(): number { return 0; }",
      "class Base {}",
      "class Derived extends Base {",
      "  run(): number { return super.missing(); }",
      "}",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-ts-super-missing-goto-", { "box.ts": source });
    try {
      const result = await goToDefinition(index, {
        file: paths["box.ts"]!,
        line: 4,
        column: columnOf(source, 4, "missing()"),
      });
      expect(result.status).toBe("not_found");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not resolve super.helper() when two same-level ancestors declare helper", async () => {
    const source = [
      "class Left {",
      "  helper(): number { return 1; }",
      "}",
      "class Right {",
      "  helper(): number { return 2; }",
      "}",
      "class Derived extends Left, Right {",
      "  run(): number { return super.helper(); }",
      "}",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-ts-super-ambiguous-goto-", { "box.ts": source });
    try {
      const result = await goToDefinition(index, {
        file: paths["box.ts"]!,
        line: 8,
        column: columnOf(source, 8, "helper()"),
      });
      expect(result.status).toBe("not_found");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not resolve super.helper() through a shared grandparent when direct bases are ambiguous", async () => {
    const source = [
      "class Grand {",
      "  helper(): number { return 0; }",
      "}",
      "class Left extends Grand {",
      "  helper(): number { return 1; }",
      "}",
      "class Right extends Grand {",
      "  helper(): number { return 2; }",
      "}",
      "class Derived extends Left, Right {",
      "  run(): number { return super.helper(); }",
      "}",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-ts-super-grandparent-goto-", { "box.ts": source });
    try {
      const result = await goToDefinition(index, {
        file: paths["box.ts"]!,
        line: 11,
        column: columnOf(source, 11, "helper()"),
      });
      expect(result.status).toBe("not_found");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("skips an interface base when a class ancestor declares the member", async () => {
    // `base` follows class ancestors. C# lists the superclass and every interface in one
    // `base_list`, so an interface declaration must never answer the keyword.
    const source = [
      "interface IShape {",
      "  int Area();",
      "}",
      "class Base {",
      "  public virtual int Area() { return 1; }",
      "}",
      "class Square : Base, IShape {",
      "  public override int Area() { return base.Area(); }",
      "}",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-cs-base-interface-goto-", { "shapes.cs": source });
    try {
      const result = await goToDefinition(index, {
        file: paths["shapes.cs"]!,
        line: 8,
        column: columnOf(source, 8, "Area();"),
      });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.definition.range.start.line).toBe(5);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not resolve base.Area() to an interface-only base", async () => {
    const source = [
      "interface IShape {",
      "  int Area();",
      "}",
      "class Square : IShape {",
      "  public int Area() { return base.Area(); }",
      "}",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-cs-base-interface-only-goto-", { "shapes.cs": source });
    try {
      const result = await goToDefinition(index, {
        file: paths["shapes.cs"]!,
        line: 5,
        column: columnOf(source, 5, "Area();"),
      });
      expect(result.status).toBe("not_found");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves C++ this members through an exact namespace-qualified base", async () => {
    const source = [
      "namespace decoy { class Base { public: int inherited() { return 0; } }; }",
      "namespace ns { class Base { public: int inherited() { return 1; } }; }",
      "class Derived : public ns::Base { public: int use() { return this->inherited(); } };",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-cpp-qualified-base-goto-", { "derived.cpp": source });
    try {
      await expectMemberAccess(index, paths["derived.cpp"]!, 3, columnOf(source, 3, "inherited()"), 2);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves C++ this members through an unqualified base", async () => {
    const source = [
      "class Base { public: int inherited() { return 1; } };",
      "class Derived : public Base { public: int use() { return this->inherited(); } };",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-cpp-unqualified-base-goto-", { "derived.cpp": source });
    try {
      await expectMemberAccess(index, paths["derived.cpp"]!, 2, columnOf(source, 2, "inherited()"), 1);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves C++ members through every base in a base clause", async () => {
    const source = [
      "class Left { public: int left_only() { return 1; } };",
      "class Right { public: int right_only() { return 2; } };",
      "class Derived : public Left, public Right { public: int use() { return this->right_only(); } };",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-cpp-multiple-base-goto-", { "derived.cpp": source });
    try {
      await expectMemberAccess(index, paths["derived.cpp"]!, 3, columnOf(source, 3, "right_only()"), 2);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves TypeScript super.helper() through a namespace-imported qualified base", async () => {
    const imported = ["export class Base {", "  helper(): number { return 1; }", "}", ""].join("\n");
    const derived = [
      'import * as ns from "./imported";',
      "class Base {",
      "  helper(): number { return 0; }",
      "}",
      "class Derived extends ns.Base {",
      "  helper(): number { return 2; }",
      "  run(): number { return super.helper(); }",
      "}",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-ts-super-ns-goto-", {
      "imported.ts": imported,
      "derived.ts": derived,
    });
    try {
      const result = await goToDefinition(index, {
        file: paths["derived.ts"]!,
        line: 7,
        column: columnOf(derived, 7, "helper()"),
      });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(fileIdentityKey(result.definition.file)).toBe(fileIdentityKey(paths["imported.ts"]!));
      expect(result.definition.range.start.line).toBe(2);
      expect(result.definition.range.start.line).not.toBe(3);
      expect(result.provenance?.resolution).toBe("member-access");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves TypeScript super.helper() through a default-import base", async () => {
    const base = ["export default class Base {", "  helper(): number { return 1; }", "}", ""].join("\n");
    const derived = [
      'import Base from "./base";',
      "class Derived extends Base {",
      "  helper(): number { return 2; }",
      "  run(): number { return super.helper(); }",
      "}",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-ts-super-default-goto-", {
      "base.ts": base,
      "derived.ts": derived,
    });
    try {
      const result = await goToDefinition(index, {
        file: paths["derived.ts"]!,
        line: 4,
        column: columnOf(derived, 4, "helper()"),
      });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(fileIdentityKey(result.definition.file)).toBe(fileIdentityKey(paths["base.ts"]!));
      expect(result.definition.range.start.line).toBe(2);
      expect(result.provenance?.resolution).toBe("member-access");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves JavaScript super.helper() through a default-import base", async () => {
    const base = ["export default class Base {", "  helper() { return 1; }", "}", ""].join("\n");
    const derived = [
      'import Base from "./base";',
      "class Derived extends Base {",
      "  helper() { return 2; }",
      "  run() { return super.helper(); }",
      "}",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-js-super-default-goto-", {
      "base.js": base,
      "derived.js": derived,
    });
    try {
      const result = await goToDefinition(index, {
        file: paths["derived.js"]!,
        line: 4,
        column: columnOf(derived, 4, "helper()"),
      });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(fileIdentityKey(result.definition.file)).toBe(fileIdentityKey(paths["base.js"]!));
      expect(result.definition.range.start.line).toBe(2);
      expect(result.provenance?.resolution).toBe("member-access");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not fall back to a simple-name Base decoy when a qualified base is unresolved or ambiguous", async () => {
    const empty = ["export const value = 1;", ""].join("\n");
    const left = ["export class Base {", "  helper(): number { return 1; }", "}", ""].join("\n");
    const right = ["export class Base {", "  helper(): number { return 2; }", "}", ""].join("\n");
    const unresolved = [
      'import * as ns from "./empty";',
      "class Base {",
      "  helper(): number { return 0; }",
      "}",
      "class Derived extends ns.Base {",
      "  run(): number { return super.helper(); }",
      "}",
      "",
    ].join("\n");
    const missingQualifier = [
      "class Base {",
      "  helper(): number { return 0; }",
      "}",
      "class Derived extends ns.Base {",
      "  run(): number { return super.helper(); }",
      "}",
      "",
    ].join("\n");
    const ambiguous = [
      'import * as ns from "./left";',
      'import * as ns from "./right";',
      "class Base {",
      "  helper(): number { return 0; }",
      "}",
      "class Derived extends ns.Base {",
      "  run(): number { return super.helper(); }",
      "}",
      "",
    ].join("\n");
    const unresolvedFix = await buildFiles("cg-ts-super-unresolved-qual-goto-", {
      "empty.ts": empty,
      "derived.ts": unresolved,
    });
    const missingFix = await buildFiles("cg-ts-super-missing-qual-goto-", { "derived.ts": missingQualifier });
    const ambiguousFix = await buildFiles("cg-ts-super-ambiguous-qual-goto-", {
      "left.ts": left,
      "right.ts": right,
      "derived.ts": ambiguous,
    });
    try {
      const unresolvedResult = await goToDefinition(unresolvedFix.index, {
        file: unresolvedFix.paths["derived.ts"]!,
        line: 6,
        column: columnOf(unresolved, 6, "helper()"),
      });
      expect(unresolvedResult.status).toBe("not_found");
      const missingResult = await goToDefinition(missingFix.index, {
        file: missingFix.paths["derived.ts"]!,
        line: 5,
        column: columnOf(missingQualifier, 5, "helper()"),
      });
      expect(missingResult.status).toBe("not_found");
      const ambiguousResult = await goToDefinition(ambiguousFix.index, {
        file: ambiguousFix.paths["derived.ts"]!,
        line: 7,
        column: columnOf(ambiguous, 7, "helper()"),
      });
      expect(ambiguousResult.status).toBe("not_found");
    } finally {
      await fsp.rm(unresolvedFix.root, { recursive: true, force: true });
      await fsp.rm(missingFix.root, { recursive: true, force: true });
      await fsp.rm(ambiguousFix.root, { recursive: true, force: true });
    }
  });

  it("selects TypeScript super overloads by known call argument count", async () => {
    const source = [
      "class Base {",
      "  helper(): number { return 1; }",
      "  helper(x: number): number { return 2; }",
      "}",
      "class Derived extends Base {",
      "  run(): number { return super.helper(); }",
      "  run2(x: number): number { return super.helper(x); }",
      "}",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-ts-super-overload-goto-", { "box.ts": source });
    try {
      await expectMemberAccess(index, paths["box.ts"]!, 6, columnOf(source, 6, "helper()"), 2);
      await expectMemberAccess(index, paths["box.ts"]!, 7, columnOf(source, 7, "helper(x)"), 3);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("selects Java super overloads by known call argument count", async () => {
    const source = [
      "class Base {",
      "  void helper() {}",
      "  void helper(int a) {}",
      "}",
      "class Derived extends Base {",
      "  void run() { super.helper(); }",
      "  void run2(int a) { super.helper(a); }",
      "}",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-java-super-overload-goto-", { "Box.java": source });
    try {
      await expectMemberAccess(index, paths["Box.java"]!, 6, columnOf(source, 6, "helper()"), 2);
      await expectMemberAccess(index, paths["Box.java"]!, 7, columnOf(source, 7, "helper(a)"), 3);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("selects C# base overloads by known call argument count", async () => {
    const source = [
      "class Base {",
      "  public void Helper() {}",
      "  public void Helper(int a) {}",
      "}",
      "class Derived : Base {",
      "  public void Run() { base.Helper(); }",
      "  public void Run2(int a) { base.Helper(a); }",
      "}",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-cs-base-overload-goto-", { "Box.cs": source });
    try {
      await expectMemberAccess(index, paths["Box.cs"]!, 6, columnOf(source, 6, "Helper()"), 2);
      await expectMemberAccess(index, paths["Box.cs"]!, 7, columnOf(source, 7, "Helper(a)"), 3);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves PHP parent members through case-variant local class and method names", async () => {
    const source = [
      "<?php",
      "class Base { function helper() { return 1; } }",
      "class Derived extends bAsE {",
      "  function run() { return parent::HELPER(); }",
      "}",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-php-parent-case-goto-", { "box.php": source });
    try {
      await expectMemberAccess(index, paths["box.php"]!, 4, columnOf(source, 4, "HELPER()"), 2);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves PHP parent members through a case-variant imported alias", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-php-parent-alias-case-goto-"));
    const baseFile = path.join(root, "src", "Base.php").replace(/\\/g, "/");
    const derivedFile = path.join(root, "Derived.php").replace(/\\/g, "/");
    const base = ["<?php", "namespace App;", "class Base {", "  function helper() { return 1; }", "}", ""].join("\n");
    const derived = [
      "<?php",
      "namespace Client;",
      "use App\\Base as ParentBase;",
      "class Derived extends pArEnTbAsE {",
      "  function run() { return parent::HELPER(); }",
      "}",
      "",
    ].join("\n");
    try {
      await fsp.mkdir(path.dirname(baseFile), { recursive: true });
      await fsp.writeFile(
        path.join(root, "composer.json"),
        JSON.stringify({ autoload: { "psr-4": { "App\\": "src/" } } }),
        "utf8",
      );
      await fsp.writeFile(baseFile, base, "utf8");
      await fsp.writeFile(derivedFile, derived, "utf8");
      const index = await createTestIndexFromPath(root);
      const result = await goToDefinition(index, {
        file: derivedFile,
        line: 5,
        column: columnOf(derived, 5, "HELPER()"),
      });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(fileIdentityKey(result.definition.file)).toBe(fileIdentityKey(baseFile));
      expect(result.definition.range.start.line).toBe(4);
      expect(result.provenance?.resolution).toBe("member-access");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("follows the Kotlin constructor-invocation superclass over a same-kind interface base", async () => {
    // `Base()` and `Face` both classify as SymbolKind.Class, so `super` must identify the
    // superclass syntactically: the delegation-specifier entry written as a constructor
    // invocation. The interface entry never answers the keyword.
    const source = [
      "interface Face {",
      "  fun helper(): Int {",
      "    return 3",
      "  }",
      "}",
      "open class Base {",
      "  open fun helper(): Int {",
      "    return 1",
      "  }",
      "}",
      "class Derived : Base(), Face {",
      "  override fun helper(): Int {",
      "    return 2",
      "  }",
      "  fun run(): Int {",
      "    return super.helper()",
      "  }",
      "}",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-kt-super-class-goto-", { "box.kt": source });
    try {
      await expectMemberAccess(index, paths["box.kt"]!, 16, columnOf(source, 16, "helper()"), 7);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not resolve a Kotlin super member through an interface-only base list", async () => {
    const source = [
      "interface Face {",
      "  fun helper(): Int {",
      "    return 3",
      "  }",
      "}",
      "class OnlyFace : Face {",
      "  override fun helper(): Int {",
      "    return 4",
      "  }",
      "  fun run(): Int {",
      "    return super.helper()",
      "  }",
      "}",
      "",
    ].join("\n");
    const { root, paths, index } = await buildFiles("cg-kt-super-interface-only-goto-", { "box.kt": source });
    try {
      const result = await goToDefinition(index, {
        file: paths["box.kt"]!,
        line: 11,
        column: columnOf(source, 11, "helper()"),
      });
      expect(result.status).toBe("not_found");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
