import { afterEach, describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { buildProjectIndex, buildProjectIndexFromFiles, findReferences, type BuildReport } from "../src/index.js";
import {
  __resetNativeTreeSitterBindingForTests,
  __setNativeTreeSitterBindingForTests,
} from "../src/native/tree-sitter-native.js";
import { loadBinding } from "../src/native/runtime.js";
import { createStubNativeSyntaxTree } from "./helpers/native.js";
import { createTestIndexFromFiles } from "./test-utils.js";

const languages = [
  {
    name: "TypeScript",
    extension: ".ts",
    definition: "export function name() { return 1; }\n",
    errorReference: 'import { name } from "./definition";\nconst broken = <name;\n',
    cleanReference: 'import { name } from "./definition";\nname();\n',
  },
  {
    name: "Python",
    extension: ".py",
    definition: "def name():\n    return 1\n",
    errorReference: "from definition import name\nclass :\n    name()\n",
    cleanReference: "from definition import name\nname()\n",
  },
  {
    name: "SQL",
    extension: ".sql",
    definition: "CREATE FUNCTION name() RETURNS integer AS $$ SELECT 1 $$ LANGUAGE sql;\n",
    errorReference: "EXEC name;\n",
    cleanReference: "SELECT name();\n",
  },
  {
    name: "SCSS",
    extension: ".scss",
    definition: "@mixin name { color: red; }\n",
    errorReference: '@import "./definition";\n.box { @include "name"; }\n.clean { @include name; }\n',
    cleanReference: '@import "./definition";\n.box { @include name; }\n',
  },
] as const;

type LanguageCase = (typeof languages)[number];
type ReferenceResult = Awaited<ReturnType<typeof findReferences>>;
type ParseErrorRange = { startIndex: number; endIndex: number };

async function findCoverage(
  language: LanguageCase,
  consumerSource: string,
  definitionSource: string = language.definition,
): Promise<{
  result: ReferenceResult;
  definitionFile: string;
  consumerFile: string;
  parseErrorRanges: ParseErrorRange[];
  definitionParseErrorRanges: ParseErrorRange[];
}> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-parse-error-coverage-"));
  const definitionFile = path.join(root, "definition" + language.extension).replace(/\\/g, "/");
  const consumerFile = path.join(root, "consumer" + language.extension).replace(/\\/g, "/");
  try {
    await fsp.writeFile(definitionFile, definitionSource, "utf8");
    await fsp.writeFile(consumerFile, consumerSource, "utf8");
    const index = await createTestIndexFromFiles(root, [definitionFile, consumerFile]);
    const result = await findReferences(index, {
      file: definitionFile,
      line: 1,
      column: definitionSource.indexOf("name") + 1,
    });
    const consumerModule = [...index.byFile.values()].find((module) => module.file === consumerFile);
    const definitionModule = [...index.byFile.values()].find((module) => module.file === definitionFile);
    return {
      result,
      definitionFile,
      consumerFile,
      parseErrorRanges: consumerModule?.parseErrorRanges ?? [],
      definitionParseErrorRanges: definitionModule?.parseErrorRanges ?? [],
    };
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

describe("parse-error reference coverage", () => {
  afterEach(() => {
    __resetNativeTreeSitterBindingForTests();
  });
  it.each(languages.filter((language) => language.name !== "SCSS"))(
    "marks an affected $name file partial when it has an ERROR/MISSING range",
    async (language) => {
      const { result, consumerFile, parseErrorRanges } = await findCoverage(language, language.errorReference);

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(parseErrorRanges.length).toBeGreaterThan(0);
      expect(result.referenceCoverage).toEqual({
        scope: "indexed_candidates",
        state: "partial",
        reasons: ["parse_error"],
        affectedFiles: [consumerFile],
      });
    },
  );

  it.each(languages)("keeps clean $name coverage unchanged", async (language) => {
    const { result, consumerFile, parseErrorRanges } = await findCoverage(language, language.cleanReference);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(parseErrorRanges).toEqual([]);
    expect(result.references.some((reference) => reference.file === consumerFile)).toBe(true);
    expect(result.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
  });

  it("ignores an ERROR in a non-candidate file that does not mention or import the definition", async () => {
    const language = languages[0];
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-parse-error-noncandidate-"));
    const definitionFile = path.join(root, "definition.ts").replace(/\\/g, "/");
    const consumerFile = path.join(root, "consumer.ts").replace(/\\/g, "/");
    const unrelatedFile = path.join(root, "unrelated.ts").replace(/\\/g, "/");
    const unrelatedSource = "const broken = <unrelated;\n";
    try {
      await fsp.writeFile(definitionFile, language.definition, "utf8");
      await fsp.writeFile(consumerFile, language.cleanReference, "utf8");
      await fsp.writeFile(unrelatedFile, unrelatedSource, "utf8");
      const index = await createTestIndexFromFiles(root, [definitionFile, consumerFile, unrelatedFile]);
      const unrelatedModule = [...index.byFile.values()].find((module) => module.file === unrelatedFile);
      expect(unrelatedModule?.parseErrorRanges?.length).toBeGreaterThan(0);

      const result = await findReferences(index, {
        file: definitionFile,
        line: 1,
        column: language.definition.indexOf("name") + 1,
      });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.references.some((reference) => reference.file === consumerFile)).toBe(true);
      expect(result.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("marks an ERROR in the declaring file as partial coverage", async () => {
    const language = languages[0];
    const definitionSource = `${language.definition}const broken = <unrelated;\n`;
    const { result, definitionFile, definitionParseErrorRanges } = await findCoverage(
      language,
      language.cleanReference,
      definitionSource,
    );

    expect(definitionParseErrorRanges.length).toBeGreaterThan(0);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.referenceCoverage).toEqual({
      scope: "indexed_candidates",
      state: "partial",
      reasons: ["parse_error"],
      affectedFiles: [definitionFile],
    });
  });

  it("marks a MISSING-only TypeScript range around a target reference partial", async () => {
    const language = languages[0];
    const { result, consumerFile, parseErrorRanges } = await findCoverage(
      language,
      'import { name } from "./definition";\nfunction f() { return name(1; }\n',
    );

    expect(parseErrorRanges.some((range) => range.startIndex < range.endIndex)).toBe(true);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.referenceCoverage).toEqual({
      scope: "indexed_candidates",
      state: "partial",
      reasons: ["parse_error"],
      affectedFiles: [consumerFile],
    });
  });

  it("keeps the SCSS parse-error exemption", async () => {
    const language = languages[3];
    const { result, parseErrorRanges, consumerFile } = await findCoverage(language, language.errorReference);

    expect(parseErrorRanges.length).toBeGreaterThan(0);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
    expect(result.references.some((reference) => reference.file === consumerFile)).toBe(true);
  });

  it("marks SQL coverage parser-degraded when native parse-error projection is unavailable, including warm cache", async () => {
    const loaded = loadBinding();
    if (!loaded.loaded) throw new Error("Native addon required for SQL projection fallback test");
    const originalExtractLanguage = loaded.binding.extractLanguage;
    const legacyTree = createStubNativeSyntaxTree();
    Reflect.deleteProperty(legacyTree, "isMissing");
    __setNativeTreeSitterBindingForTests({
      ...loaded,
      binding: {
        ...loaded.binding,
        extractLanguage: (source, languageId, importsQuery, exportsQuery, localsQuery, importBindingsQuery) => {
          const extraction = originalExtractLanguage(
            source,
            languageId,
            importsQuery,
            exportsQuery,
            localsQuery,
            importBindingsQuery,
          );
          return languageId === "sql" && source.startsWith("SELECT normalize_email")
            ? { ...extraction, syntaxTree: legacyTree }
            : extraction;
        },
      },
    });

    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-parse-error-sql-legacy-"));
    const definitionFile = path.join(root, "schema.sql").replace(/\\/g, "/");
    const consumerFile = path.join(root, "query.sql").replace(/\\/g, "/");
    const definition = "CREATE FUNCTION normalize_email(e text) RETURNS text AS $$ SELECT e $$ LANGUAGE sql;\n";
    const consumer = "SELECT normalize_email(email) FROM users;\nSELECT ( FROM users;\n";
    const options = { cache: "disk" as const, threads: 1, useNativeWorkers: false };
    try {
      await fsp.writeFile(definitionFile, definition, "utf8");
      await fsp.writeFile(consumerFile, consumer, "utf8");
      for (const cacheState of ["cold", "warm"] as const) {
        const report: BuildReport = { timings: {} };
        const index = await buildProjectIndex(root, { ...options, report });
        const result = await findReferences(index, {
          file: definitionFile,
          line: 1,
          column: definition.indexOf("normalize_email") + 1,
        });
        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        expect(result.referenceCoverage).toEqual({
          scope: "indexed_candidates",
          state: "partial",
          reasons: ["parser_degraded"],
          affectedFiles: [consumerFile],
        });
        if (cacheState === "warm") expect(report.cache?.hits).toBeGreaterThan(0);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves parse-error coverage through a warm per-file cache", async () => {
    const language = languages[0];
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-parse-error-cache-"));
    const definitionFile = path.join(root, "definition" + language.extension).replace(/\\/g, "/");
    const consumerFile = path.join(root, "consumer" + language.extension).replace(/\\/g, "/");
    const files = [definitionFile, consumerFile];
    const options = { cache: "disk" as const, cacheDir: path.join(root, "cache"), threads: 1 };
    try {
      await fsp.writeFile(definitionFile, language.definition, "utf8");
      await fsp.writeFile(consumerFile, language.errorReference, "utf8");
      await buildProjectIndexFromFiles(root, files, options);
      const report: BuildReport = { timings: {} };
      const index = await buildProjectIndexFromFiles(root, files, { ...options, report });
      expect(report.cache?.hits).toBeGreaterThan(0);
      const result = await findReferences(index, {
        file: definitionFile,
        line: 1,
        column: language.definition.indexOf("name") + 1,
      });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.referenceCoverage).toEqual({
        scope: "indexed_candidates",
        state: "partial",
        reasons: ["parse_error"],
        affectedFiles: [consumerFile],
      });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
