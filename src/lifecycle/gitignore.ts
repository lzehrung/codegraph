import type { Stats } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { isGitPathIgnored, isGitPathTracked, isGitRepo } from "../util/git.js";
import { CodegraphLifecycleUserError } from "./errors.js";

const LIFECYCLE_MANIFEST_PATH = ".codegraph/manifest.json";
const GITIGNORE_PATH = ".gitignore";
const GITIGNORE_RULE = ".codegraph/";

export type CodegraphLifecycleGitignoreResult = {
  status: "added" | "already-ignored" | "tracked" | "not-git" | "disabled";
  path: ".gitignore";
};

export async function prepareCodegraphLifecycleGitignore(
  root: string,
  options: { updateGitignore?: boolean } = {},
): Promise<CodegraphLifecycleGitignoreResult> {
  const { updateGitignore = true } = options;
  if (!updateGitignore) return { status: "disabled", path: GITIGNORE_PATH };

  const resolvedRoot = path.resolve(root);
  if (!(await isGitRepo(resolvedRoot))) return { status: "not-git", path: GITIGNORE_PATH };
  if (await isGitPathTracked(resolvedRoot, LIFECYCLE_MANIFEST_PATH)) {
    return { status: "tracked", path: GITIGNORE_PATH };
  }
  if (await isGitPathIgnored(resolvedRoot, LIFECYCLE_MANIFEST_PATH)) {
    return { status: "already-ignored", path: GITIGNORE_PATH };
  }

  const gitignorePath = path.join(resolvedRoot, GITIGNORE_PATH);
  let existing = "";
  let stats: Stats | undefined;
  try {
    stats = await fsp.lstat(gitignorePath);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      const detail = error instanceof Error ? error.message : String(error);
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
      const detail = error instanceof Error ? error.message : String(error);
      throw new CodegraphLifecycleUserError(
        `Unable to read ${gitignorePath}: ${detail}. Check file permissions or rerun with --no-update-gitignore.`,
      );
    }
  }

  const newline = existing.includes("\r\n") ? "\r\n" : "\n";
  let suffix = `${GITIGNORE_RULE}${newline}`;
  if (existing && !existing.endsWith("\n")) suffix = `${newline}${suffix}`;
  try {
    await fsp.appendFile(gitignorePath, suffix, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CodegraphLifecycleUserError(
      `Unable to update ${gitignorePath}: ${detail}. Check file permissions or rerun with --no-update-gitignore.`,
    );
  }
  return { status: "added", path: GITIGNORE_PATH };
}
