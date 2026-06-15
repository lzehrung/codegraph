import type { FileId } from "../types.js";

export type ReferenceCandidateIndex = {
  byTargetFile: Map<FileId, Set<FileId>>;
};
