import { supportForFile } from "../languages.js";
import { supportsReceiverMemberResolution } from "../indexer/navigation-goto.js";
import type { ProjectIndex } from "../indexer/types.js";
import { fileIdentityKey } from "../util/paths.js";
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
    const fileKey = fileIdentityKey(symbol.file);
    if (seenFiles.has(fileKey)) continue;
    seenFiles.add(fileKey);

    const languageId = index.parsed?.get(fileKey)?.sup.id ?? supportForFile(symbol.file)?.id;
    if (!languageId) continue;

    // Python attributes are parsed, but normal instance receivers cannot yet be
    // proven through assignments or constructor calls. Keep its coverage claim
    // conservative until that lookup path has direct semantic coverage.
    const hasVerifiedReceiverResolution = languageId !== "python" && supportsReceiverMemberResolution(languageId);
    if (hasVerifiedReceiverResolution) {
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
