import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { supportById } from "./languages.js";
import type { LanguageExtensionMap } from "./indexer/types.js";
import type { ProjectFileDiscoveryOptions } from "./util/projectFiles.js";

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
  })
  .strict();

type ParsedCodegraphConfig = z.infer<typeof codegraphConfigSchema>;

export type CodegraphConfig = {
  discovery?: ProjectFileDiscoveryOptions;
  languages?: {
    extensions?: LanguageExtensionMap;
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

function normalizeLanguageExtensions(extensions: Record<string, string> | undefined): LanguageExtensionMap | undefined {
  if (!extensions) return undefined;
  const normalized: LanguageExtensionMap = {};
  for (const [rawKey, rawLanguageId] of Object.entries(extensions)) {
    const key = rawKey.trim().toLowerCase();
    const languageId = rawLanguageId.trim();
    if (!key.startsWith(".")) {
      throw new Error(`Invalid ${CODEGRAPH_CONFIG_FILE}: languages.extensions key "${rawKey}" must start with ".".`);
    }
    if (!supportById(languageId)) {
      throw new Error(
        `Invalid ${CODEGRAPH_CONFIG_FILE}: languages.extensions["${rawKey}"] references unknown language "${languageId}".`,
      );
    }
    normalized[key] = languageId;
  }
  return Object.keys(normalized).length ? normalized : undefined;
}

function languageExtensionIncludeGlobs(languageExtensions: LanguageExtensionMap | undefined): string[] {
  return Object.keys(languageExtensions ?? {})
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => extension.startsWith("."))
    .sort()
    .map((extension) => `**/*${extension}`);
}

export async function loadCodegraphConfig(projectRoot: string): Promise<CodegraphConfig> {
  const configPath = path.join(projectRoot, CODEGRAPH_CONFIG_FILE);
  let raw: string;
  try {
    raw = await fsp.readFile(configPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${CODEGRAPH_CONFIG_FILE}: ${message}`);
  }

  const parsed = codegraphConfigSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(`Invalid ${CODEGRAPH_CONFIG_FILE}: ${z.prettifyError(parsed.error)}`);
  }
  const languageExtensions = normalizeLanguageExtensions(parsed.data.languages?.extensions);
  const languageDiscovery = languageExtensions
    ? { includeGlobs: languageExtensionIncludeGlobs(languageExtensions) }
    : undefined;
  const discovery = mergeDiscoveryOptions(normalizeDiscoveryConfig(parsed.data.discovery), languageDiscovery);
  return {
    ...(hasDiscoveryOptions(discovery) ? { discovery } : {}),
    ...(languageExtensions ? { languages: { extensions: languageExtensions } } : {}),
  };
}
