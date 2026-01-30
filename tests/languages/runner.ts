import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";
import { chunkFile } from "../../src/chunking/chunkFile.js";
import { getLanguageConfig } from "../../src/bootstrap/treeSitterLanguages.js";
import type {
  DependencyGraphExpectation,
  LanguageTestDefinition,
} from "./types.js";
import {
  createTestIndexFromFiles,
  createTestIndexFromPath,
  findSymbolsByName,
} from "../test-utils.js";
import { collectGraph, findReferences, goToDefinition } from "../../src/index.js";
import type { ProjectIndex } from "../../src/index.js";
import type { Edge, Graph } from "../../src/types.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const tokenize = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0);

export function runLanguageTests(def: LanguageTestDefinition) {
  describe(`Language: ${def.id}`, () => {
    for (const sample of def.samples ?? []) {
      it(sample.name, async () => {
        const config = await getLanguageConfig(def.id);
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

        sample.expectedChunks(chunks);
      });
    }

    if (def.parity) {
      const samplePath = path.resolve(
        process.cwd(),
        "tests",
        "samples",
        def.parity.sampleDir,
      );
      let index: ProjectIndex;
      let graph: Graph;

      const normalizePath = (p: string) => p.replace(/\\/g, "/");
      const resolveSamplePath = (p: string) =>
        normalizePath(path.join(samplePath, p));

      const collectParityFiles = () => {
        const files = new Set<string>();
        const addFile = (filePath: string) => {
          files.add(resolveSamplePath(filePath));
        };
        for (const expectation of def.parity?.dependencyGraph ?? []) {
          addFile(expectation.from);
          if (expectation.to.type === "file") {
            addFile(expectation.to.path);
          }
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
        for (const expectation of def.parity?.references ?? []) {
          addFile(expectation.file);
        }
        return Array.from(files);
      };

      beforeAll(async () => {
        const parityFiles = collectParityFiles();
        index =
          parityFiles.length > 0
            ? await createTestIndexFromFiles(samplePath, parityFiles)
            : await createTestIndexFromPath(samplePath);
        graph =
          parityFiles.length > 0
            ? await collectGraph(samplePath, parityFiles)
            : index.graph;
      });

      const matchEdge = (edge: Edge, expectation: DependencyGraphExpectation) => {
        const expectedFrom = resolveSamplePath(expectation.from);
        if (edge.from !== expectedFrom) return false;
        if (expectation.to.type === "external") {
          return (
            edge.to.type === "external" &&
            edge.to.name === expectation.to.name
          );
        }
        return edge.to.type === "file" && edge.to.path === resolveSamplePath(expectation.to.path);
      };

      if (def.parity.dependencyGraph) {
        it("builds the dependency graph", () => {
          for (const expectation of def.parity.dependencyGraph ?? []) {
            const found = graph.edges.some((edge) =>
              matchEdge(edge, expectation),
            );
            expect(found).toBe(true);
          }
        });
      }

      if (def.parity.symbols) {
        it("extracts symbols", () => {
          for (const expectation of def.parity.symbols ?? []) {
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
              expect(result.definition.file).toBe(
                resolveSamplePath(expectation.expectedDefinition.file),
              );
              expect(result.definition.range.start.line).toBe(
                expectation.expectedDefinition.line,
              );
            }
          });
        }
      }

      if (def.parity.references) {
        for (const expectation of def.parity.references ?? []) {
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
              expect(result.references.length).toBeGreaterThanOrEqual(
                expectation.minimumCount ?? 1,
              );
            }
          });
        }
      }
    }
  });
}
