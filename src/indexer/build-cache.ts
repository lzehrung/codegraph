export {
  MANIFEST_VERSION,
  collectWorkspaceManifestDependencyEdges,
  computeConfigHash,
  loadManifest,
  normalizeIndexedFileInputs,
  normalizeIndexedFileInputsWithinRoot,
  sanitizeManifestEntriesForRoot,
  sanitizeManifestTransientFilesForRoot,
  transformManifestEntries,
  verifyManifestEntries,
  writeManifest,
  type IndexManifest,
  type ManifestFileEntry,
} from "./build-cache/manifest.js";
export {
  buildBloomFilterForFile,
  cacheSignatureForFile,
  clearMemoryCache,
  closeDiskCacheDatabase,
  fileSignature,
  pruneDiskModuleCache,
  tryLoadFromCache,
  writeModulesToCache,
  writeToCache,
  type FileSignature,
  type PendingModuleCacheWrite,
} from "./build-cache/module-cache.js";
export { cacheRoot, resolveCacheLocation } from "./build-cache/location.js";
export {
  BLOOM_FILTER_SNAPSHOT_FILENAME,
  BLOOM_FILTER_SNAPSHOT_VERSION,
  createProjectSnapshotIdentity,
  projectSnapshotFilesSignature,
  tryLoadDetailedSymbolGraphSnapshot,
  tryLoadPersistedBloomFilters,
  tryLoadProjectSnapshotModules,
  tryLoadProjectIndexSnapshot,
  writeDetailedSymbolGraphSnapshot,
  writeProjectIndexSnapshot,
} from "./build-cache/project-snapshot.js";
export {
  diffBuildOptions,
  graphOptionsEqual,
  normalizeGraphOptions,
  normalizeLanguageExtensions,
  summarizeBuildOptions,
  type ManifestBuildOptions,
} from "./build-cache/options.js";
export {
  createFallbackImportExtractionHandler,
  initCacheReport,
  initFileReport,
  initManifestReport,
  recordConfigHashResult,
  recordFileFailure,
} from "./build-cache/reports.js";
