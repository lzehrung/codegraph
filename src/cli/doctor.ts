import fs from "node:fs";
import path from "node:path";
import {
  isNativeTreeSitterAvailable,
  getNativeTreeSitterLoadError,
  getNativeTreeSitterSupportedLanguageIds,
} from "../native/treeSitterNative.js";
import { getCodegraphPackageIdentity, type CodegraphPackageIdentity } from "./packageInfo.js";

type IndexedArtifactReport = {
  type: "jsonGraph" | "sqliteGraph" | "diskCache" | "unknown";
  path: string;
  exists: boolean;
  details?: Record<string, string | number | boolean>;
};

export type DoctorReport = {
  package: CodegraphPackageIdentity;
  native: {
    available: boolean;
    loadError?: string;
    supportedLanguageIds: string[];
  };
  indexArtifact?: IndexedArtifactReport;
};

function normalizePathForDisplay(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function pathExists(filePath: string): boolean {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function statIfExists(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function detectIndexedArtifactType(filePath: string): IndexedArtifactReport["type"] {
  const normalized = normalizePathForDisplay(filePath).toLowerCase();
  if (normalized.endsWith("/codegraph.json") || normalized.endsWith(".json")) {
    return "jsonGraph";
  }
  if (normalized.endsWith("/graph.sqlite") || normalized.endsWith(".sqlite")) {
    return "sqliteGraph";
  }
  if (normalized.endsWith("/.codegraph-cache") || normalized.includes("/.codegraph-cache/")) {
    return "diskCache";
  }
  return "unknown";
}

function buildIndexedArtifactReport(indexPath: string): IndexedArtifactReport {
  const resolvedPath = path.resolve(indexPath);
  const stats = statIfExists(resolvedPath);
  const type = detectIndexedArtifactType(resolvedPath);
  const diskCacheDir =
    type === "diskCache" && stats && !stats.isDirectory() && path.basename(resolvedPath) === "manifest.json"
      ? path.dirname(resolvedPath)
      : resolvedPath;
  let details:
    | {
        manifestPresent: boolean;
        sqlitePresent: boolean;
      }
    | {
        sizeBytes: number;
        isDirectory: boolean;
      }
    | undefined;
  if (stats && type === "diskCache") {
    details = {
      manifestPresent: pathExists(path.join(diskCacheDir, "manifest.json")),
      sqlitePresent: pathExists(path.join(diskCacheDir, "index-cache.sqlite")),
    };
  } else if (stats) {
    details = { sizeBytes: stats.size, isDirectory: stats.isDirectory() };
  }
  return {
    type,
    path: normalizePathForDisplay(resolvedPath),
    exists: !!stats,
    ...(details ? { details } : {}),
  };
}

export function buildDoctorReport(indexPath?: string): DoctorReport {
  const loadError = getNativeTreeSitterLoadError();
  return {
    package: getCodegraphPackageIdentity(),
    native: {
      available: isNativeTreeSitterAvailable(),
      ...(loadError ? { loadError: String(loadError) } : {}),
      supportedLanguageIds: getNativeTreeSitterSupportedLanguageIds(),
    },
    ...(indexPath ? { indexArtifact: buildIndexedArtifactReport(indexPath) } : {}),
  };
}
