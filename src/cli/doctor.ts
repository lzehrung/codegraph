import fs from "node:fs";
import path from "node:path";
import {
  isNativeTreeSitterAvailable,
  getNativeTreeSitterLoadError,
  getNativeTreeSitterSupportedLanguageIds,
} from "../native/treeSitterNative.js";
import {
  getCodegraphPackageIdentity,
  normalizePathForDisplay,
  pathExists,
  type CodegraphPackageIdentity,
} from "./packageInfo.js";

type IndexedArtifactReport = {
  type: "jsonGraph" | "sqliteGraph" | "diskCache" | "artifactBundle" | "unknown";
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

function statIfExists(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function readArtifactManifest(dirPath: string): { artifacts: Record<string, string> } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dirPath, "manifest.json"), "utf8"));
    if (!isRecord(parsed)) return null;
    if (parsed.schemaVersion !== 1 || parsed.graphJsonSchema !== "codegraph.graph-json") return null;
    if (!isRecord(parsed.artifacts)) return null;
    const artifacts: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.artifacts)) {
      if (typeof value === "string") artifacts[key] = value;
    }
    return { artifacts };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function detectIndexedArtifactType(filePath: string, stats: fs.Stats | null): IndexedArtifactReport["type"] {
  if (stats?.isDirectory() && readArtifactManifest(filePath)) {
    return "artifactBundle";
  }
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
  const type = detectIndexedArtifactType(resolvedPath, stats);
  const diskCacheDir =
    type === "diskCache" && stats && !stats.isDirectory() && path.basename(resolvedPath) === "manifest.json"
      ? path.dirname(resolvedPath)
      : resolvedPath;
  const artifactManifest = type === "artifactBundle" ? readArtifactManifest(resolvedPath) : null;
  let details:
    | {
        manifestPresent: boolean;
        sqlitePresent: boolean;
      }
    | {
        manifestPresent: boolean;
        sqlitePresent: boolean;
        graphJsonPresent: boolean;
        reportPresent: boolean;
        questionsPresent: boolean;
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
  } else if (stats && artifactManifest) {
    details = {
      manifestPresent: true,
      sqlitePresent: artifactPresent(resolvedPath, artifactManifest.artifacts.sqlite),
      graphJsonPresent: artifactPresent(resolvedPath, artifactManifest.artifacts.graphJson),
      reportPresent: artifactPresent(resolvedPath, artifactManifest.artifacts.report),
      questionsPresent: artifactPresent(resolvedPath, artifactManifest.artifacts.questions),
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

function artifactPresent(dirPath: string, fileName: string | undefined): boolean {
  if (typeof fileName !== "string" || fileName.trim() === "" || path.isAbsolute(fileName)) return false;
  const artifactPath = path.resolve(dirPath, fileName);
  const bundleRoot = path.resolve(dirPath);
  const relativePath = path.relative(bundleRoot, artifactPath);
  if (relativePath === "" || relativePath.startsWith("..") || path.isAbsolute(relativePath)) return false;
  return pathExists(artifactPath);
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
