import type { LanguageSupport } from "../languages.js";
import {
  getNativeTreeSitterLoadError,
  getNativeTreeSitterSupportedLanguageIds,
  getNativeQueryMetadataForSupport,
  isNativeTreeSitterAvailable,
} from "./treeSitterNative.js";
import type {
  BackendReport,
  BuildReport,
  NativeBackendFallbackReason,
  NativeBackendLanguageReport,
} from "../indexer.js";

export type NativeBackendOutcome = {
  usedNative: boolean;
  support?: LanguageSupport;
  file?: string;
  languageId?: string;
  fallbackReason?: NativeBackendFallbackReason;
  error?: string;
};

function stringifyNativeLoadError(error: unknown): string | undefined {
  if (!error) return undefined;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function initNativeBackendReport(
  report: BuildReport | undefined,
): BackendReport | undefined {
  if (!report) return undefined;
  if (!report.backend) {
    const loadError = stringifyNativeLoadError(getNativeTreeSitterLoadError());
    report.backend = {
      native: {
        available: isNativeTreeSitterAvailable(),
        enabled: false,
        supportedLanguageIds: getNativeTreeSitterSupportedLanguageIds(),
        filesUsed: 0,
        filesFellBack: 0,
        fallbackReasons: {
          unavailable: 0,
          unsupportedLanguage: 0,
          queryFailure: 0,
        },
        byLanguage: {},
        errors: [],
      },
    };
    if (loadError) {
      report.backend.native.loadError = loadError;
    }
  }
  return report.backend;
}

function getOrCreateNativeLanguageReport(
  backend: BackendReport,
  support: LanguageSupport,
): NativeBackendLanguageReport {
  const existing = backend.native.byLanguage[support.id];
  if (existing) {
    return existing;
  }
  const metadata = getNativeQueryMetadataForSupport(support);
  const created: NativeBackendLanguageReport = {
    filesSeen: 0,
    filesUsed: 0,
    filesFellBack: 0,
    fallbackReasons: {
      unavailable: 0,
      unsupportedLanguage: 0,
      queryFailure: 0,
    },
    ...(metadata.normalizedQueryKinds.length > 0
      ? { normalizedQueryKinds: [...metadata.normalizedQueryKinds] }
      : {}),
    ...(metadata.skippedQueryKinds.length > 0
      ? { skippedQueryKinds: [...metadata.skippedQueryKinds] }
      : {}),
  };
  backend.native.byLanguage[support.id] = created;
  return created;
}

export function recordNativeBackendOutcome(
  report: BuildReport | undefined,
  outcome: NativeBackendOutcome,
): void {
  const backend = initNativeBackendReport(report);
  if (!backend) return;
  const resolvedLanguageId = outcome.languageId ?? outcome.support?.id;
  if (outcome.support) {
    const languageReport = getOrCreateNativeLanguageReport(backend, outcome.support);
    languageReport.filesSeen += 1;
    if (outcome.usedNative) {
      languageReport.filesUsed += 1;
    } else if (outcome.fallbackReason) {
      languageReport.filesFellBack += 1;
      languageReport.fallbackReasons[outcome.fallbackReason] += 1;
    }
  }
  if (outcome.usedNative) {
    backend.native.enabled = true;
    backend.native.filesUsed += 1;
    return;
  }
  if (!outcome.fallbackReason) return;
  backend.native.filesFellBack += 1;
  backend.native.fallbackReasons[outcome.fallbackReason] += 1;
  if (
    outcome.error &&
    outcome.file &&
    resolvedLanguageId &&
    backend.native.errors.length < 20
  ) {
    backend.native.errors.push({
      file: outcome.file,
      languageId: resolvedLanguageId,
      reason: outcome.fallbackReason,
      message: outcome.error,
    });
  }
}
