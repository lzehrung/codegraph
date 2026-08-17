import { supportsReducedModeRegexRecovery } from "../../native/treeSitterNative.js";
import type { FallbackImportExtractionEvent } from "../../graphs/specifiers.js";
import { logWithLevel, type LogLevel } from "../../logging.js";
import { stringifyUnknown } from "../../util/ast.js";
import type {
  BuildFileReport,
  BuildOptions,
  BuildReport,
  CacheReport,
  FallbackImportExtractionReport,
  ManifestReport,
} from "../types.js";

export function initCacheReport(
  report: BuildReport | undefined,
  mode: BuildOptions["cache"] | undefined,
): CacheReport | undefined {
  if (!report) return undefined;
  if (!report.cache) {
    report.cache = { mode: mode ?? "off", hits: 0, misses: 0 };
  }
  return report.cache;
}

export function initFileReport(report: BuildReport | undefined): BuildFileReport | undefined {
  if (!report) return undefined;
  if (!report.files) {
    report.files = { total: 0, cached: 0, parsed: 0 };
  }
  return report.files;
}

export function recordFileFailure(report: BuildReport | undefined, file: string, error: unknown): void {
  const fileReport = initFileReport(report);
  if (!fileReport) return;
  fileReport.failed = (fileReport.failed ?? 0) + 1;
  const errors = fileReport.errors ?? [];
  if (errors.length < 20) {
    errors.push({
      file: file.replace(/\\/g, "/"),
      message: stringifyUnknown(error),
    });
  }
  fileReport.errors = errors;
}

function initFallbackImportExtractionReport(
  report: BuildReport | undefined,
): FallbackImportExtractionReport | undefined {
  if (!report) return undefined;
  if (!report.graph) {
    report.graph = {
      fallbackImportExtraction: {
        total: 0,
        byLanguage: {},
        byReason: {
          fast: 0,
          "reduced-mode": 0,
          "query-error": 0,
          "query-empty": 0,
        },
        files: {},
      },
    };
  } else if (!report.graph.fallbackImportExtraction) {
    report.graph.fallbackImportExtraction = {
      total: 0,
      byLanguage: {},
      byReason: {
        fast: 0,
        "reduced-mode": 0,
        "query-error": 0,
        "query-empty": 0,
      },
      files: {},
    };
  }
  return report.graph.fallbackImportExtraction;
}

export function createFallbackImportExtractionHandler(
  report: BuildReport | undefined,
  opts?: BuildOptions,
): ((event: FallbackImportExtractionEvent) => void) | undefined {
  const fallbackReport = initFallbackImportExtractionReport(report);
  const warned = new Set<string>();
  const logLevel = opts?.logLevel ?? "warn";
  const shouldLog = logLevel !== "silent" && logLevel !== "error";

  return (event: FallbackImportExtractionEvent) => {
    const filePath = event.file ? event.file.replace(/\\/g, "/") : "unknown";
    if (fallbackReport) {
      if (!fallbackReport.files[filePath]) {
        fallbackReport.total += 1;
        fallbackReport.byLanguage[event.language] = (fallbackReport.byLanguage[event.language] ?? 0) + 1;
        fallbackReport.byReason ??= {
          fast: 0,
          "reduced-mode": 0,
          "query-error": 0,
          "query-empty": 0,
        };
        fallbackReport.byReason[event.reason] += 1;
      }
      fallbackReport.files[filePath] = {
        language: event.language,
        reason: event.reason,
      };
    }
    if (!shouldLog) return;
    const warningKey = `${event.language}:${event.reason}`;
    if (warned.has(warningKey)) return;
    warned.add(warningKey);
    const severity =
      event.reason === "fast" || event.reason === "reduced-mode" || supportsReducedModeRegexRecovery(event.language)
        ? "debug"
        : "warn";
    let message: string;
    if (event.reason === "reduced-mode") {
      message = `Native parser unavailable for ${event.language}; using reduced import extraction.`;
    } else if (event.reason === "fast") {
      message = `Fast mode active for ${event.language}; using regex-based import extraction instead of the native parser.`;
    } else if (supportsReducedModeRegexRecovery(event.language)) {
      message = `Native import recovery degraded for ${event.language}; using native-owned fallback extraction.`;
    } else if (event.reason === "query-error") {
      message = `Native import query failed for ${event.language}; using regex-based fallback extraction.`;
    } else {
      message = `Native import query returned no results for ${event.language}; using regex-based fallback extraction to recover additional imports.`;
    }
    logWithLevel(opts?.logLevel, severity, message, {
      language: event.language,
      reason: event.reason,
    });
  };
}

export function initManifestReport(
  report: BuildReport | undefined,
  used: boolean,
  reused: boolean,
): ManifestReport | undefined {
  if (!report) return undefined;
  if (!report.manifest) {
    report.manifest = { used, reused };
  } else {
    report.manifest.used = used;
    report.manifest.reused = reused;
  }
  return report.manifest;
}

export function recordConfigHashResult(
  manifestReport: ManifestReport | undefined,
  configHashResult: { hash: string; error?: string },
  logLevel: LogLevel | undefined,
): string {
  if (!configHashResult.error) return configHashResult.hash;
  if (manifestReport) {
    manifestReport.configHashError = configHashResult.error;
  }
  logWithLevel(logLevel, "warn", `Warning: ${configHashResult.error}`);
  return configHashResult.hash;
}
