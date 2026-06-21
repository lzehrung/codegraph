import { describe, expect, it } from "vitest";
import { collectDeletedTrackedFileDependents, collectTrackedFileDependents } from "../src/indexer/incremental-plan.js";
import type { ManifestFileEntry } from "../src/indexer/build-cache.js";
import type { Edge } from "../src/types.js";

function fileEdge(from: string, to: string): Edge {
  return { from, to: { type: "file", path: to }, raw: `./${to}` };
}

function entry(edges: Edge[]): ManifestFileEntry {
  return { sig: "sig", edges };
}

describe("incremental-plan dependents", () => {
  it("collects transitive dependents of changed files", () => {
    const trackedEntries: Record<string, ManifestFileEntry> = {
      "/proj/a.ts": entry([fileEdge("/proj/a.ts", "/proj/b.ts")]),
      "/proj/b.ts": entry([fileEdge("/proj/b.ts", "/proj/c.ts")]),
      "/proj/c.ts": entry([]),
    };

    const changed = new Set(["/proj/c.ts"]);
    expect(collectTrackedFileDependents(trackedEntries, changed)).toEqual(new Set(["/proj/b.ts", "/proj/a.ts"]));
  });

  it("still collects dependents of deleted tracked files", () => {
    const trackedEntries: Record<string, ManifestFileEntry> = {
      "/proj/a.ts": entry([fileEdge("/proj/a.ts", "/proj/b.ts")]),
      "/proj/b.ts": entry([]),
    };
    const deleted = new Set(["/proj/b.ts"]);
    expect(collectDeletedTrackedFileDependents(trackedEntries, deleted)).toEqual(new Set(["/proj/a.ts"]));
  });
});
