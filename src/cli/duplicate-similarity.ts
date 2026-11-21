import type { DuplicateSimilarityHint } from "../duplicates.js";
import { compareStrings } from "../util/strings.js";

type DuplicateSimilarityChange = {
  file: string;
  oldFile?: string;
  similarityIndex?: number;
};

export function changedFilesWithSimilaritySources(changes: readonly DuplicateSimilarityChange[]): string[] {
  const files = new Set<string>();
  for (const change of changes) {
    files.add(change.file);
    if (change.oldFile !== undefined && change.similarityIndex !== undefined) {
      files.add(change.oldFile);
    }
  }
  return Array.from(files).sort((left, right) => compareStrings(left, right));
}

export function duplicateSimilarityHintsFromChanges(
  changes: readonly DuplicateSimilarityChange[],
): DuplicateSimilarityHint[] {
  return changes
    .filter(
      (
        change,
      ): change is DuplicateSimilarityChange & {
        oldFile: string;
        similarityIndex: number;
      } => change.oldFile !== undefined && change.similarityIndex !== undefined,
    )
    .map((change) => ({
      leftFile: change.oldFile,
      rightFile: change.file,
      similarityIndex: change.similarityIndex,
    }));
}
