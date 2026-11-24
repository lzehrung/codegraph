import { typescriptCollapsedOverloadTarget } from "../ts-callables.js";
import type { CallableIdentityPolicy } from "../callable-identity-policy-types.js";
import { SymbolKind, type ExportEntry } from "../types.js";

function collapseTypeScriptCallableExports(exports: ExportEntry[]): ExportEntry[] {
  const groups = new Map<string, Extract<ExportEntry, { type: "local" }>[]>();
  for (const entry of exports) {
    if (entry.type !== "local" || entry.target.kind !== SymbolKind.Function) continue;
    const callable = entry.target.callable;
    if (!callable || callable.role === "other") continue;
    const key = `${callable.key}\0${entry.exportedAs}`;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  const drop = new Set<ExportEntry>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const canonical = typescriptCollapsedOverloadTarget(group, (entry) => entry.target.callable);
    if (!canonical) continue;
    if (!canonical.target.docstring?.trim()) {
      const documented = group.find((entry) => entry.target.docstring?.trim());
      if (documented?.target.docstring) canonical.target.docstring = documented.target.docstring;
    }
    for (const entry of group) {
      if (entry !== canonical) drop.add(entry);
    }
  }
  if (drop.size === 0) return exports;
  return exports.filter((entry) => !drop.has(entry));
}

export const typescriptCallableIdentityPolicy: CallableIdentityPolicy = {
  completeExports: collapseTypeScriptCallableExports,
  keyShape: "file-owner-name",
};
