import { expect } from "vitest";

import type { EdgeTo } from "../../src/types.js";
import type { ExportEntry, ProjectIndex } from "../../src/indexer/types.js";

/**
 * Assert an edge target is the `file` variant and narrow it.
 *
 * Tests routinely assert `to.type === "file"` and then read `to.path`, which TypeScript
 * cannot connect across statements. This keeps the assertion (so a wrong variant still
 * fails the test) and returns the narrowed value.
 */
export function expectFileEdgeTo(to: EdgeTo | undefined): { type: "file"; path: string } {
  expect(to?.type).toBe("file");
  if (to?.type !== "file") {
    throw new Error(`expected a file edge target, received ${to?.type ?? "undefined"}`);
  }
  return to;
}

/**
 * The exported name of an entry, or undefined for `exportStar`, which has no exported
 * name of its own. Lets a lookup filter on the name without asserting a variant that
 * may legitimately be absent.
 */
export function exportedNameOf(entry: ExportEntry): string | undefined {
  return entry.type === "exportStar" ? undefined : entry.exportedAs;
}

/**
 * A `ProjectIndex` with the required collections present, so a test can supply only the
 * parts it exercises. Tests that pass a bare `{ graph, byFile }` literal are relying on
 * the analyzer never touching the rest; this makes that explicit instead of unsound.
 */
export function makeTestProjectIndex(partial: Partial<ProjectIndex> = {}): ProjectIndex {
  return {
    graph: { nodes: new Set(), edges: [] },
    modules: new Map(),
    byFile: new Map(),
    exportCache: new Map(),
    scopeCache: new Map(),
    ...partial,
  };
}
