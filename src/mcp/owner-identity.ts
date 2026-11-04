import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { hasDiscoveryOptions, loadCodegraphConfig, mergeDiscoveryOptions, mergeGraphOptions } from "../config.js";
import type { BuildOptions } from "../indexer/types.js";
import { normalizeLanguageExtensions } from "../languages.js";
import { currentNativeTargetSuffix, findLocalNativeBinary, readPlatformPackage } from "../native/binding-loader.js";
import { getCodegraphPackageIdentity } from "../util/package-info.js";
import { normalizePath } from "../util/paths.js";
import { DEFAULT_MCP_INDEX_WAIT_MS } from "./runtime-limits.js";

export type SharedOwnerOptions = {
  root: string;
  buildOptions?: BuildOptions;
  readOnly?: boolean;
  artifactPath?: string;
  warmup?: "off" | "base" | "symbols";
  watch?: boolean;
  mcpIndexWaitMs?: number;
};

export type ResolvedSharedOwnerOptions = SharedOwnerOptions & {
  readOnly: boolean;
  warmup: "off" | "base" | "symbols";
  watch: boolean;
  mcpIndexWaitMs: number;
};

/** Resolve relative option paths in the caller and canonicalize paths that denote its root. */
export async function resolveSharedOwnerOptions(options: SharedOwnerOptions): Promise<ResolvedSharedOwnerOptions> {
  const logicalRoot = path.resolve(options.root);
  const root = normalizePath(await fs.realpath(logicalRoot));
  const normalizeRootPath = (value: string): string => {
    const trimmed = value.trim();
    if (!trimmed) return value;
    const absolute = path.resolve(trimmed);
    const equal =
      process.platform === "win32" ? absolute.toLowerCase() === logicalRoot.toLowerCase() : absolute === logicalRoot;
    return equal ? root : normalizePath(absolute);
  };
  let buildOptions = options.buildOptions;
  if (buildOptions?.report) {
    throw new Error("A shared MCP owner cannot populate a caller-owned build report.");
  }
  if (buildOptions) {
    const discovery = buildOptions.discovery;
    if (discovery) {
      const globRoot = discovery.globRoot === undefined ? undefined : normalizeRootPath(discovery.globRoot);
      const gitignoreRoot =
        discovery.gitignoreRoot === undefined ? undefined : normalizeRootPath(discovery.gitignoreRoot);
      buildOptions = {
        ...buildOptions,
        discovery: {
          ...discovery,
          ...(globRoot !== undefined ? { globRoot } : {}),
          ...(gitignoreRoot !== undefined ? { gitignoreRoot } : {}),
        },
      };
      if (!Object.keys(buildOptions.discovery ?? {}).length) {
        const { discovery: _discovery, ...rest } = buildOptions;
        buildOptions = rest;
      }
    }
    if (buildOptions.cacheDir?.trim()) {
      buildOptions = { ...buildOptions, cacheDir: normalizeRootPath(buildOptions.cacheDir) };
    }
    if (buildOptions.cacheLocation && path.isAbsolute(buildOptions.cacheLocation)) {
      buildOptions = { ...buildOptions, cacheLocation: normalizeRootPath(buildOptions.cacheLocation) };
    }
    // IPC cannot preserve callbacks, mutable reports, class instances, or non-finite values.
    // Reject them instead of silently changing what the client asked the owner to do.
    const serialized = stableJson(buildOptions);
    buildOptions = JSON.parse(serialized) as BuildOptions;
    if (!Object.keys(buildOptions).length) buildOptions = undefined;
  }
  return await effectiveOwnerOptions({
    root,
    ...(buildOptions ? { buildOptions } : {}),
    readOnly: options.readOnly ?? true,
    ...(options.artifactPath !== undefined ? { artifactPath: options.artifactPath } : {}),
    warmup: options.warmup ?? "base",
    watch: options.watch ?? true,
    mcpIndexWaitMs: options.mcpIndexWaitMs ?? DEFAULT_MCP_INDEX_WAIT_MS,
  });
}

/** Hash actual runtime inputs without loading an addon in the stdio bridge. */
export async function getSharedOwnerIdentity(options: ResolvedSharedOwnerOptions): Promise<string> {
  const pkg = getCodegraphPackageIdentity();
  const packageRoot = await fs.realpath(pkg.packageRoot);
  const userConfigRoot =
    process.platform === "win32"
      ? process.env.APPDATA?.trim() || path.join(os.homedir(), "AppData", "Roaming")
      : process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  const environment: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const key = process.platform === "win32" ? rawKey.toUpperCase() : rawKey;
    if (
      key.startsWith("GIT_") ||
      [
        "CODEGRAPH_CACHE_DIR",
        "CODEGRAPH_DISABLE_QUERY_SIDECAR",
        "PATH",
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "XDG_STATE_HOME",
        "NODE_OPTIONS",
        "NODE_PATH",
        "GOROOT",
        "TMPDIR",
        "TMP",
        "TEMP",
      ].includes(key)
    ) {
      environment[key] = key === "CODEGRAPH_CACHE_DIR" && value.trim() ? path.resolve(value.trim()) : value;
    }
  }
  const identity = {
    schema: 1,
    options: await effectiveOwnerOptions(options),
    config: await readOptionalFile(path.join(options.root, "codegraph.config.json")),
    userConfig: await readOptionalFile(path.join(userConfigRoot, "codegraph", "config.json")),
    environment,
    runtime: {
      packageRoot: normalizePath(packageRoot),
      version: pkg.version,
      node: process.version,
      executable: normalizePath(await fs.realpath(process.execPath)),
      platform: process.platform,
      arch: process.arch,
      compiled: await compiledRuntimeIdentity(packageRoot),
      native: await nativeBinaryIdentity(packageRoot),
    },
  };
  return createHash("sha256").update(stableJson(identity)).digest("hex");
}

/** Match the session's config merge so CLI-expanded and workspace-explicit options agree. */
async function effectiveOwnerOptions(options: ResolvedSharedOwnerOptions): Promise<ResolvedSharedOwnerOptions> {
  const config = await loadCodegraphConfig(options.root);
  const {
    discovery: optionDiscovery,
    graph: optionGraph,
    languageExtensions: optionExtensions,
    cacheLocation: optionCacheLocation,
    ...otherBuildOptions
  } = options.buildOptions ?? {};
  const discovery = mergeDiscoveryOptions(config.discovery, optionDiscovery);
  let discoveryOptions: BuildOptions["discovery"];
  if (hasDiscoveryOptions(discovery)) {
    discoveryOptions = {
      ...discovery,
      globRoot: discovery.globRoot ?? options.root,
      ...(optionDiscovery?.knownSymlinkDirectories !== undefined
        ? { knownSymlinkDirectories: optionDiscovery.knownSymlinkDirectories }
        : {}),
    };
  } else if (optionDiscovery?.knownSymlinkDirectories !== undefined) {
    discoveryOptions = { knownSymlinkDirectories: optionDiscovery.knownSymlinkDirectories };
  }
  const mergedGraph = mergeGraphOptions(config.graph, optionGraph);
  const graph = {
    ...(mergedGraph.resolveNodeModules ? { resolveNodeModules: true } : {}),
    ...(mergedGraph.dynamicImportHeuristics ? { dynamicImportHeuristics: true } : {}),
    ...(mergedGraph.resolutionHints?.length ? { resolutionHints: mergedGraph.resolutionHints } : {}),
    ...(mergedGraph.logLevel !== undefined ? { logLevel: mergedGraph.logLevel } : {}),
  };
  const languageExtensions = normalizeLanguageExtensions(optionExtensions) ?? config.languages?.extensions;
  const cacheLocation = optionCacheLocation ?? config.cache?.location;
  return {
    root: options.root,
    readOnly: options.readOnly,
    ...(options.artifactPath !== undefined ? { artifactPath: options.artifactPath } : {}),
    warmup: options.warmup,
    watch: options.watch,
    mcpIndexWaitMs: options.mcpIndexWaitMs,
    buildOptions: {
      ...otherBuildOptions,
      ...(discoveryOptions ? { discovery: discoveryOptions } : {}),
      ...(Object.keys(graph).length ? { graph } : {}),
      ...(languageExtensions ? { languageExtensions } : {}),
      ...(cacheLocation ? { cacheLocation } : {}),
    },
  };
}

/** The owner executes the compiled module graph, including its worker and CLI entrypoints. */
async function compiledRuntimeIdentity(packageRoot: string): Promise<string> {
  const dist = path.join(packageRoot, "dist");
  const hash = createHash("sha256");
  const directories = [dist];
  for (let index = 0; index < directories.length; index += 1) {
    const directory = directories[index]!;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : Number(left.name > right.name)));
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error("Shared MCP runtime files must not be symbolic links. Rebuild or reinstall Codegraph.");
      }
      if (entry.isDirectory()) {
        directories.push(file);
      } else if (/\.(?:[cm]?js|json)$/u.test(entry.name)) {
        if (!entry.isFile()) throw new Error("Shared MCP runtime contains a non-regular implementation file.");
        hash
          .update(normalizePath(path.relative(dist, file)))
          .update("\0")
          .update(await hashFile(file))
          .update("\0");
      }
    }
  }
  return hash.digest("hex");
}

async function nativeBinaryIdentity(packageRoot: string): Promise<object> {
  const localRoot = path.join(packageRoot, "packages", "codegraph-native");
  const local = findLocalNativeBinary(localRoot);
  const target = currentNativeTargetSuffix();
  const requireFromRuntime = createRequire(path.join(packageRoot, "dist", "native", "runtime.js"));
  let packageEntry: string | undefined;
  try {
    packageEntry = requireFromRuntime.resolve("@lzehrung/codegraph-native");
  } catch {
    // A directly loaded workspace addon can work without an installed package.
  }
  const packageLocal = packageEntry ? findLocalNativeBinary(path.dirname(packageEntry)) : null;
  const resolvePlatform = (
    resolve: (specifier: string) => string,
  ): { sourcePath: string; packageVersion: string } | undefined => {
    if (!target) return undefined;
    try {
      return readPlatformPackage("@lzehrung/codegraph-native", target, resolve);
    } catch (cause) {
      try {
        resolve(`@lzehrung/codegraph-native-${target}`);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "MODULE_NOT_FOUND") return undefined;
        throw new Error("Cannot verify the shared owner's native platform package.", { cause: error });
      }
      throw new Error("Cannot verify the shared owner's native platform package.", { cause });
    }
  };
  const platform = resolvePlatform(requireFromRuntime.resolve);
  const nestedPlatform = packageEntry ? resolvePlatform(createRequire(packageEntry).resolve) : undefined;
  const files = new Map<string, { path: string; sha256: string }>();
  const fingerprint = async (file: string | null | undefined): Promise<{ path: string; sha256: string } | null> => {
    if (!file) return null;
    const resolved = await fs.realpath(file);
    let result = files.get(resolved);
    if (!result) {
      result = { path: normalizePath(resolved), sha256: await hashFile(resolved) };
      files.set(resolved, result);
    }
    return result;
  };
  if (!local && !packageLocal && !platform && !nestedPlatform) {
    throw new Error("Cannot verify a native addon for the shared Codegraph owner.");
  }
  return {
    target,
    packageEntry: await fingerprint(packageEntry),
    local: await fingerprint(local),
    packageLocal: await fingerprint(packageLocal),
    platform: platform ? { source: await fingerprint(platform.sourcePath), version: platform.packageVersion } : null,
    nestedPlatform: nestedPlatform
      ? { source: await fingerprint(nestedPlatform.sourcePath), version: nestedPlatform.packageVersion }
      : null,
  };
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function readOptionalFile(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function stableJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value === "object" && value !== null) {
    if (ancestors.has(value)) throw new Error("Shared MCP owner options cannot contain cycles.");
    ancestors.add(value);
    try {
      if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry, ancestors)).join(",")}]`;
      if (Object.getPrototypeOf(value) === Object.prototype) {
        const entries = Object.entries(value)
          .filter(([, entry]) => entry !== undefined)
          .sort(([left], [right]) => (left < right ? -1 : Number(left > right)));
        return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry, ancestors)}`).join(",")}}`;
      }
    } finally {
      ancestors.delete(value);
    }
  }
  throw new Error("Shared MCP owner options must contain only serializable JSON values; callbacks are not supported.");
}
