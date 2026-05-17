import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ProjectFileDiscoveryOptions } from "./util.js";

export const CODEGRAPH_CONFIG_FILE = "codegraph.config.json";

const stringArraySchema = z.array(z.string().trim().min(1));

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
  })
  .strict();

type ParsedCodegraphConfig = z.infer<typeof codegraphConfigSchema>;

export type CodegraphConfig = {
  discovery?: ProjectFileDiscoveryOptions;
};

function uniq(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

export function hasDiscoveryOptions(discovery: ProjectFileDiscoveryOptions): boolean {
  return Boolean(
    discovery.includeGlobs?.length ||
      discovery.ignoreGlobs?.length ||
      discovery.useGitignore !== undefined ||
      discovery.globRoot ||
      discovery.gitignoreRoot ||
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
  const globRoot = override?.globRoot ?? base?.globRoot;
  const gitignoreRoot = override?.gitignoreRoot ?? base?.gitignoreRoot;
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

function normalizeDiscoveryConfig(discovery: ParsedCodegraphConfig["discovery"]): ProjectFileDiscoveryOptions | undefined {
  if (!discovery) return undefined;
  const normalized: ProjectFileDiscoveryOptions = {
    ...(discovery.includeGlobs !== undefined ? { includeGlobs: discovery.includeGlobs } : {}),
    ...(discovery.ignoreGlobs !== undefined ? { ignoreGlobs: discovery.ignoreGlobs } : {}),
    ...(discovery.useGitignore !== undefined ? { useGitignore: discovery.useGitignore } : {}),
  };
  return hasDiscoveryOptions(normalized) ? normalized : undefined;
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
  const discovery = normalizeDiscoveryConfig(parsed.data.discovery);
  return {
    ...(discovery ? { discovery } : {}),
  };
}
