import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isMissingPathError } from "../util/errors.js";
import type { ProjectFileDiscoveryOptions } from "../util/project-files.js";
import { isForbiddenAnchor, normalizePath, resolveFilePathFromRoot } from "../util/paths.js";
import { getCliCommandUsage } from "./options.js";

// A slash- or backslash-prefixed path is drive-relative on Windows. Node resolves it
// against the current drive, but resolveFilePathFromRoot leaves it unchanged because
// path.posix considers it absolute. Route those non-UNC paths through path.win32.resolve
// so later confinement checks receive a drive-qualified root.
const WINDOWS_DRIVE_QUALIFIED_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_DRIVE_RELATIVE_ROOT_PATTERN = /^[\\/](?![\\/])/;
function resolveAbsoluteProjectRoot(cwd: () => string, candidate: string): string {
  if (
    process.platform === "win32" &&
    WINDOWS_DRIVE_RELATIVE_ROOT_PATTERN.test(candidate) &&
    !WINDOWS_DRIVE_QUALIFIED_PATTERN.test(candidate)
  ) {
    return path.win32.resolve(cwd(), candidate);
  }
  return resolveFilePathFromRoot(cwd(), candidate);
}

export function looksLikeGlobPattern(baseRoot: string, value: string): boolean {
  const hasGlobSyntax =
    /[*?]/.test(value) || (value.includes("{") && value.includes("}")) || (value.includes("[") && value.includes("]"));
  if (!hasGlobSyntax) return false;
  return !fs.existsSync(resolveFilePathFromRoot(baseRoot, value));
}

function invalidGlobRootMessage(command: string, value: string): string {
  return `Invalid ${command} path "${value}". Positional paths are scan roots, not glob patterns. Repeat --ignore-glob or --include-glob for each glob filter.`;
}

export function isExistingDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath, { throwIfNoEntry: false })?.isDirectory() ?? false;
  } catch {
    return false;
  }
}

export function isLifecycleCommand(command: string): command is "init" | "status" | "sync" | "uninit" {
  return command === "init" || command === "status" || command === "sync" || command === "uninit";
}

export function acceptsOptionalProjectRoot(command: string): boolean {
  return (
    command === "apisurface" ||
    command === "graph-delta" ||
    command === "links" ||
    command === "review" ||
    command === "unresolved"
  );
}

/** Commands whose single positional may name the project root (back-compat form). */
function usesLegacyRootPositional(command: string): boolean {
  return (
    command === "graph" ||
    command === "graph-delta" ||
    command === "index" ||
    command === "hotspots" ||
    command === "inspect" ||
    command === "duplicates" ||
    command === "impact" ||
    command === "review" ||
    command === "apisurface" ||
    command === "links" ||
    command === "unresolved" ||
    isLifecycleCommand(command)
  );
}

export function supportsIncludeRoots(command: string): boolean {
  return (
    command === "graph" ||
    command === "index" ||
    command === "hotspots" ||
    command === "inspect" ||
    command === "duplicates" ||
    command === "drift" ||
    command === "orient" ||
    command === "cycles"
  );
}

export function assertValidIncludeRoots(command: string, baseRoot: string, includeRoots: readonly string[]): void {
  const globLikeRoot = includeRoots.find((includeRoot) => looksLikeGlobPattern(baseRoot, includeRoot));
  if (!globLikeRoot) return;
  throw new Error(invalidGlobRootMessage(command, globLikeRoot));
}

export type CliRootPolicyResult = { status: "ok"; projectRootFs: string } | { status: "error"; messages: string[] };

/** Find lifecycle state without crossing Git, home, or filesystem-root boundaries. */
export function discoverCodegraphLifecycleRoot(
  startDirectory: string,
  homedir: string = os.homedir(),
): CliRootPolicyResult {
  const start = path.resolve(startDirectory);
  let realCandidate: string;
  try {
    realCandidate = fs.realpathSync.native(start);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "error",
      messages: [`Current directory ${start} is not accessible: ${message}. cd to the project directory and rerun.`],
    };
  }
  const realHome = realpathForDiscovery(path.resolve(homedir));
  const caseInsensitive = process.platform === "win32" || process.platform === "darwin";

  let candidate = start;
  let childName: string | undefined;
  let candidatePath = start;
  try {
    while (true) {
      const atDiscoveryBoundary = isLifecycleDiscoveryBoundary(
        candidate,
        realCandidate,
        homedir,
        realHome,
        caseInsensitive,
      );
      if (candidate !== start && atDiscoveryBoundary) break;
      candidatePath = path.join(candidate, ".codegraph");
      const state = lstatRootCandidate(candidatePath);
      if (state?.isDirectory() && !state.isSymbolicLink()) {
        candidatePath = path.join(candidatePath, "manifest.json");
        const manifest = lstatRootCandidate(candidatePath);
        if (manifest?.isFile()) return { status: "ok", projectRootFs: candidate };
      }
      if (atDiscoveryBoundary) break;

      const isStateDirectory = sameDiscoveryPath(path.basename(candidate), ".codegraph", caseInsensitive);
      const parent = path.dirname(candidate);
      if (isStateDirectory) {
        const isStateCache = candidate === start || sameDiscoveryPath(childName ?? "", "cache", caseInsensitive);
        if (isStateCache) {
          const realParent = realpathForDiscovery(parent);
          if (!isLifecycleDiscoveryBoundary(parent, realParent, homedir, realHome, caseInsensitive)) {
            return { status: "ok", projectRootFs: parent };
          }
          break;
        }
      }

      candidatePath = path.join(candidate, ".git");
      const git = lstatRootCandidate(candidatePath);
      if (git) break;
      if (parent === candidate) break;
      childName = path.basename(candidate);
      candidate = parent;
      realCandidate = realpathForDiscovery(parent);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "error",
      messages: [`Unable to discover Codegraph lifecycle root at ${candidatePath}: ${message}`],
    };
  }
  return { status: "ok", projectRootFs: start };
}

function realpathForDiscovery(candidate: string): string {
  try {
    return fs.realpathSync.native(candidate);
  } catch {
    return candidate;
  }
}

function sameDiscoveryPath(left: string, right: string, caseInsensitive: boolean): boolean {
  const normalizedLeft = normalizePath(left);
  const normalizedRight = normalizePath(right);
  if (caseInsensitive) return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  return normalizedLeft === normalizedRight;
}

function isLifecycleDiscoveryBoundary(
  candidate: string,
  realCandidate: string,
  homedir: string,
  realHome: string,
  caseInsensitive: boolean,
): boolean {
  if (isForbiddenAnchor(candidate, homedir, caseInsensitive)) return true;
  if (isForbiddenAnchor(realCandidate, homedir, caseInsensitive)) return true;
  return (
    sameDiscoveryPath(candidate, realHome, caseInsensitive) ||
    sameDiscoveryPath(realCandidate, realHome, caseInsensitive)
  );
}

function lstatRootCandidate(target: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(target, { throwIfNoEntry: false });
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

/**
 * Positional/root policy for every command: legacy root positionals, lifecycle
 * root rules, and the optional-project-root commands. Pure policy — callers own
 * stderr/exit handling for the error case.
 */
export function resolveCliRootPolicy(input: {
  command: string;
  positionals: readonly string[];
  rootOpt: string | undefined;
  cwd: () => string;
}): CliRootPolicyResult {
  const { command, positionals, rootOpt, cwd } = input;
  const resolveAbs = (p: string) => resolveAbsoluteProjectRoot(cwd, p);
  if (command === "impact" && positionals.length) {
    const impactRootArg = positionals[0]!;
    const resolvedImpactRoot = resolveAbs(impactRootArg);
    const isLegacyImpactRoot = !rootOpt && isExistingDirectory(resolvedImpactRoot);
    if (!isLegacyImpactRoot) {
      return {
        status: "error",
        messages: [`Unexpected positional argument for impact: ${impactRootArg}`, getCliCommandUsage("impact")],
      };
    }
  }

  const firstPositionalRoot = positionals.length === 1 ? resolveAbs(positionals[0]!) : undefined;
  if (isLifecycleCommand(command) && rootOpt && positionals.length) {
    return {
      status: "error",
      messages: [
        `Invalid ${command} path "${positionals[0]!}". Positional paths cannot be combined with --root for lifecycle commands.`,
      ],
    };
  }
  if (
    isLifecycleCommand(command) &&
    !rootOpt &&
    firstPositionalRoot !== undefined &&
    !isExistingDirectory(firstPositionalRoot)
  ) {
    return {
      status: "error",
      messages: [`Invalid ${command} path "${positionals[0]!}". Expected an existing directory or use --root <path>.`],
    };
  }
  if (acceptsOptionalProjectRoot(command) && rootOpt && positionals.length) {
    return { status: "error", messages: [`Positional project root cannot be combined with --root for ${command}.`] };
  }
  if (
    acceptsOptionalProjectRoot(command) &&
    !rootOpt &&
    firstPositionalRoot !== undefined &&
    !isExistingDirectory(firstPositionalRoot)
  ) {
    return {
      status: "error",
      messages: [`Invalid ${command} project root "${positionals[0]!}". Expected an existing directory.`],
    };
  }
  if (
    usesLegacyRootPositional(command) &&
    !isLifecycleCommand(command) &&
    !acceptsOptionalProjectRoot(command) &&
    !rootOpt &&
    firstPositionalRoot !== undefined &&
    !isExistingDirectory(firstPositionalRoot)
  ) {
    const positional = positionals[0]!;
    if (looksLikeGlobPattern(cwd(), positional)) {
      return { status: "error", messages: [invalidGlobRootMessage(command, positional)] };
    }
    return {
      status: "error",
      messages: [`Invalid ${command} path "${positional}". Expected an existing directory or use --root <path>.`],
    };
  }

  if (rootOpt) return { status: "ok", projectRootFs: resolveAbs(rootOpt) };
  const hasPositionalProjectRoot =
    usesLegacyRootPositional(command) && firstPositionalRoot !== undefined && isExistingDirectory(firstPositionalRoot);
  if (hasPositionalProjectRoot) return { status: "ok", projectRootFs: firstPositionalRoot };
  const startDirectory = cwd();
  if (isLifecycleCommand(command)) return discoverCodegraphLifecycleRoot(startDirectory);
  return { status: "ok", projectRootFs: startDirectory };
}

export type CliDiscoveryGlobPolicy = {
  cliGlobDiscoveryOptions: ProjectFileDiscoveryOptions;
  activeCliRootGlobDiscoveryOptions: ProjectFileDiscoveryOptions;
  cliGitignoreDiscoveryOptions: ProjectFileDiscoveryOptions;
  hasCliDiscoveryGlobs: boolean;
};

/**
 * CLI discovery-glob flags: --include-glob/--ignore-glob are one-off filters
 * relative to each active scan root; --include-root-glob/--ignore-root-glob
 * currently apply only to duplicates.
 */
export function resolveCliDiscoveryGlobPolicy(
  command: string,
  parsed: { options: ReadonlyMap<string, string[]>; flags: ReadonlySet<string> },
): CliDiscoveryGlobPolicy {
  const includeGlobs = parsed.options.get("--include-glob") ?? [];
  const scanIgnoreGlobs = parsed.options.get("--ignore-glob") ?? [];
  const rootIncludeGlobs = parsed.options.get("--include-root-glob") ?? [];
  const rootIgnoreGlobs = parsed.options.get("--ignore-root-glob") ?? [];
  const cliGlobDiscoveryOptions: ProjectFileDiscoveryOptions = {
    ...(includeGlobs.length ? { includeGlobs } : {}),
    ...(scanIgnoreGlobs.length ? { ignoreGlobs: scanIgnoreGlobs } : {}),
  };
  const supportsRootDiscoveryGlobs = command === "duplicates";
  if (!supportsRootDiscoveryGlobs && (rootIncludeGlobs.length || rootIgnoreGlobs.length)) {
    throw new Error("The --include-root-glob and --ignore-root-glob flags are currently supported only by duplicates.");
  }
  const activeCliRootGlobDiscoveryOptions: ProjectFileDiscoveryOptions = supportsRootDiscoveryGlobs
    ? {
        ...(rootIncludeGlobs.length ? { includeGlobs: rootIncludeGlobs } : {}),
        ...(rootIgnoreGlobs.length ? { ignoreGlobs: rootIgnoreGlobs } : {}),
      }
    : {};
  const cliGitignoreDiscoveryOptions: ProjectFileDiscoveryOptions = {
    ...(parsed.flags.has("--no-gitignore") ? { useGitignore: false } : {}),
  };
  const hasCliDiscoveryGlobs = Boolean(
    includeGlobs.length ||
    scanIgnoreGlobs.length ||
    activeCliRootGlobDiscoveryOptions.includeGlobs?.length ||
    activeCliRootGlobDiscoveryOptions.ignoreGlobs?.length,
  );
  return {
    cliGlobDiscoveryOptions,
    activeCliRootGlobDiscoveryOptions,
    cliGitignoreDiscoveryOptions,
    hasCliDiscoveryGlobs,
  };
}

/**
 * Include-root positional policy. Throws (top-level catch reports it) when a
 * lone positional is glob-shaped, matching the historical dispatcher behavior.
 */
export function resolveCliIncludeRoots(input: {
  command: string;
  positionals: readonly string[];
  rootOpt: string | undefined;
  cwd: () => string;
}): string[] {
  const { command, positionals, rootOpt, cwd } = input;
  if (!supportsIncludeRoots(command)) return [];
  if (rootOpt) {
    // If the user explicitly sets --root, treat all remaining positionals as include roots.
    return [...positionals];
  }
  if (command === "orient" || command === "drift") {
    // Orient and drift use positionals only as include roots; they do not use the legacy root positional.
    return [...positionals];
  }
  if (positionals.length > 1) {
    // Otherwise, a single positional arg is treated as the project root (back-compat).
    return [...positionals];
  }
  if (positionals.length === 1 && looksLikeGlobPattern(cwd(), positionals[0]!)) {
    throw new Error(invalidGlobRootMessage(command, positionals[0]!));
  }
  return [];
}
