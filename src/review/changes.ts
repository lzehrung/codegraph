import { performance } from "node:perf_hooks";
import { createImpactIgnoreMatcher, createImpactIncludeMatcher } from "../impact/path.js";
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
  const isIncludedReviewFile = createImpactIncludeMatcher(
    discoveryGlobRoot,
    appliedOptions.discovery?.includeGlobs ?? [],
  );

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
      if (isIncludedReviewFile(file) && !isIgnoredReviewFile(file)) changedFiles.add(file);
    }
  }
  if (reviewTimings) {
    reviewTimings.changesMs = Math.round(performance.now() - changesStart);
  }

  const diffStart = performance.now();
  const shouldLoadGitDiff = Boolean(
    (appliedOptions.gitBase || appliedOptions.changedSince) &&
    (changedFiles.size ||
      appliedOptions.discovery?.includeGlobs?.length ||
      appliedOptions.discovery?.ignoreGlobs?.length),
  );
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
      const oldAbsPath = oldPath ? normalizeFile(oldPath, "Review old diff file") : undefined;
      const normalizedChange: FileChange = {
        ...rest,
        path: absPath,
        ...(oldAbsPath ? { oldPath: oldAbsPath } : {}),
      };
      const newPathIncluded = isIncludedReviewFile(absPath);
      const oldPathIncluded = oldAbsPath !== undefined && isIncludedReviewFile(oldAbsPath);
      const newPathIgnored = isIgnoredReviewFile(absPath);
      const oldPathIgnored = oldAbsPath !== undefined && isIgnoredReviewFile(oldAbsPath);
      const explicitlyRequested =
        explicitFiles.has(absPath) || (oldAbsPath !== undefined && explicitFiles.has(oldAbsPath));
      const newPathVisible = newPathIncluded && !newPathIgnored;
      const oldPathVisible = oldPathIncluded && !oldPathIgnored;
      const included = explicitlyRequested || newPathVisible || oldPathVisible;
      if (!included) {
        changedFiles.delete(absPath);
        if (oldAbsPath !== undefined) changedFiles.delete(oldAbsPath);
        continue;
      }
      let reportPath = absPath;
      let reportChange = normalizedChange;
      if (
        normalizedChange.kind === "renamed" &&
        !explicitlyRequested &&
        !newPathVisible &&
        oldPathVisible &&
        oldAbsPath !== undefined
      ) {
        reportPath = oldAbsPath;
        reportChange = {
          path: reportPath,
          kind: "deleted",
          hunks: normalizedChange.hunks,
          ...(normalizedChange.isBinary ? { isBinary: normalizedChange.isBinary } : {}),
          ...(normalizedChange.modeChanged ? { modeChanged: normalizedChange.modeChanged } : {}),
        };
      }
      changedFiles.add(reportPath);
      diffHunksByFile.set(reportPath, reportChange.hunks);
      diffKindsByFile.set(reportPath, reportChange.kind);
      diffChangesByFile.set(reportPath, reportChange);
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
