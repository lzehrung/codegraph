import fs from "node:fs/promises";
import path from "node:path";
import {
  DETAILED_SYMBOL_GRAPH_SNAPSHOT_FILENAME,
  assembleDetailedSymbolGraphSidecar,
  inflateDetailedSymbolGraphSidecar,
  layoutDetailedSymbolGraphColumns,
  packDetailedSymbolGraphSidecar,
  splitDetailedSymbolGraphSidecar,
  type DetailedSidecarColumns,
  type DetailedSidecarHeader,
} from "../../src/indexer/build-cache/detailed-graph-snapshot.js";

/** Where a disk-cached project keeps its detailed symbol graph sidecar. */
export function detailedSidecarPath(root: string): string {
  return path.join(root, ".codegraph", "cache", "index-v1", DETAILED_SYMBOL_GRAPH_SNAPSHOT_FILENAME);
}

export async function readDetailedSidecarHeader(sidecarPath: string): Promise<DetailedSidecarHeader> {
  const { header } = splitDetailedSymbolGraphSidecar(await fs.readFile(sidecarPath));
  return header as DetailedSidecarHeader;
}

/** Rewrites the named header fields and seals the file again, so a load meets the changed field, not a failed checksum. */
export async function patchDetailedSidecarHeader(
  sidecarPath: string,
  patch: Partial<Record<keyof DetailedSidecarHeader, unknown>>,
): Promise<void> {
  const { header, payload } = splitDetailedSymbolGraphSidecar(await fs.readFile(sidecarPath));
  const patched = { ...(header as DetailedSidecarHeader), ...patch } as DetailedSidecarHeader;
  await fs.writeFile(sidecarPath, packDetailedSymbolGraphSidecar(patched, payload));
}

/**
 * The bytes of a sidecar with its header text passed through `edit`, and the checksum and the payload left as they
 * were written: the file is well formed and no longer verifies, as after a byte of its header changes. An edit that
 * leaves the text as it was throws, because a file that still verifies would prove nothing.
 */
export function editDetailedSidecarHeaderText(raw: Buffer, edit: (text: string) => string): Buffer {
  const { payload } = splitDetailedSymbolGraphSidecar(raw);
  const headerLength = raw.readUInt32LE(4);
  const prefixLength = raw.length - payload.length - headerLength;
  const text = raw.toString("utf8", prefixLength, prefixLength + headerLength);
  const edited = edit(text);
  if (edited === text) throw new Error("the edit did not change the header text");
  const headerBytes = Buffer.from(edited, "utf8");
  const prefix = Buffer.from(raw.subarray(0, prefixLength));
  prefix.writeUInt32LE(headerBytes.length, 4);
  return Buffer.concat([prefix, headerBytes, payload]);
}

/**
 * The columns of the sidecar at `sidecarPath` as views over its decompressed body. `save` compresses the body as
 * it now is and writes a sidecar whose checksum verifies, so a test can alter one column and keep the rest valid.
 */
export async function openDetailedSidecar(sidecarPath: string): Promise<{
  header: DetailedSidecarHeader;
  columns: DetailedSidecarColumns;
  save: () => Promise<void>;
}> {
  const { header: rawHeader, payload } = splitDetailedSymbolGraphSidecar(await fs.readFile(sidecarPath));
  const header = rawHeader as DetailedSidecarHeader;
  const body = await inflateDetailedSymbolGraphSidecar(header, payload);
  const columns = layoutDetailedSymbolGraphColumns(body, header);
  if (columns.edgeFrom.buffer !== body.buffer && header.counts.edges)
    throw new Error("sidecar columns do not alias the body");
  return {
    header,
    columns,
    save: async () => {
      await fs.writeFile(sidecarPath, await assembleDetailedSymbolGraphSidecar(header, body));
    },
  };
}
