import { performance } from "node:perf_hooks";
import { createImpactIgnoreMatcher } from "../impact/path.js";
import { parseUnifiedDiff } from "../impact/parse.js";
import type { FileChange, Hunk } from "../impact/types.js";
import { assertFilePathWithinRoot } from "../util/paths.js";
import { getUnifiedDiff, listChangedFiles } from "../util/git.js";
import type { ReviewOptions, ReviewTimingReport } from "./types.js";

export type ReviewChangeCollection = {
  changedFiles: Set<string>;
  explicitFiles: Set<string>;
  diffHunksByFile: Map<string, Hunk[]>;
  diffKindsByFile: Map<string, string>;
  diffChangesByFile: Map<string, FileChange>;
};

export async function collectReviewChanges(
  projectRoot: string,
  appliedOptions: ReviewOptions,
  reviewTimings?: ReviewTimingReport,
): Promise<ReviewChangeCollection> {
  const normalizeFile = (file: string, label: string) => assertFilePathWithinRoot(projectRoot, file, label);
  const discoveryIgnoreGlobs = appliedOptions.discovery?.ignoreGlobs ?? [];
  const discoveryGlobRoot = appliedOptions.discovery?.globRoot ?? projectRoot;
  const isIgnoredReviewFile = createImpactIgnoreMatcher(discoveryGlobRoot, discoveryIgnoreGlobs);

  const changedFiles = new Set<string>();
  const explicitFiles = new Set<string>();
  const changesStart = performance.now();
  for (const file of appliedOptions.files ?? []) {
    const normalized = normalizeFile(file, "Review file");
    changedFiles.add(normalized);
    explicitFiles.add(normalized);
  }

  if (appliedOptions.gitBase || appliedOptions.changedSince) {
    const gitDiffOpts: {
      base?: string | undefined;
      head?: string | undefined;
      changedSince?: string | undefined;
    } = {
      base: appliedOptions.gitBase,
      head: appliedOptions.gitHead,
    };
    if (!appliedOptions.gitBase && appliedOptions.changedSince) {
      gitDiffOpts.changedSince = appliedOptions.changedSince;
    }
    const gitList = await listChangedFiles(projectRoot, gitDiffOpts);
    for (const file of gitList) {
      if (!isIgnoredReviewFile(file)) changedFiles.add(file);
    }
  }
  if (reviewTimings) {
    reviewTimings.changesMs = Math.round(performance.now() - changesStart);
  }

  const diffStart = performance.now();
  const shouldLoadGitDiff = (appliedOptions.gitBase || appliedOptions.changedSince) && changedFiles.size;
  const diffText =
    appliedOptions.diffText ??
    (shouldLoadGitDiff
      ? await getUnifiedDiff(projectRoot, {
          base: appliedOptions.gitBase,
          head: appliedOptions.gitHead,
          changedSince: appliedOptions.changedSince,
        })
      : "");
  const diff = diffText ? parseUnifiedDiff(diffText) : null;
  if (reviewTimings) {
    reviewTimings.diffMs = Math.round(performance.now() - diffStart);
  }

  const diffHunksByFile = new Map<string, Hunk[]>();
  const diffKindsByFile = new Map<string, string>();
  const diffChangesByFile = new Map<string, FileChange>();
  if (diff) {
    for (const fileChange of diff.files) {
      const { oldPath, ...rest } = fileChange;
      const absPath = normalizeFile(fileChange.path, "Review diff file");
      const normalizedChange: FileChange = {
        ...rest,
        path: absPath,
        ...(oldPath
          ? {
              oldPath: normalizeFile(oldPath, "Review old diff file"),
            }
          : {}),
      };
      if (isIgnoredReviewFile(absPath)) {
        changedFiles.delete(absPath);
        continue;
      }
      changedFiles.add(absPath);
      diffHunksByFile.set(absPath, normalizedChange.hunks);
      diffKindsByFile.set(absPath, normalizedChange.kind);
      diffChangesByFile.set(absPath, normalizedChange);
    }
  }

  return {
    changedFiles,
    explicitFiles,
    diffHunksByFile,
    diffKindsByFile,
    diffChangesByFile,
  };
}
