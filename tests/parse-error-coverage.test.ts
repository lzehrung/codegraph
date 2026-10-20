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
] as const;

type LanguageCase = (typeof languages)[number];
type ReferenceResult = Awaited<ReturnType<typeof findReferences>>;

async function findCoverage(
  language: LanguageCase,
  consumerSource: string,
): Promise<{
  result: ReferenceResult;
  consumerFile: string;
  parseErrorRanges: { startIndex: number; endIndex: number; text: string }[];
}> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-parse-error-coverage-"));
  const definitionFile = path.join(root, "definition" + language.extension).replace(/\\/g, "/");
  const consumerFile = path.join(root, "consumer" + language.extension).replace(/\\/g, "/");
  try {
    await fsp.writeFile(definitionFile, language.definition, "utf8");
    await fsp.writeFile(consumerFile, consumerSource, "utf8");
    const index = await createTestIndexFromFiles(root, [definitionFile, consumerFile]);
    const result = await findReferences(index, {
      file: definitionFile,
      line: 1,
      column: language.definition.indexOf("name") + 1,
    });
    const consumerModule = [...index.byFile.values()].find((module) => module.file === consumerFile);
    return { result, consumerFile, parseErrorRanges: consumerModule?.parseErrorRanges ?? [] };
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

describe("parse-error reference coverage", () => {
  it.each(languages)("marks a $name reference inside an ERROR range as partial", async (language) => {
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
  });

  it.each(languages)("ignores an ERROR range that contains only a longer $name identifier", async (language) => {
    const { result, consumerFile, parseErrorRanges } = await findCoverage(language, language.unrelatedError);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(parseErrorRanges.some((range) => range.text.includes("namesake"))).toBe(true);
    expect(result.references.some((reference) => reference.file === consumerFile)).toBe(true);
    expect(result.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
  });

  it.each(languages)("keeps clean $name coverage unchanged", async (language) => {
    const { result, consumerFile, parseErrorRanges } = await findCoverage(language, language.cleanReference);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(parseErrorRanges).toEqual([]);
    expect(result.references.some((reference) => reference.file === consumerFile)).toBe(true);
    expect(result.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
  });
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
