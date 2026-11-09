import type { NativePoint, NativeSyntaxTree } from "./tree-sitter-native.js";
import {
  buildByteToStringIndexMap,
  stringIndexForByte,
  stringPositionForBytePoint,
  type ByteToStringIndexMap,
} from "./byte-index.js";

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

  constructor(source: string, tree: NativeSyntaxTree, byteIndexMap?: ByteToStringIndexMap) {
    this.source = source;
    this.byteIndexMap = byteIndexMap ?? buildByteToStringIndexMap(source);
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

  /**
   * Return the smallest named descendant holding a UTF-16 range. As in Tree-sitter's
   * `named_descendant_for_byte_range`, an earlier nonempty child ending at the range start
   * does not own that boundary. Walk anonymous children too: they can contain named nodes.
   */
  descendantForIndex(startIndex: number, endIndex: number): ProjectedSyntaxNode {
    const columns = this.tree.columns;
    let currentId = this.id;
    let namedId = currentId;
    for (;;) {
      let nextId = -1;
      const end = columns.childOffsets[currentId + 1]!;
      for (let slot = columns.childOffsets[currentId]!; slot < end; slot += 1) {
        const childId = columns.childIds[slot]!;
        const childEnd = this.tree.stringIndexForByte(columns.endIndex[childId]!);
        if (childEnd < endIndex) continue;
        const childStart = this.tree.stringIndexForByte(columns.startIndex[childId]!);
        if (endsBeforeRangeStart(childEnd - startIndex, childStart === childEnd)) continue;
        if (startIndex < childStart) break;
        nextId = childId;
        if (columns.named[childId]) namedId = childId;
        break;
      }
      if (nextId < 0) return this.tree.nodeById(namedId)!;
      currentId = nextId;
    }
  }

  /** `descendantForIndex` for a range given as row and column positions (UTF-16 columns). */
  descendantForPosition(start: ProjectedPosition, end: ProjectedPosition): ProjectedSyntaxNode {
    const columns = this.tree.columns;
    let currentId = this.id;
    let namedId = currentId;
    for (;;) {
      let nextId = -1;
      const childEnd = columns.childOffsets[currentId + 1]!;
      for (let slot = columns.childOffsets[currentId]!; slot < childEnd; slot += 1) {
        const childId = columns.childIds[slot]!;
        const endPosition = this.tree.positionForPoint({
          row: columns.endRow[childId]!,
          column: columns.endColumn[childId]!,
          index: columns.endIndex[childId]!,
        });
        if (comparePosition(endPosition, end) < 0) continue;
        const startPosition = this.tree.positionForPoint({
          row: columns.startRow[childId]!,
          column: columns.startColumn[childId]!,
          index: columns.startIndex[childId]!,
        });
        if (
          endsBeforeRangeStart(comparePosition(endPosition, start), comparePosition(startPosition, endPosition) === 0)
        ) {
          continue;
        }
        if (comparePosition(start, startPosition) < 0) break;
        nextId = childId;
        if (columns.named[childId]) namedId = childId;
        break;
      }
      if (nextId < 0) return this.tree.nodeById(namedId)!;
      currentId = nextId;
    }
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

  /** Find the previous sibling in the parent's child list without materializing the siblings. */
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

/**
 * Whether a child that reaches a lookup range's end still lies before the range, given how its end compares with the
 * range's start. A child that only ends where the range starts does, so the node that starts there holds the offset.
 * An empty child has no extent to extend past the offset it sits at, so it holds that offset.
 */
function endsBeforeRangeStart(endVersusRangeStart: number, childIsEmpty: boolean): boolean {
  return childIsEmpty ? endVersusRangeStart < 0 : endVersusRangeStart <= 0;
}
