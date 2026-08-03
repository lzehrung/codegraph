import { buildProjectIndexIncremental } from "./build-index.js";
import type { IncrementalBuildOptions, ProjectIndex } from "./types.js";

/**
 * Scope of a current-repository-state index load.
 *
 * `project` lets discovery decide the file set, optionally unioning
 * `additionalFiles` (for example review targets outside discovery). `resolved-files`
 * declares an already resolved, complete file scope. Neither variant can express
 * "these files changed"; changed-file inputs belong to `buildProjectIndexIncremental`.
 */
export type CurrentProjectIndexScope =
  | { kind: "project"; additionalFiles?: readonly string[] }
  | { kind: "resolved-files"; files: readonly string[] };

/**
 * Build options accepted for current-state loads.
 *
 * Scope encoding and change-range selection are deliberately excluded: they are
 * expressed by {@link CurrentProjectIndexScope} or belong to specialized
 * incremental callers such as `graph-delta` and `drift`.
 */
export type LoadCurrentProjectIndexOptions = Omit<
  IncrementalBuildOptions,
  | "files"
  | "additionalFiles"
  | "filesAreProjectScope"
  | "gitBase"
  | "gitHead"
  | "changedSince"
  | "reconciledManifestUpdatedAt"
  | "reconciledWorkingTreeDiffFiles"
  | "reconciledUntrackedFiles"
>;

export type LoadCurrentProjectIndexRequest = {
  root: string;
  scope: CurrentProjectIndexScope;
  options?: LoadCurrentProjectIndexOptions;
};

/** Bound loader handed to command handlers so they cannot select a full-build path. */
export type CurrentProjectIndexLoader = () => Promise<ProjectIndex>;

const NON_CURRENT_STATE_OPTION_KEYS = [
  "files",
  "additionalFiles",
  "filesAreProjectScope",
  "gitBase",
  "gitHead",
  "changedSince",
  "reconciledManifestUpdatedAt",
  "reconciledWorkingTreeDiffFiles",
  "reconciledUntrackedFiles",
] as const;

/**
 * Translate a current-state request into incremental build options.
 *
 * The disk cache is the default because current-state queries must validate
 * persisted state instead of rebuilding; an explicit `off`/`memory`/`disk` mode
 * from the caller always wins.
 */
export function currentProjectIndexBuildOptions(
  scope: CurrentProjectIndexScope,
  options?: LoadCurrentProjectIndexOptions,
): IncrementalBuildOptions {
  const buildOptions: IncrementalBuildOptions = { ...options };
  // Callers may forward a wider options object; strip anything that would be
  // reinterpreted as scope or as a changed-file range.
  for (const key of NON_CURRENT_STATE_OPTION_KEYS) {
    delete buildOptions[key];
  }
  buildOptions.cache = options?.cache ?? "disk";
  if (scope.kind === "resolved-files") {
    buildOptions.files = [...scope.files];
    buildOptions.filesAreProjectScope = true;
    return buildOptions;
  }
  if (scope.additionalFiles?.length) {
    buildOptions.additionalFiles = [...scope.additionalFiles];
  }
  return buildOptions;
}

/**
 * Load the index for current repository state.
 *
 * All freshness decisions (manifest compatibility, discovery/config/native/graph
 * options, file signatures, Git reconciliation, snapshot validation, dependent
 * invalidation, and rebuild fallback) stay in `buildProjectIndexIncremental`.
 * This helper only encodes intent: current state, declared scope, disk default.
 */
export async function loadCurrentProjectIndex(request: LoadCurrentProjectIndexRequest): Promise<ProjectIndex> {
  return await buildProjectIndexIncremental(
    request.root,
    currentProjectIndexBuildOptions(request.scope, request.options),
  );
}

/** Bind a project-scope loader for handlers that receive index loading by injection. */
export function createCurrentProjectIndexLoader(
  root: string,
  options?: LoadCurrentProjectIndexOptions,
  scope: CurrentProjectIndexScope = { kind: "project" },
): CurrentProjectIndexLoader {
  return async () => await loadCurrentProjectIndex({ root, scope, ...(options ? { options } : {}) });
}
