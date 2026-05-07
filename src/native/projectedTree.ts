import type { NativePoint, NativeSyntaxNode, NativeSyntaxTree } from "./treeSitterNative.js";

export type ProjectedPosition = {
  row: number;
  column: number;
};

export class ProjectedSyntaxTree {
  readonly source: string;
  private readonly nodesById: Map<number, ProjectedSyntaxNode>;
  private readonly byteToStringIndex: number[];
  private readonly lineStartBytes: number[];
  readonly rootNode: ProjectedSyntaxNode;

  constructor(source: string, tree: NativeSyntaxTree) {
    this.source = source;
    const sourceByteMap = buildSourceByteMap(source);
    this.byteToStringIndex = sourceByteMap.byteToStringIndex;
    this.lineStartBytes = sourceByteMap.lineStartBytes;
    this.nodesById = new Map();
    for (const node of tree.nodes) {
      this.nodesById.set(node.id, new ProjectedSyntaxNode(this, node));
    }
    const rootNode = this.nodeById(tree.rootId);
    if (!rootNode) {
      throw new Error("Projected syntax tree is missing the root node");
    }
    this.rootNode = rootNode;
  }

  nodeById(id: number): ProjectedSyntaxNode | undefined {
    return this.nodesById.get(id);
  }

  stringIndexForByte(byteIndex: number): number {
    const bounded = Math.max(0, Math.min(byteIndex, this.byteToStringIndex.length - 1));
    return this.byteToStringIndex[bounded] ?? this.source.length;
  }

  positionForPoint(point: NativePoint): ProjectedPosition {
    const lineStartByte = this.lineStartBytes[point.row] ?? 0;
    const lineStartIndex = this.stringIndexForByte(lineStartByte);
    const pointIndex = this.stringIndexForByte(lineStartByte + point.column);
    return {
      row: point.row,
      column: Math.max(0, pointIndex - lineStartIndex),
    };
  }
}

export class ProjectedSyntaxNode {
  private readonly tree: ProjectedSyntaxTree;
  private readonly raw: NativeSyntaxNode;

  constructor(tree: ProjectedSyntaxTree, raw: NativeSyntaxNode) {
    this.tree = tree;
    this.raw = raw;
  }

  get id(): number {
    return this.raw.id;
  }

  get type(): string {
    return this.raw.nodeType;
  }

  get startIndex(): number {
    return this.tree.stringIndexForByte(this.raw.start.index);
  }

  get endIndex(): number {
    return this.tree.stringIndexForByte(this.raw.end.index);
  }

  get startPosition(): ProjectedPosition {
    return this.tree.positionForPoint(this.raw.start);
  }

  get endPosition(): ProjectedPosition {
    return this.tree.positionForPoint(this.raw.end);
  }

  get text(): string {
    return this.tree.source.slice(this.startIndex, this.endIndex);
  }

  get parent(): ProjectedSyntaxNode | null {
    if (this.raw.parentId < 0) return null;
    return this.tree.nodeById(this.raw.parentId) ?? null;
  }

  get namedChildren(): ProjectedSyntaxNode[] {
    return this.raw.namedChildIds.flatMap((id) => {
      const child = this.tree.nodeById(id);
      return child ? [child] : [];
    });
  }

  get previousNamedSibling(): ProjectedSyntaxNode | null {
    const parent = this.parent;
    if (!parent) return null;
    const siblings = parent.namedChildren;
    const currentIndex = siblings.findIndex((node) => node.id === this.id);
    if (currentIndex <= 0) return null;
    return siblings[currentIndex - 1] ?? null;
  }

  get previousSibling(): ProjectedSyntaxNode | null {
    const parent = this.parent;
    if (!parent) return null;
    const siblings = parent.raw.childIds.flatMap((id) => {
      const sibling = this.tree.nodeById(id);
      return sibling ? [sibling] : [];
    });
    const currentIndex = siblings.findIndex((node) => node.id === this.id);
    if (currentIndex <= 0) return null;
    return siblings[currentIndex - 1] ?? null;
  }

  child(index: number): ProjectedSyntaxNode | null {
    const childId = this.raw.childIds[index];
    if (childId === undefined) return null;
    return this.tree.nodeById(childId) ?? null;
  }

  childForFieldName(fieldName: string): ProjectedSyntaxNode | null {
    const childIndex = this.raw.childFieldNames.findIndex((name) => name === fieldName);
    if (childIndex < 0) return null;
    return this.child(childIndex);
  }

  descendantForIndex(startIndex: number, endIndex: number): ProjectedSyntaxNode {
    for (const child of this.namedChildren) {
      if (child.startIndex <= startIndex && child.endIndex >= endIndex) {
        return child.descendantForIndex(startIndex, endIndex);
      }
    }
    return this;
  }

  descendantForPosition(start: ProjectedPosition, end: ProjectedPosition): ProjectedSyntaxNode {
    for (const child of this.namedChildren) {
      if (comparePosition(child.startPosition, start) <= 0 && comparePosition(child.endPosition, end) >= 0) {
        return child.descendantForPosition(start, end);
      }
    }
    return this;
  }
}

function comparePosition(left: ProjectedPosition, right: ProjectedPosition): number {
  if (left.row !== right.row) {
    return left.row - right.row;
  }
  return left.column - right.column;
}

type SourceByteMap = {
  byteToStringIndex: number[];
  lineStartBytes: number[];
};

function buildSourceByteMap(source: string): SourceByteMap {
  const byteToStringIndex: number[] = [0];
  const lineStartBytes: number[] = [0];
  let byteOffset = 0;
  let stringIndex = 0;

  while (stringIndex < source.length) {
    const codePoint = source.codePointAt(stringIndex);
    if (codePoint === undefined) break;

    const char = String.fromCodePoint(codePoint);
    const charStringLength = char.length;
    const charByteLength = Buffer.byteLength(char, "utf8");

    for (let offset = 1; offset < charByteLength; offset += 1) {
      byteToStringIndex[byteOffset + offset] = stringIndex;
    }

    byteOffset += charByteLength;
    stringIndex += charStringLength;
    byteToStringIndex[byteOffset] = stringIndex;

    if (char === "\n") {
      lineStartBytes.push(byteOffset);
    }
  }

  byteToStringIndex[byteOffset] = source.length;
  return { byteToStringIndex, lineStartBytes };
}
