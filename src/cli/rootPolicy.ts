import fs from "node:fs";
import path from "node:path";
import type { NativeRuntimeMode } from "../native/treeSitterNative.js";
import type { ProjectFileDiscoveryOptions } from "../util/projectFiles.js";
import { resolveFilePathFromRoot } from "../util/paths.js";

// Node's path.posix.isAbsolute treats a leading "/" as absolute even on Windows, where such a
// path is actually drive-relative: the OS resolves it against the *current* drive, not a real
// filesystem root. resolveFilePathFromRoot returns already-absolute paths unchanged, so a
// driveless `--root /tmp/x` never gains a drive letter and every later confinement check
// (which compares against drive-qualified discovered file paths) fails with "outside project
// root" (probe V10). Detect exactly that shape and route it through path.win32.resolve, which
// injects the same drive Node itself would use.
const WINDOWS_DRIVE_QUALIFIED_PATTERN = /^[A-Za-z]:[\\/]/;
function resolveAbsoluteProjectRoot(cwd: () => string, candidate: string): string {
  if (
    process.platform === "win32" &&
    path.posix.isAbsolute(candidate) &&
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

export function parseNativeRuntimeMode(value: string | undefined): NativeRuntimeMode {
  if (value === undefined) return "auto";
  if (value === "auto" || value === "on" || value === "off") {
    return value;
  }
  throw new Error(`Invalid --native value "${value}". Expected auto|on|off.`);
}

export type CliRootPolicyResult = { status: "ok"; projectRootFs: string } | { status: "error"; messages: string[] };

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
        messages: [
          `Unexpected positional argument for impact: ${impactRootArg}`,
          "Usage: codegraph impact [project-root] [--provider git|github|raw] [options]",
        ],
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

  const defaultProjectRoot =
    usesLegacyRootPositional(command) &&
    !rootOpt &&
    firstPositionalRoot !== undefined &&
    isExistingDirectory(firstPositionalRoot)
      ? firstPositionalRoot
      : cwd();
  const projectRootFs = rootOpt ? resolveAbs(rootOpt) : defaultProjectRoot;
  return { status: "ok", projectRootFs };
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
