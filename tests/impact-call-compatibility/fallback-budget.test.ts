import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildProjectIndex } from "../../src/indexer.js";
import { findReferences, goToDefinition } from "../../src/indexer/navigation.js";
import { attachCallCompatibilityHints } from "../../src/impact/callCompatibility.js";
import type { ChangedSymbol } from "../../src/impact/types.js";
import type { Range } from "../../src/types.js";

vi.mock(
  "../../src/indexer/navigation.js",
  async (importOriginal: () => Promise<typeof import("../../src/indexer/navigation.js")>) => {
    const actual = await importOriginal();
    return {
      ...actual,
      findReferences: vi.fn(),
      goToDefinition: vi.fn(),
    };
  },
);

function rangeFor(source: string, needle: string): Range {
  const index = source.lastIndexOf(needle);
  if (index < 0) {
    throw new Error(`Expected source to contain ${needle}`);
  }
  const prefix = source.slice(0, index);
  const lines = prefix.split("\n");
  const line = lines.length;
  const column = (lines[lines.length - 1]?.length ?? 0) + 1;
  return {
    start: { line, column, index },
    end: { line, column: column + needle.length, index: index + needle.length },
  };
}

describe("call compatibility fallback budget", () => {
  async function buildChangedHelperFixture(): Promise<{
    root: string;
    index: Awaited<ReturnType<typeof buildProjectIndex>>;
    changedSymbol: ChangedSymbol;
    indexedMainFile: string;
    mainSource: string;
  }> {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-call-compat-fixture-"));
    await fsp.mkdir(path.join(root, "src"), { recursive: true });
    const apiFile = path.join(root, "src", "api.ts");
    const mainFile = path.join(root, "src", "main.ts");
    const apiSource = "export function helper(a: string, b: number) { return a + b; }\n";
    const mainSource = 'import { helper } from "./api";\nexport const value = helper("x");\n';
    await fsp.writeFile(apiFile, apiSource, "utf8");
    await fsp.writeFile(mainFile, mainSource, "utf8");

    const index = await buildProjectIndex(root, { cache: "memory" });
    const indexedApiFile = [...index.byFile.keys()].find((file) => file.endsWith("/src/api.ts"));
    const indexedMainFile = [...index.byFile.keys()].find((file) => file.endsWith("/src/main.ts"));
    if (!indexedApiFile || !indexedMainFile) {
      throw new Error("Expected indexed fixture files");
    }
    const helperDef = index.byFile.get(indexedApiFile)?.locals.find((local) => local.localName === "helper");
    if (!helperDef) {
      throw new Error("Expected helper definition");
    }

    return {
      root,
      index,
      changedSymbol: {
        id: `${indexedApiFile}#helper`,
        file: indexedApiFile,
        name: "helper",
        kind: helperDef.kind,
        exported: true,
        range: helperDef.range,
        signatureChanged: true,
      },
      indexedMainFile,
      mainSource,
    };
  }

  it("does not run verified callsite scanning after resolved refs produce a callsite", async () => {
    const fixture = await buildChangedHelperFixture();
    try {
      vi.mocked(findReferences).mockResolvedValue({
        status: "ok",
        references: [{ file: fixture.indexedMainFile, range: rangeFor(fixture.mainSource, "helper") }],
      });

      await attachCallCompatibilityHints(fixture.index, [fixture.changedSymbol], {
        maxRefs: 1000,
        projectRoot: fixture.root,
      });

      expect(fixture.changedSymbol.callCompatibility).toContainEqual(
        expect.objectContaining({
          status: "likely_mismatch",
          reason: "argument_count_below_minimum",
          callsiteFile: "src/main.ts",
        }),
      );
      expect(goToDefinition).not.toHaveBeenCalled();
    } finally {
      vi.mocked(findReferences).mockReset();
      vi.mocked(goToDefinition).mockReset();
      await fsp.rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("clears stale hints when changed symbols are reused with stricter limits or filters", async () => {
    const fixture = await buildChangedHelperFixture();
    try {
      vi.mocked(findReferences).mockResolvedValue({
        status: "ok",
        references: [{ file: fixture.indexedMainFile, range: rangeFor(fixture.mainSource, "helper") }],
      });

      await attachCallCompatibilityHints(fixture.index, [fixture.changedSymbol], {
        maxRefs: 1000,
        projectRoot: fixture.root,
      });
      expect(fixture.changedSymbol.callCompatibility).toHaveLength(1);

      await attachCallCompatibilityHints(fixture.index, [fixture.changedSymbol], {
        maxRefs: 0,
        projectRoot: fixture.root,
      });
      expect(fixture.changedSymbol.callCompatibility).toBeUndefined();

      await attachCallCompatibilityHints(fixture.index, [fixture.changedSymbol], {
        maxRefs: 1000,
        projectRoot: fixture.root,
      });
      expect(fixture.changedSymbol.callCompatibility).toHaveLength(1);

      await attachCallCompatibilityHints(fixture.index, [fixture.changedSymbol], {
        maxRefs: 1000,
        projectRoot: fixture.root,
        shouldIncludeReference: () => false,
      });
      expect(fixture.changedSymbol.callCompatibility).toBeUndefined();
    } finally {
      vi.mocked(findReferences).mockReset();
      vi.mocked(goToDefinition).mockReset();
      await fsp.rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
