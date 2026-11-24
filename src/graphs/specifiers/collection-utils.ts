import type { ModuleSpecifier } from "../../util/specifiers.js";

export function moduleSpecifierKey(entry: ModuleSpecifier): string {
  return `${entry.spec}::${entry.typeOnly ? 1 : 0}::${entry.phpImportType ?? ""}::${
    entry.exportCondition ?? ""
  }::${entry.pathAttribute ?? ""}::${entry.includeForm ?? ""}::${entry.rubyLoadForm ?? ""}::${entry.jvmPackageWildcard ? 1 : 0}::${
    entry.resolutionKind ?? ""
  }`;
}

export function appendUniqueSpecifiers(
  target: ModuleSpecifier[],
  incoming: ModuleSpecifier[],
  seen: Set<string>,
): void {
  for (const entry of incoming) {
    const key = moduleSpecifierKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(entry);
  }
}

export function makeSeenSet(target: ModuleSpecifier[]): Set<string> {
  return new Set(target.map(moduleSpecifierKey));
}
