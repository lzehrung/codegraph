import { supportForFile } from "../languages.js";
import { supportsReceiverMemberResolution } from "../indexer/navigation-goto.js";
import type { ProjectIndex } from "../indexer/types.js";
import type { ChangedSymbol, MemberResolutionCoverage } from "./types.js";

/**
 * Buckets the source languages touched by `changedSymbols` into languages
 * where receiver/instance member-call resolution (`obj.method()`) is
 * verified by codegraph, and languages where it is not implemented.
 *
 * Language is looked up from the already-parsed index cache when available
 * (every changed file has normally been parsed to locate changed symbols),
 * falling back to extension-based detection. Files whose language cannot be
 * determined are skipped rather than guessed.
 */
export function computeMemberResolutionCoverage(
  changedSymbols: readonly ChangedSymbol[],
  index: ProjectIndex,
): MemberResolutionCoverage {
  const receiverAware = new Set<string>();
  const limited = new Set<string>();
  const seenFiles = new Set<string>();

  for (const symbol of changedSymbols) {
    if (seenFiles.has(symbol.file)) continue;
    seenFiles.add(symbol.file);

    const languageId = index.parsed?.get(symbol.file)?.sup.id ?? supportForFile(symbol.file)?.id;
    if (!languageId) continue;

    if (supportsReceiverMemberResolution(languageId)) {
      receiverAware.add(languageId);
    } else {
      limited.add(languageId);
    }
  }

  return {
    receiverAwareLanguages: [...receiverAware].sort(),
    limitedLanguages: [...limited].sort(),
  };
}
