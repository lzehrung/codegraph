import type { Stats } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { PROJECT_CACHE_RELATIVE_PATH } from "../indexer/build-cache/location.js";
import { isGitPathIgnored, isGitPathTracked, isGitRepo } from "../util/git.js";
import { errorMessage } from "../util/errors.js";
import { CodegraphLifecycleUserError } from "./errors.js";

const LIFECYCLE_MANIFEST_PATH = ".codegraph/manifest.json";
const LIFECYCLE_CACHE_PATH = PROJECT_CACHE_RELATIVE_PATH.replaceAll(path.sep, "/");
const GITIGNORE_PATH = ".gitignore";
const LIFECYCLE_GITIGNORE_RULE = ".codegraph/";
export const CODEGRAPH_GITIGNORE_RULES = [LIFECYCLE_GITIGNORE_RULE] as const;

export type CodegraphLifecycleGitignoreResult = {
  status: "added" | "already-ignored" | "tracked" | "not-git" | "disabled";
  path: ".gitignore";
  rules?: string[];
};

async function readGitignoreFile(
  gitignorePath: string,
): Promise<{ existing: string; stats?: Stats; newline: "\n" | "\r\n" }> {
  let existing = "";
  let stats: Stats | undefined;
  try {
    stats = await fsp.lstat(gitignorePath);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      const detail = errorMessage(error);
      throw new CodegraphLifecycleUserError(
        `Unable to inspect ${gitignorePath}: ${detail}. Check the path and permissions or rerun with --no-update-gitignore.`,
      );
    }
  }

  if (stats) {
    if (!stats.isFile()) {
      let kind = "non-regular file";
      if (stats.isDirectory()) kind = "directory";
      if (stats.isSymbolicLink()) kind = "symbolic link";
      throw new CodegraphLifecycleUserError(
        `Cannot update ${gitignorePath}: expected a regular file, but found a ${kind}. ` +
          "Replace it with a regular file or rerun with --no-update-gitignore.",
      );
    }
    try {
      existing = await fsp.readFile(gitignorePath, "utf8");
    } catch (error) {
      const detail = errorMessage(error);
      throw new CodegraphLifecycleUserError(
        `Unable to read ${gitignorePath}: ${detail}. Check file permissions or rerun with --no-update-gitignore.`,
      );
    }
  }

  return {
    existing,
    ...(stats ? { stats } : {}),
    newline: existing.includes("\r\n") ? "\r\n" : "\n",
  };
}

export async function prepareCodegraphLifecycleGitignore(
  root: string,
  options: { updateGitignore?: boolean } = {},
): Promise<CodegraphLifecycleGitignoreResult> {
  const { updateGitignore = true } = options;
  if (!updateGitignore) return { status: "disabled", path: GITIGNORE_PATH };

  const resolvedRoot = path.resolve(root);
  if (!(await isGitRepo(resolvedRoot))) return { status: "not-git", path: GITIGNORE_PATH };
  const manifestTracked = await isGitPathTracked(resolvedRoot, LIFECYCLE_MANIFEST_PATH);
  if (manifestTracked) return { status: "tracked", path: GITIGNORE_PATH };
  const manifestIgnored = await isGitPathIgnored(resolvedRoot, LIFECYCLE_MANIFEST_PATH);
  const cacheIgnored = await isGitPathIgnored(resolvedRoot, LIFECYCLE_CACHE_PATH);
  if (manifestIgnored && cacheIgnored) {
    return { status: "already-ignored", path: GITIGNORE_PATH, rules: [...CODEGRAPH_GITIGNORE_RULES] };
  }
  const missingRules = [LIFECYCLE_GITIGNORE_RULE];

  const gitignorePath = path.join(resolvedRoot, GITIGNORE_PATH);
  const { existing, newline } = await readGitignoreFile(gitignorePath);
  let suffix = missingRules.map((rule) => `${rule}${newline}`).join("");
  if (existing && !existing.endsWith("\n")) suffix = `${newline}${suffix}`;
  try {
    await fsp.appendFile(gitignorePath, suffix, "utf8");
  } catch (error) {
    const detail = errorMessage(error);
    throw new CodegraphLifecycleUserError(
      `Unable to update ${gitignorePath}: ${detail}. Check file permissions or rerun with --no-update-gitignore.`,
    );
  }
  return { status: "added", path: GITIGNORE_PATH, rules: missingRules };
}
