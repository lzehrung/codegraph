const ACTIVE_PACKAGE_EXPORT_CONDITIONS: Record<string, true> = {
  "node-addons": true,
  node: true,
  import: true,
  require: true,
  "module-sync": true,
  module: true,
  default: true,
};

function isExportTargetRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectPackageExportTargets(target: unknown, matchedSubpath?: string): string[] | null {
  if (target === null) return null;
  if (typeof target === "string") {
    const resolvedTarget = matchedSubpath === undefined ? target : target.replaceAll("*", matchedSubpath);
    return resolvedTarget.startsWith("./") ? [resolvedTarget] : [];
  }
  if (Array.isArray(target)) {
    const targets: string[] = [];
    for (const entry of target) {
      const fallbackTargets = collectPackageExportTargets(entry, matchedSubpath);
      if (fallbackTargets?.length) targets.push(...fallbackTargets);
    }
    return targets;
  }
  if (!isExportTargetRecord(target)) return [];

  for (const [condition, conditionTarget] of Object.entries(target)) {
    if (!Object.hasOwn(ACTIVE_PACKAGE_EXPORT_CONDITIONS, condition)) continue;
    const conditionTargets = collectPackageExportTargets(conditionTarget, matchedSubpath);
    if (conditionTargets === null || conditionTargets.length) return conditionTargets;
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

export function resolvePackageExportTargets(exportsField: unknown, subpath: string): string[] {
  if (typeof exportsField === "string" || Array.isArray(exportsField)) {
    return subpath === "." ? (collectPackageExportTargets(exportsField) ?? []) : [];
  }
  if (!isExportTargetRecord(exportsField)) return [];

  const exportKeys = Object.keys(exportsField);
  const hasSubpathMap = exportKeys.some((key) => key.startsWith("."));
  if (!hasSubpathMap) {
    return subpath === "." ? (collectPackageExportTargets(exportsField) ?? []) : [];
  }
  if (Object.hasOwn(exportsField, subpath)) {
    return collectPackageExportTargets(exportsField[subpath]) ?? [];
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
  return collectPackageExportTargets(exportsField[matchedPattern.pattern], matchedPattern.matchedSubpath) ?? [];
}

export function pickPackageExportTarget(target: unknown): string | null {
  return collectPackageExportTargets(target)?.[0] ?? null;
}
