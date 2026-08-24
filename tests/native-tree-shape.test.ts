import { describe, expect, it } from "vitest";

import { isColumnarSyntaxTree } from "../src/native/treeShape.js";
import { createStubNativeSyntaxTree } from "./helpers/native.js";

describe("isColumnarSyntaxTree", () => {
  it("accepts a well-formed columnar tree", () => {
    expect(isColumnarSyntaxTree(createStubNativeSyntaxTree())).toBe(true);
  });

  it("rejects the legacy pre-columnar shape", () => {
    expect(isColumnarSyntaxTree({ rootId: 0, nodes: [] })).toBe(false);
  });

  it("rejects a DataView masquerading as a typed-array column", () => {
    const tree = createStubNativeSyntaxTree();
    const buffer = new ArrayBuffer(4);
    expect(isColumnarSyntaxTree({ ...tree, kindIds: new DataView(buffer) })).toBe(false);
  });

  it("rejects a tree missing nodeCount", () => {
    const tree = createStubNativeSyntaxTree();
    const { nodeCount: _nodeCount, ...withoutNodeCount } = tree;
    expect(isColumnarSyntaxTree(withoutNodeCount)).toBe(false);
  });

  it("rejects non-object and null values", () => {
    expect(isColumnarSyntaxTree(null)).toBe(false);
    expect(isColumnarSyntaxTree(undefined)).toBe(false);
    expect(isColumnarSyntaxTree("tree")).toBe(false);
  });
});
