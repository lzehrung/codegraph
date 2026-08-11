/**
 * Conditional `package.json#exports` target selection.
 *
 * Matches Node's documented algorithm for the parts this indexer needs:
 * - condition object keys are evaluated in author/declaration order
 * - `default` always matches and terminates
 * - nested condition objects recurse
 * - arrays are fallback lists (collected here; the resolver takes the first existing file)
 * - unmatched conditions fall through
 *
 * Deliberately not modeled (keep these out of "silent disagreement" territory by
 * documenting rather than approximating):
 * - custom `--conditions` / user-defined condition names beyond the Node builtins below
 * - `browser` / `deno` / `worker` / `types` / `development` / `production` conditions
 * - import attributes (`with` / `assert`) as condition inputs
 * - `imports` (`#...`) package imports maps
 * - URL / non-`./` targets (filtered out, matching prior indexer behavior)
 * - `module-sync` top-level-await restrictions when loaded via `require()`
 *
 * `import` and `require` are mutually exclusive and selected by
 * {@link PackageExportConditionMode}. Unspecified mode defaults to `import`.
 */
export type PackageExportConditionMode = "import" | "require";

const SHARED_PACKAGE_EXPORT_CONDITIONS = ["node-addons", "node", "module-sync", "module", "default"] as const;

function activePackageExportConditions(mode: PackageExportConditionMode): ReadonlySet<string> {
  return new Set<string>([...SHARED_PACKAGE_EXPORT_CONDITIONS, mode]);
}

function isExportTargetRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectPackageExportTargets(
  target: unknown,
  conditions: ReadonlySet<string>,
  matchedSubpath?: string,
): string[] | null {
  if (target === null) return null;
  if (typeof target === "string") {
    const resolvedTarget = matchedSubpath === undefined ? target : target.replaceAll("*", matchedSubpath);
    return resolvedTarget.startsWith("./") ? [resolvedTarget] : [];
  }
  if (Array.isArray(target)) {
    const targets: string[] = [];
    for (const entry of target) {
      const fallbackTargets = collectPackageExportTargets(entry, conditions, matchedSubpath);
      if (fallbackTargets?.length) targets.push(...fallbackTargets);
    }
    return targets;
  }
  if (!isExportTargetRecord(target)) return [];

  // Author key order, not a hard-coded priority list. Restored from pre-c1680788.
  for (const [condition, conditionTarget] of Object.entries(target)) {
    if (!conditions.has(condition)) continue;
    const conditionTargets = collectPackageExportTargets(conditionTarget, conditions, matchedSubpath);
    if (condition === "default" || conditionTargets === null || conditionTargets.length) return conditionTargets;
  }
  return [];
}

function matchSubpathPattern(pattern: string, subpath: string): string | null {
  const wildcardIndex = pattern.indexOf("*");
  if (wildcardIndex === -1 || pattern.indexOf("*", wildcardIndex + 1) !== -1) return null;

  const prefix = pattern.slice(0, wildcardIndex);
  const suffix = pattern.slice(wildcardIndex + 1);
  if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix) || subpath.length < prefix.length + suffix.length) {
    return null;
  }
  return subpath.slice(prefix.length, subpath.length - suffix.length);
}

export function resolvePackageExportTargets(
  exportsField: unknown,
  subpath: string,
  mode: PackageExportConditionMode = "import",
): string[] {
  const conditions = activePackageExportConditions(mode);
  if (typeof exportsField === "string" || Array.isArray(exportsField)) {
    return subpath === "." ? (collectPackageExportTargets(exportsField, conditions) ?? []) : [];
  }
  if (!isExportTargetRecord(exportsField)) return [];

  const exportKeys = Object.keys(exportsField);
  const hasSubpathMap = exportKeys.some((key) => key.startsWith("."));
  if (!hasSubpathMap) {
    return subpath === "." ? (collectPackageExportTargets(exportsField, conditions) ?? []) : [];
  }
  if (Object.hasOwn(exportsField, subpath)) {
    return collectPackageExportTargets(exportsField[subpath], conditions) ?? [];
  }

  let matchedPattern:
    | {
        pattern: string;
        matchedSubpath: string;
      }
    | undefined;
  for (const pattern of exportKeys) {
    if (!pattern.startsWith("./")) continue;
    const matchedSubpath = matchSubpathPattern(pattern, subpath);
    if (matchedSubpath === null) continue;
    if (
      !matchedPattern ||
      pattern.indexOf("*") > matchedPattern.pattern.indexOf("*") ||
      (pattern.indexOf("*") === matchedPattern.pattern.indexOf("*") && pattern.length > matchedPattern.pattern.length)
    ) {
      matchedPattern = { pattern, matchedSubpath };
    }
  }
  if (!matchedPattern) return [];
  return (
    collectPackageExportTargets(exportsField[matchedPattern.pattern], conditions, matchedPattern.matchedSubpath) ?? []
  );
}
