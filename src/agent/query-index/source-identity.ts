import { createHash } from "node:crypto";
import type { ProjectIndexManifestEntry } from "../../indexer/types.js";

export function createQuerySourceIdentity(normalizedPath: string, entry: ProjectIndexManifestEntry): string {
  const hash = createHash("sha256");
  hash.update("search-source-v1\0");
  hash.update(normalizedPath);
  hash.update("\0");
  hash.update(entry.sig);
  hash.update("\0");
  hash.update(entry.gitSig ?? "");
  return hash.digest("hex");
}
