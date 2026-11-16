import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildScopeIndexFromSource } from "../src/indexer/scope.js";
import { closestContainingScope } from "../src/indexer/scope-nodes.js";
import type { Scope, ScopeIndex } from "../src/indexer/scope-types.js";
import { supportForFileWithoutHeaderSample } from "../src/languages.js";
import type { SyntaxNodeLike } from "../src/languages/types.js";
import { ProjectedSyntaxTree } from "../src/native/projected-tree.js";
import { getNativeSyntaxTreeExecution } from "../src/native/tree-sitter-native.js";

/** The scan every scope was tried by before the nesting lookup: the reference the lookup must reproduce. */
function referenceClosestContainingScope(scopeIndex: ScopeIndex, node: SyntaxNodeLike): Scope | undefined {
  let best: Scope | undefined;
  for (const scope of scopeIndex.allScopes) {
    if (
      node.startIndex >= scope.node.startIndex &&
      node.endIndex <= scope.node.endIndex &&
      (!best || (scope.node.startIndex >= best.node.startIndex && scope.node.endIndex <= best.node.endIndex))
    )
      best = scope;
  }
  return best;
}

/** A node that is only a range, so the geometry of scopes can be set up directly. */
function rangeNode(startIndex: number, endIndex: number): SyntaxNodeLike {
  const position = { row: 0, column: 0 };
  return {
    type: "range",
    text: "",
    startIndex,
    endIndex,
    startPosition: position,
    endPosition: position,
    parent: null,
    namedChildren: [],
    child: () => null,
    childForFieldName: () => null,
  };
}

/**
 * A scope index whose scopes cover the given ranges, in creation order. The first question about an index is answered
 * by a scan and the nesting is built on the second, so one question is asked here and every later one takes the nesting.
 */
function scopeIndexOf(ranges: ReadonlyArray<readonly [number, number]>): ScopeIndex {
  const allScopes: Scope[] = ranges.map(([start, end]) => ({
    kind: "block",
    map: new Map(),
    node: rangeNode(start, end),
    parent: undefined,
  }));
  const scopeIndex: ScopeIndex = { bindings: new Map(), all: [], allScopes, cppQualifiedFunctionBindings: new Map() };
  closestContainingScope(scopeIndex, rangeNode(0, 1));
  return scopeIndex;
}

function sourceFilesUnder(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFilesUnder(entryPath));
    else if (entry.isFile() && fs.statSync(entryPath).size < 200_000) files.push(entryPath);
  }
  return files.sort();
}

function namedNodesOf(root: SyntaxNodeLike): SyntaxNodeLike[] {
  const nodes: SyntaxNodeLike[] = [];
  const pending: SyntaxNodeLike[] = [root];
  for (let node = pending.pop(); node; node = pending.pop()) {
    nodes.push(node);
    pending.push(...node.namedChildren);
  }
  return nodes;
}

/**
 * The nodes to ask about in one file: every scope's own node and its first and last named child, where a range that
 * ties or touches a scope's edge is decided, and an even spread of all the other nodes.
 */
function queriesFor(scopeIndex: ScopeIndex, nodes: readonly SyntaxNodeLike[]): Set<SyntaxNodeLike> {
  const queries = new Set<SyntaxNodeLike>();
  for (const scope of scopeIndex.allScopes) {
    queries.add(scope.node);
    const children = scope.node.namedChildren;
    if (children.length) queries.add(children[0]!).add(children[children.length - 1]!);
  }
  const step = Math.max(1, Math.floor(nodes.length / 300));
  for (let index = 0; index < nodes.length; index += step) queries.add(nodes[index]!);
  return queries;
}

describe("closest containing scope", () => {
  it("returns the scope the scan of every scope returns at the scope edges and across every sample and edge-corpus file", () => {
    const roots = ["samples", "edge-corpus"].map((name) => path.join(process.cwd(), "tests", name));
    const languages = new Set<string>();
    let queried = 0;
    for (const file of roots.flatMap(sourceFilesUnder)) {
      const support = supportForFileWithoutHeaderSample(file);
      if (!support) continue;
      const source = fs.readFileSync(file, "utf8");
      const execution = getNativeSyntaxTreeExecution(source, support);
      if (!execution.tree) continue;
      const tree = new ProjectedSyntaxTree(source, execution.tree);
      const scopeIndex = buildScopeIndexFromSource(file, source, support, [], { tree });
      for (const node of queriesFor(scopeIndex, namedNodesOf(tree.rootNode))) {
        const expected = referenceClosestContainingScope(scopeIndex, node);
        expect(closestContainingScope(scopeIndex, node), `${path.relative(process.cwd(), file)} ${node.type}`).toBe(
          expected,
        );
        queried += 1;
      }
      languages.add(support.id);
    }
    // Every grammar with a scope model took part, so a language whose scopes nest differently would show here.
    expect([...languages]).toEqual(expect.arrayContaining(["ts", "tsx", "js", "python", "cpp", "csharp", "go", "php"]));
    expect(queried).toBeGreaterThan(10_000);
  });

  it("picks the scope created last among scopes with one range, and the deepest around a node", () => {
    // Created in this order: outer, then two scopes over [10, 50], then one inside them.
    const scopeIndex = scopeIndexOf([
      [0, 100],
      [10, 50],
      [10, 50],
      [20, 30],
    ]);
    const scopes = scopeIndex.allScopes;
    expect(closestContainingScope(scopeIndex, rangeNode(22, 25))).toBe(scopes[3]);
    expect(closestContainingScope(scopeIndex, rangeNode(35, 40))).toBe(scopes[2]);
    expect(closestContainingScope(scopeIndex, rangeNode(60, 70))).toBe(scopes[0]);
    expect(closestContainingScope(scopeIndex, rangeNode(200, 210))).toBeUndefined();
  });

  it("does not depend on creation order matching source order", () => {
    // A default value is walked as its function scope opens, before earlier text in the same declaration.
    const scopeIndex = scopeIndexOf([
      [0, 200],
      [120, 180],
      [10, 90],
      [130, 150],
      [20, 40],
    ]);
    for (const [start, end] of [
      [25, 30],
      [60, 70],
      [95, 110],
      [125, 128],
      [135, 140],
      [160, 170],
      [185, 190],
    ] as const) {
      const node = rangeNode(start, end);
      expect(closestContainingScope(scopeIndex, node), `${start}..${end}`).toBe(
        referenceClosestContainingScope(scopeIndex, node),
      );
    }
  });

  it("keeps the scan's answer for an empty range on the shared edge of two scopes", () => {
    const scopeIndex = scopeIndexOf([
      [0, 20],
      [20, 40],
    ]);
    const edge = rangeNode(20, 20);
    expect(closestContainingScope(scopeIndex, edge)).toBe(referenceClosestContainingScope(scopeIndex, edge));
    expect(closestContainingScope(scopeIndex, edge)).toBe(scopeIndex.allScopes[0]);
  });

  it("keeps the scan's answer when scopes overlap without nesting", () => {
    const scopeIndex = scopeIndexOf([
      [0, 60],
      [40, 100],
      [45, 55],
    ]);
    for (const [start, end] of [
      [10, 20],
      [42, 44],
      [47, 52],
      [70, 90],
    ] as const) {
      const node = rangeNode(start, end);
      expect(closestContainingScope(scopeIndex, node), `${start}..${end}`).toBe(
        referenceClosestContainingScope(scopeIndex, node),
      );
    }
  });
});
