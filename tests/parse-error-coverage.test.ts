import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { buildProjectIndexFromFiles, findReferences, type BuildReport } from "../src/index.js";
import { createTestIndexFromFiles } from "./test-utils.js";
const languages = [
  {
    name: "TypeScript",
    extension: ".ts",
    definition: "export function name() { return 1; }\n",
    errorReference: 'import { name } from "./definition";\nconst broken = <name;\n',
    unrelatedError: 'import { name } from "./definition";\nname();\nconst broken = <namesake;\n',
    cleanReference: 'import { name } from "./definition";\nname();\n',
  },
  {
    name: "Python",
    extension: ".py",
    definition: "def name():\n    return 1\n",
    errorReference: "from definition import name\nclass :\n    name()\n",
    unrelatedError: "from definition import name\nname()\nx = namesake + * 2\n",
    cleanReference: "from definition import name\nname()\n",
  },
  {
    name: "SQL",
    extension: ".sql",
    definition: "CREATE FUNCTION name() RETURNS integer AS $$ SELECT 1 $$ LANGUAGE sql;\n",
    errorReference: "EXEC name;\n",
    unrelatedError: "EXEC namesake;\nSELECT name();\n",
    cleanReference: "SELECT name();\n",
  },
  {
    name: "SCSS",
    extension: ".scss",
    definition: "@mixin name { color: red; }\n",
    errorReference: '@import "./definition";\n.box { @include "name"; }\n',
    unrelatedError: '@import "./definition";\n.box { @include "namesake"; }\n.other { @include name; }\n',
    cleanReference: '@import "./definition";\n.box { @include name; }\n',
  },
] as const;

type LanguageCase = (typeof languages)[number];
type ReferenceResult = Awaited<ReturnType<typeof findReferences>>;

async function findCoverage(
  language: LanguageCase,
  consumerSource: string,
  definitionSource: string = language.definition,
  targetName: string = "name",
): Promise<{
  result: ReferenceResult;
  definitionFile: string;
  consumerFile: string;
  parseErrorRanges: { startIndex: number; endIndex: number; text: string }[];
  definitionParseErrorRanges: { startIndex: number; endIndex: number; text: string }[];
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
      column: definitionSource.indexOf(targetName) + 1,
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
  it.each(languages.filter((language) => language.name !== "SCSS"))(
    "marks a $name reference inside an ERROR range as partial",
    async (language) => {
      const { result, consumerFile, parseErrorRanges } = await findCoverage(language, language.errorReference);

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(parseErrorRanges.some((range) => range.text.includes("name"))).toBe(true);
      expect(result.referenceCoverage).toEqual({
        scope: "indexed_candidates",
        state: "partial",
        reasons: ["parse_error"],
        affectedFiles: [consumerFile],
      });
    },
  );

  it.each(languages.filter((language) => language.name !== "SCSS"))(
    "ignores an ERROR range that contains only a longer $name identifier",
    async (language) => {
      const { result, consumerFile, parseErrorRanges } = await findCoverage(language, language.unrelatedError);

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(parseErrorRanges.some((range) => range.text.includes("namesake"))).toBe(true);
      expect(result.references.some((reference) => reference.file === consumerFile)).toBe(true);
      expect(result.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
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
});

it("marks an ERROR in the declaring file as partial coverage", async () => {
  const language = languages[0];
  const definitionSource = `${language.definition}const broken = <name;\n`;
  const { result, definitionFile, definitionParseErrorRanges } = await findCoverage(
    language,
    language.cleanReference,
    definitionSource,
  );

  expect(definitionParseErrorRanges.some((range) => range.text.includes("name"))).toBe(true);
  expect(result.status).toBe("ok");
  if (result.status !== "ok") return;
  expect(result.referenceCoverage).toEqual({
    scope: "indexed_candidates",
    state: "partial",
    reasons: ["parse_error"],
    affectedFiles: [definitionFile],
  });
});

it("marks a MISSING-only TypeScript range around a target reference", async () => {
  const language = languages[0];
  const { result, consumerFile, parseErrorRanges } = await findCoverage(
    language,
    'import { name } from "./definition";\nfunction f() { return name(1; }\n',
  );

  expect(parseErrorRanges.some((range) => range.text.includes("name") && range.startIndex < range.endIndex)).toBe(true);
  expect(result.status).toBe("ok");
  if (result.status !== "ok") return;
  expect(result.referenceCoverage).toEqual({
    scope: "indexed_candidates",
    state: "partial",
    reasons: ["parse_error"],
    affectedFiles: [consumerFile],
  });
});

it("keeps a MISSING-only TypeScript range for an unrelated name complete", async () => {
  const language = languages[0];
  const { result, consumerFile, parseErrorRanges } = await findCoverage(
    language,
    'import { name } from "./definition";\nname();\nfunction f() { return namesake(1; }\n',
  );

  expect(parseErrorRanges.some((range) => range.text.includes("namesake") && range.startIndex < range.endIndex)).toBe(
    true,
  );
  expect(result.status).toBe("ok");
  if (result.status !== "ok") return;
  expect(result.references.some((reference) => reference.file === consumerFile)).toBe(true);
  expect(result.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
});

it("marks an imported named alias in an ERROR range as partial coverage", async () => {
  const language = languages[0];
  const definitionSource = `${language.definition}export function other() { return 2; }\n`;
  const { result, consumerFile, parseErrorRanges } = await findCoverage(
    language,
    'import { name as alias } from "./definition";\nconst broken = <alias;\n',
    definitionSource,
  );

  expect(parseErrorRanges.some((range) => range.text.includes("alias"))).toBe(true);
  expect(result.status).toBe("ok");
  if (result.status !== "ok") return;
  expect(result.referenceCoverage).toEqual({
    scope: "indexed_candidates",
    state: "partial",
    reasons: ["parse_error"],
    affectedFiles: [consumerFile],
  });
});

it("does not let an unrelated import alias degrade target coverage", async () => {
  const language = languages[0];
  const definitionSource = `${language.definition}export function other() { return 2; }\n`;
  const { result, consumerFile, parseErrorRanges } = await findCoverage(
    language,
    'import { name as alias, other as unrelatedAlias } from "./definition";\nalias();\nconst broken = <unrelatedAlias;\n',
    definitionSource,
  );

  expect(parseErrorRanges.some((range) => range.text.includes("unrelatedAlias"))).toBe(true);
  expect(result.status).toBe("ok");
  if (result.status !== "ok") return;
  expect(result.references.some((reference) => reference.file === consumerFile)).toBe(true);
  expect(result.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
});

it("marks a default import alias in an ERROR range as partial coverage", async () => {
  const language = languages[0];
  const definitionSource = "export default function name() { return 1; }\n";
  const { result, consumerFile, parseErrorRanges } = await findCoverage(
    language,
    'import defaultAlias from "./definition";\nconst broken = <defaultAlias;\n',
    definitionSource,
  );

  expect(parseErrorRanges.some((range) => range.text.includes("defaultAlias"))).toBe(true);
  expect(result.status).toBe("ok");
  if (result.status !== "ok") return;
  expect(result.referenceCoverage).toEqual({
    scope: "indexed_candidates",
    state: "partial",
    reasons: ["parse_error"],
    affectedFiles: [consumerFile],
  });
});

it("matches unquoted SQL definition names case-insensitively in ERROR ranges", async () => {
  const language = languages[2];
  const { result, consumerFile, parseErrorRanges } = await findCoverage(language, "EXEC NAME;\n");

  expect(parseErrorRanges.some((range) => range.text.includes("NAME"))).toBe(true);
  expect(result.status).toBe("ok");
  if (result.status !== "ok") return;
  expect(result.referenceCoverage).toEqual({
    scope: "indexed_candidates",
    state: "partial",
    reasons: ["parse_error"],
    affectedFiles: [consumerFile],
  });
});

it("matches an unqualified SQL reference to a qualified definition in ERROR ranges", async () => {
  const language = languages[2];
  const definitionSource = "CREATE FUNCTION app.name() RETURNS integer AS $$ SELECT 1 $$ LANGUAGE sql;\n";
  const { result, consumerFile, parseErrorRanges } = await findCoverage(language, "EXEC name;\n", definitionSource);

  expect(parseErrorRanges.some((range) => range.text.includes("name"))).toBe(true);
  expect(result.status).toBe("ok");
  if (result.status !== "ok") return;
  expect(result.referenceCoverage).toEqual({
    scope: "indexed_candidates",
    state: "partial",
    reasons: ["parse_error"],
    affectedFiles: [consumerFile],
  });
});

it("keeps quoted SQL names case-sensitive in ERROR ranges", async () => {
  const language = languages[2];
  const definitionSource = 'CREATE FUNCTION "Name"() RETURNS integer AS $$ SELECT 1 $$ LANGUAGE sql;\n';
  const { result, parseErrorRanges } = await findCoverage(language, 'EXEC "NAME";\n', definitionSource, "Name");

  expect(parseErrorRanges.some((range) => range.text.includes('"NAME"'))).toBe(true);
  expect(result.status).toBe("ok");
  if (result.status !== "ok") return;
  expect(result.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
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
