export { sliceText, stringifyUnknown, toRange, unquote } from "./util/ast.js";
export {
  maskJsLikeCommentsAndStrings,
  parseJsonc,
  stripJsLikeComments,
  stripJsonTrailingCommas,
  stripPythonCommentsAndStrings,
} from "./util/comments.js";
export {
  getGitBlobHashes,
  getGitHead,
  getUnifiedDiff,
  assertSafeRevision,
  gitDiffArgs,
  isGitIndexSentinel,
  isGitRepo,
  isGitWorktreeSentinel,
  listChangedFiles,
  listUntrackedFiles,
} from "./util/git.js";
export {
  assertFilePathWithinRoot,
  isAbsoluteFilePath,
  isFilePathWithinRoot,
  normalizePath,
  normalizeResolutionHints,
  resolveFilePathFromRoot,
  toProjectDisplayPath,
  toProjectRelativePath,
} from "./util/paths.js";
export {
  DEFAULT_PROJECT_FILE_IGNORES,
  DEFAULT_PROJECT_MANIFESTS,
  DEFAULT_PROJECT_PATTERNS,
  discoverProjectFiles,
  listProjectFiles,
} from "./util/projectFiles.js";
export type {
  GitCandidateSet,
  GitignoreSource,
  ProjectFileDiscoveryOptions,
  ProjectFileInfo,
  ProjectFileKind,
  ProjectFileRole,
  ProjectFileType,
} from "./util/projectFiles.js";
export { extractJsTsDynamicSpecifiers, extractJsTsSpecifiers, extractPythonSpecifiers } from "./util/specifiers.js";
export type { ModuleSpecifier } from "./util/specifiers.js";
export {
  fileExists,
  listWorkspacePackageResolutionCandidates,
  loadJSON,
  loadWorkspaceConfig,
  resolvePackageSubpath,
  resolveWorkspacePackage,
} from "./util/workspace.js";
export type { WorkspaceConfig, WorkspacePackageInfo } from "./util/workspace.js";
export { mapLimit } from "./util/concurrency.js";
export {
  GRAPH_ONLY_RESOLUTION_EXTENSIONS,
  clearImportResolutionCaches,
  clearResolutionCaches,
  getGraphOnlyResolutionExtensions,
  getPhpComposerImplicitFiles,
  listResolutionCandidates,
  loadNearestTsconfigFor,
  resolveGoImportPath,
  resolveImportSpecifier,
  resolvePathLikeModule,
  resolvePythonModule,
  resolveSpecifier,
  resolveJvmPackageImportPaths,
} from "./util/resolution.js";
export type { FileId, MatchPathFn } from "./util/resolution.js";
