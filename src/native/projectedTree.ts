import type { NativePoint, NativeSyntaxTree } from "./treeSitterNative.js";
import {
  buildByteToStringIndexMap,
  stringIndexForByte,
  stringPositionForBytePoint,
  type ByteToStringIndexMap,
} from "./byteIndex.js";

export type ProjectedPosition = {
  row: number;
  column: number;
};

/**
 * Reads the native columnar projection (see `NativeSyntaxTree`) through the ordinary
 * `SyntaxNodeLike` node API.
 *
 * Nodes are materialized lazily and memoized by id, so a walk that touches a handful
 * of nodes allocates a handful of wrappers rather than one per node in the file, and
 * repeated lookups of the same id return the same instance.
 */
export class ProjectedSyntaxTree {
  readonly source: string;
  /** Shared byte-offset -> UTF-16 string-index map; reuse this instead of rebuilding one. */
  readonly byteIndexMap: ByteToStringIndexMap;
  readonly rootNode: ProjectedSyntaxNode;
  /** @internal Column storage; read through `ProjectedSyntaxNode`. */
  readonly columns: NativeSyntaxTree;

  private readonly nodes: Array<ProjectedSyntaxNode | undefined>;
  private fieldNameIds: Map<string, number> | undefined;

  constructor(source: string, tree: NativeSyntaxTree) {
    this.source = source;
    this.byteIndexMap = buildByteToStringIndexMap(source);
    this.columns = tree;
    this.nodes = new Array<ProjectedSyntaxNode | undefined>(tree.nodeCount);
    const rootNode = this.nodeById(tree.rootId);
    if (!rootNode) {
      throw new Error("Projected syntax tree is missing the root node");
    }
    this.rootNode = rootNode;
  }

  nodeById(id: number): ProjectedSyntaxNode | undefined {
    if (id < 0 || id >= this.columns.nodeCount) return undefined;
    const existing = this.nodes[id];
    if (existing) return existing;
    const created = new ProjectedSyntaxNode(this, id);
    this.nodes[id] = created;
    return created;
  }

  stringIndexForByte(byteIndex: number): number {
    return stringIndexForByte(this.byteIndexMap, byteIndex);
  }

  positionForPoint(point: NativePoint): ProjectedPosition {
    return stringPositionForBytePoint(this.byteIndexMap, point);
  }

  /** @internal Resolve an interned field name, or `undefined` when the grammar never emits it. */
  fieldNameId(fieldName: string): number | undefined {
    if (!this.fieldNameIds) {
      this.fieldNameIds = new Map(this.columns.fieldNames.map((name, index) => [name, index]));
    }
    return this.fieldNameIds.get(fieldName);
  }
}

export class ProjectedSyntaxNode {
  private readonly tree: ProjectedSyntaxTree;
  readonly id: number;

  constructor(tree: ProjectedSyntaxTree, id: number) {
    this.tree = tree;
    this.id = id;
  }

  get type(): string {
    const columns = this.tree.columns;
    return columns.kinds[columns.kindIds[this.id]!]!;
  }

  get startIndex(): number {
    return this.tree.stringIndexForByte(this.tree.columns.startIndex[this.id]!);
  }

  get endIndex(): number {
    return this.tree.stringIndexForByte(this.tree.columns.endIndex[this.id]!);
  }

  get startPosition(): ProjectedPosition {
    const columns = this.tree.columns;
    return this.tree.positionForPoint({
      row: columns.startRow[this.id]!,
      column: columns.startColumn[this.id]!,
      index: columns.startIndex[this.id]!,
    });
  }

  get endPosition(): ProjectedPosition {
    const columns = this.tree.columns;
    return this.tree.positionForPoint({
      row: columns.endRow[this.id]!,
      column: columns.endColumn[this.id]!,
      index: columns.endIndex[this.id]!,
    });
  }

  get text(): string {
    return this.tree.source.slice(this.startIndex, this.endIndex);
  }

  get parent(): ProjectedSyntaxNode | null {
    const parentId = this.tree.columns.parentIds[this.id]!;
    if (parentId < 0) return null;
    return this.tree.nodeById(parentId) ?? null;
  }

  get namedChildren(): ProjectedSyntaxNode[] {
    const columns = this.tree.columns;
    return this.collect(columns.namedChildIds, columns.namedChildOffsets);
  }

  get previousNamedSibling(): ProjectedSyntaxNode | null {
    const columns = this.tree.columns;
    return this.previousIn(columns.namedChildIds, columns.namedChildOffsets);
  }

  get previousSibling(): ProjectedSyntaxNode | null {
    const columns = this.tree.columns;
    return this.previousIn(columns.childIds, columns.childOffsets);
  }

  child(index: number): ProjectedSyntaxNode | null {
    const columns = this.tree.columns;
    const start = columns.childOffsets[this.id]!;
    const end = columns.childOffsets[this.id + 1]!;
    if (index < 0 || index >= end - start) return null;
    return this.tree.nodeById(columns.childIds[start + index]!) ?? null;
  }

  childForFieldName(fieldName: string): ProjectedSyntaxNode | null {
    const fieldNameId = this.tree.fieldNameId(fieldName);
    if (fieldNameId === undefined) return null;
    const columns = this.tree.columns;
    const start = columns.childOffsets[this.id]!;
    const end = columns.childOffsets[this.id + 1]!;
    for (let slot = start; slot < end; slot += 1) {
      if (columns.childFieldNameIds[slot] === fieldNameId) {
        return this.tree.nodeById(columns.childIds[slot]!) ?? null;
      }
    }
    return null;
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

  private collect(ids: Uint32Array, offsets: Uint32Array): ProjectedSyntaxNode[] {
    const start = offsets[this.id]!;
    const end = offsets[this.id + 1]!;
    const out: ProjectedSyntaxNode[] = [];
    for (let slot = start; slot < end; slot += 1) {
      const node = this.tree.nodeById(ids[slot]!);
      if (node) out.push(node);
    }
    return out;
  }

  /** Walk the parent's list backwards from this node without materializing the siblings. */
  private previousIn(ids: Uint32Array, offsets: Uint32Array): ProjectedSyntaxNode | null {
    const parentId = this.tree.columns.parentIds[this.id]!;
    if (parentId < 0) return null;
    const start = offsets[parentId]!;
    const end = offsets[parentId + 1]!;
    for (let slot = start; slot < end; slot += 1) {
      if (ids[slot] !== this.id) continue;
      if (slot === start) return null;
      return this.tree.nodeById(ids[slot - 1]!) ?? null;
    }
    return null;
  }
}

function comparePosition(left: ProjectedPosition, right: ProjectedPosition): number {
  if (left.row !== right.row) {
    return left.row - right.row;
  }
  return left.column - right.column;
}
