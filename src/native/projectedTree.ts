import type {
  NativePoint,
  NativeSyntaxNode,
  NativeSyntaxTree,
} from "./treeSitterNative.js";

export type ProjectedPosition = {
  row: number;
  column: number;
};

export class ProjectedSyntaxTree {
  readonly source: string;
  private readonly nodesById: Map<number, ProjectedSyntaxNode>;
  readonly rootNode: ProjectedSyntaxNode;

  constructor(source: string, tree: NativeSyntaxTree) {
    this.source = source;
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
    return this.raw.start.index;
  }

  get endIndex(): number {
    return this.raw.end.index;
  }

  get startPosition(): ProjectedPosition {
    return toProjectedPosition(this.raw.start);
  }

  get endPosition(): ProjectedPosition {
    return toProjectedPosition(this.raw.end);
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

  child(index: number): ProjectedSyntaxNode | null {
    const childId = this.raw.childIds[index];
    if (childId === undefined) return null;
    return this.tree.nodeById(childId) ?? null;
  }

  childForFieldName(fieldName: string): ProjectedSyntaxNode | null {
    const childIndex = this.raw.childFieldNames.findIndex(
      (name) => name === fieldName,
    );
    if (childIndex < 0) return null;
    return this.child(childIndex);
  }

  descendantForIndex(
    startIndex: number,
    endIndex: number,
  ): ProjectedSyntaxNode {
    for (const child of this.namedChildren) {
      if (
        child.startIndex <= startIndex &&
        child.endIndex >= endIndex
      ) {
        return child.descendantForIndex(startIndex, endIndex);
      }
    }
    return this;
  }

  descendantForPosition(
    start: ProjectedPosition,
    end: ProjectedPosition,
  ): ProjectedSyntaxNode {
    for (const child of this.namedChildren) {
      if (
        comparePosition(child.startPosition, start) <= 0 &&
        comparePosition(child.endPosition, end) >= 0
      ) {
        return child.descendantForPosition(start, end);
      }
    }
    return this;
  }
}

function toProjectedPosition(point: NativePoint): ProjectedPosition {
  return {
    row: point.row,
    column: point.column,
  };
}

function comparePosition(left: ProjectedPosition, right: ProjectedPosition): number {
  if (left.row !== right.row) {
    return left.row - right.row;
  }
  return left.column - right.column;
}
