import fsp from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  buildProjectIndex,
  buildSymbolGraphDetailed,
  findReferences,
  goToDefinition,
  type SymbolGraph,
} from "../../src/index.js";
import * as nativeRuntime from "../../src/native/tree-sitter-native.js";
import { normalizePath } from "../../src/util/paths.js";
import { mkTmpDir } from "../helpers/filesystem.js";
import {
  CALLABLE_CONSUMER_ROWS,
  columnOf,
  writeFixtureFiles,
  type CallableConsumerCall,
  type CallableConsumerRow,
} from "./callable-consumer-fixtures.js";

/**
 * #378 capability-driven cross-language consumer matrix.
 *
 * The detailed symbol graph and the shared callable-arity facts are only produced by the native
 * runtime, so the whole matrix is skipped when it is unavailable instead of asserting success on
 * a parser the host cannot run.
 */
const nativeDescribe = nativeRuntime.isNativeTreeSitterAvailable() ? describe : describe.skip;

async function materializeRow(root: string, row: CallableConsumerRow): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const file of row.files) {
    files[file.path] = `${file.lines.join("\n")}\n`;
  }
  return await writeFixtureFiles(root, files);
}

function linesOf(row: CallableConsumerRow, file: string): string[] {
  const entry = row.files.find((candidate) => candidate.path === file);
  if (!entry) {
    throw new Error(`${row.languageId}: no fixture file ${file}`);
  }
  return entry.lines;
}

function callColumn(row: CallableConsumerRow, call: CallableConsumerCall): number {
  return columnOf(linesOf(row, call.file ?? row.ownerFile), call.line, call.token);
}

/** Resolved `calls` edge targets for one caller node, by graph node identity. */
function callTargets(graph: SymbolGraph, callerId: string): Array<{ name: string; file: string }> {
  const targets: Array<{ name: string; file: string }> = [];
  for (const edge of graph.edges) {
    if (edge.label !== "calls" || edge.from !== callerId) continue;
    const node = graph.nodes.get(edge.to);
    if (node) {
      targets.push({ name: node.name, file: normalizePath(node.file) });
    }
  }
  return targets;
}

nativeDescribe("callable consumer matrix", () => {
  for (const row of CALLABLE_CONSUMER_ROWS) {
    it(`${row.label ?? row.languageId} keeps accepted calls, arity mismatches, and out-of-unit decoys apart`, async () => {
      const root = await mkTmpDir(`cg-callable-consumer-${row.languageId}-`);
      try {
        const paths = await materializeRow(root, row);
        const ownerPath = paths[row.ownerFile];
        const decoyPath = paths[row.decoy.file];
        if (!ownerPath || !decoyPath) {
          throw new Error(`${row.languageId}: fixture files were not written`);
        }

        const index = await buildProjectIndex(root, { cache: "off" });
        const graph = await buildSymbolGraphDetailed(index);
        const nodes = [...graph.nodes.values()];

        const targetNodes = nodes.filter(
          (node) => node.name === row.target.name && normalizePath(node.file) === ownerPath,
        );
        expect(targetNodes, `${row.languageId}: expected one ${row.target.name} node in ${row.ownerFile}`).toHaveLength(
          1,
        );
        const acceptedNodes = nodes.filter(
          (node) => node.name === row.accepted.caller && normalizePath(node.file) === ownerPath,
        );
        expect(acceptedNodes, `${row.languageId}: expected a ${row.accepted.caller} node`).toHaveLength(1);

        // The accepted call must reach the owner target and never the same-named decoy.
        const acceptedTargets = callTargets(graph, acceptedNodes[0]!.id);
        expect(
          acceptedTargets.map((target) => `${target.file}::${target.name}`),
          `${row.languageId}: ${row.accepted.caller} must call ${row.target.name}`,
        ).toContain(`${ownerPath}::${row.target.name}`);
        expect(
          acceptedTargets.some((target) => target.file === decoyPath),
          `${row.languageId}: ${row.accepted.caller} must not call the out-of-unit decoy`,
        ).toBe(false);

        const goto = await goToDefinition(index, {
          file: ownerPath,
          line: row.accepted.line,
          column: callColumn(row, row.accepted),
        });
        expect(goto.status, `${row.languageId}: accepted call must resolve`).toBe("ok");
        if (goto.status !== "ok") {
          throw new Error(`${row.languageId}: accepted call did not resolve`);
        }
        expect(normalizePath(goto.definition.file)).toBe(ownerPath);
        expect(goto.definition.range.start.line).toBe(row.target.line);

        const references = await findReferences(index, {
          file: ownerPath,
          line: row.target.line,
          column: columnOf(linesOf(row, row.ownerFile), row.target.line, row.target.name),
        });
        expect(references.status, `${row.languageId}: target references must resolve`).toBe("ok");
        if (references.status !== "ok") {
          throw new Error(`${row.languageId}: target references did not resolve`);
        }
        expect(
          references.references.map((reference) => `${normalizePath(reference.file)}:${reference.range.start.line}`),
          `${row.languageId}: accepted call site must be a reference`,
        ).toContain(`${ownerPath}:${row.accepted.line}`);
        expect(
          references.references.some((reference) => normalizePath(reference.file) === decoyPath),
          `${row.languageId}: owner references must exclude the out-of-unit decoy`,
        ).toBe(false);

        const decoyReferences = await findReferences(index, {
          file: decoyPath,
          line: row.decoy.line,
          column: columnOf(linesOf(row, row.decoy.file), row.decoy.line, row.decoy.token),
        });
        expect(decoyReferences.status, `${row.languageId}: decoy references must resolve`).toBe("ok");
        if (decoyReferences.status !== "ok") {
          throw new Error(`${row.languageId}: decoy references did not resolve`);
        }
        expect(
          decoyReferences.references.some((reference) => normalizePath(reference.file) === ownerPath),
          `${row.languageId}: decoy references must exclude the owner unit`,
        ).toBe(false);

        const arityRejected = row.arityRejected;
        if (arityRejected) {
          const rejectedNodes = nodes.filter(
            (node) => node.name === arityRejected.caller && normalizePath(node.file) === ownerPath,
          );
          expect(rejectedNodes, `${row.languageId}: expected a ${arityRejected.caller} node`).toHaveLength(1);
          const rejectedTargets = callTargets(graph, rejectedNodes[0]!.id);
          expect(
            rejectedTargets.map((target) => `${target.file}::${target.name}`),
            `${row.languageId}: an arity-incompatible call must not produce a calls edge`,
          ).not.toContain(`${ownerPath}::${arityRejected.targetName}`);
          expect(
            rejectedTargets.some((target) => target.file === decoyPath),
            `${row.languageId}: an arity-incompatible call must not fall through to the decoy`,
          ).toBe(false);
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });
  }

  it("keeps Python instance, static, and class receiver forms on their own members", async () => {
    // #378: Python receiver binding must follow the call form, not the parameter spelling.
    // A `self`-bound instance call, a class-qualified static call, and a `cls`-bound classmethod
    // call each reach their own member, while a call on an unknown receiver reaches none.
    const lines = [
      "class Box:",
      "    def target(self, value):",
      "        return value",
      "",
      "    @staticmethod",
      "    def static_target(value):",
      "        return value",
      "",
      "    @classmethod",
      "    def class_target(cls, value):",
      "        return value",
      "",
      "    def bound_instance(self):",
      "        return self.target(1)",
      "",
      "    def bound_static(self):",
      "        return Box.static_target(1)",
      "",
      "    @classmethod",
      "    def bound_class(cls):",
      "        return cls.class_target(1)",
      "",
      "    def unbound_unknown(self, other):",
      "        return other.target(1)",
    ];
    const root = await mkTmpDir("cg-callable-consumer-python-forms-");
    try {
      const paths = await writeFixtureFiles(root, { "box.py": `${lines.join("\n")}\n` });
      const filePath = paths["box.py"]!;
      const index = await buildProjectIndex(root, { cache: "off" });
      const graph = await buildSymbolGraphDetailed(index);
      const nodes = [...graph.nodes.values()];

      for (const [caller, expectedTarget] of [
        ["bound_instance", "target"],
        ["bound_static", "static_target"],
        ["bound_class", "class_target"],
      ] as const) {
        const callerNode = nodes.find((node) => node.name === caller && normalizePath(node.file) === filePath);
        expect(callerNode, `${caller} must be indexed`).toBeDefined();
        expect(
          callTargets(graph, callerNode!.id).map((target) => target.name),
          `${caller} must reach ${expectedTarget}`,
        ).toContain(expectedTarget);
      }

      const unknownNode = nodes.find(
        (node) => node.name === "unbound_unknown" && normalizePath(node.file) === filePath,
      );
      expect(unknownNode, "unbound_unknown must be indexed").toBeDefined();
      expect(callTargets(graph, unknownNode!.id)).toEqual([]);

      const goto = await goToDefinition(index, {
        file: filePath,
        line: 14,
        column: columnOf(lines, 14, "target"),
      });
      expect(goto.status).toBe("ok");
      if (goto.status !== "ok") throw new Error("Expected the instance method declaration");
      expect(goto.definition.range.start.line).toBe(2);

      const references = await findReferences(index, {
        file: filePath,
        line: 2,
        column: columnOf(lines, 2, "target"),
      });
      expect(references.status).toBe("ok");
      if (references.status !== "ok") throw new Error("Expected instance method references");
      expect(references.references.map((reference) => reference.range.start.line)).toContain(14);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
