import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeImpact } from "../src/impact/analyzer.js";
import { SymbolKind } from "../src/indexer.js";
import type * as NavigationModule from "../src/indexer/navigation.js";
import type { FindReferencesResult, ProjectIndex, SymbolDef } from "../src/indexer/types.js";
import type { ChangedSymbol } from "../src/impact/types.js";

const mockedNavigation = vi.hoisted(() => ({
  findReferences: vi.fn(),
  activeLookups: 0,
  maximumActiveLookups: 0,
  delaysBySymbol: new Map<string, number>(),
  referencesBySymbol: new Map<string, { file: string; confidence?: "medium" }>(),
}));

vi.mock("../src/indexer/navigation.js", async (importOriginal) => {
  const original = await importOriginal<typeof NavigationModule>();
  return { ...original, findReferences: mockedNavigation.findReferences };
});

type ReferenceFixture = {
  symbol: string;
  file: string;
  delayMs: number;
  confidence?: "medium";
};

type FindReferencesRequest = { def: SymbolDef } | { file: string; line: number; column: number };
type FindReferencesOptions = {
  context?: "line" | "block";
  lines?: number;
  blockMaxLines?: number;
  maxReferences?: number;
};

function createIndex(): ProjectIndex {
  return { files: [], byFile: new Map(), graph: { nodes: [], edges: [] } };
}

function createChangedSymbols(names: readonly string[], exportedSymbols: ReadonlySet<string>): ChangedSymbol[] {
  return names.map((name, index) => ({
    id: `src/api.ts::${name}::${index}`,
    file: "src/api.ts",
    name,
    kind: SymbolKind.Function,
    exported: exportedSymbols.has(name),
    range: {
      start: { line: index + 1, column: 1, index: index * 10 },
      end: { line: index + 1, column: 10, index: index * 10 + 9 },
    },
  }));
}

function configureReferenceLookups(fixtures: readonly ReferenceFixture[]): void {
  mockedNavigation.activeLookups = 0;
  mockedNavigation.maximumActiveLookups = 0;
  mockedNavigation.delaysBySymbol.clear();
  mockedNavigation.referencesBySymbol.clear();
  for (const fixture of fixtures) {
    mockedNavigation.delaysBySymbol.set(fixture.symbol, fixture.delayMs);
    mockedNavigation.referencesBySymbol.set(fixture.symbol, {
      file: fixture.file,
      ...(fixture.confidence !== undefined ? { confidence: fixture.confidence } : {}),
    });
  }

  mockedNavigation.findReferences.mockImplementation(
    async (
      _index: ProjectIndex,
      request: FindReferencesRequest,
      _options?: FindReferencesOptions,
    ): Promise<FindReferencesResult> => {
      if (!("def" in request)) {
        throw new Error("Impact ranking regression only supports definition lookups");
      }
      const fixture = mockedNavigation.referencesBySymbol.get(request.def.localName);
      if (!fixture) {
        throw new Error(`No reference fixture for ${request.def.localName}`);
      }

      mockedNavigation.activeLookups += 1;
      mockedNavigation.maximumActiveLookups = Math.max(
        mockedNavigation.maximumActiveLookups,
        mockedNavigation.activeLookups,
      );
      try {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, mockedNavigation.delaysBySymbol.get(request.def.localName) ?? 0);
        });
        const provenance =
          fixture.confidence === undefined
            ? undefined
            : { resolution: "member-access" as const, confidence: fixture.confidence };
        return {
          status: "ok",
          definition: request.def,
          references: [
            {
              file: fixture.file,
              range: {
                start: { line: 1, column: 1 },
                end: { line: 1, column: 10 },
              },
              ...(provenance !== undefined ? { provenance } : {}),
            },
          ],
        };
      } finally {
        mockedNavigation.activeLookups -= 1;
      }
    },
  );
}

async function analyzeSymbols(names: readonly string[], exportedSymbols = new Set(names)) {
  const analysis = analyzeImpact(createIndex(), createChangedSymbols(names, exportedSymbols), [], {
    membersOnly: true,
  });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await vi.runAllTimersAsync();
  return await analysis;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("impact ranking", () => {
  it("uses a stable total order after eight concurrent direct-reference lookups", async () => {
    const symbols = Array.from({ length: 9 }, (_, index) => `changed${index}`);
    const expectedFiles = symbols.map((_, index) => `src/consumer-${String(index).padStart(2, "0")}.ts`);
    const firstFixtures = symbols.map((symbol, index) => ({
      symbol,
      file: expectedFiles[index]!,
      delayMs: index === 8 ? 90 : (8 - index) * 10,
    }));
    configureReferenceLookups(firstFixtures);
    const first = await analyzeSymbols(symbols);
    const firstMaximumActiveLookups = mockedNavigation.maximumActiveLookups;

    const secondFixtures = symbols.map((symbol, index) => ({
      symbol,
      file: expectedFiles[index]!,
      delayMs: (index + 1) * 10,
    }));
    configureReferenceLookups(secondFixtures);
    const second = await analyzeSymbols(symbols);
    const secondMaximumActiveLookups = mockedNavigation.maximumActiveLookups;

    expect(firstMaximumActiveLookups).toBe(8);
    expect(secondMaximumActiveLookups).toBe(8);
    expect(first.map((item) => item.file)).toEqual(expectedFiles);
    expect(JSON.stringify(first.map((item) => item.file))).toBe(JSON.stringify(second.map((item) => item.file)));
    expect(second.map((item) => item.file)).toEqual(expectedFiles);
  });

  it("ranks exact references ahead of otherwise equal medium-confidence references", async () => {
    configureReferenceLookups([
      { symbol: "medium", file: "src/medium-consumer.ts", delayMs: 1, confidence: "medium" },
      { symbol: "exact", file: "src/exact-consumer.ts", delayMs: 20 },
    ]);

    const impacted = await analyzeSymbols(["medium", "exact"]);

    expect(impacted.map((item) => item.file)).toEqual(["src/exact-consumer.ts", "src/medium-consumer.ts"]);
    expect(impacted[0]?.severity).toBeGreaterThan(impacted[1]?.severity ?? 0);
    expect(impacted[0]?.confidence).toBeGreaterThan(impacted[1]?.confidence ?? 0);
  });

  it("keeps severity and confidence paired with the strongest shared-file reference", async () => {
    configureReferenceLookups([
      { symbol: "exact", file: "src/shared-consumer.ts", delayMs: 1 },
      { symbol: "medium", file: "src/shared-consumer.ts", delayMs: 20, confidence: "medium" },
    ]);

    const [impact] = await analyzeSymbols(["exact", "medium"], new Set(["medium"]));

    expect(impact?.confidence).toBeCloseTo(0.85, 5);
    expect(impact?.explain?.resolutionConfidence).toBe("medium");
  });
});
