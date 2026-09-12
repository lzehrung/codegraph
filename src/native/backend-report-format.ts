import type { BuildReport } from "../indexer/types.js";

/**
 * Pure formatters over an already-collected `BuildReport`. They live apart from
 * `native-backend-report.ts` because that module imports the native runtime, and the CLI's startup
 * path prints a degraded-backend line without ever loading the addon
 * (`tests/cli-startup-eager-modules.test.ts` bounds the startup module graph).
 */
export function listNativeBackendAffectedLanguages(report: BuildReport | undefined): string[] {
  const native = report?.backend?.native;
  if (!native) return [];
  return Object.entries(native.byLanguage)
    .filter(([, entry]) => entry.filesFellBack > 0)
    .map(([languageId]) => languageId)
    .sort((left, right) => left.localeCompare(right));
}

export function formatNativeBackendAffectedLanguages(report: BuildReport | undefined): string | undefined {
  const languages = listNativeBackendAffectedLanguages(report);
  if (!languages.length) return undefined;
  return `affected languages: ${languages.join(", ")}`;
}
