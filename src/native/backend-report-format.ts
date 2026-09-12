import type { BuildReport } from "../indexer/types.js";

/** Keep CLI formatting independent of native runtime loading. */
export function formatNativeBackendAffectedLanguages(report: BuildReport | undefined): string | undefined {
  const native = report?.backend?.native;
  if (!native) return undefined;
  const languages = Object.entries(native.byLanguage)
    .filter(([, entry]) => entry.filesFellBack > 0)
    .map(([languageId]) => languageId)
    .sort((left, right) => left.localeCompare(right));
  if (!languages.length) return undefined;
  return `affected languages: ${languages.join(", ")}`;
}
