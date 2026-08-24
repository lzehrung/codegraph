import { describe, it, expect } from "vitest";
import {
  findCommonPrefix,
  buildFileTree,
  sortTree,
  autoExpandSingleChildren,
  buildEdgeIndexes,
} from "../../docs/graph-visualization/file-tree-model.js";
import compactPayload from "./fixtures/compact-payload.json" with { type: "json" };

/** The viewer module is plain JS, so name the shape its tree nodes actually have. */
type TreeNode = { name: string; type: string; children: TreeNode[] };
import legacyPayload from "./fixtures/legacy-payload.json" with { type: "json" };

describe("findCommonPrefix", () => {
  it("finds common directory prefix", () => {
    expect(findCommonPrefix(["src/a.ts", "src/b.ts", "src/c.ts"])).toBe("src/");
  });

  it("handles deeper common prefix", () => {
    expect(findCommonPrefix(["a/b/c/x.ts", "a/b/c/y.ts"])).toBe("a/b/c/");
  });

  it("returns empty string for no common prefix", () => {
    expect(findCommonPrefix(["foo/a.ts", "bar/b.ts"])).toBe("");
  });

  it("returns empty string for empty array", () => {
    expect(findCommonPrefix([])).toBe("");
  });

  it("handles single path", () => {
    expect(findCommonPrefix(["src/foo.ts"])).toBe("src/");
  });

  it("handles paths with no directory", () => {
    expect(findCommonPrefix(["foo.ts", "bar.ts"])).toBe("");
  });

  it("normalises backslashes", () => {
    expect(findCommonPrefix(["src\\a.ts", "src\\b.ts"])).toBe("src/");
  });

  it("stops at last shared slash, not partial directory names", () => {
    // "src-utils/a.ts" and "src-lib/b.ts" share "src-" but no full directory
    expect(findCommonPrefix(["src-utils/a.ts", "src-lib/b.ts"])).toBe("");
  });
});

describe("buildFileTree -- compact format", () => {
  it("returns root and itemsByKey", () => {
    const result = buildFileTree(compactPayload);
    expect(result.root).toBeDefined();
    expect(result.itemsByKey).toBeInstanceOf(Map);
  });

  it("creates file nodes with correct graphKeys", () => {
    const { itemsByKey } = buildFileTree(compactPayload);
    expect(itemsByKey.has("f:0")).toBe(true);
    expect(itemsByKey.has("f:4")).toBe(true);
    expect(itemsByKey.get("f:0")!.name).toBe("index.ts");
  });

  it("creates symbol nodes with correct graphKeys", () => {
    const { itemsByKey } = buildFileTree(compactPayload);
    expect(itemsByKey.has("s:0")).toBe(true);
    expect(itemsByKey.get("s:0")!.name).toBe("main");
    expect(itemsByKey.get("s:0")!.kind).toBe("function");
  });

  it("attaches symbols to their parent file", () => {
    const { itemsByKey } = buildFileTree(compactPayload);
    const sym = itemsByKey.get("s:0")!;
    expect(sym.parent).toBeDefined();
    expect(sym.parent!.type).toBe("file");
    expect(sym.parent!.graphKey).toBe("f:0");
  });

  it("creates directory structure from paths", () => {
    const { root } = buildFileTree(compactPayload);
    // All paths share "src/" prefix, which is stripped.
    // Remaining structure: index.ts, utils/, components/
    const names = root.children.map((c: { name: string }) => c.name);
    expect(names).toContain("utils");
    expect(names).toContain("components");
    expect(names).toContain("index.ts");
  });

  it("sorts directories before files", () => {
    const { root } = buildFileTree(compactPayload);
    const types = root.children.map((c: { type: string }) => c.type);
    const firstFile = types.indexOf("file");
    const lastDir = types.lastIndexOf("directory");
    if (lastDir >= 0 && firstFile >= 0) {
      expect(lastDir).toBeLessThan(firstFile);
    }
  });

  it("nests files under correct directories", () => {
    const { root }: { root: TreeNode } = buildFileTree(compactPayload);
    const utils = root.children.find((c) => c.name === "utils");
    expect(utils).toBeDefined();
    const fileNames = utils!.children.map((c) => c.name);
    expect(fileNames).toContain("helper.ts");
    expect(fileNames).toContain("format.ts");
  });

  it("populates symbols on file nodes", () => {
    const { itemsByKey } = buildFileTree(compactPayload);
    const indexFile = itemsByKey.get("f:0")!;
    expect(indexFile.symbols.length).toBe(2);
    expect(indexFile.symbols[0].name).toBe("main");
    expect(indexFile.symbols[1].name).toBe("App");
  });

  it("handles payload with no symbols gracefully", () => {
    const payload = { files: ["a.ts", "b.ts"], fileEdges: [] };
    const { root, itemsByKey } = buildFileTree(payload);
    expect(root.children.length).toBe(2);
    expect(itemsByKey.get("f:0")!.symbols.length).toBe(0);
  });
});

describe("buildFileTree -- legacy format", () => {
  it("builds tree from nodes array", () => {
    const { root, itemsByKey } = buildFileTree(legacyPayload);
    expect(root.children.length).toBeGreaterThan(0);
    // Legacy uses full paths as graphKeys
    expect(itemsByKey.has("src/a.ts")).toBe(true);
    expect(itemsByKey.has("src/b.ts")).toBe(true);
  });

  it("has no symbols in legacy format", () => {
    const { itemsByKey } = buildFileTree(legacyPayload);
    for (const item of itemsByKey.values()) {
      if (item.type === "file") {
        expect(item.symbols.length).toBe(0);
      }
    }
  });
});

describe("sortTree", () => {
  it("sorts directories before files", () => {
    const node = {
      type: "directory" as const,
      children: [
        { type: "file" as const, name: "z.ts", children: undefined },
        { type: "directory" as const, name: "b", children: [] },
        { type: "file" as const, name: "a.ts", children: undefined },
        { type: "directory" as const, name: "a", children: [] },
      ],
    };
    sortTree(node);
    expect(node.children.map((c) => c.name)).toEqual(["a", "b", "a.ts", "z.ts"]);
  });

  it("sorts recursively", () => {
    const node = {
      type: "directory" as const,
      children: [
        {
          type: "directory" as const,
          name: "sub",
          children: [
            { type: "file" as const, name: "z.ts", children: undefined },
            { type: "file" as const, name: "a.ts", children: undefined },
          ],
        },
      ],
    };
    sortTree(node);
    expect(node.children[0].children!.map((c) => c.name)).toEqual(["a.ts", "z.ts"]);
  });
});

describe("autoExpandSingleChildren", () => {
  it("expands a directory with a single directory child", () => {
    const node = {
      type: "directory" as const,
      expanded: false,
      children: [{ type: "directory" as const, expanded: false, children: [{ type: "file" as const, name: "a.ts" }] }],
    };
    autoExpandSingleChildren(node);
    expect(node.expanded).toBe(true);
    // inner directory has a file child, not a single dir child -- should stay collapsed
    expect(node.children[0].expanded).toBe(false);
  });

  it("does not expand when there are multiple children", () => {
    const node = {
      type: "directory" as const,
      expanded: false,
      children: [
        { type: "directory" as const, expanded: false, children: [] },
        { type: "file" as const, name: "a.ts" },
      ],
    };
    autoExpandSingleChildren(node);
    expect(node.expanded).toBe(false);
  });

  it("expands chain of single-child directories", () => {
    const inner = { type: "directory" as const, expanded: false, children: [{ type: "file" as const, name: "a.ts" }] };
    const mid = { type: "directory" as const, expanded: false, children: [inner] };
    const outer = { type: "directory" as const, expanded: false, children: [mid] };
    autoExpandSingleChildren(outer);
    expect(outer.expanded).toBe(true);
    expect(mid.expanded).toBe(true);
    // inner has 1 child but it is a file, not a directory
    expect(inner.expanded).toBe(false);
  });

  it("does nothing for file nodes", () => {
    const node = { type: "file" as const, expanded: false };
    Reflect.apply(autoExpandSingleChildren, undefined, [node]);
    expect(node.expanded).toBe(false);
  });
});

describe("buildEdgeIndexes", () => {
  it("indexes file edges by from", () => {
    const indexes = buildEdgeIndexes(compactPayload);
    const from0 = indexes.fileEdgesByFrom.get(0) || [];
    expect(from0.length).toBe(3); // index.ts has 3 outgoing edges
  });

  it("indexes file edges by to", () => {
    const indexes = buildEdgeIndexes(compactPayload);
    // helper.ts (index 1) is imported by index.ts and button.ts
    const to1 = indexes.fileEdgesByTo.get(1) || [];
    expect(to1.length).toBe(2);
  });

  it("indexes symbol edges by from", () => {
    const indexes = buildEdgeIndexes(compactPayload);
    const from0 = indexes.symbolEdgesByFrom.get(0) || [];
    expect(from0.length).toBe(2); // main calls capitalize and formatDate
  });

  it("indexes symbol edges by to", () => {
    const indexes = buildEdgeIndexes(compactPayload);
    const to2 = indexes.symbolEdgesByTo.get(2) || [];
    expect(to2.length).toBe(1); // capitalize is called by main
  });

  it("returns empty maps for empty payload", () => {
    const indexes = buildEdgeIndexes({});
    expect(indexes.fileEdgesByFrom.size).toBe(0);
    expect(indexes.symbolEdgesByTo.size).toBe(0);
  });

  it("skips malformed edges", () => {
    const indexes = buildEdgeIndexes({
      fileEdges: [null, { from: "bad" }, undefined],
      symbolEdges: [null, { from: "bad", to: "also bad" }],
    });
    expect(indexes.fileEdgesByFrom.size).toBe(0);
    expect(indexes.symbolEdgesByFrom.size).toBe(0);
  });
});
