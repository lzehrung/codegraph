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

/** Rewrites the named header fields and leaves the payload bytes, and so the checksum they carry, untouched. */
export async function patchDetailedSidecarHeader(
  sidecarPath: string,
  patch: Partial<Record<keyof DetailedSidecarHeader, unknown>>,
): Promise<void> {
  const { header, payload } = splitDetailedSymbolGraphSidecar(await fs.readFile(sidecarPath));
  const patched = { ...(header as DetailedSidecarHeader), ...patch } as DetailedSidecarHeader;
  await fs.writeFile(sidecarPath, packDetailedSymbolGraphSidecar(patched, payload));
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
