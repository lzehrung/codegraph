import fsp from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { errorMessage, isFileSystemErrorCode } from "../util/errors.js";
import { normalizePath } from "../util/paths.js";

/** Discovery-only bounds, not limits on the selected project's index or source-file sizes. */
export const MCP_ROOT_PREFLIGHT_LIMITS = Object.freeze({
  ancestorDirectories: 128,
  directories: 512,
  directoryDepth: 16, // The selected root is depth zero.
  entries: 16_384, // Includes files, directories, links, and ignored directory names.
  entryNameBytes: 512 * 1024, // Cumulative UTF-8 directory-entry names; no file contents are read.
  elapsedMs: 2_000, // Checked between filesystem operations, not an OS I/O cancellation deadline.
});

// These prune only the preflight, without changing project-file discovery or configured includes.
// Keep Git metadata opaque, including worktree/submodule pointers in regular .git files.
const SKIPPED_DIRECTORIES: Readonly<Record<string, true>> = {
  ".git": true,
  ".hg": true,
  ".svn": true,
  ".codegraph": true,
  ".codegraph-cache": true,
  node_modules: true,
  bower_components: true,
  vendor: true,
  pods: true,
  ".venv": true,
  venv: true,
  "site-packages": true,
  __pycache__: true,
  ".tox": true,
  ".nox": true,
  ".cache": true,
  ".npm": true,
  ".yarn": true,
  ".pnpm-store": true,
  ".cargo": true,
  ".gradle": true,
  ".m2": true,
  ".nuget": true,
  ".pytest_cache": true,
  ".mypy_cache": true,
  ".ruff_cache": true,
  ".parcel-cache": true,
  ".sass-cache": true,
  ".terraform": true,
  ".turbo": true,
  ".next": true,
  ".nuxt": true,
  ".svelte-kit": true,
  ".angular": true,
  ".build": true,
  ".swiftpm": true,
  ".nyc_output": true,
  coverage: true,
  dist: true,
  build: true,
  target: true,
  out: true,
  bin: true,
  obj: true,
};

const ROOT_SCOPE_REMEDIES =
  "Select one project with --root <project>, configure projects with --workspace <config>, " +
  "or intentionally permit this root with --allow-parent-root.";

type RootScopeCode = "MCP_ROOT_SCOPE_UNKNOWN" | "MCP_ROOT_SELECTION_REQUIRED";

type PreflightState = {
  root: string;
  startedAt: number;
  entries: number;
  entryNameBytes: number;
  projects: string[];
};

class McpRootScopeError extends Error {
  constructor(
    readonly code: RootScopeCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "McpRootScopeError";
  }
}

function scopeUnknown(state: PreflightState, reason: string, cause?: unknown): McpRootScopeError {
  let knownProjects = "";
  if (state.projects.length) {
    knownProjects = `\nGit project observed (not a complete inventory): ${JSON.stringify(state.projects[0])}.`;
  }
  return new McpRootScopeError(
    "MCP_ROOT_SCOPE_UNKNOWN",
    `MCP root scope unknown for ${JSON.stringify(state.root)}: ${reason}. ` +
      `The bounded preflight could not establish a single-project scope.${knownProjects}\n${ROOT_SCOPE_REMEDIES}`,
    { cause },
  );
}

function selectionRequired(state: PreflightState): McpRootScopeError {
  const projects = state.projects
    .sort()
    .map((project) => `  - ${JSON.stringify(project)}`)
    .join("\n");
  return new McpRootScopeError(
    "MCP_ROOT_SELECTION_REQUIRED",
    `MCP project selection required for ${JSON.stringify(state.root)}: found at least two independent Git projects.\n` +
      `${projects}\nPreflight stopped after two projects; this is not a complete inventory.\n${ROOT_SCOPE_REMEDIES}`,
  );
}

function assertTimeBudget(state: PreflightState): void {
  if (performance.now() - state.startedAt >= MCP_ROOT_PREFLIGHT_LIMITS.elapsedMs) {
    throw scopeUnknown(state, `elapsed discovery budget exhausted (${MCP_ROOT_PREFLIGHT_LIMITS.elapsedMs} ms)`);
  }
}

async function hasGitMarker(directory: string): Promise<boolean> {
  try {
    const marker = await fsp.lstat(path.join(directory, ".git"));
    return marker.isDirectory() || marker.isFile();
  } catch (error) {
    if (isFileSystemErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function hasOwningGitProject(realRoot: string, state: PreflightState): Promise<boolean> {
  let directory = realRoot;
  for (let count = 0; count < MCP_ROOT_PREFLIGHT_LIMITS.ancestorDirectories; count += 1) {
    assertTimeBudget(state);
    const hasMarker = await hasGitMarker(directory);
    assertTimeBudget(state);
    if (hasMarker) return true;
    const parent = path.dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
  throw scopeUnknown(
    state,
    `owning-project discovery budget exhausted (${MCP_ROOT_PREFLIGHT_LIMITS.ancestorDirectories} ancestor directories)`,
  );
}

/**
 * Reject an unselected parent of multiple independent Git projects before automatic MCP setup.
 * An owning Git root/subdirectory is already selected; a complete scan with zero or one nested
 * Git project is also allowed. Nested Git projects are boundaries, not trees to scan for more
 * projects. Explicit root aliases are resolved once; discovered links are never traversed.
 */
export async function assertMcpRootScope(root: string, options: { allowParentRoot?: boolean } = {}): Promise<void> {
  if (options.allowParentRoot) return;

  const state: PreflightState = {
    root: normalizePath(path.resolve(root)),
    startedAt: performance.now(),
    entries: 0,
    entryNameBytes: 0,
    projects: [],
  };
  let operation = "resolve the selected root";
  try {
    const realRoot = await fsp.realpath(path.resolve(root));
    const rootStat = await fsp.lstat(realRoot);
    if (!rootStat.isDirectory()) throw scopeUnknown(state, "the selected root is not a directory");

    operation = "check the selected root's owning Git project";
    if (await hasOwningGitProject(realRoot, state)) return;

    const directories = [{ directory: realRoot, depth: 0 }];
    for (let index = 0; index < directories.length; index += 1) {
      const current = directories[index]!;
      const relative = normalizePath(path.relative(realRoot, current.directory));
      operation = `inspect directory ${JSON.stringify(relative || ".")}`;
      assertTimeBudget(state);
      const stat = await fsp.lstat(current.directory);
      if (stat.isSymbolicLink()) continue;
      if (!stat.isDirectory()) {
        throw scopeUnknown(state, `a directory changed type during discovery (${JSON.stringify(relative || ".")})`);
      }
      if (index && (await hasGitMarker(current.directory))) {
        state.projects.push(relative);
        if (state.projects.length > 1) throw selectionRequired(state);
        continue;
      }

      const directory = await fsp.opendir(current.directory, { bufferSize: 32 });
      try {
        while (true) {
          assertTimeBudget(state);
          const entry = await directory.read();
          assertTimeBudget(state);
          if (!entry) break;
          state.entries += 1;
          if (state.entries > MCP_ROOT_PREFLIGHT_LIMITS.entries) {
            throw scopeUnknown(
              state,
              `directory-entry discovery budget exceeded (${MCP_ROOT_PREFLIGHT_LIMITS.entries} entries)`,
            );
          }
          state.entryNameBytes += Buffer.byteLength(entry.name, "utf8");
          if (state.entryNameBytes > MCP_ROOT_PREFLIGHT_LIMITS.entryNameBytes) {
            throw scopeUnknown(
              state,
              `entry-name discovery byte budget exceeded (${MCP_ROOT_PREFLIGHT_LIMITS.entryNameBytes} UTF-8 bytes)`,
            );
          }
          if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
          if (Object.hasOwn(SKIPPED_DIRECTORIES, entry.name.toLowerCase())) continue;
          if (current.depth >= MCP_ROOT_PREFLIGHT_LIMITS.directoryDepth) {
            throw scopeUnknown(
              state,
              `directory-depth discovery budget exceeded (${MCP_ROOT_PREFLIGHT_LIMITS.directoryDepth} levels)`,
            );
          }
          if (directories.length >= MCP_ROOT_PREFLIGHT_LIMITS.directories) {
            throw scopeUnknown(
              state,
              `directory discovery budget exceeded (${MCP_ROOT_PREFLIGHT_LIMITS.directories} directories)`,
            );
          }
          directories.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 });
        }
      } finally {
        await directory.close();
      }
    }
    assertTimeBudget(state);
  } catch (error) {
    if (error instanceof McpRootScopeError) throw error;
    let detail = errorMessage(error);
    if (error instanceof Error && "code" in error) detail = String(error.code);
    throw scopeUnknown(state, `could not ${operation} (${detail})`, error);
  }
}
