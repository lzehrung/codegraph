import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, brotliDecompress, constants as zlibConstants } from "node:zlib";
import type {
  SymbolEdge,
  SymbolGraph,
  SymbolNode,
  SymbolNodeKind,
  SymbolVisibility,
} from "../../graphs/symbol-graph.js";
import type { Pos, Range } from "../../types.js";
import { logWithLevel } from "../../logging.js";
import { isPlainRecord } from "../../util/guards.js";
import { assertFilePathWithinRoot, fileIdentityKey, isFilePathWithinRoot, normalizePath } from "../../util/paths.js";
import type { BuildOptions, BuildReport, ProjectIndex } from "../types.js";
import { cacheRoot } from "./location.js";
import { cacheAbsolutePath, cacheRelativePath } from "./module-cache.js";
import { getImplementationFingerprint } from "./options.js";
import { isMissingArtifactError, recordSnapshotInvalidation, writeSnapshotAtomically } from "./project-snapshot.js";
import { recordCacheCorruption } from "./reports.js";

// v5: nodes carry Kotlin and Swift memberArity plus the proven-callable marker.
// v6: Swift ownership/arity fixes change persisted detailed-graph edges and memberArity.
// v7: callable-binding proof corrections change persisted callable flags and call edges.
// v8: receiver edge reconciliation, Kotlin ancestry, and static receiver scope change persisted graph edges.
// v9: exact C++ qualified ownership changes persisted member ownership and receiver call edges.
// v10: C/C++ void-parameter arity changes persisted memberArity and call edges.
// v11: canonical C/C++ declaration aliases preserve base-graph compatibility across cache loads.
// v12: shared callable ranges, cross-file ownership, and Zig visibility change detailed call edges.
// v13: same-file C# constructor edges respect namespace visibility instead of file-wide names.
// v14: C# alias-qualified targets and shared partial-type identity change persisted edges.
// v15: trivia-safe package peers can change cross-file detailed call edges.
// v16: Swift extension visibility and nested C# partial owner identity change persisted call edges.
// v17: qualified C# generic type uses can change persisted constructor/type edges.
// v18: constrained Swift extensions no longer donate members to unproven nominal owners.
// v19: Swift constraint-token equivalence can restore peer call edges across formatting.
// v20: C# verbatim namespace/type identifiers can merge shared-owner identities and call edges.
// v21: C# `file` types lose cross-file edges; extension receivers change persisted member arity.
// v22: C# verbatim namespace aliases (`@X` vs `X`) can add alias-qualified type and constructor edges.
// v23: C# `file partial` owners in different files no longer share member and call edges.
// v24: C# top-level types beside block namespaces become global-namespace peers with new edges.
// v25: identical C# aliases in separate namespace blocks each resolve their own scoped uses.
// v26: accuracy-audit fixes add Go cross-package, Ruby ancestry, TS static, Rust impl, PHP
// namespace, and same-unit peer edges, and drop invalid cross-file, unexported, and ambiguous ones.
// v27: C# type aliases in a multi-file namespace can add call edges, or drop a guessed one.
// A same-named type in another namespace is not the alias target.
// v28: JVM type-on-demand imports only bind direct nested classifiers.
// v29: binary column sidecar (`detailed-symbol-graph.bin`) replaces the JSON text one; the graph is unchanged.
export const DETAILED_SYMBOL_GRAPH_SNAPSHOT_VERSION = 29;
export const DETAILED_SYMBOL_GRAPH_SNAPSHOT_FILENAME = "detailed-symbol-graph.bin";
/** The text sidecar of versions 28 and older. Nothing reads it; the next successful write removes it. */
const LEGACY_JSON_SIDECAR_FILENAME = "detailed-symbol-graph.json";

/**
 * Persisted detailed symbol graph: `[magic][u32 header length][header JSON][brotli payload]`.
 *
 * The payload is one body of 8-byte aligned little-endian columns (typed arrays), not text, so it never needs a
 * string as long as the graph and loads as views. Strings live in two tables (files, then everything else) of
 * UTF-8 bytes plus offsets; a node refers to its file and name by table index and rebuilds its id from them
 * (`file::name::tail`, the form every indexed node has), and an edge refers to nodes by position. Every distinct
 * file is stored once as a project-relative path, so a load rebases and validates it once, not once per node and
 * edge. The header names the project identity and implementation the graph was derived for, and carries the
 * SHA-256 of the payload bytes, so a changed project, a different build, and a damaged file are told apart.
 */
const SNAPSHOT_MAGIC = "CGDG";
const PREFIX_BYTES = 8;
const SECTION_ALIGNMENT = 8;
const STRING_CHUNK_BYTES = 1 << 20;
const BROTLI_QUALITY = 4;
/** An absent optional value in a u32 column. No count, position, or offset the format stores reaches it. */
const ABSENT = 0xffffffff;

const brotliCompressAsync = promisify(brotliCompress);
const brotliDecompressAsync = promisify(brotliDecompress);
const LITTLE_ENDIAN_HOST = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

const NODE_KIND_CODES: Record<SymbolNodeKind, number> = {
  function: 0,
  class: 1,
  variable: 2,
  interface: 3,
  type: 4,
  default: 5,
  table: 6,
  view: 7,
  index: 8,
  constraint: 9,
  routine: 10,
  resource: 11,
  data: 12,
  module: 13,
  output: 14,
  import: 15,
  namespaceImport: 16,
};
const NODE_KINDS = (Object.keys(NODE_KIND_CODES) as SymbolNodeKind[]).sort(
  (left, right) => NODE_KIND_CODES[left] - NODE_KIND_CODES[right],
);
const VISIBILITY_CODES: Record<SymbolVisibility, number> = { public: 1, private: 2, protected: 3, internal: 4 };
const VISIBILITIES = (Object.keys(VISIBILITY_CODES) as SymbolVisibility[]).sort(
  (left, right) => VISIBILITY_CODES[left] - VISIBILITY_CODES[right],
);

/** The node properties in the order a node written in canonical form lists them; any other order is stored. */
const NODE_KEY_ORDER = [
  "id",
  "file",
  "name",
  "kind",
  "docstring",
  "lineSpan",
  "complexity",
  "visibility",
  "implementationTarget",
  "memberArity",
  "callable",
] as const;
const EDGE_KEY_ORDER = ["from", "to", "label", "site"] as const;
const SITE_KEY_ORDER = ["file", "range"] as const;
const RANGE_KEY_ORDER = ["start", "end"] as const;
const POSITION_KEY_ORDER = ["line", "column", "index"] as const;

/** How a node id relates to its file and name; the tail is what follows `file::name::`. */
const ID_NUMERIC_TAIL = 0;
const ID_TEXT_TAIL = 1;
const ID_REST_TEXT = 2;
const FLAG_CALLABLE = 1;
const FLAG_IMPLEMENTATION_TARGET_SHIFT = 1;
const SITE_HAS_START_INDEX = 1;
const SITE_HAS_END_INDEX = 2;

type SidecarCounts = {
  files: number;
  strings: number;
  nodes: number;
  edges: number;
  sites: number;
  aliases: number;
};

export type DetailedSidecarHeader = {
  version: number;
  /** Provenance only: the sidecar holds project-relative paths, so it loads under any root. */
  projectRoot: string;
  implementationFingerprint: string;
  projectSnapshotIdentity: string;
  counts: SidecarCounts;
  fileBlobBytes: number;
  stringBlobBytes: number;
  /** Table entries whose text is not well-formed UTF-16 (a lone surrogate); UTF-8 cannot hold them. */
  illFormedFiles: Array<[number, string]>;
  illFormedStrings: Array<[number, string]>;
  /** Property orders of nodes that do not list their properties in canonical order; a node refers by position + 1. */
  nodeKeyOrders: string[][];
  bodyBytes: number;
  payloadSha256: string;
};

type RecordCounts = Pick<SidecarCounts, "nodes" | "edges" | "sites" | "aliases">;

type RecordColumns = {
  nodeFile: Uint32Array;
  nodeName: Uint32Array;
  nodeIdTail: Uint32Array;
  nodeDocstring: Uint32Array;
  nodeLineSpan: Uint32Array;
  nodeMemberArity: Uint32Array;
  nodeComplexity: Float64Array;
  nodeKeyOrder: Uint16Array;
  nodeIdMode: Uint8Array;
  nodeKind: Uint8Array;
  nodeVisibility: Uint8Array;
  nodeFlags: Uint8Array;
  siteFile: Uint32Array;
  siteStartLine: Uint32Array;
  siteStartColumn: Uint32Array;
  siteStartIndex: Uint32Array;
  siteEndLine: Uint32Array;
  siteEndColumn: Uint32Array;
  siteEndIndex: Uint32Array;
  siteFlags: Uint8Array;
  edgeFrom: Uint32Array;
  edgeTo: Uint32Array;
  edgeLabel: Uint32Array;
  edgeSite: Uint32Array;
  aliasFile: Uint32Array;
  aliasRest: Uint32Array;
  aliasCanonical: Uint32Array;
};

type TableColumns = {
  fileOffsets: Uint32Array;
  fileBlob: Uint8Array;
  stringOffsets: Uint32Array;
  stringBlob: Uint8Array;
};

export type DetailedSidecarColumns = RecordColumns & TableColumns;

/** A graph the sidecar cannot hold exactly. Persisting it is skipped, so a load never sees an altered graph. */
class UnpersistableGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnpersistableGraphError";
  }
}

/** A sidecar a load does not accept; the message is the reason recorded for the cache artifact. */
class SidecarRejection extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SidecarRejection";
  }
}

type CursorMode = { kind: "fresh" } | { kind: "measure" } | { kind: "view"; body: Uint8Array };

/**
 * Walks the body layout. The same walk allocates the columns a writer fills (`fresh`), sizes the body
 * (`measure`), and views the columns of a loaded body (`view`), so the three cannot disagree on the order.
 */
class SectionCursor {
  offset = 0;

  constructor(private readonly mode: CursorMode) {}

  u8(length: number): Uint8Array {
    const start = this.advance(length, 1);
    if (this.mode.kind === "view")
      return new Uint8Array(this.mode.body.buffer, this.mode.body.byteOffset + start, length);
    return new Uint8Array(this.mode.kind === "fresh" ? length : 0);
  }

  u16(length: number): Uint16Array {
    const start = this.advance(length, 2);
    if (this.mode.kind === "view")
      return new Uint16Array(this.mode.body.buffer, this.mode.body.byteOffset + start, length);
    return new Uint16Array(this.mode.kind === "fresh" ? length : 0);
  }

  u32(length: number): Uint32Array {
    const start = this.advance(length, 4);
    if (this.mode.kind === "view")
      return new Uint32Array(this.mode.body.buffer, this.mode.body.byteOffset + start, length);
    return new Uint32Array(this.mode.kind === "fresh" ? length : 0);
  }

  f64(length: number): Float64Array {
    const start = this.advance(length, 8);
    if (this.mode.kind === "view")
      return new Float64Array(this.mode.body.buffer, this.mode.body.byteOffset + start, length);
    return new Float64Array(this.mode.kind === "fresh" ? length : 0);
  }

  private advance(length: number, elementBytes: number): number {
    const start = this.offset;
    const end = start + length * elementBytes;
    this.offset = end + ((SECTION_ALIGNMENT - (end % SECTION_ALIGNMENT)) % SECTION_ALIGNMENT);
    if (this.mode.kind === "view" && end > this.mode.body.byteLength) {
      throw new SidecarRejection("a column runs past the end of the sidecar body");
    }
    return start;
  }
}

function layoutRecordColumns(cursor: SectionCursor, counts: RecordCounts): RecordColumns {
  const { nodes, edges, sites, aliases } = counts;
  return {
    nodeFile: cursor.u32(nodes),
    nodeName: cursor.u32(nodes),
    nodeIdTail: cursor.u32(nodes),
    nodeDocstring: cursor.u32(nodes),
    nodeLineSpan: cursor.u32(nodes),
    nodeMemberArity: cursor.u32(nodes),
    nodeComplexity: cursor.f64(nodes),
    nodeKeyOrder: cursor.u16(nodes),
    nodeIdMode: cursor.u8(nodes),
    nodeKind: cursor.u8(nodes),
    nodeVisibility: cursor.u8(nodes),
    nodeFlags: cursor.u8(nodes),
    siteFile: cursor.u32(sites),
    siteStartLine: cursor.u32(sites),
    siteStartColumn: cursor.u32(sites),
    siteStartIndex: cursor.u32(sites),
    siteEndLine: cursor.u32(sites),
    siteEndColumn: cursor.u32(sites),
    siteEndIndex: cursor.u32(sites),
    siteFlags: cursor.u8(sites),
    edgeFrom: cursor.u32(edges),
    edgeTo: cursor.u32(edges),
    edgeLabel: cursor.u32(edges),
    edgeSite: cursor.u32(edges),
    aliasFile: cursor.u32(aliases),
    aliasRest: cursor.u32(aliases),
    aliasCanonical: cursor.u32(aliases),
  };
}

function layoutTableColumns(
  cursor: SectionCursor,
  counts: Pick<SidecarCounts, "files" | "strings">,
  blobBytes: { files: number; strings: number },
): TableColumns {
  return {
    fileOffsets: cursor.u32(counts.files + 1),
    fileBlob: cursor.u8(blobBytes.files),
    stringOffsets: cursor.u32(counts.strings + 1),
    stringBlob: cursor.u8(blobBytes.strings),
  };
}

function bodyBytesFor(counts: SidecarCounts, blobBytes: { files: number; strings: number }): number {
  const cursor = new SectionCursor({ kind: "measure" });
  layoutRecordColumns(cursor, counts);
  layoutTableColumns(cursor, counts, blobBytes);
  return cursor.offset;
}

/** The columns of a decompressed body, as views over it; a throw means the header and the body disagree. */
export function layoutDetailedSymbolGraphColumns(
  body: Uint8Array,
  header: DetailedSidecarHeader,
): DetailedSidecarColumns {
  const blobBytes = { files: header.fileBlobBytes, strings: header.stringBlobBytes };
  if (bodyBytesFor(header.counts, blobBytes) !== body.byteLength) {
    throw new SidecarRejection("the sidecar body does not match its counts");
  }
  const aligned = body.byteOffset % SECTION_ALIGNMENT === 0 ? body : new Uint8Array(body);
  const cursor = new SectionCursor({ kind: "view", body: aligned });
  const records = layoutRecordColumns(cursor, header.counts);
  return { ...records, ...layoutTableColumns(cursor, header.counts, blobBytes) };
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < ABSENT;
}

function isIllFormedList(value: unknown): value is Array<[number, string]> {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) => Array.isArray(entry) && entry.length === 2 && isCount(entry[0]) && typeof entry[1] === "string",
    )
  );
}

function isNodeKeyOrderList(value: unknown): value is string[][] {
  const required = NODE_KEY_ORDER.slice(0, 4);
  return (
    Array.isArray(value) &&
    value.every(
      (keys) =>
        Array.isArray(keys) &&
        new Set(keys).size === keys.length &&
        keys.every((key) => (NODE_KEY_ORDER as readonly unknown[]).includes(key)) &&
        required.every((key) => keys.includes(key)),
    )
  );
}

function isSidecarHeader(value: unknown): value is DetailedSidecarHeader {
  if (!isPlainRecord(value) || value.version !== DETAILED_SYMBOL_GRAPH_SNAPSHOT_VERSION) return false;
  const counts = value.counts;
  return (
    typeof value.projectRoot === "string" &&
    typeof value.implementationFingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(value.implementationFingerprint) &&
    typeof value.projectSnapshotIdentity === "string" &&
    /^[a-f0-9]{64}$/.test(value.projectSnapshotIdentity) &&
    typeof value.payloadSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.payloadSha256) &&
    isPlainRecord(counts) &&
    isCount(counts.files) &&
    isCount(counts.strings) &&
    isCount(counts.nodes) &&
    isCount(counts.edges) &&
    isCount(counts.sites) &&
    isCount(counts.aliases) &&
    counts.sites <= counts.edges &&
    isCount(value.fileBlobBytes) &&
    isCount(value.stringBlobBytes) &&
    isCount(value.bodyBytes) &&
    isIllFormedList(value.illFormedFiles) &&
    isIllFormedList(value.illFormedStrings) &&
    isNodeKeyOrderList(value.nodeKeyOrders)
  );
}

/**
 * Paths between the project root and the sidecar. A persisted path is project-relative; one in canonical form
 * (no `.` or `..` segment, drive colon, backslash, or repeated slash) resolves by joining it to the resolved
 * root, which is what resolving and normalizing it gives, and any other goes through the shared confinement
 * check, which also rejects a path that leaves the root.
 */
class SidecarPaths {
  private readonly base: string;

  constructor(private readonly projectRoot: string) {
    const resolved = normalizePath(path.resolve(projectRoot));
    this.base = resolved.endsWith("/") ? resolved.slice(0, -1) : resolved;
  }

  relative(file: string): string {
    return path.isAbsolute(file) ? cacheRelativePath(this.projectRoot, file) : file;
  }

  absolute(relative: string): string {
    if (isCanonicalRelativePath(relative)) return `${this.base}/${relative}`;
    return assertFilePathWithinRoot(
      this.projectRoot,
      cacheAbsolutePath(this.projectRoot, relative),
      "Persisted cache path",
    );
  }
}

const NON_CANONICAL_PATH_CHARACTERS = /[\\:\0]|\/\//;
const DOT_SEGMENT = /(?:^|\/)\.\.?(?:\/|$)/;

function isCanonicalRelativePath(value: string): boolean {
  if (!value || value.startsWith("/") || value.endsWith("/")) return false;
  return !NON_CANONICAL_PATH_CHARACTERS.test(value) && !DOT_SEGMENT.test(value);
}

type IndexedFiles = Pick<ReadonlyMap<string, unknown>, "has">;

/** UTF-8 bytes in chunks, so the text of a large graph is never held, or made, as one string or one buffer. */
class ChunkedBytes {
  total = 0;
  private readonly chunks: Buffer[] = [];
  private current = Buffer.allocUnsafe(STRING_CHUNK_BYTES);
  private used = 0;

  append(text: string): void {
    // Each UTF-16 unit takes at most three UTF-8 bytes.
    const room = text.length * 3;
    if (this.current.length - this.used < room) {
      if (this.used) this.chunks.push(this.current.subarray(0, this.used));
      this.current = Buffer.allocUnsafe(Math.max(STRING_CHUNK_BYTES, room));
      this.used = 0;
    }
    const written = text.length ? this.current.write(text, this.used, "utf8") : 0;
    this.used += written;
    this.total += written;
  }

  toBuffer(): Buffer {
    const parts = this.used ? [...this.chunks, this.current.subarray(0, this.used)] : this.chunks;
    return Buffer.concat(parts, this.total);
  }
}

class StringTableWriter {
  readonly illFormed: Array<[number, string]> = [];
  private readonly bytes = new ChunkedBytes();
  private readonly ends: number[] = [];
  private readonly indexByText = new Map<string, number>();

  get size(): number {
    return this.ends.length;
  }

  /** The index of `text`, added once. */
  intern(text: string): number {
    const known = this.indexByText.get(text);
    if (known !== undefined) return known;
    const index = this.add(text);
    this.indexByText.set(text, index);
    return index;
  }

  /** A new entry, even when an equal one exists; for long text that is rarely repeated. */
  add(text: string): number {
    const index = this.ends.length;
    if (text.isWellFormed()) {
      this.bytes.append(text);
    } else {
      this.illFormed.push([index, text]);
    }
    this.ends.push(this.bytes.total);
    return index;
  }

  finish(): { offsets: Uint32Array; blob: Buffer } {
    if (this.bytes.total >= ABSENT) throw new UnpersistableGraphError("The string table is too large to index.");
    const offsets = new Uint32Array(this.ends.length + 1);
    for (let index = 0; index < this.ends.length; index += 1) offsets[index + 1] = this.ends[index]!;
    return { offsets, blob: this.bytes.toBuffer() };
  }
}

type FileEntry = { index: number; normalized: string };

class FileTableWriter {
  readonly strings = new StringTableWriter();
  private readonly entriesByFile = new Map<string, FileEntry>();
  private readonly indexByRelative = new Map<string, number>();

  constructor(
    private readonly paths: SidecarPaths,
    private readonly indexedFiles: IndexedFiles | undefined,
  ) {}

  entry(file: string): FileEntry {
    const known = this.entriesByFile.get(file);
    if (known) return known;
    const relative = this.paths.relative(file);
    // Throws for a file outside the project root, which no load would accept.
    const absolute = this.paths.absolute(relative);
    if (this.indexedFiles && !this.indexedFiles.has(fileIdentityKey(absolute))) {
      throw new UnpersistableGraphError(`The graph names a file the project index does not hold: ${file}`);
    }
    let index = this.indexByRelative.get(relative);
    if (index === undefined) {
      index = this.strings.add(relative);
      this.indexByRelative.set(relative, index);
    }
    const created = { index, normalized: normalizePath(file) };
    this.entriesByFile.set(file, created);
    return created;
  }
}

function keysFollow(value: object, order: readonly string[]): boolean {
  let position = -1;
  for (const key of Object.keys(value)) {
    const at = order.indexOf(key);
    if (at <= position) return false;
    position = at;
  }
  return true;
}

function columnInteger(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value >= ABSENT) {
    throw new UnpersistableGraphError(`The graph holds ${what} that is not a column integer: ${String(value)}`);
  }
  return value;
}

/** The value of `tail` when it is a decimal index as `String(index)` writes it, else `undefined`. */
function decimalIndex(tail: string): number | undefined {
  const length = tail.length;
  if (!length || length > 10) return undefined;
  if (tail.charCodeAt(0) === 48) return length === 1 ? 0 : undefined;
  let value = 0;
  for (let position = 0; position < length; position += 1) {
    const digit = tail.charCodeAt(position) - 48;
    if (digit < 0 || digit > 9) return undefined;
    value = value * 10 + digit;
  }
  return value < ABSENT ? value : undefined;
}

type CanonicalizedSymbolGraph = SymbolGraph & { nodeAliases?: ReadonlyMap<string, string> };
const NO_ALIASES: ReadonlyMap<string, string> = new Map();

export type DetailedSymbolGraphSidecarInput = {
  projectRoot: string;
  projectSnapshotIdentity: string;
  graph: SymbolGraph;
  /** When set, every file the graph names must be in it, as a load requires. */
  indexedFiles?: IndexedFiles;
};

/**
 * Fills the columns of a graph and the two string tables. Throws {@link UnpersistableGraphError} for a graph the
 * format cannot hold exactly (an unknown property, a negative or fractional count, an edge to no node).
 */
function encodeColumns(input: DetailedSymbolGraphSidecarInput) {
  const { graph } = input;
  const paths = new SidecarPaths(input.projectRoot);
  const aliases = (graph as CanonicalizedSymbolGraph).nodeAliases ?? NO_ALIASES;
  let siteCount = 0;
  for (const edge of graph.edges) if (edge.site !== undefined) siteCount += 1;
  const counts: RecordCounts = {
    nodes: graph.nodes.size,
    edges: graph.edges.length,
    sites: siteCount,
    aliases: aliases.size,
  };
  const columns = layoutRecordColumns(new SectionCursor({ kind: "fresh" }), counts);
  const files = new FileTableWriter(paths, input.indexedFiles);
  const strings = new StringTableWriter();
  const keyOrders = new Map<string, number>();
  const nodeIndexById = new Map<string, number>();

  let nodeNumber = 0;
  for (const node of graph.nodes.values()) {
    encodeNode(node, nodeNumber, columns, files, strings, keyOrders);
    nodeIndexById.set(node.id, nodeNumber);
    nodeNumber += 1;
  }
  if (nodeIndexById.size !== counts.nodes) throw new UnpersistableGraphError("The graph holds two nodes with one id.");

  let siteNumber = 0;
  for (let edgeNumber = 0; edgeNumber < counts.edges; edgeNumber += 1) {
    const edge = graph.edges[edgeNumber]!;
    if (!keysFollow(edge, EDGE_KEY_ORDER))
      throw new UnpersistableGraphError("An edge holds a property the format has no column for.");
    const from = nodeIndexById.get(edge.from);
    const to = nodeIndexById.get(edge.to);
    if (from === undefined || to === undefined)
      throw new UnpersistableGraphError("An edge runs to a node the graph does not hold.");
    columns.edgeFrom[edgeNumber] = from;
    columns.edgeTo[edgeNumber] = to;
    if (edge.label === undefined) {
      columns.edgeLabel[edgeNumber] = ABSENT;
    } else if (typeof edge.label === "string") {
      columns.edgeLabel[edgeNumber] = strings.intern(edge.label);
    } else {
      throw new UnpersistableGraphError("An edge label is not text.");
    }
    if (edge.site === undefined) {
      columns.edgeSite[edgeNumber] = ABSENT;
    } else {
      encodeSite(edge.site, siteNumber, columns, files);
      columns.edgeSite[edgeNumber] = siteNumber;
      siteNumber += 1;
    }
  }

  let aliasNumber = 0;
  for (const [aliasId, canonicalId] of aliases) {
    const canonical = nodeIndexById.get(canonicalId);
    if (canonical === undefined || nodeIndexById.has(aliasId)) {
      throw new UnpersistableGraphError("A node alias is not a removed node of a node the graph holds.");
    }
    // Like every persisted handle, an alias is its file followed by what the first `::` starts.
    const separator = aliasId.indexOf("::");
    const aliasFile = separator < 0 ? aliasId : aliasId.slice(0, separator);
    columns.aliasFile[aliasNumber] = files.entry(aliasFile).index;
    columns.aliasRest[aliasNumber] = strings.add(separator < 0 ? "" : aliasId.slice(separator));
    columns.aliasCanonical[aliasNumber] = canonical;
    aliasNumber += 1;
  }
  return { counts, columns, files, strings, keyOrders };
}

function encodeNode(
  node: SymbolNode,
  position: number,
  columns: RecordColumns,
  files: FileTableWriter,
  strings: StringTableWriter,
  keyOrders: Map<string, number>,
): void {
  const file = files.entry(node.file);
  columns.nodeFile[position] = file.index;
  columns.nodeName[position] = strings.intern(node.name);

  // Every indexed node's id is `file::name::tail`; any other id that starts with its file keeps its rest as text.
  const { id, name } = node;
  const nameEnd = file.normalized.length + 2 + name.length;
  if (!id.startsWith(file.normalized) || !id.startsWith("::", file.normalized.length)) {
    throw new UnpersistableGraphError(`A node id does not start with its file: ${id}`);
  }
  if (id.startsWith(name, file.normalized.length + 2) && id.startsWith("::", nameEnd)) {
    const tail = id.slice(nameEnd + 2);
    const index = decimalIndex(tail);
    columns.nodeIdMode[position] = index === undefined ? ID_TEXT_TAIL : ID_NUMERIC_TAIL;
    columns.nodeIdTail[position] = index === undefined ? strings.intern(tail) : index;
  } else {
    columns.nodeIdMode[position] = ID_REST_TEXT;
    columns.nodeIdTail[position] = strings.add(id.slice(file.normalized.length));
  }

  const kind = NODE_KIND_CODES[node.kind];
  if (kind === undefined)
    throw new UnpersistableGraphError(`A node has a kind the format has no code for: ${String(node.kind)}`);
  columns.nodeKind[position] = kind;

  if (node.docstring === undefined) {
    columns.nodeDocstring[position] = ABSENT;
  } else if (typeof node.docstring === "string") {
    columns.nodeDocstring[position] = strings.add(node.docstring);
  } else {
    throw new UnpersistableGraphError("A node docstring is not text.");
  }
  columns.nodeLineSpan[position] = node.lineSpan === undefined ? ABSENT : columnInteger(node.lineSpan, "a line span");
  columns.nodeMemberArity[position] =
    node.memberArity === undefined ? ABSENT : columnInteger(node.memberArity, "a member arity");
  if (node.complexity === undefined) {
    columns.nodeComplexity[position] = Number.NaN;
  } else if (typeof node.complexity === "number" && Number.isFinite(node.complexity) && node.complexity >= 0) {
    columns.nodeComplexity[position] = node.complexity;
  } else {
    throw new UnpersistableGraphError(
      `A node has a complexity that is not a non-negative number: ${String(node.complexity)}`,
    );
  }
  if (node.visibility === undefined) {
    columns.nodeVisibility[position] = 0;
  } else {
    const visibility = VISIBILITY_CODES[node.visibility];
    if (visibility === undefined)
      throw new UnpersistableGraphError("A node has a visibility the format has no code for.");
    columns.nodeVisibility[position] = visibility;
  }
  let flags = 0;
  // A marker that is not literally `true`, or a target that is not a boolean, is a graph the format cannot hold.
  const callable: unknown = node.callable;
  if (callable !== undefined) {
    if (typeof callable !== "boolean" || !callable) {
      throw new UnpersistableGraphError("A node callable marker is not literally true.");
    }
    flags |= FLAG_CALLABLE;
  }
  const implementationTarget: unknown = node.implementationTarget;
  if (implementationTarget !== undefined) {
    if (typeof implementationTarget !== "boolean") {
      throw new UnpersistableGraphError("A node implementation target is not a boolean.");
    }
    flags |= (implementationTarget ? 1 : 2) << FLAG_IMPLEMENTATION_TARGET_SHIFT;
  }
  columns.nodeFlags[position] = flags;

  if (keysFollow(node, NODE_KEY_ORDER)) {
    columns.nodeKeyOrder[position] = 0;
    return;
  }
  const keys = Object.keys(node);
  if (!keys.every((key) => (NODE_KEY_ORDER as readonly string[]).includes(key))) {
    throw new UnpersistableGraphError("A node holds a property the format has no column for.");
  }
  const order = keys.join(",");
  let orderNumber = keyOrders.get(order);
  if (orderNumber === undefined) {
    orderNumber = keyOrders.size + 1;
    if (orderNumber > 0xffff) throw new UnpersistableGraphError("The graph holds too many property orders.");
    keyOrders.set(order, orderNumber);
  }
  columns.nodeKeyOrder[position] = orderNumber;
}

function encodeSite(
  site: NonNullable<SymbolEdge["site"]>,
  position: number,
  columns: RecordColumns,
  files: FileTableWriter,
): void {
  const { file, range } = site;
  const { start, end } = range;
  if (
    !keysFollow(site, SITE_KEY_ORDER) ||
    !keysFollow(range, RANGE_KEY_ORDER) ||
    !keysFollow(start, POSITION_KEY_ORDER) ||
    !keysFollow(end, POSITION_KEY_ORDER)
  ) {
    throw new UnpersistableGraphError("A call site holds a property the format has no column for.");
  }
  columns.siteFile[position] = files.entry(file).index;
  columns.siteStartLine[position] = columnInteger(start.line, "a line");
  columns.siteStartColumn[position] = columnInteger(start.column, "a column");
  columns.siteEndLine[position] = columnInteger(end.line, "a line");
  columns.siteEndColumn[position] = columnInteger(end.column, "a column");
  let flags = 0;
  if (start.index !== undefined) {
    columns.siteStartIndex[position] = columnInteger(start.index, "an index");
    flags |= SITE_HAS_START_INDEX;
  }
  if (end.index !== undefined) {
    columns.siteEndIndex[position] = columnInteger(end.index, "an index");
    flags |= SITE_HAS_END_INDEX;
  }
  columns.siteFlags[position] = flags;
}

function copyColumns(target: object, source: object): void {
  for (const [key, value] of Object.entries(target) as Array<[string, ArrayBufferView]>) {
    const from = (source as Record<string, ArrayBufferView>)[key];
    if (!from) throw new UnpersistableGraphError(`A column is missing: ${key}`);
    new Uint8Array(value.buffer, value.byteOffset, value.byteLength).set(
      new Uint8Array(from.buffer, from.byteOffset, from.byteLength),
    );
  }
}

/** A sidecar file: `header` as JSON, then the compressed `payload` its checksum covers. */
export function packDetailedSymbolGraphSidecar(header: DetailedSidecarHeader, payload: Uint8Array): Buffer {
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const prefix = Buffer.alloc(PREFIX_BYTES);
  prefix.write(SNAPSHOT_MAGIC, 0, "ascii");
  prefix.writeUInt32LE(headerBytes.length, 4);
  return Buffer.concat([prefix, headerBytes, payload]);
}

/**
 * Compresses `body` and puts it behind `header`, filling in the length and the checksum of the payload. It is the
 * last step of a write, and of a test that alters a column and needs a sidecar that still verifies.
 */
export async function assembleDetailedSymbolGraphSidecar(
  header: DetailedSidecarHeader,
  body: Uint8Array,
): Promise<Buffer> {
  const payload = await brotliCompressAsync(body, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: body.byteLength,
    },
  });
  return packDetailedSymbolGraphSidecar(
    { ...header, bodyBytes: body.byteLength, payloadSha256: createHash("sha256").update(payload).digest("hex") },
    payload,
  );
}

/** The bytes of a sidecar for `input.graph`, as a write stores them. */
export async function encodeDetailedSymbolGraphSnapshot(input: DetailedSymbolGraphSidecarInput): Promise<Buffer> {
  if (!LITTLE_ENDIAN_HOST) throw new UnpersistableGraphError("The sidecar columns are little-endian.");
  const { counts: recordCounts, columns, files, strings, keyOrders } = encodeColumns(input);
  const fileTable = files.strings.finish();
  const stringTable = strings.finish();
  const counts: SidecarCounts = { ...recordCounts, files: files.strings.size, strings: strings.size };
  const blobBytes = { files: fileTable.blob.length, strings: stringTable.blob.length };

  const body = Buffer.alloc(bodyBytesFor(counts, blobBytes));
  const cursor = new SectionCursor({ kind: "view", body });
  copyColumns(layoutRecordColumns(cursor, counts), columns);
  copyColumns(layoutTableColumns(cursor, counts, blobBytes), {
    fileOffsets: fileTable.offsets,
    fileBlob: fileTable.blob,
    stringOffsets: stringTable.offsets,
    stringBlob: stringTable.blob,
  });
  return await assembleDetailedSymbolGraphSidecar(
    {
      version: DETAILED_SYMBOL_GRAPH_SNAPSHOT_VERSION,
      projectRoot: normalizePath(path.resolve(input.projectRoot)),
      implementationFingerprint: getImplementationFingerprint(),
      projectSnapshotIdentity: input.projectSnapshotIdentity,
      counts,
      fileBlobBytes: blobBytes.files,
      stringBlobBytes: blobBytes.strings,
      illFormedFiles: files.strings.illFormed,
      illFormedStrings: strings.illFormed,
      nodeKeyOrders: [...keyOrders.keys()].map((order) => order.split(",")),
      bodyBytes: 0,
      payloadSha256: "",
    },
    body,
  );
}

/** The header and the payload of a sidecar's bytes; throws for bytes that are not one. */
export function splitDetailedSymbolGraphSidecar(bytes: Uint8Array): { header: unknown; payload: Uint8Array } {
  const raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (raw.length < PREFIX_BYTES || raw.toString("ascii", 0, 4) !== SNAPSHOT_MAGIC) {
    throw new SidecarRejection("invalid detailed symbol graph payload");
  }
  const headerEnd = PREFIX_BYTES + raw.readUInt32LE(4);
  if (headerEnd > raw.length) throw new SidecarRejection("invalid detailed symbol graph payload");
  return {
    header: JSON.parse(raw.toString("utf8", PREFIX_BYTES, headerEnd)) as unknown,
    payload: raw.subarray(headerEnd),
  };
}

/** The body of a sidecar once the checksum of its payload has held. */
export async function inflateDetailedSymbolGraphSidecar(
  header: DetailedSidecarHeader,
  payload: Uint8Array,
): Promise<Buffer> {
  if (createHash("sha256").update(payload).digest("hex") !== header.payloadSha256) {
    throw new SidecarRejection("detailed symbol graph checksum mismatch");
  }
  const body = await brotliDecompressAsync(payload, { maxOutputLength: Math.max(1, header.bodyBytes) });
  if (body.length !== header.bodyBytes) throw new SidecarRejection("detailed symbol graph body length mismatch");
  return body;
}

function readStringTable(
  offsets: Uint32Array,
  blob: Uint8Array,
  count: number,
  illFormed: ReadonlyArray<readonly [number, string]>,
): string[] {
  const bytes = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  const table = new Array<string>(count);
  let start = offsets[0]!;
  if (start !== 0) throw new SidecarRejection("a string table does not start at its first byte");
  for (let index = 0; index < count; index += 1) {
    const end = offsets[index + 1]!;
    if (end < start || end > bytes.length) throw new SidecarRejection("a string table offset is out of order");
    table[index] = end === start ? "" : bytes.toString("utf8", start, end);
    start = end;
  }
  if (start !== bytes.length) throw new SidecarRejection("a string table does not end at its last byte");
  for (const [index, text] of illFormed) if (index < count) table[index] = text;
  return table;
}

function requireText(table: readonly string[], index: number, what: string): string {
  const text = table[index];
  if (text === undefined) throw new SidecarRejection(`${what} refers to a missing string`);
  return text;
}

/**
 * Builds the graph a sidecar holds. A file the index does not hold, or one outside the project root, rejects the
 * sidecar; each is checked once per distinct file. Everything else it checks is shape: a column value that
 * refers past its table, a duplicate id, an alias that is not a removed node.
 */
function materializeGraph(
  columns: DetailedSidecarColumns,
  header: DetailedSidecarHeader,
  paths: SidecarPaths,
  indexedFiles: IndexedFiles,
): SymbolGraph {
  const { counts } = header;
  const stringTable = readStringTable(
    columns.stringOffsets,
    columns.stringBlob,
    counts.strings,
    header.illFormedStrings,
  );
  const relativeFiles = readStringTable(columns.fileOffsets, columns.fileBlob, counts.files, header.illFormedFiles);
  const files = new Array<string>(counts.files);
  for (let index = 0; index < counts.files; index += 1) {
    const file = paths.absolute(relativeFiles[index]!);
    if (!indexedFiles.has(fileIdentityKey(file)))
      throw new SidecarRejection("detailed symbol graph does not match project");
    files[index] = file;
  }

  const nodes = new Map<string, SymbolNode>();
  const ids = new Array<string>(counts.nodes);
  for (let position = 0; position < counts.nodes; position += 1) {
    const file = files[columns.nodeFile[position]!];
    if (file === undefined) throw new SidecarRejection("a node refers to a missing file");
    const name = requireText(stringTable, columns.nodeName[position]!, "a node name");
    let id: string;
    switch (columns.nodeIdMode[position]) {
      case ID_NUMERIC_TAIL:
        id = `${file}::${name}::${columns.nodeIdTail[position]!}`;
        break;
      case ID_TEXT_TAIL:
        id = `${file}::${name}::${requireText(stringTable, columns.nodeIdTail[position]!, "a node id")}`;
        break;
      case ID_REST_TEXT:
        id = `${file}${requireText(stringTable, columns.nodeIdTail[position]!, "a node id")}`;
        break;
      default:
        throw new SidecarRejection("a node has an unknown id form");
    }
    const kind = NODE_KINDS[columns.nodeKind[position]!];
    if (kind === undefined) throw new SidecarRejection("a node has an unknown kind");
    const node = columns.nodeKeyOrder[position]
      ? nodeInKeyOrder(
          header.nodeKeyOrders[columns.nodeKeyOrder[position]! - 1],
          { id, file, name, kind },
          position,
          columns,
          stringTable,
        )
      : canonicalNode({ id, file, name, kind }, position, columns, stringTable);
    nodes.set(id, node);
    ids[position] = id;
  }
  if (nodes.size !== counts.nodes) throw new SidecarRejection("detailed symbol graph holds duplicate node ids");

  const edges: SymbolEdge[] = [];
  for (let position = 0; position < counts.edges; position += 1) {
    const from = ids[columns.edgeFrom[position]!];
    const to = ids[columns.edgeTo[position]!];
    if (from === undefined || to === undefined) throw new SidecarRejection("an edge refers to a missing node");
    const edge: SymbolEdge = { from, to };
    const label = columns.edgeLabel[position]!;
    if (label !== ABSENT) edge.label = requireText(stringTable, label, "an edge label");
    const site = columns.edgeSite[position]!;
    if (site !== ABSENT) edge.site = decodeSite(site, columns, files);
    edges.push(edge);
  }

  const graph: SymbolGraph = { nodes, edges };
  if (counts.aliases) {
    const aliases = new Map<string, string>();
    for (let position = 0; position < counts.aliases; position += 1) {
      const file = files[columns.aliasFile[position]!];
      const canonical = ids[columns.aliasCanonical[position]!];
      if (file === undefined || canonical === undefined)
        throw new SidecarRejection("a node alias refers to a missing file or node");
      const aliasId = `${file}${requireText(stringTable, columns.aliasRest[position]!, "a node alias")}`;
      if (aliasId === canonical || nodes.has(aliasId) || aliases.has(aliasId))
        throw new SidecarRejection("a node alias is invalid");
      aliases.set(aliasId, canonical);
    }
    for (const canonical of aliases.values()) {
      if (aliases.has(canonical)) throw new SidecarRejection("a node alias names another alias");
    }
    Object.defineProperty(graph, "nodeAliases", { value: aliases });
  }
  return graph;
}

type NodeCore = Pick<SymbolNode, "id" | "file" | "name" | "kind">;

/** The optional properties of a node, set in canonical order after its four required ones. */
function canonicalNode(
  core: NodeCore,
  position: number,
  columns: DetailedSidecarColumns,
  strings: readonly string[],
): SymbolNode {
  const node: SymbolNode = { id: core.id, file: core.file, name: core.name, kind: core.kind };
  const docstring = columns.nodeDocstring[position]!;
  if (docstring !== ABSENT) node.docstring = requireText(strings, docstring, "a node docstring");
  const lineSpan = columns.nodeLineSpan[position]!;
  if (lineSpan !== ABSENT) node.lineSpan = lineSpan;
  const complexity = columns.nodeComplexity[position]!;
  if (!Number.isNaN(complexity)) node.complexity = complexity;
  const visibility = columns.nodeVisibility[position]!;
  if (visibility) node.visibility = nodeVisibility(visibility);
  const flags = columns.nodeFlags[position]!;
  if (flags) {
    const implementationTarget = nodeImplementationTarget(flags);
    if (implementationTarget !== undefined) node.implementationTarget = implementationTarget;
  }
  const memberArity = columns.nodeMemberArity[position]!;
  if (memberArity !== ABSENT) node.memberArity = memberArity;
  if (flags & FLAG_CALLABLE) node.callable = true;
  return node;
}

function nodeVisibility(code: number): SymbolVisibility {
  const visibility = VISIBILITIES[code - 1];
  if (visibility === undefined) throw new SidecarRejection("a node has an unknown visibility");
  return visibility;
}

function nodeImplementationTarget(flags: number): boolean | undefined {
  if (flags & ~(FLAG_CALLABLE | (3 << FLAG_IMPLEMENTATION_TARGET_SHIFT)))
    throw new SidecarRejection("a node has unknown flags");
  const state = (flags >> FLAG_IMPLEMENTATION_TARGET_SHIFT) & 3;
  if (state === 3) throw new SidecarRejection("a node has an unknown implementation target");
  return state ? state === 1 : undefined;
}

/** A node whose properties were not in canonical order when it was written: the same properties, in that order. */
function nodeInKeyOrder(
  keys: readonly string[] | undefined,
  core: NodeCore,
  position: number,
  columns: DetailedSidecarColumns,
  strings: readonly string[],
): SymbolNode {
  if (!keys) throw new SidecarRejection("a node refers to a missing property order");
  const canonical = canonicalNode(core, position, columns, strings);
  const values: Record<string, unknown> = {};
  for (const key of keys) {
    const value: unknown = (canonical as Record<string, unknown>)[key];
    if (value !== undefined) values[key] = value;
  }
  return values as SymbolNode;
}

function decodeSite(
  position: number,
  columns: DetailedSidecarColumns,
  files: readonly string[],
): NonNullable<SymbolEdge["site"]> {
  const file = files[columns.siteFile[position]!];
  if (file === undefined) throw new SidecarRejection("a call site refers to a missing file");
  const flags = columns.siteFlags[position]!;
  const start: Pos = { line: columns.siteStartLine[position]!, column: columns.siteStartColumn[position]! };
  if (flags & SITE_HAS_START_INDEX) start.index = columns.siteStartIndex[position]!;
  const end: Pos = { line: columns.siteEndLine[position]!, column: columns.siteEndColumn[position]! };
  if (flags & SITE_HAS_END_INDEX) end.index = columns.siteEndIndex[position]!;
  const range: Range = { start, end };
  return { file, range };
}

export function detailedSymbolGraphSnapshotPath(projectRoot: string, opts: BuildOptions | undefined): string {
  const root = path.resolve(cacheRoot(projectRoot, opts));
  const snapshotPath = path.resolve(root, DETAILED_SYMBOL_GRAPH_SNAPSHOT_FILENAME);
  if (!isFilePathWithinRoot(root, snapshotPath)) {
    throw new Error(`Detailed symbol graph snapshot escaped cache root: ${snapshotPath}`);
  }
  return snapshotPath;
}

export async function writeDetailedSymbolGraphSnapshot(
  projectRoot: string,
  opts: BuildOptions | undefined,
  index: ProjectIndex,
  graph: SymbolGraph,
): Promise<void> {
  if ((opts?.cache ?? "off") !== "disk" || !index.projectSnapshotIdentity) return;
  try {
    const snapshotPath = detailedSymbolGraphSnapshotPath(projectRoot, opts);
    const bytes = await encodeDetailedSymbolGraphSnapshot({
      projectRoot,
      projectSnapshotIdentity: index.projectSnapshotIdentity,
      graph,
      indexedFiles: index.byFile,
    });
    await writeSnapshotAtomically(snapshotPath, bytes);
    // Nothing reads the text sidecar of earlier versions. A leftover one only wastes space, so failing to remove it is
    // not a failed write.
    await fsp
      .rm(path.join(path.dirname(snapshotPath), LEGACY_JSON_SIDECAR_FILENAME), { force: true })
      .catch(() => undefined);
  } catch (error) {
    // Persisting the graph is an optimization: the caller keeps the graph it built. The reason is still worth a line
    // at debug level, because a graph that never persists costs a full rebuild in every process.
    const reason = error instanceof Error ? error.message : String(error);
    logWithLevel(
      opts?.logLevel,
      "debug",
      `Cache artifact not written ${DETAILED_SYMBOL_GRAPH_SNAPSHOT_FILENAME}: ${reason}`,
    );
  }
}

export async function tryLoadDetailedSymbolGraphSnapshot(
  projectRoot: string,
  opts: BuildOptions | undefined,
  index: ProjectIndex,
  report?: BuildReport,
): Promise<SymbolGraph | null> {
  if ((opts?.cache ?? "off") !== "disk" || !index.projectSnapshotIdentity || !LITTLE_ENDIAN_HOST) return null;
  const snapshotPath = detailedSymbolGraphSnapshotPath(projectRoot, opts);
  try {
    let bytes: Buffer;
    try {
      bytes = await fsp.readFile(snapshotPath);
    } catch (error) {
      if (isMissingArtifactError(error)) return null;
      throw error;
    }
    const { header, payload } = splitDetailedSymbolGraphSidecar(bytes);
    const serializedVersion = isPlainRecord(header) && typeof header.version === "number" ? header.version : null;
    if (serializedVersion !== null && serializedVersion < DETAILED_SYMBOL_GRAPH_SNAPSHOT_VERSION) {
      recordSnapshotInvalidation(snapshotPath, "detailed symbol graph derivation version mismatch", opts?.logLevel);
      return null;
    }
    if (!isSidecarHeader(header)) {
      recordCacheCorruption(report, snapshotPath, "invalid detailed symbol graph payload", opts?.logLevel);
      return null;
    }
    if (header.implementationFingerprint !== getImplementationFingerprint()) {
      recordSnapshotInvalidation(snapshotPath, "implementation fingerprint mismatch", opts?.logLevel);
      return null;
    }
    if (header.projectSnapshotIdentity !== index.projectSnapshotIdentity) {
      recordSnapshotInvalidation(snapshotPath, "project snapshot identity mismatch", opts?.logLevel);
      return null;
    }
    const body = await inflateDetailedSymbolGraphSidecar(header, payload);
    return materializeGraph(
      layoutDetailedSymbolGraphColumns(body, header),
      header,
      new SidecarPaths(projectRoot),
      index.byFile,
    );
  } catch (error) {
    recordCacheCorruption(
      report,
      snapshotPath,
      error instanceof SidecarRejection ? error.message : String(error),
      opts?.logLevel,
    );
    return null;
  }
}
