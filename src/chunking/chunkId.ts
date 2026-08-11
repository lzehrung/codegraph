import { createHash } from "node:crypto";
import type { Chunk } from "./types.js";

/**
 * Assigns content-addressed IDs after chunking has finalized each chunk's text.
 * Identical chunks use a deterministic suffix only to preserve uniqueness.
 */
export function withStableChunkIds(chunks: Chunk[], languageId: string, filePath: string | undefined): Chunk[] {
  const occurrences = new Map<string, number>();
  const scopedPath = filePath ?? "unknown";

  return chunks.map((chunk) => {
    const digest = createHash("sha256")
      .update("codegraph-chunk-id-v1\0")
      .update(languageId)
      .update("\0")
      .update(scopedPath)
      .update("\0")
      .update(chunk.type)
      .update("\0")
      .update(chunk.name ?? "")
      .update("\0")
      .update(chunk.text)
      .digest("hex");
    const occurrence = occurrences.get(digest) ?? 0;
    occurrences.set(digest, occurrence + 1);
    const id = occurrence === 0 ? `${languageId}:${scopedPath}:${digest}` : `${languageId}:${scopedPath}:${digest}:${occurrence}`;

    return { ...chunk, id };
  });
}
