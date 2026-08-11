import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";
import { chunkFile } from "../../src/chunking/chunkFile.js";
import { LANG_CONFIGS } from "../../src/bootstrap/treeSitterLanguages.js";
import type {
  ChunkExpectation,
  DependencyGraphExpectation,
  ExactReferencesExpectation,
  ExactSymbolExpectation,
  LanguageTestDefinition,
  ReferencesExpectation,
  SymbolExpectation,
} from "./types.js";
import { createTestIndexFromFiles, createTestIndexFromPath, findSymbolsByName } from "../test-utils.js";
import { collectGraph, findReferences, goToDefinition, listSymbols } from "../../src/index.js";
import type { ProjectIndex } from "../../src/index.js";
import type { Edge, Graph } from "../../src/types.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const tokenize = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0);

function symbolKey(symbol: { name: string; kind?: string }): string {
  return symbol.kind ? `${symbol.name}\0${symbol.kind}` : `${symbol.name}\0`;
}

function sortedKeys(keys: string[]): string[] {
  return [...keys].sort((left, right) => left.localeCompare(right));
}

function assertExactChunks(chunks: ReturnType<typeof chunkFile>, expected: ChunkExpectation[]) {
  expect(chunks).toHaveLength(expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    const actual = chunks[index]!;
    const want = expected[index]!;
    expect(actual.type, `chunk[${index}].type`).toBe(want.type);
    if (want.name !== undefined) {
      expect(actual.name, `chunk[${index}].name`).toBe(want.name);
    } else {
      expect(actual.name, `chunk[${index}].name`).toBeUndefined();
    }
    if (want.startLine !== undefined) {
      expect(actual.startLine, `chunk[${index}].startLine`).toBe(want.startLine);
    }
    if (want.endLine !== undefined) {
      expect(actual.endLine, `chunk[${index}].endLine`).toBe(want.endLine);
    }
    if (want.text !== undefined) {
      expect(actual.text, `chunk[${index}].text`).toBe(want.text);
    }
    if (want.tokenCount !== undefined) {
      expect(actual.tokenCount, `chunk[${index}].tokenCount`).toBe(want.tokenCount);
    }
  }
}

export function runLanguageTests(def: LanguageTestDefinition) {
  describe(`Language: ${def.id}`, () => {
    for (const sample of def.samples ?? []) {
      it(sample.name, () => {
        const config = LANG_CONFIGS[def.id];
        if (!config) {
          throw new Error(`Language config not found for ${def.id}`);
        }

        let source = sample.source;
        let filePath = `test.${def.id}`;

        if (sample.sourceFile) {
          const fullPath = path.join(dirname, "samples", sample.sourceFile);
          source = fs.readFileSync(fullPath, "utf8");
          filePath = sample.sourceFile;
        }

        if (source === undefined) {
          throw new Error(`No source provided for sample ${sample.name}`);
        }

        const chunks = chunkFile({
          language: config,
          source: source.trimStart(),
          filePath,
          minTokens: sample.options?.minTokens ?? 1,
          maxTokens: sample.options?.maxTokens ?? 1000,
          tokenizer: tokenize,
        });

        if (sample.exactChunks) {
          assertExactChunks(chunks, sample.exactChunks);
        } else {
          sample.expectedChunks(chunks);
        }
      });
    }

    if (def.parity) {
      const samplePath = path.resolve(process.cwd(), "tests", "samples", def.parity.sampleDir);
      let index: ProjectIndex;
      let graph: Graph;

      const normalizePath = (p: string) => p.replace(/\\/g, "/");
      const resolveSamplePath = (p: string) => normalizePath(path.join(samplePath, p));
      const edgeIdentity = (edge: Edge): string => {
        const kind = edge.typeOnly ? "type-only" : "runtime";
        if (edge.to.type === "external") {
          return `${edge.from}|external|${edge.to.name}|${kind}`;
        }
        return `${edge.from}|file|${edge.to.path}|${kind}`;
      };


      const expectationIdentity = (expectation: DependencyGraphExpectation): string => {
        const from = resolveSamplePath(expectation.from);
        const kind = expectation.typeOnly ? "type-only" : "runtime";
        if (expectation.to.type === "external") {
          return `${from}|external|${expectation.to.name}|${kind}`;
        }
        return `${from}|file|${resolveSamplePath(expectation.to.path)}|${kind}`;
      };

      const matchEdge = (edge: Edge, expectation: DependencyGraphExpectation) => {
        return edgeIdentity(edge) === expectationIdentity(expectation);
      };

      const collectParityFiles = () => {
        const files = new Set<string>();
        const addFile = (filePath: string) => {
          files.add(resolveSamplePath(filePath));
        };
        for (const expectation of def.parity?.exact?.dependencyGraph ?? def.parity?.dependencyGraph ?? []) {
          addFile(expectation.from);
          if (expectation.to.type === "file") {
            addFile(expectation.to.path);
          }
        }
        for (const expectation of def.parity?.absentDependencyGraph ?? []) {
          addFile(expectation.from);
          if (expectation.to.type === "file") {
            const targetFile = resolveSamplePath(expectation.to.path);
            if (fs.existsSync(targetFile)) {
              files.add(targetFile);
            }
          }
        }
        for (const expectation of def.parity?.exact?.symbols ?? []) {
          addFile(expectation.file);
        }
        for (const expectation of def.parity?.symbols ?? []) {
          addFile(expectation.file);
        }
        for (const expectation of def.parity?.goToDefinition ?? []) {
          addFile(expectation.file);
          if (expectation.expectedDefinition) {
            addFile(expectation.expectedDefinition.file);
          }
        }
        for (const expectation of def.parity?.exact?.references ?? def.parity?.references ?? []) {
          addFile(expectation.file);
        }
        return Array.from(files);
      };

      beforeAll(async () => {
        const parityFiles = collectParityFiles();
        index = parityFiles.length
          ? await createTestIndexFromFiles(samplePath, parityFiles)
          : await createTestIndexFromPath(samplePath);
        graph = parityFiles.length ? await collectGraph(samplePath, parityFiles) : index.graph;
      });

      const assertExactDependencyGraph = (expectations: DependencyGraphExpectation[]) => {
        it("builds the exact dependency graph", () => {
          expect(sortedKeys(graph.edges.map(edgeIdentity))).toEqual(
            sortedKeys(expectations.map(expectationIdentity)),
          );
        });
      };

      const assertSubsetDependencyGraph = (expectations: DependencyGraphExpectation[]) => {
        it("builds the dependency graph", () => {
          for (const expectation of expectations) {
            const found = graph.edges.some((edge) => matchEdge(edge, expectation));
            expect(found).toBe(true);
          }
        });
      };

      if (def.parity.exact?.dependencyGraph) {
        assertExactDependencyGraph(def.parity.exact.dependencyGraph);
      } else if (def.parity.dependencyGraph) {
        assertSubsetDependencyGraph(def.parity.dependencyGraph);
      }

      if (def.parity.absentDependencyGraph) {
        it("does not build unsupported dependency graph edges", () => {
          for (const expectation of def.parity?.absentDependencyGraph ?? []) {
            const found = graph.edges.some((edge) => matchEdge(edge, expectation));
            expect(found).toBe(false);
          }
        });
      }

      const assertExactSymbols = (expectations: ExactSymbolExpectation[]) => {
        it("extracts the exact symbol set", () => {
          for (const expectation of expectations) {
            const filePath = resolveSamplePath(expectation.file);
            const actual = listSymbols(index, { file: filePath }).map((symbol) =>
              symbol.kind ? { name: symbol.name, kind: symbol.kind } : { name: symbol.name },
            );
            const expected = expectation.symbols.map((symbol) =>
              symbol.kind ? { name: symbol.name, kind: symbol.kind } : { name: symbol.name },
            );
            expect(sortedKeys(actual.map(symbolKey))).toEqual(sortedKeys(expected.map(symbolKey)));
          }
        });
      };

      const assertSubsetSymbols = (expectations: SymbolExpectation[]) => {
        it("extracts symbols", () => {
          for (const expectation of expectations) {
            const filePath = resolveSamplePath(expectation.file);
            for (const symbol of expectation.includes) {
              const matches = findSymbolsByName(index, symbol.name, filePath);
              expect(matches.length).toBeGreaterThan(0);
              if (symbol.kind) {
                const hasKind = matches.some((match) => match.kind === symbol.kind);
                expect(hasKind).toBe(true);
              }
            }
            for (const name of expectation.excludes ?? []) {
              const matches = findSymbolsByName(index, name, filePath);
              expect(matches.length).toBe(0);
            }
          }
        });
      };

      if (def.parity.exact?.symbols) {
        assertExactSymbols(def.parity.exact.symbols);
      } else if (def.parity.symbols) {
        assertSubsetSymbols(def.parity.symbols);
      }

      if (def.parity.goToDefinition) {
        for (const expectation of def.parity.goToDefinition ?? []) {
          it(expectation.name, async () => {
            const filePath = resolveSamplePath(expectation.file);
            const result = await goToDefinition(index, {
              file: filePath,
              line: expectation.line,
              column: expectation.column,
            });
            const status = expectation.expectedStatus ?? "ok";
            if (status === "not_found") {
              expect(result.status).toBe("not_found");
              return;
            }
            expect(result.status).toBe("ok");
            if (result.status === "ok" && expectation.expectedDefinition) {
              expect(result.definition.file).toBe(resolveSamplePath(expectation.expectedDefinition.file));
              expect(result.definition.range.start.line).toBe(expectation.expectedDefinition.line);
            }
          });
        }
      }

      const assertExactReferences = (expectations: ExactReferencesExpectation[]) => {
        for (const expectation of expectations) {
          it(expectation.name, async () => {
            const filePath = resolveSamplePath(expectation.file);
            const result = await findReferences(index, {
              file: filePath,
              line: expectation.line,
              column: expectation.column,
            });
            const status = expectation.expectedStatus ?? "ok";
            if (status === "not_found") {
              expect(result.status).toBe("not_found");
              return;
            }
            expect(result.status).toBe("ok");
            if (result.status === "ok") {
              expect(expectation.exactCount, "exact.references require exactCount when status is ok").toEqual(
                expect.any(Number),
              );
              expect(result.references.length).toBe(expectation.exactCount);
            }
          });
        }
      };

      const assertSubsetReferences = (expectations: ReferencesExpectation[]) => {
        for (const expectation of expectations) {
          it(expectation.name, async () => {
            const filePath = resolveSamplePath(expectation.file);
            const result = await findReferences(index, {
              file: filePath,
              line: expectation.line,
              column: expectation.column,
            });
            const status = expectation.expectedStatus ?? "ok";
            if (status === "not_found") {
              expect(result.status).toBe("not_found");
              return;
            }
            expect(result.status).toBe("ok");
            if (result.status === "ok") {
              expect(result.references.length).toBeGreaterThanOrEqual(expectation.minimumCount ?? 1);
            }
          });
        }
      };

      if (def.parity.exact?.references) {
        assertExactReferences(def.parity.exact.references);
      } else if (def.parity.references) {
        assertSubsetReferences(def.parity.references);
      }
    }
  });
}

