import { logWithLevel, type LogLevel } from "../../logging.js";
import { stringifyUnknown } from "../../util/ast.js";
import type { BuildFileReport, BuildOptions, BuildReport, CacheReport, ManifestReport } from "../types.js";

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
