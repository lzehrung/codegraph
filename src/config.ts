import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  isLiteralLanguageExtension,
  isRemappableLanguageExtension,
  normalizeLanguageExtensions,
  supportById,
} from "./languages.js";
import type { LanguageExtensionMap } from "./languages.js";
import type { GraphBuildOptions } from "./graphs/types.js";
import { normalizeResolutionHints } from "./util/paths.js";
import { errorMessage } from "./util/errors.js";
import { type ProjectFileDiscoveryOptions } from "./util/projectFiles.js";

export const CODEGRAPH_CONFIG_FILE = "codegraph.config.json";

const stringArraySchema = z.array(z.string().trim().min(1));

const languageExtensionsSchema = z.record(z.string().trim().min(1), z.string().trim().min(1));

const codegraphConfigSchema = z
  .object({
    discovery: z
      .object({
        includeGlobs: stringArraySchema.optional(),
        ignoreGlobs: stringArraySchema.optional(),
        useGitignore: z.boolean().optional(),
      })
      .strict()
      .optional(),
    languages: z
      .object({
        extensions: languageExtensionsSchema.optional(),
      })
      .strict()
      .optional(),
    graph: z
      .object({
        resolutionHints: stringArraySchema.optional(),
      })
      .strict()
      .optional(),
    cache: z
      .object({
        location: z.string().trim().min(1),
      })
      .optional(),
  })
  .strict();

type ParsedCodegraphConfig = z.infer<typeof codegraphConfigSchema>;

export type CodegraphConfig = {
  cache?: {
    location: string;
  };
  discovery?: ProjectFileDiscoveryOptions;
  languages?: {
    extensions?: LanguageExtensionMap;
  };
  graph?: {
    resolutionHints?: string[];
  };
};

function uniq(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim().replace(/\\/g, "/")).filter(Boolean)));
}

function normalizeDiscoveryRoot(root: string | undefined): string | undefined {
  const normalized = root?.trim().replace(/\\/g, "/");
  return normalized ? normalized : undefined;
}

export function hasDiscoveryOptions(discovery: ProjectFileDiscoveryOptions): boolean {
  return Boolean(
    discovery.includeGlobs?.length ||
    discovery.ignoreGlobs?.length ||
    discovery.useGitignore !== undefined ||
    normalizeDiscoveryRoot(discovery.globRoot) ||
    normalizeDiscoveryRoot(discovery.gitignoreRoot) ||
    discovery.logLevel,
  );
}

export function mergeDiscoveryOptions(
  base: ProjectFileDiscoveryOptions | undefined,
  override: ProjectFileDiscoveryOptions | undefined,
): ProjectFileDiscoveryOptions {
  const includeGlobs = uniq([...(base?.includeGlobs ?? []), ...(override?.includeGlobs ?? [])]);
  const ignoreGlobs = uniq([...(base?.ignoreGlobs ?? []), ...(override?.ignoreGlobs ?? [])]);
  const useGitignore = override?.useGitignore ?? base?.useGitignore;
  const globRoot = normalizeDiscoveryRoot(override?.globRoot) ?? normalizeDiscoveryRoot(base?.globRoot);
  const gitignoreRoot = normalizeDiscoveryRoot(override?.gitignoreRoot) ?? normalizeDiscoveryRoot(base?.gitignoreRoot);
  const logLevel = override?.logLevel ?? base?.logLevel;
  return {
    ...(includeGlobs.length ? { includeGlobs } : {}),
    ...(ignoreGlobs.length ? { ignoreGlobs } : {}),
    ...(useGitignore !== undefined ? { useGitignore } : {}),
    ...(globRoot !== undefined ? { globRoot } : {}),
    ...(gitignoreRoot !== undefined ? { gitignoreRoot } : {}),
    ...(logLevel !== undefined ? { logLevel } : {}),
  };
}
export function mergeGraphOptions(
  base: CodegraphConfig["graph"] | undefined,
  override: GraphBuildOptions | undefined,
): GraphBuildOptions {
  const resolutionHints = normalizeResolutionHints([
    ...(base?.resolutionHints ?? []),
    ...(override?.resolutionHints ?? []),
  ]);
  return {
    ...override,
    ...(resolutionHints.length ? { resolutionHints } : {}),
  };
}

function normalizeDiscoveryConfig(
  discovery: ParsedCodegraphConfig["discovery"],
): ProjectFileDiscoveryOptions | undefined {
  if (!discovery) return undefined;
  const normalized: ProjectFileDiscoveryOptions = {
    ...(discovery.includeGlobs !== undefined ? { includeGlobs: discovery.includeGlobs } : {}),
    ...(discovery.ignoreGlobs !== undefined ? { ignoreGlobs: discovery.ignoreGlobs } : {}),
    ...(discovery.useGitignore !== undefined ? { useGitignore: discovery.useGitignore } : {}),
  };
  return hasDiscoveryOptions(normalized) ? normalized : undefined;
}

function normalizeConfigLanguageExtensions(
  extensions: Record<string, string> | undefined,
): LanguageExtensionMap | undefined {
  if (!extensions) return undefined;
  for (const [rawKey, rawLanguageId] of Object.entries(extensions)) {
    const key = rawKey.trim().toLowerCase();
    const languageId = rawLanguageId.trim().toLowerCase();
    if (!key.startsWith(".")) {
      throw new Error(`Invalid ${CODEGRAPH_CONFIG_FILE}: languages.extensions key "${rawKey}" must start with ".".`);
    }
    if (!isLiteralLanguageExtension(key)) {
      throw new Error(
        `Invalid ${CODEGRAPH_CONFIG_FILE}: languages.extensions key "${rawKey}" must be a literal suffix containing only letters, digits, ".", "_", "+", or "-".`,
      );
    }
    if (!isRemappableLanguageExtension(key)) {
      throw new Error(`Invalid ${CODEGRAPH_CONFIG_FILE}: languages.extensions key "${rawKey}" cannot be remapped.`);
    }
    if (!supportById(languageId)) {
      throw new Error(
        `Invalid ${CODEGRAPH_CONFIG_FILE}: languages.extensions["${rawKey}"] references unknown language "${languageId}".`,
      );
    }
  }
  return normalizeLanguageExtensions(extensions);
}
async function loadUserCacheLocation(): Promise<string | undefined> {
  const configRoot =
    process.platform === "win32"
      ? process.env.APPDATA?.trim() || path.join(os.homedir(), "AppData", "Roaming")
      : process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  const configPath = path.join(configRoot, "codegraph", "config.json");
  try {
    const parsedJson = JSON.parse(await fsp.readFile(configPath, "utf8")) as unknown;
    const parsed = codegraphConfigSchema.safeParse(parsedJson);
    if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
    return parsed.data.cache?.location;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error(`Invalid user codegraph config: ${errorMessage(error)}`);
  }
}

export async function loadCodegraphConfig(projectRoot: string): Promise<CodegraphConfig> {
  const userCacheLocation = await loadUserCacheLocation();
  const configPath = path.join(projectRoot, CODEGRAPH_CONFIG_FILE);
  let raw: string;
  try {
    raw = await fsp.readFile(configPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return userCacheLocation ? { cache: { location: userCacheLocation } } : {};
    }
    throw error;
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid ${CODEGRAPH_CONFIG_FILE}: ${errorMessage(error)}`);
  }
  const parsed = codegraphConfigSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(`Invalid ${CODEGRAPH_CONFIG_FILE}: ${z.prettifyError(parsed.error)}`);
  }
  const languageExtensions = normalizeConfigLanguageExtensions(parsed.data.languages?.extensions);
  const discovery = normalizeDiscoveryConfig(parsed.data.discovery);
  const resolutionHints = normalizeResolutionHints(parsed.data.graph?.resolutionHints);
  const graph = resolutionHints.length ? { resolutionHints } : undefined;
  return {
    cache: { location: parsed.data.cache?.location ?? userCacheLocation ?? "project" },
    ...(discovery ? { discovery } : {}),
    ...(graph ? { graph } : {}),
    ...(languageExtensions ? { languages: { extensions: languageExtensions } } : {}),
  };
}
