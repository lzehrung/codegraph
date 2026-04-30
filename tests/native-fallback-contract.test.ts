import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildProjectIndex,
  buildProjectIndexFromFiles,
  buildProjectIndexIncremental,
  collectImportsForFile,
  collectLocalsAndExportsFromSource,
  type BuildReport,
  type ModuleIndex,
} from "../src/index.js";
import { prepareParserInput } from "../src/languages/filePrep.js";
import * as nativeRuntime from "../src/native/treeSitterNative.js";

const nativeDescribe = nativeRuntime.isNativeTreeSitterAvailable() ? describe : describe.skip;

function normalizeFile(file: string): string {
  return path.resolve(file).replace(/\\/g, "/");
}

function simplifyModule(index: ModuleIndex): unknown {
  return {
    imports: index.imports.map((entry) => ({
      ...entry,
      resolved: typeof entry.resolved === "string" ? normalizeFile(entry.resolved) : entry.resolved,
    })),
    locals: index.locals.map((local) => ({
      localName: local.localName,
      kind: local.kind,
    })),
    exports: index.exports.map((entry) => {
      if (entry.type === "local") {
        return {
          type: entry.type,
          exportedAs: entry.exportedAs,
          localName: entry.target.localName,
          kind: entry.target.kind,
        };
      }
      if (entry.type === "reexport") {
        return {
          type: entry.type,
          exportedAs: entry.exportedAs,
          fromModule: normalizeFile(entry.fromModule),
          sourceSpecifier: entry.sourceSpecifier,
          typeOnly: entry.typeOnly ?? false,
        };
      }
      if (entry.type === "namespaceReexport") {
        return {
          type: entry.type,
          exportedAs: entry.exportedAs,
          fromModule: normalizeFile(entry.fromModule),
          typeOnly: entry.typeOnly ?? false,
        };
      }
      return {
        type: entry.type,
        fromModule: normalizeFile(entry.fromModule),
        sourceSpecifier: entry.sourceSpecifier,
        typeOnly: entry.typeOnly ?? false,
      };
    }),
  };
}

async function makeTempProject(): Promise<{
  root: string;
  alphaFile: string;
  betaFile: string;
}> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-native-fallback-"));
  const alphaFile = path.join(root, "alpha.ts");
  const betaFile = path.join(root, "beta.ts");

  await fsp.writeFile(
    betaFile,
    ["export const betaValue = 1;", "export function betaHelper() {", "  return betaValue;", "}", ""].join("\n"),
    "utf8",
  );

  await fsp.writeFile(
    alphaFile,
    [
      "import { betaHelper, betaValue } from './beta';",
      "",
      "export function alphaValue() {",
      "  return betaHelper() + betaValue;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  return { root, alphaFile, betaFile };
}

async function computeJsOnlyModule(file: string, projectRoot: string): Promise<unknown> {
  const prepared = await prepareParserInput(file);
  const imports = await collectImportsForFile(file, projectRoot, {
    source: prepared.source,
    sup: prepared.sup,
    lang: prepared.lang,
  });
  const moduleIndex = collectLocalsAndExportsFromSource(
    normalizeFile(file),
    prepared.source,
    prepared.sup,
    prepared.lang,
    imports,
  );
  moduleIndex.imports = imports;
  return simplifyModule(moduleIndex);
}

function mockNativeFailureForFile(file: string) {
  const normalizedFile = normalizeFile(file);
  const original = nativeRuntime.getNativeQueryExecution;
  return vi.spyOn(nativeRuntime, "getNativeQueryExecution").mockImplementation((source, support) => {
    if (support.id === "ts" && source.includes("export function alphaValue") && normalizedFile.endsWith("/alpha.ts")) {
      return {
        results: null,
        fallbackReason: "queryFailure",
        error: "forced native query failure",
      };
    }
    return original(source, support);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

nativeDescribe("native fallback contract", () => {
  it("falls back cleanly for one file without mixing native and JS extraction", async () => {
    const { root, alphaFile, betaFile } = await makeTempProject();
    const alphaNormalized = normalizeFile(alphaFile);
    const betaNormalized = normalizeFile(betaFile);
    const jsOnlyAlpha = await computeJsOnlyModule(alphaFile, root);

    const spy = mockNativeFailureForFile(alphaFile);
    const report: BuildReport = { timings: {} };

    try {
      const index = await buildProjectIndexFromFiles(root, [alphaFile, betaFile], {
        report,
      });

      expect(simplifyModule(index.byFile.get(alphaNormalized)!)).toEqual(jsOnlyAlpha);
      expect(report.backend?.native.byLanguage.ts?.filesSeen).toBe(2);
      expect(report.backend?.native.byLanguage.ts?.filesUsed).toBe(1);
      expect(report.backend?.native.byLanguage.ts?.filesFellBack).toBe(1);
      expect(report.backend?.native.byLanguage.ts?.fallbackReasons.queryFailure).toBe(1);
      expect(report.backend?.native.errors).toContainEqual({
        file: alphaNormalized,
        languageId: "ts",
        reason: "queryFailure",
        message: "forced native query failure",
      });

      const betaModule = index.byFile.get(betaNormalized);
      expect(betaModule).toBeDefined();
      expect(spy).toHaveBeenCalled();
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the same per-file fallback contract in incremental builds", async () => {
    const { root, alphaFile, betaFile } = await makeTempProject();
    const alphaNormalized = normalizeFile(alphaFile);
    const jsOnlyAlpha = await computeJsOnlyModule(alphaFile, root);

    try {
      await buildProjectIndex(root, { cache: "disk" });

      const report: BuildReport = { timings: {} };
      const spy = mockNativeFailureForFile(alphaFile);
      const index = await buildProjectIndexIncremental(root, {
        cache: "disk",
        files: [alphaFile, betaFile],
        report,
      });

      expect(simplifyModule(index.byFile.get(alphaNormalized)!)).toEqual(jsOnlyAlpha);
      expect(report.backend?.native.byLanguage.ts?.filesSeen).toBe(2);
      expect(report.backend?.native.byLanguage.ts?.filesUsed).toBe(1);
      expect(report.backend?.native.byLanguage.ts?.filesFellBack).toBe(1);
      expect(report.backend?.native.byLanguage.ts?.fallbackReasons.queryFailure).toBe(1);
      expect(spy).toHaveBeenCalled();
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
